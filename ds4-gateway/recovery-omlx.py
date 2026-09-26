#!/usr/bin/env python3
"""Recover an enrolled, directly launched local oMLX without rewriting its launcher.

The core owns admission and post-start verification. This adapter uses the
existing launcher/serve.sh, and an explicitly enrolled PID file and command hash.
It does not create a launchd service or change model/cache settings.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.request

spec = importlib.util.spec_from_file_location('mac_recovery_common', Path(__file__).with_name('recovery-launchd.py'))
mac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mac)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def validate_config(config):
    required = {'root', 'binary', 'port', 'command_sha256', 'api_key_file', 'start_stopped'}
    def absolute(value):
        return isinstance(value, str) and value.startswith('/') and '\0' not in value
    if (not isinstance(config, dict) or not required <= set(config)
            or set(config) - required - {'launcher', 'profile_files'}
            or any(not absolute(config[k]) for k in ('root', 'binary', 'api_key_file'))
            or type(config['port']) is not int or not 1 <= config['port'] <= 65535
            or type(config['start_stopped']) is not bool
            or not isinstance(config['command_sha256'], str)
            or not re.fullmatch(r'[a-f0-9]{64}', config['command_sha256'])):
        raise ValueError('invalid_private_configuration')
    if 'launcher' in config:
        files = config.get('profile_files')
        if (not absolute(config['launcher']) or not isinstance(files, list)
                or len(files) > 32 or any(not absolute(p) for p in files)
                or len(set(files)) != len(files)):
            raise ValueError('invalid_launcher_configuration')
    elif 'profile_files' in config:
        raise ValueError('invalid_launcher_configuration')


def enrolled_file(path, executable=False):
    info = os.lstat(path)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid())
            or info.st_mode & 0o022 or (executable and not os.access(path, os.X_OK))):
        raise ValueError('launcher_file_unverified')
    return mac.file_digest(path)


def profile(config):
    root = Path(config['root'])
    names = ('serve.sh', 'state/settings.json', 'state/model_settings.json')
    files = {str(root / name): mac.file_digest(root / name) for name in (names if 'launcher' in config else ('start.py', *names))}
    value = {'files': files, 'binary': str(Path(config['binary']).resolve()),
             'binary_sha256': mac.file_digest(config['binary']), 'port': config['port'],
             'command_sha256': config['command_sha256']}
    if 'launcher' in config:
        # Include the selected executable path as well as all explicitly enrolled
        # dependencies. Never silently substitute an installed start.py.
        for path in config['profile_files']:
            files[path] = enrolled_file(path)
        files[config['launcher']] = enrolled_file(config['launcher'], executable=True)
        value['launcher'] = config['launcher']
    return fingerprint(value)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def port_occupied(port):
    # Match the HTTP server's reuse semantics: TIME_WAIT after its last request
    # must not prevent recovery. A listening socket still prevents this bind.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
        except OSError as error:
            if error.errno == mac.errno.EADDRINUSE:
                return True
            raise
    return False


def inspect(config):
    root = Path(config['root'])
    text = (root / 'server.pid').read_text().strip()
    if not re.fullmatch(r'[1-9][0-9]{0,9}', text) or not 2 <= int(text) <= 2147483647:
        raise ValueError('recorded_pid_unverified')
    pid = int(text)
    static = profile(config)
    machine = mac.machine_identity()
    base = {'version': 1, 'machine': machine, 'profile': static, 'service_profile': static,
            'loaded': True, 'registration': 'enrolled_launcher', 'active': False, 'stopped': False,
            'instance': '', 'pid': 0, 'listener': False, 'fault': None}
    if not alive(pid):
        return {**base, 'stopped': True, 'listener': port_occupied(config['port']),
                'stopped_epoch': fingerprint([machine, static, text, (root / 'server.pid').stat().st_mtime_ns])}
    process = mac.process_info(pid)
    if (str(Path(process['executable']).resolve()) != str(Path(config['binary']).resolve())
            or hashlib.sha256(process['command'].encode()).hexdigest() != config['command_sha256']):
        raise ValueError('recorded_process_identity_changed')
    return {**base, 'active': True, 'pid': pid, 'started_at': process['started_at'],
            'instance': fingerprint([machine, pid, process['started_at']])[:32],
            'listener': mac.owns_listener(pid, config['port'])}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


def idle(config):
    credential = Path(config['api_key_file'])
    if not mac.owned_private_regular(credential) or credential.stat().st_size > 8192:
        raise ValueError('endpoint_credential_unavailable')
    token = credential.read_text().strip()
    if not token or re.search(r'[\x00-\x20\x7f]', token):
        raise ValueError('endpoint_credential_unavailable')
    request = urllib.request.Request(f'http://127.0.0.1:{config["port"]}/api/status', headers={'Authorization': 'Bearer ' + token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=5) as response:
        raw = response.read(262145)
        if len(raw) > 262144: raise ValueError('status_response_limit')
        status = json.loads(raw)
    return status.get('status') == 'ok' and all(type(status.get(k)) is int and status[k] == 0 for k in ('active_requests', 'waiting_requests', 'models_loading'))


def start(config, journal, action_id):
    # Preserve the installation's own startup environment and settings.
    root = Path(config['root'])
    command = [config['launcher']] if 'launcher' in config else [sys.executable, '-I', str(root / 'start.py')]
    with (journal.parent / ('start-' + action_id + '.log')).open('ab') as log:
        process = subprocess.Popen(command, cwd=root,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
    return process.pid  # Admission waits for native proof, not this acknowledgement.


def handle(config, request, journal):
    if request == {'action': 'inspect'}: return inspect(config)
    restarting = request.get('action') == 'restart'
    fields = ({'action', 'action_id', 'instance', 'machine', 'profile', 'canary', 'fault_after'} if restarting else
              {'action', 'action_id', 'stopped_epoch', 'machine', 'service_profile'})
    if (set(request) != fields or request.get('action') not in ('start', 'restart')
            or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', request.get('action_id', ''))):
        raise ValueError('invalid_adapter_request')
    # There is no guessed oMLX fatal-log classifier. Live restarts are explicit drills.
    if restarting and request['canary'] is not True: raise ValueError('current_fatal_evidence_unavailable')
    if not restarting and config['start_stopped'] is not True: raise ValueError('stopped_start_not_enrolled')
    with open(str(journal) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        history = json.loads(journal.read_text()) if journal.exists() else {}
        request_hash = fingerprint(request)
        if request['action_id'] in history:
            previous = history[request['action_id']]
            if previous['request_hash'] != request_hash: raise ValueError('action_id_conflict')
            return previous
        current = inspect(config)
        keys = ('machine', 'profile', 'instance') if restarting else ('machine', 'service_profile', 'stopped_epoch')
        if any(current.get(k) != request[k] for k in keys): raise ValueError('service_identity_changed')
        if restarting:
            if not current['active'] or not current['listener'] or not idle(config): raise ValueError('wait_for_native_idle')
            if inspect(config) != current: raise ValueError('service_identity_changed')
        elif not current['stopped'] or current['active'] or current['listener']:
            raise ValueError('stopped_service_unverified')
        identity = current['instance'] if restarting else current['stopped_epoch']
        if any(item.get('identity') == identity for item in history.values()): raise ValueError('instance_already_attempted')
        receipt = {'request_hash': request_hash, 'operation': request['action'], 'identity': identity,
                   'issued_at': round(time.time() * 1000), 'state': 'intent'}
        history[request['action_id']] = receipt
        mac.atomic_save(journal, history)
        if inspect(config) != current: raise ValueError('service_identity_changed')
        if restarting:
            os.kill(current['pid'], signal.SIGTERM)
            deadline = time.monotonic() + 30
            while alive(current['pid']):
                if time.monotonic() >= deadline: raise ValueError('service_stop_pending')
                time.sleep(.2)
        # Never start over another listener or changed launcher.
        if profile(config) != current['service_profile'] or port_occupied(config['port']):
            raise ValueError('startup_identity_or_port_changed')
        receipt['launcher_pid'] = start(config, journal, request['action_id'])
        receipt['state'] = 'issued'
        mac.atomic_save(journal, history)
        return receipt


def main():
    filename = Path(sys.argv[1])
    config = mac.read_private_config(filename)
    validate_config(config)
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192: raise ValueError('adapter_input_limit')
    request=json.loads(raw)
    if request.get('action')=='transaction':
        spec=importlib.util.spec_from_file_location('omlx_transaction',Path(__file__).with_name('recovery_omlx_transaction.py'))
        transaction=importlib.util.module_from_spec(spec);spec.loader.exec_module(transaction)
        result=transaction.dispatch(filename,config,request)
    else:result=handle(config,request,filename.with_suffix('.actions.json'))
    print(json.dumps(result))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        reason=str(error) if re.fullmatch(r'omlx_transaction_[a-z_]+',str(error)) else 'adapter_check_or_operation_failed'
        print(json.dumps({'error': reason}))
        sys.exit(1)
