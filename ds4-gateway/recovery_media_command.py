"""Exact-container command receipts for a recovering media coordinator.

Internal protocol, not a mutation CLI or enrollment authority. A caller must
bind the original private profile, own the gateway reservation, attest native
idle before stopping, and retain its operation ID. Never infer command rejection
from runner exit or a missing acknowledgement. In-flight intent is observation
only even after its OS lease is released.
"""
import copy
import fcntl
import os
from pathlib import Path
import re
import stat

from docker_profile import digest, signature
from recovery_pair_native import private_read, private_save

UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
ID = re.compile(r'[a-f0-9]{64}')
STEPS = {f'{role}-{action}-{member}': action for role in ('llm', 'media')
         for action in ('start', 'stop') for member in (0, 1)}


def require(condition, reason):
    if not condition:
        raise ValueError('media_command_' + reason)


def runtime(container):
    state = container['State']
    require(type(state.get('Running')) is bool and
            all(state.get(k, False) is False for k in ('Paused', 'Restarting', 'Dead')),
            'runtime_unverified')
    require(all(isinstance(state.get(k), str) and state[k] for k in ('StartedAt', 'FinishedAt')),
            'epoch_unverified')
    return {'running': state['Running'], 'started_at': state['StartedAt'], 'finished_at': state['FinishedAt']}


def validate(request):
    require(isinstance(request, dict) and set(request) ==
            {'version', 'operation_id', 'step', 'machine', 'container', 'action', 'definition', 'before'} and
            type(request['version']) is int and request['version'] == 1, 'request_unverified')
    require(isinstance(request['operation_id'], str) and UUID.fullmatch(request['operation_id']) and
            isinstance(request['step'], str) and request['step'] in STEPS and STEPS[request['step']] == request['action'], 'identity_unverified')
    require(isinstance(request['container'], str) and ID.fullmatch(request['container']), 'container_unverified')
    require(isinstance(request['machine'], str) and ID.fullmatch(request['machine']), 'machine_unverified')
    definition = request['definition']
    require(isinstance(definition, dict) and set(definition) == {'Id', 'Image', 'Config', 'HostConfig', 'Mounts'} and
            definition['Id'] == request['container'], 'profile_unverified')
    require(isinstance(definition['Image'], str) and re.fullmatch(r'sha256:[a-f0-9]{64}', definition['Image']) and
            isinstance(definition['Config'], dict) and isinstance(definition['HostConfig'], dict) and
            isinstance(definition['Mounts'], list) and all(isinstance(m, dict) and isinstance(m.get('Destination'), str)
                for m in definition['Mounts']) and signature(definition) == definition, 'profile_unverified')
    before = request['before']
    require(isinstance(before, dict) and set(before) == {'running', 'started_at', 'finished_at'} and
            type(before['running']) is bool and before['running'] == (request['action'] == 'stop') and
            all(isinstance(before[k], str) and before[k] for k in ('started_at', 'finished_at')), 'initial_epoch_unverified')
    return request


def root_directory(directory):
    root = Path(directory)
    info = root.lstat()
    require(root.is_absolute() and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and
            not info.st_mode & 0o077, 'private_directory_unverified')
    return root


def record_path(root, request):
    return root / (request['operation_id'] + '-' + request['step'] + '.json')


def read_record(root, request):
    try:
        row = private_read(record_path(root, request))
    except FileNotFoundError:
        return None
    require(isinstance(row, dict) and row.get('schema') == 1 and row.get('request') == request and
            row.get('request_hash') == digest(request) and row.get('state') in ('prepared', 'intent', 'completed'),
            'saved_request_changed')
    backup = private_read(root / (request['operation_id'] + '-' + request['step'] + '.backup'))
    require(backup == {'request': request, 'request_hash': digest(request)}, 'backup_changed')
    if row['state'] == 'completed':
        require(completed(request, row.get('after')), 'completion_unverified')
    return row


def current(request, io):
    require(io.machine() == request['machine'], 'native_machine_changed')
    container = io.inspect(request['container'])
    require(signature(container) == request['definition'], 'native_profile_changed')
    return runtime(container)


def completed(request, after):
    if not isinstance(after, dict) or set(after) != {'running', 'started_at', 'finished_at'}:
        return False
    if type(after['running']) is not bool or any(not isinstance(after[k], str) or not after[k] for k in ('started_at', 'finished_at')):
        return False
    before = request['before']
    if request['action'] == 'start':
        return after.get('running') is True and isinstance(after.get('started_at'), str) and bool(after['started_at']) and after['started_at'] != before['started_at']
    return after.get('running') is False and after.get('started_at') == before['started_at'] and isinstance(after.get('finished_at'), str) and bool(after['finished_at']) and after['finished_at'] != before['finished_at']


