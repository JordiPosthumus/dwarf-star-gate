"""Native SSH I/O and exclusive durable journal for exact GLM pair recovery.

There is deliberately no standalone mutation CLI: the recovery controller must
supply its current ownership check and explicit enrollment. Native observations
contain private launch configuration and must not be exposed as public status.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import uuid

from recovery_pair import enrollment_identity, file_pins, fingerprint, observe_pair, recover_pair, require, signature

UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
MAX_JOURNAL = 4 * 1024 * 1024


def private_read(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
                and info.st_size <= MAX_JOURNAL, 'pair_private_journal_unverified')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(MAX_JOURNAL + 1)
        require(len(data) <= MAX_JOURNAL, 'pair_journal_output_limit')
        return json.loads(data)
    finally:
        os.close(fd)


def private_save(file, value):
    data = (json.dumps(value, allow_nan=False) + '\n').encode()
    require(len(data) <= MAX_JOURNAL, 'pair_journal_output_limit')
    temporary = file.with_name(file.name + '.' + str(uuid.uuid4()) + '.tmp')
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        fd = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


class PairJournal:
    """One physical-pair runner at a time, including across process restarts."""
    def __init__(self, directory, enrollment, request):
        self.root = Path(directory)
        info = self.root.lstat()
        require(self.root.is_absolute() and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                and not info.st_mode & 0o077, 'pair_private_directory_unverified')
        require(UUID.fullmatch(request.get('action_id', '')) is not None, 'invalid_pair_action_id')
        self.profile = enrollment_identity(enrollment)['profile']
        self.request = request
        self.file = self.root / (request['action_id'] + '.json')
        self.fd = None

    def __enter__(self):
        fd = os.open(self.root / 'runner.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, 'pair_lock_unverified')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError('pair_runner_already_active') from None
            files = [file for file in self.root.iterdir() if file.suffix == '.json' and UUID.fullmatch(file.stem)]
            require(len(files) < 10000 or self.file in files, 'pair_journal_full')
            for file in files:
                value = private_read(file)
                require(value.get('schema') == 1 and value.get('action_id') == file.stem, 'pair_journal_invalid')
                if file == self.file:
                    continue
                require(value.get('state') == 'completed', 'pair_other_operation_unresolved')
                require(fingerprint(value.get('initial_epochs')) != self.request['epoch'], 'pair_epoch_already_attempted')
            self.fd = fd
            return self
        except BaseException:
            os.close(fd)
            raise

    def read(self):
        require(self.fd is not None, 'pair_journal_lease_required')
        try:
            return private_read(self.file)
        except FileNotFoundError:
            return None

    def save(self, value):
        require(self.fd is not None and value['action_id'] == self.request['action_id']
                and value['enrollment'] == self.profile, 'pair_journal_lease_required')
        private_save(self.file, value)

    def __exit__(self, *args):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


REMOTE_FILES = r'''
import hashlib, os, stat
paths = {m['Source'] for m in container['Mounts'] if m['Type'] == 'bind'}
if payload['recipe_root']:
    for name in ('.env', 'start.sh', '.glm53-exl3-head.inner.sh'):
        paths.add(str(Path(payload['recipe_root']) / name))
files = {}; total = 0
for name in sorted(paths):
    file = Path(name)
    try:
        info = file.stat()
    except FileNotFoundError:
        files[name] = {'absent': True}; continue
    if stat.S_ISDIR(info.st_mode):
        continue
    if not stat.S_ISREG(info.st_mode) or info.st_size + total > 8388608:
        raise ValueError('pair_file_snapshot_limit')
    with file.open('rb') as stream:
        before = os.fstat(stream.fileno())
        data = stream.read(8388608 - total + 1)
        after = os.fstat(stream.fileno())
    total += len(data)
    if total > 8388608 or (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError('pair_file_changed_during_read')
    files[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'mode': after.st_mode & 511}
'''


class PairReader:
    """Read configured native targets before granting any recovery authority."""
    def __init__(self, binding, execute=subprocess.run):
        require(isinstance(binding, dict) and set(binding) == {'worker_id', 'model', 'port', 'context_length', 'concurrency', 'members'}, 'pair_capture_binding_unverified')
        require(isinstance(binding['worker_id'], str) and re.fullmatch(r'[A-Za-z0-9][\w-]{0,63}', binding['worker_id'])
                and isinstance(binding['model'], str) and 0 < len(binding['model']) <= 256, 'pair_capture_binding_unverified')
        require(all(type(binding[k]) is int and binding[k] > 0 for k in ('port', 'context_length', 'concurrency'))
                and binding['port'] <= 65535, 'pair_capture_binding_unverified')
        members = binding['members']
        require(isinstance(members, list) and len(members) == 2, 'pair_capture_binding_unverified')
        for m in members:
            require(isinstance(m, dict) and set(m) == {'ssh', 'container', 'recipe_root'}
                    and isinstance(m['ssh'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*', m['ssh'])
                    and isinstance(m['container'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', m['container'])
                    and (m['recipe_root'] is None or isinstance(m['recipe_root'], str) and m['recipe_root'].startswith('/')
                         and '\x00' not in m['recipe_root'] and '..' not in Path(m['recipe_root']).parts), 'pair_capture_binding_unverified')
        require(members[0]['recipe_root'] is not None and members[0]['ssh'] != members[1]['ssh'], 'pair_capture_binding_unverified')
        self.enrollment = binding
        self.execute = execute

    def remote(self, host, args, timeout=120):
        require(host in [m['ssh'] for m in self.enrollment['members']], 'pair_host_not_enrolled')
        result = self.execute(['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                               '-o', 'ConnectTimeout=8', '--', host, ' '.join(shlex.quote(str(arg)) for arg in args)],
                              capture_output=True, timeout=timeout, check=True)
        require(len(result.stdout) + len(result.stderr) <= 4 * 1024 * 1024, 'pair_remote_output_limit')
        return result.stdout

    def inspect_member(self, member):
        # Reuse the Docker helper's native PID-namespace listener ownership and
        # timestamped CUDA evidence. It is executed as a module, never its CLI.
        source = Path(__file__).with_name('recovery-docker.py').read_bytes()
        program = "import base64,json,sys\nfrom pathlib import Path\nnamespace={'__name__':'pair_reader'}\n"
        program += "exec(base64.b64decode(" + repr(base64.b64encode(source).decode()) + "),namespace)\n"
        program += "payload=json.loads(sys.argv[1]);initial=json.loads(namespace['run'](['docker','inspect',payload['container']]))[0]\n"
        program += "service=namespace['inspect']({'container':initial['Id'],'port':payload['port']})\n"
        program += "container=json.loads(namespace['run'](['docker','inspect',payload['container']]))[0]\n"
        program += "epoch=namespace['fingerprint']([container['Id'],container['State'].get('StartedAt'),container['State'].get('FinishedAt')])\n"
        program += "if service['stopped_epoch']!=epoch:raise ValueError('pair_changed_during_inspection')\n"
        program += REMOTE_FILES
        program += "\nprint(json.dumps({'machine':service['machine'],'container':container,'files':files,'listener_owned':service['listener'],'started_at':service['started_at'],'fault':service['fault']}))\n"
        payload = {'container': member['container'], 'recipe_root': member['recipe_root'], 'port': self.enrollment['port']}
        return json.loads(self.remote(member['ssh'], ['python3', '-I', '-c', program, json.dumps(payload)]))

    def observe(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(self.inspect_member, self.enrollment['members']))


class RemotePair(PairReader):
    def __init__(self, enrollment, execute=subprocess.run):
        enrollment_identity(enrollment)
        self.enrollment = enrollment
        self.execute = execute

    def idle(self):
        """Require explicit native idle counters while the pinned head is up."""
        try:
            current = observe_pair(self.enrollment, self.observe())
            if current['members'][0] == 'stopped':
                return True  # Our exact stopped head cannot admit direct work.
            program = """import json,math,re,sys,urllib.request
