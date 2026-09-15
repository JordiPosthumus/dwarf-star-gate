#!/usr/bin/env python3
"""Recover one enrolled Docker container without recreating or changing it.

The gateway owns draining and verification. Docker keeps its restart policy.
This helper never starts stopped containers, pulls images or changes settings.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def digest(value):
    return hashlib.sha256(value).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def run(args):
    result = subprocess.run(args, capture_output=True, timeout=35, check=True)
    if len(result.stdout) + len(result.stderr) > 1024 * 1024:
        raise ValueError('adapter_output_limit')
    # Docker writes application stderr logs to stderr, even on a successful call.
    return (result.stdout + (result.stderr if args[1] == 'logs' else b'')).decode()


def milliseconds(value):
    return round(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


def fault_evidence(lines, started):
    fault = None
    for line in lines.splitlines():
        stamp, _, message = line.partition(' ')
        try:
            at = milliseconds(stamp)
        except ValueError:
            continue
        if at >= started and re.search(r'CUDA error:.*(?:illegal memory access|device-side assert)', message, re.I):
            if fault is None or at > fault['at']:
                fault = {'at': at, 'reason': 'fatal_accelerator_error'}
    return fault


def owns_listener(container, port):
    # Inspect only processes visible inside this container's PID namespace.
    # A host-network listener belonging to a different container is insufficient.
    code = """import os,json
from pathlib import Path
inodes=set()
for process in Path('/proc').iterdir():
 if not process.name.isdigit(): continue
 try:
  for fd in (process/'fd').iterdir():
   try:
    link=os.readlink(fd)
    if link.startswith('socket:['): inodes.add(link[8:-1])
   except FileNotFoundError: pass
 except FileNotFoundError: pass
found=False
for name in ['tcp','tcp6']:
 file=Path('/proc/net')/name
 if not file.exists(): continue
 for row in file.read_text().splitlines()[1:]:
  fields=row.split()
  if fields[3]=='0A' and int(fields[1].split(':')[1],16)==PORT and fields[9] in inodes: found=True
print(json.dumps(found))
""".replace('PORT', str(port))
    return json.loads(run(['docker', 'exec', container, 'python3', '-c', code])) is True


def inspect(config):
    value = json.loads(run(['docker', 'inspect', config['container']]))[0]
    if value['Id'] != config['container']:
        raise ValueError('container_identity_changed')
    state = value['State']
    definition = {key: value[key] for key in ['Id', 'Image', 'Config', 'HostConfig', 'Mounts']}
    # Match the retained-profile reader: Docker's mount enumeration is unordered.
    definition['Mounts'] = sorted(value['Mounts'], key=lambda mount: mount['Destination'])
    profile = fingerprint(definition)
    active = state.get('Running') is True and not state.get('Paused') and not state.get('Restarting')
    started = milliseconds(state['StartedAt']) if active else None
    return {
        'version': 1, 'machine': digest(Path('/etc/machine-id').read_bytes()),
        'profile': profile, 'service_profile': profile, 'loaded': True,
        'active': bool(active), 'stopped': state.get('Status') in ['created', 'exited', 'dead'],
        'stopped_epoch': fingerprint([value['Id'], state.get('StartedAt'), state.get('FinishedAt')]),
        'instance': fingerprint([value['Id'], state['StartedAt']])[:32] if active else '',
        'pid': state.get('Pid', 0), 'started_at': started,
        'listener': owns_listener(value['Id'], config['port']) if active else False,
        'fault': fault_evidence(run(['docker', 'logs', '--timestamps', '--since', state['StartedAt'], '--tail', '200', value['Id']]), started) if active else None,
        'restart_policy': value['HostConfig'].get('RestartPolicy', {}).get('Name'),
    }


def save(filename, value):
    temporary = filename.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, filename)
    fd = os.open(filename.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def handle(config, request, journal):
    if request == {'action': 'inspect'}:
        return inspect(config)
    fields = {'action', 'action_id', 'instance', 'machine', 'profile', 'canary', 'fault_after'}
    if (set(request) != fields or request['action'] != 'restart'
            or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', request['action_id'])
            or type(request['canary']) is not bool or type(request['fault_after']) not in [int, float]):
        raise ValueError('invalid_adapter_request')
    with open(str(journal) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        history = json.loads(journal.read_text()) if journal.exists() else {}
        request_hash = fingerprint(request)
        previous = history.get(request['action_id'])
        if previous:
            if previous['request_hash'] != request_hash:
                raise ValueError('action_id_conflict')
            return previous
        current = inspect(config)
        if not current['active'] or not current['listener'] or any(current.get(key) != request[key] for key in ['instance', 'machine', 'profile']):
            raise ValueError('service_identity_changed')
        if not request['canary'] and (not current['fault'] or current['fault']['at'] < request['fault_after']):
            raise ValueError('current_fatal_evidence_required')
        if any(item['instance'] == current['instance'] for item in history.values()):
            raise ValueError('instance_already_attempted')
        receipt = {'request_hash': request_hash, 'operation': 'restart', 'instance': current['instance'],
                   'issued_at': round(time.time() * 1000), 'state': 'intent'}
        history[request['action_id']] = receipt
        save(journal, history)  # Lost acknowledgement never authorizes a replay.
        run(['docker', 'restart', config['container']])
        receipt['state'] = 'issued'
        save(journal, history)
        return receipt


def main():
    filename = Path(sys.argv[1])
    config = json.loads(filename.read_text())
    if (set(config) != {'container', 'port'} or not re.fullmatch(r'[a-f0-9]{64}', config['container'])
            or type(config['port']) is not int or not 1 <= config['port'] <= 65535
            or filename.stat().st_mode & 0o077):
        raise ValueError('invalid_private_configuration')
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ValueError('adapter_input_limit')
    print(json.dumps(handle(config, json.loads(raw), filename.with_suffix('.actions.json'))))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'adapter_check_or_operation_failed'}))
        sys.exit(1)