def lease(root, request, *, create):
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_CREAT if create else 0)
    # Pin both the logical action and its physical target. Concurrent conflicting
    # requests must not write one action path under different container locks.
    names = ['action-' + request['operation_id'] + '-' + request['step'] + '.lock',
             'container-' + request['machine'] + '-' + request['container'] + '.lock']
    descriptors = []
    try:
        for name in names:
            fd = os.open(root / name, flags, 0o600)
            descriptors.append(fd)
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
                    'lease_unverified')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                release(descriptors)
                return None
        return descriptors
    except BaseException:
        release(descriptors)
        raise


def release(descriptors):
    for fd in reversed(descriptors):
        os.close(fd)


def summary(request, row, **extra):
    return {'operation_id': request['operation_id'], 'step': request['step'],
            'request_hash': digest(request), 'state': row['state'] if row else 'missing', **extra}


def status(directory, request, io):
    """Read-only observation; creates no directory, lease, record or command."""
    request = validate(copy.deepcopy(request))
    try:
        root = root_directory(directory)
    except FileNotFoundError:
        return summary(request, None, runner_active=False, outcome='unconfirmed')
    row = read_record(root, request)
    try:
        fd = lease(root, request, create=False)
    except FileNotFoundError:
        require(row is None, 'saved_lease_missing')
        return summary(request, row, runner_active=False, outcome='unconfirmed')
    if fd is None:
        return summary(request, row, runner_active=True, outcome='recorded' if row and row['state'] == 'completed' else 'unconfirmed')
    try:
        # Re-read after acquiring the lease: the previous runner may have saved
        # its result between the first read and releasing its lock.
        row = read_record(root, request)
        outcome = 'recorded' if row and row['state'] == 'completed' else 'unconfirmed'
        if row and row['state'] == 'intent' and completed(request, current(request, io)):
            outcome = 'observed'
        return summary(request, row, runner_active=False, outcome=outcome)
    finally:
        release(fd)


def run(directory, request, io, ownership):
    """Issue at most one start/stop; recover only by observing saved intent.

    io exposes machine/inspect/start/stop/idle. machine attests the enrolled
    physical identity, not an SSH alias. stop must be graceful, with no forced
    kill deadline. ownership must attest this original operation's current
    gateway reservation; the caller supplies no default approval.
    """
    request = validate(copy.deepcopy(request))
    root = root_directory(directory)
    fd = lease(root, request, create=True)
    if fd is None:
        return summary(request, read_record(root, request), runner_active=True)
    try:
        row = read_record(root, request)
        if row and row['state'] == 'completed':
            return summary(request, row, runner_active=False)
        # Every unresolved command on this exact container blocks a different
        # operation or stage. Never use a new action ID to escape uncertainty.
        for file in root.glob('*.json'):
            other = private_read(file)
            require(isinstance(other, dict) and isinstance(other.get('request'), dict), 'journal_unverified')
            other_request = validate(other['request'])
            require(record_path(root, other_request) == file, 'journal_identity_changed')
            verified = read_record(root, other_request)
            if other_request['machine'] == request['machine'] and other_request['container'] == request['container'] and file != record_path(root, request):
                require(verified['state'] == 'completed', 'other_command_unresolved')
        if row and row['state'] == 'intent':
            after = current(request, io)
            if completed(request, after):
                row = {**row, 'state': 'completed', 'after': after, 'completion_source': 'native_observation'}
                private_save(record_path(root, request), row)
            return summary(request, row, runner_active=False)
        require(ownership(request) is True, 'ownership_unavailable')
        require(current(request, io) == request['before'], 'initial_epoch_changed')
        if request['action'] == 'stop':
            require(io.idle(request['container']) is True, 'native_work_not_idle')
        if row is None:
            backup = {'request': request, 'request_hash': digest(request)}
            backup_path = root / (request['operation_id'] + '-' + request['step'] + '.backup')
            if backup_path.exists():
                require(private_read(backup_path) == backup, 'backup_changed')
            else:
                private_save(backup_path, backup)
            row = {'schema': 1, **backup, 'state': 'prepared'}
            private_save(record_path(root, request), row)
        # Check again after the durable backup; no baseline is adopted from a
        # later epoch, changed profile or newly busy native engine.
        require(current(request, io) == request['before'], 'initial_epoch_changed')
        if request['action'] == 'stop':
            require(io.idle(request['container']) is True, 'native_work_not_idle')
        require(ownership(request) is True, 'ownership_unavailable')
        row = {**row, 'state': 'intent'}
        private_save(record_path(root, request), row)
        getattr(io, request['action'])(request['container'])
        after = current(request, io)
        if completed(request, after):
            row = {**row, 'state': 'completed', 'after': after, 'completion_source': 'native_observation'}
            private_save(record_path(root, request), row)
        return summary(request, row, runner_active=False)
    finally:
        release(fd)
