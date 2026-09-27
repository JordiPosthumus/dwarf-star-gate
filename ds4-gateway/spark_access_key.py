"""Bounded new-Spark SSH key setup. Never touches models or SSH daemon settings."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import time
import uuid


def hardware_identity():
    if platform.system() != 'Linux' or platform.machine() not in ('aarch64', 'arm64'):
        return None
    machine = Path('/etc/machine-id').read_text().strip()
    output = subprocess.run(['nvidia-smi', '--query-gpu=name,uuid', '--format=csv,noheader'], capture_output=True, text=True, timeout=8, check=True).stdout
    rows = [line.split(',') for line in output.splitlines()]
    if not rows or any(len(row) != 2 or 'GB10' not in row[0] or not re.fullmatch(r'GPU-[a-fA-F0-9-]{16,80}', row[1].strip()) for row in rows):
        return None
    ids = sorted(row[1].strip() for row in rows)
    if len(set(ids)) != len(ids):
        return None
    encoded = json.dumps([hashlib.sha256(machine.encode()).hexdigest(), ids], separators=(',', ':')).encode()
    return hashlib.sha256(encoded).hexdigest()


def owned(path, *, directory=False):
    info = path.lstat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022 or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError('Existing SSH paths are not owner-controlled; preserved unchanged')


def install(request, *, home=None, identify=hardware_identity):
    if set(request) != {'operation_id', 'identity', 'public_key'} or not re.fullmatch(r'[a-f0-9]{64}', request['identity']):
        raise ValueError('Invalid key setup request')
    if str(uuid.UUID(request['operation_id'])) != request['operation_id']:
        raise ValueError('Invalid key setup identity')
    key = request['public_key']
    if not isinstance(key, str) or len(key) > 16384 or not re.fullmatch(r'(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-[\w@.-]+) [A-Za-z0-9+/]+={0,3}', key):
        raise ValueError('Invalid public key')
    base64.b64decode(key.split()[1], validate=True)
    if identify() != request['identity']:
        return {'state': 'identity_changed', 'changed': False}
    home = Path(home or Path.home())
    owned(home, directory=True)
    ssh = home / '.ssh'
    if not ssh.exists():
        ssh.mkdir(mode=0o700)
    owned(ssh, directory=True)
    journal = home
    for name in ('.local', 'share', 'star-gate', 'access', request['operation_id']):
        journal = journal / name
        if not journal.exists():
            journal.mkdir(mode=0o700)
        owned(journal, directory=True)
    lock_file = ssh / '.dsg-access.lock'
    fd = os.open(lock_file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        owned(lock_file)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'state': 'key_setup_running', 'changed': None}
        binding = {'identity': request['identity'], 'public_key_sha256': hashlib.sha256(key.encode()).hexdigest()}
        binding_file = journal / 'request.json'
        if binding_file.exists():
            owned(binding_file)
            if json.loads(binding_file.read_text()) != binding:
                raise ValueError('This operation ID already has a different key or machine identity')
        else:
            binding_fd = os.open(binding_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(binding_fd, 'w') as stream:
                json.dump(binding, stream)
                stream.flush()
                os.fsync(stream.fileno())
        target = ssh / 'authorized_keys'
        existed = target.exists()
        if existed:
            owned(target)
        before = target.read_bytes() if existed else b''
        if len(before) > 1024 * 1024:
            raise ValueError('Existing authorized_keys is too large for bounded setup')
        plain = before.decode('utf-8')
        matching = [line for line in plain.splitlines() if not line.lstrip().startswith('#') and re.search(r'(?:^|\s)' + re.escape(key) + r'(?:\s|$)', line)]
        if matching:
            unrestricted = any(line == key or line.startswith(key + ' ') for line in matching)
            return {'state': 'key_present' if unrestricted else 'existing_key_restricted', 'changed': False}
        stamp = str(time.time_ns())
        if existed:
            backup = journal / ('authorized-keys-before-' + stamp)
            backup_fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(backup_fd, 'wb') as stream:
                stream.write(before)
                stream.flush()
                os.fsync(stream.fileno())
        intent = {'identity': request['identity'], 'public_key_sha256': hashlib.sha256(key.encode()).hexdigest(),
                  'before_sha256': hashlib.sha256(before).hexdigest(), 'before_existed': existed, 'state': 'append_intent'}
        receipt = journal / ('key-' + stamp + '.json')
        receipt_fd = os.open(receipt, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(receipt_fd, 'w') as stream:
            json.dump(intent, stream)
            stream.flush()
            os.fsync(stream.fileno())
        flags = os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW if existed else os.O_RDWR | os.O_CREAT | os.O_EXCL
        key_fd = os.open(target, flags, 0o600)
        try:
            with os.fdopen(key_fd, 'r+b', closefd=False) as stream:
                if stream.read() != before:
                    raise ValueError('authorized_keys changed during setup; preserved unchanged')
            addition = (b'\n' if before and not before.endswith(b'\n') else b'') + (key + ' star-gate-access\n').encode()
            remaining = memoryview(addition)
            while remaining:
                remaining = remaining[os.write(key_fd, remaining):]
            os.fsync(key_fd)
        finally:
            os.close(key_fd)
        intent['state'] = 'appended'
        receipt.write_text(json.dumps(intent))
        return {'state': 'key_present', 'changed': True, 'backup_retained': existed}
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        result = install(json.loads(input()))
    except Exception:
        result = {'state': 'key_setup_unconfirmed', 'changed': None}
    print('DSG_ACCESS_RESULT=' + json.dumps(result))
