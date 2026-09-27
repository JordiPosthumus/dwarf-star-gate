#!/usr/bin/env python3
"""Private fixed-protocol controller bridge for a detached exact-pair runner."""
import fcntl
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

# The enrolled absolute helper is trusted code. Isolated Python does not add
# its directory to sys.path; load only this helper's adjacent shipped modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from docker_profile import UnixHTTP
from recovery_pair import enrollment_identity, fingerprint, observe_pair, require, validate_request, validate_journal
from recovery_pair_native import PairJournal, RemotePair, private_read, private_save, run_native_pair


def configuration(filename):
    value = private_read(Path(filename))
    require(isinstance(value, dict) and set(value) == {'schema', 'enrollment', 'journal_directory', 'gateway_socket'}
            and value['schema'] == 1, 'pair_config_unverified')
    enrollment_identity(value['enrollment'])
    for key in ('journal_directory', 'gateway_socket'):
        require(isinstance(value[key], str) and Path(value[key]).is_absolute() and '\x00' not in value[key], 'pair_config_path_unverified')
    root = Path(value['journal_directory'])
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, 'pair_private_directory_unverified')
    return value


def owned(config, request):
    """Fail closed if the current controller cannot attest this exact request."""
    try:
        socket = Path(config['gateway_socket'])
        info = socket.lstat()
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, 'pair_control_socket_unverified')
        connection = UnixHTTP(str(socket), 10)
        try:
            connection.request('POST', '/recovery-pair-permit', json.dumps(request), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            data = response.read(65537)
            if response.status != 200 or len(data) > 65536:
                return False
            result = json.loads(data)
            return result.get('allowed') is True and all(result.get(k) == request[k] for k in ('action_id', 'epoch', 'profile'))
        finally:
            connection.close()
    except Exception:
        return False


def inspect(config, remote_factory=RemotePair):
    enrollment = config['enrollment']
    raw = remote_factory(enrollment).observe()
    current = observe_pair(enrollment, raw)
    times = [row.get('started_at') if current['members'][i] == 'running' else 0 for i, row in enumerate(raw)]
    require(all(type(t) in (int, float) and math.isfinite(t) and t >= 0 for t in times), 'pair_start_time_unverified')
    return {**{k: current[k] for k in ('version', 'machine', 'profile', 'active', 'stopped', 'partial', 'listener', 'fault')},
            'loaded': True, 'instance': current['epoch'][:32], 'pair_epoch': current['epoch'],
            'stopped_epoch': current['epoch'], 'service_profile': current['profile'], 'started_at': max(times),
            'context_length': enrollment['context_length'], 'concurrency': enrollment['concurrency'], 'model': enrollment['model']}


def summary(config, request):
    root = Path(config['journal_directory'])
    try:
        row = private_read(root / (request['action_id'] + '.json'))
    except FileNotFoundError:
        return {'state': 'pending', 'action_id': request['action_id']}
    validate_journal(config['enrollment'], request, row)
    return {k: row[k] for k in ('state', 'action_id', 'reason', 'updated_at', 'final_epoch') if k in row}


def launch(filename, config, request, *, permitted=owned, popen=subprocess.Popen):
    validate_request(config['enrollment'], request)
    require(permitted(config, request) is True, 'pair_ownership_unavailable')
    root = Path(config['journal_directory'])
    fd = os.open(root / 'dispatch.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, 'pair_lock_unverified')
        fcntl.flock(fd, fcntl.LOCK_EX)
        request_file = root / (request['action_id'] + '.request')
        expected = {'request': request, 'enrollment': fingerprint(config)}
        try:
            previous = private_read(request_file)
        except FileNotFoundError:
            previous = None
        require(previous is None or previous == expected, 'pair_action_id_conflict')
        if previous is None:
            private_save(request_file, expected)
        result = summary(config, request)
        if result['state'] == 'completed':
            return result
        # A live lease, not a saved PID, determines whether native work is live.
        try:
            with PairJournal(root, config['enrollment'], request):
                pass
        except ValueError as error:
            if str(error) == 'pair_runner_already_active':
                return {'state': 'running', 'action_id': request['action_id']}
            raise
        log_fd = os.open(root / (request['action_id'] + '.log'), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(log_fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, 'pair_log_unverified')
            child = popen([sys.executable, '-I', str(Path(__file__).resolve()), str(Path(filename).resolve()), '--run', request['action_id']],
                          stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd, start_new_session=True, close_fds=True)
        finally:
            os.close(log_fd)
        return {'state': 'running', 'action_id': request['action_id'], 'runner_pid': child.pid}
    finally:
        os.close(fd)


def run(filename, action_id, *, native=run_native_pair, permitted=owned):
    require(isinstance(action_id, str) and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', action_id), 'invalid_pair_action_id')
    config = configuration(filename)
    saved = private_read(Path(config['journal_directory']) / (action_id + '.request'))
    require(saved.get('enrollment') == fingerprint(config) and saved.get('request', {}).get('action_id') == action_id, 'pair_runner_enrollment_changed')
    request = saved['request']
    validate_request(config['enrollment'], request)
    return native(config['journal_directory'], config['enrollment'], request, lambda: permitted(config, request))


def main():
    try:
        require(len(sys.argv) in (2, 4), 'invalid_pair_invocation')
        filename = sys.argv[1]
        if len(sys.argv) == 4:
            require(sys.argv[2] == '--run', 'invalid_pair_invocation')
            run(filename, sys.argv[3])
        else:
            config = configuration(filename)
            data = sys.stdin.buffer.read(65537)
            require(len(data) <= 65536, 'pair_request_limit')
            request = json.loads(data)
            result = inspect(config) if request == {'action': 'inspect'} else launch(filename, config, request)
            print(json.dumps(result))
    except Exception as error:
        # Native stderr, Docker definitions and host paths never cross this API.
        reason = str(error) if re.fullmatch(r'pair_[a-z_]+|invalid_pair_[a-z_]+', str(error)) else 'pair_adapter_unverified'
        print(json.dumps({'error': reason}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