r=urllib.request.urlopen('http://127.0.0.1:'+sys.argv[1]+'/metrics',timeout=10)
data=r.read(1048577)
if len(data)>1048576:raise ValueError('metrics_limit')
gauges={name:[] for name in ('num_requests_running','num_requests_waiting')}
for line in data.decode().splitlines():
    m=re.fullmatch(r'vllm:(num_requests_running|num_requests_waiting)(?:\\{[^}]*\\})?\\s+([^\\s]+)(?:\\s+[^\\s]+)?',line)
    if m:gauges[m[1]].append(float(m[2]))
print(json.dumps({'idle':all(values and all(math.isfinite(v) and v==0 for v in values) for values in gauges.values())}))
"""
            head = self.enrollment['members'][0]
            result = json.loads(self.remote(head['ssh'], ['python3', '-I', '-c', program, str(self.enrollment['port'])], timeout=20))
            return result.get('idle') is True
        except Exception:
            return False

    def command(self, action, host, container):
        require(action in ('start', 'stop') and any(m['ssh'] == host and m['container'] == container
                for m in self.enrollment['members']), 'pair_command_not_enrolled')
        self.remote(host, ['docker', action, *(['-t', '120'] if action == 'stop' else []), container], timeout=150)

    def stop(self, host, container):
        self.command('stop', host, container)

    def start(self, host, container):
        self.command('start', host, container)


def run_native_pair(directory, enrollment, request, ownership):
    remote = RemotePair(enrollment)
    with PairJournal(directory, enrollment, request) as journal:
        return recover_pair(enrollment, request, read_journal=journal.read, save_journal=journal.save,
                            observe=remote.observe, stop=remote.stop, start=remote.start,
                            ownership=lambda: ownership() is True and remote.idle())


def capture_pair(binding, reader_factory=PairReader):
    """Capture fresh pins, then independently re-observe exact IDs without mutation."""
    reader = reader_factory(binding)
    before = reader.observe()
    require(isinstance(before, list) and len(before) == 2, 'pair_observation_incomplete')
    members = [{**target, 'container': row['container']['Id'], 'machine': row['machine'],
                'definition': signature(row['container']), 'files': file_pins(row['files'])}
               for target, row in zip(binding['members'], before)]
    enrollment = {**binding, 'schema': 1, 'kind': 'glm53-docker-pair', 'members': members}
    initial = observe_pair(enrollment, before)
    # The second observation addresses immutable container IDs, not reusable names.
    reader.enrollment = enrollment
    after = reader.observe()
    current = observe_pair(enrollment, after)
    require(initial['epoch'] == current['epoch'], 'pair_changed_during_capture')
    require(current['active'] and current['listener'] and current['fault'] is None, 'pair_capture_requires_healthy_pair')
    return {'schema': 1, 'enrollment': enrollment, 'before': before, 'after': after,
            'identity': enrollment_identity(enrollment), 'epoch': current['epoch']}
