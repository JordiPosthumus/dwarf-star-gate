"""Fixed private media-plan transport for exact native command journals."""
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recovery_media_command as command
from docker_profile import digest, signature
from media_maintenance import main as maintenance
from recovery_pair_native import private_read, private_save
from serving_qualification import native_load
from media_recipe_contract import SUPPORTED as RECIPE_FIELDS


def require(value, reason):
    if not value:
        raise ValueError('media_bridge_' + reason)


def plan_at(folder):
    root = command.root_directory(folder)
    plan = private_read(root / 'plan.json')
    require(plan.get('command_journal_version') == 1 and command.UUID.fullmatch(plan.get('operation_id', '')) and
            root.name == plan['operation_id'], 'plan_unverified')
    return root, plan


def targets(plan):
    pair = plan.get('llm_pair')
    result = {}
    if pair:
        require(len(pair.get('members', [])) == 2, 'pair_unverified')
        for member, row in enumerate(pair['members']):
            result['llm-' + str(member)] = {'host': row['ssh'], 'container': row['container'], 'kind': 'llm', 'member': member}
    else:
        result['llm-0'] = {'host': plan['host'], 'container': plan['llm_container'], 'kind': 'llm', 'member': 0}
    lanes = plan.get('media_lanes')
    if lanes is not None:
        require(pair and [l.get('member') for l in lanes] == [0, 1], 'lanes_unverified')
        media = lanes
    else:
        media = [{'host': plan['host'], 'member': pair.get('media_member', 0) if pair else 0, 'engine': plan['engine']}]
    for lane in media:
        member, engine = lane['member'], lane['engine']
        require(member in (0, 1) and engine.get('kind') in ('comfyui', 'ace-step') and
                type(engine.get('port')) is int and 1 <= engine['port'] <= 65535, 'engine_unverified')
        require(lane['host'] == result['llm-' + str(member)]['host'], 'member_host_changed')
        result['media-' + str(member)] = {'host': lane['host'], 'container': engine['container'],
                                        'kind': engine['kind'], 'port': engine['port'], 'member': member, 'image': engine['image']}
    for target in result.values():
        require(isinstance(target['host'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*', target['host']) and
                isinstance(target['container'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', target['container']), 'target_unverified')
    return result


class Remote:
    def __init__(self, host, execute=subprocess.run):
        self.host, self.execute = host, execute

    def call(self, args, timeout=30):
        reply = self.execute(['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                              '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
                              '--', self.host, ' '.join(shlex.quote(str(v)) for v in args)],
                             capture_output=True, check=True, timeout=timeout)
        require(len(reply.stdout) <= 8 * 1024 * 1024, 'native_output_limit')
        return reply.stdout

    def machine(self):
        code = '''import hashlib,json,re,subprocess
from pathlib import Path
gpus=sorted(subprocess.check_output(['nvidia-smi','--query-gpu=uuid','--format=csv,noheader'],timeout=20).decode().strip().splitlines())
if not 1<=len(gpus)<=16 or len(gpus)!=len(set(gpus)) or any(not re.fullmatch(r'GPU-[a-fA-F0-9-]{16,80}',v) for v in gpus):raise ValueError('GPU identity unavailable')
identity={'scheme':'linux-machine-id-and-gpu-uuid-v1','os_machine_id_sha256':hashlib.sha256(Path('/etc/machine-id').read_bytes()).hexdigest(),'gpu_uuids':gpus}
print(json.dumps({'machine':hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':')).encode()).hexdigest()}))'''
        value = json.loads(self.call(['python3', '-I', '-c', code]))
        require(isinstance(value.get('machine'), str) and command.ID.fullmatch(value['machine']), 'machine_unverified')
        return value['machine']

    def inspect(self, cid):
        value = json.loads(self.call(['docker', 'inspect', cid]))
        require(isinstance(value, list) and len(value) == 1, 'container_unverified')
        return value[0]

    def start(self, cid):
        self.call(['docker', 'start', cid], timeout=None)

    def recipe_fields(self, cid, image):
        code = Path(__file__).with_name('media_recipe_contract.py').read_text()
        return json.loads(self.call(['python3', '-I', '-c', code, cid, image], timeout=300))

    def stop(self, cid):
        # Graceful stop only. A slow or disconnected native command remains
        # under its saved intent; no forced deadline or second command follows.
        self.call(['docker', 'stop', '-t', '-1', cid], timeout=None)

    def media_idle(self, kind, port):
        code = '''import json,sys,urllib.request
kind,port=sys.argv[1:]
route='/v1/stats' if kind=='ace-step' else '/queue'
with urllib.request.urlopen('http://127.0.0.1:'+port+route,timeout=10) as r:data=json.load(r)
if kind=='ace-step':
 d=data.get('data',{});j=d.get('jobs',{});v=[j.get('queued'),j.get('running'),d.get('queue_size')]
 idle=all(type(n) is int and n==0 for n in v)
else:
 v=[data.get('queue_running'),data.get('queue_pending')];idle=all(isinstance(x,list) and len(x)==0 for x in v)
print(json.dumps({'idle':idle}))'''
        return json.loads(self.call(['python3', '-I', '-c', code, kind, str(port)])).get('idle') is True

    def files(self, container, recipe_root):
        payload = {'paths': [m['Source'] for m in container['Mounts'] if m['Type'] == 'bind'], 'recipe': recipe_root}
        code = '''import hashlib,json,sys
from pathlib import Path
p=json.loads(sys.argv[1]);paths=set(p['paths'])
if p['recipe']:
 for name in ['.env','start.sh','.glm53-exl3-head.inner.sh']:paths.add(str(Path(p['recipe'])/name))
result={};total=0
for name in sorted(paths):
 f=Path(name)
 if f.is_file():
  before=f.stat();data=f.read_bytes();after=f.stat();total+=len(data)
  if total>8388608 or (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('File snapshot changed')
  result[name]={'sha256':hashlib.sha256(data).hexdigest(),'mode':after.st_mode&511}
 elif name not in p['paths']:result[name]={'absent':True}
print(json.dumps(result))'''
        return json.loads(self.call(['python3', '-I', '-c', code, json.dumps(payload)]))


def load_bindings(root, plan):
    saved = private_read(root / 'media-command-bindings.json')
    require(saved.get('schema') == 1 and saved.get('plan_hash') == digest(plan) and saved.get('targets') == targets(plan), 'plan_binding_changed')
    require(set(saved.get('machines', {})) == {t['host'] for t in saved['targets'].values()} and
            all(isinstance(v, str) and command.ID.fullmatch(v) for v in saved['machines'].values()), 'machine_binding_unverified')
    return saved


def transport_lease(root, name):
    fd = os.open(root / name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, 'lease_unverified')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            return None
        return fd
    except BaseException:
        os.close(fd)
        raise


def prepare(folder, remote_factory=Remote):
    root, plan = plan_at(folder)
    fd = transport_lease(root, 'media-command-prepare.lock')
    require(fd is not None, 'preparation_active')
    try:
        directory = root / 'commands'
        directory.mkdir(mode=0o700, exist_ok=True)
        command.root_directory(directory)
        file = root / 'media-command-bindings.json'
        if file.exists():
            load_bindings(root, plan)
        else:
            selected = targets(plan)
            machines = {host: remote_factory(host).machine() for host in sorted({t['host'] for t in selected.values()})}
            require(all(isinstance(v, str) and command.ID.fullmatch(v) for v in machines.values()), 'machine_unverified')
            require(len(machines) == len(set(machines.values())), 'physical_members_not_distinct')
            private_save(file, {'schema': 1, 'plan_hash': digest(plan), 'targets': selected, 'machines': machines})
        required = plan.get('required_recipe_fields', [])
        require(isinstance(required, list) and len(required) == len(set(required)) and
                all(k in RECIPE_FIELDS for k in required), 'recipe_requirements_unverified')
        if required:
            bindings = load_bindings(root, plan)
            proofs = {}
            try:
                for key, target in bindings['targets'].items():
                    if not key.startswith('media-'):
                        continue
                    require(target['kind'] == 'ace-step', 'recipe_engine_changed')
                    remote = remote_factory(target['host'])
                    require(remote.machine() == bindings['machines'][target['host']], 'recipe_machine_changed')
                    proof = remote.recipe_fields(target['container'], target['image'])
                    require(proof.get('state') == 'verified' and proof.get('container') == target['container'] and
                            proof.get('image') == target['image'] and proof.get('supported') == RECIPE_FIELDS and
                            proof.get('container_state_unchanged') is True, 'recipe_fields_unverified')
                    proofs[key] = proof
            except Exception:
                return {'state': 'recipe_unverified', 'operation_id': plan['operation_id'],
                        'required_recipe_fields': required, 'native_mutation': False}
            expected = {'plan_hash': digest(plan), 'bindings_hash': digest(bindings), 'proofs': proofs}
            proof_path = root / 'media-recipe-contracts.json'
            if proof_path.exists():
                require(private_read(proof_path) == expected, 'recipe_proof_changed')
            else:
                private_save(proof_path, expected)
        return {'state': 'prepared', 'operation_id': plan['operation_id']}
    finally:
        os.close(fd)


def original(root, plan, role, member):
    if role == 'llm' and plan.get('llm_pair'):
        saved = private_read(root / 'llm-pair-before.json')
        require(saved.get('members') == plan['llm_pair']['members'] and len(saved.get('containers', [])) == 2, 'pair_snapshot_changed')
        return saved['containers'][member], {'containers': saved, 'files': private_read(root / 'llm-pair-files-before.json')}
    if role == 'media' and plan.get('media_lanes'):
        saved = private_read(root / 'parallel-engines-before.json')
        matches = [r for r in saved.get('members', []) if r.get('member') == member]
        require(len(matches) == 1, 'engine_snapshot_unverified')
        return matches[0]['container'], saved
    saved = private_read(root / 'containers-before.json')
    require(role in saved, 'container_snapshot_unverified')
    return saved[role], saved


def prior_result(root, plan, bindings, role, action, member):
    """Use the original journal's observed epoch, never a fresh baseline."""
    step = f'{role}-{action}-{member}'
    before, snapshot = original(root, plan, role, member)
    target = bindings['targets'][f'{role}-{member}']
    saved = private_read(root / 'commands' / (step + '.request'))
    pins = {'plan_hash': digest(plan), 'bindings_hash': digest(bindings),
            'snapshot_hash': digest(snapshot), 'step': step, 'container': before['Id']}
    require(all(saved.get(k) == v for k, v in pins.items()), 'prior_binding_changed')
    request = command.validate(saved['request'])
    require(request['operation_id'] == plan['operation_id'] and request['step'] == step and
            request['container'] == before['Id'] and request['machine'] == bindings['machines'][target['host']] and
            request['definition'] == signature(before) and request['before'] == command.runtime(before), 'prior_identity_changed')
    row = command.read_record(root / 'commands', request)
    require(row is not None and row['state'] == 'completed', 'prior_command_unconfirmed')
    return row['after']


class BoundIO:
    def __init__(self, root, plan, target, bindings, remote_factory):
        self.root, self.plan, self.target, self.bindings, self.remote_factory = root, plan, target, bindings, remote_factory
        self.remote = remote_factory(target['host'])

    def machine(self):
        return self.remote.machine()

    def inspect(self, cid):
        current = self.remote.inspect(cid)
        if self.target['kind'] == 'ace-step' and self.plan.get('required_recipe_fields') and current['State']['Running'] is False:
            saved = private_read(self.root / 'media-recipe-contracts.json')
            require(saved.get('plan_hash') == digest(self.plan) and saved.get('bindings_hash') == digest(self.bindings),
                    'recipe_proof_binding_changed')
            expected = saved.get('proofs', {}).get('media-' + str(self.target['member']))
            require(expected is not None and self.remote.recipe_fields(cid, self.target['image']) == expected,
                    'recipe_source_changed')
        if self.target['kind'] == 'llm' and self.plan.get('llm_pair'):
            member = self.target['member']
            saved = private_read(self.root / 'llm-pair-files-before.json')
            require(isinstance(saved.get('files'), list) and len(saved['files']) == 2, 'pair_file_snapshot_unverified')
            pins = {name: {k:v for k,v in value.items() if k != 'data'} for name,value in saved['files'][member].items()}
            require(self.remote.files(current, self.plan['llm_pair']['members'][member].get('recipe_root')) == pins, 'pair_files_changed')
        return current

    def start(self, cid):
        return self.remote.start(cid)

    def stop(self, cid):
        return self.remote.stop(cid)

    def idle(self, cid):
        if self.target['kind'] != 'llm':
            return self.remote.media_idle(self.target['kind'], self.target['port'])
        if self.plan.get('llm_pair') and self.target['member'] == 1:
            head = self.bindings['targets']['llm-0']
            remote = self.remote_factory(head['host'])
            require(remote.machine() == self.bindings['machines'][head['host']], 'head_machine_changed')
            before, _ = original(self.root, self.plan, 'llm', 0)
            current = remote.inspect(before['Id'])
            require(signature(current) == signature(before), 'head_profile_changed')
            # Like paired recovery, an exactly stopped head cannot admit direct
            # distributed LLM work. A still-running head needs native idle proof.
            if command.runtime(current)['running'] is False:
                require(command.runtime(current) == prior_result(self.root, self.plan, self.bindings, 'llm', 'stop', 0),
                        'head_epoch_changed')
                return True
        url = self.plan['recovery']['url'].removesuffix('/').removesuffix('/v1') + '/metrics'
        with urllib.request.urlopen(url, timeout=10) as response:
            load = native_load(response.read(1048576))
        return load['num_requests_running'] == load['num_requests_waiting'] == 0


def _invoke(folder, mode, step, cid, *, remote_factory=Remote, maintain=maintenance):
    require(mode in ('run', 'status') and step in command.STEPS and command.ID.fullmatch(cid), 'invocation_unverified')
    root, plan = plan_at(folder)
    bindings = load_bindings(root, plan)
    role, action, member_text = step.split('-')
    member = int(member_text)
    target = bindings['targets'].get(role + '-' + member_text)
    require(target is not None, 'member_not_enrolled')
    before, snapshot = original(root, plan, role, member)
    require(before['Id'] == cid and (role == 'llm' or cid == target['container'] and before['Image'] == target['image']), 'container_binding_changed')
    directory = command.root_directory(root / 'commands')
    file = directory / (step + '.request')
    io = BoundIO(root, plan, target, bindings, remote_factory)
    pins = {'plan_hash': digest(plan), 'bindings_hash': digest(bindings), 'snapshot_hash': digest(snapshot), 'step': step, 'container': cid}
    try:
        saved = private_read(file)
    except FileNotFoundError:
        saved = None
    if saved is None:
        if mode == 'status':
            return {'state': 'missing', 'operation_id': plan['operation_id'], 'step': step, 'outcome': 'unconfirmed'}
        # A vanished transport request must not turn an existing intent into a
        # claim of non-execution. Broken symlinks also count as prior artifacts.
        stem = plan['operation_id'] + '-' + step
        require(not any(os.path.lexists(directory / (stem + suffix)) for suffix in ('.json', '.backup')),
                'request_missing_with_prior_journal')
        try:
            require(maintain(root, 'transition' if action == 'stop' and role == 'llm' or action == 'start' and role == 'media' else 'owned').get('owned') is True, 'ownership_unavailable')
            require(io.machine() == bindings['machines'][target['host']], 'machine_changed')
            current = io.inspect(cid)
            require(signature(current) == signature(before), 'original_profile_changed')
            epoch = command.runtime(before) if (role, action) in (('llm', 'stop'), ('media', 'start')) else \
                prior_result(root, plan, bindings, role, 'stop' if action == 'start' else 'start', member)
            require(command.runtime(current) == epoch, 'original_epoch_changed')
            request = {'version': 1, 'operation_id': plan['operation_id'], 'step': step, 'machine': bindings['machines'][target['host']],
                       'container': cid, 'action': action, 'definition': signature(before), 'before': epoch}
            command.validate(request)
        except Exception:
            # Only this invocation's preflight is known not to have dispatched.
            return {'state': 'refused', 'operation_id': plan['operation_id'], 'step': step, 'command_issued': False}
        saved = {**pins, 'request': request}
        private_save(file, saved)
    require(all(saved.get(k) == v for k, v in pins.items()) and saved.get('request', {}).get('definition') == signature(before), 'saved_binding_changed')
    request = command.validate(saved['request'])
    require(request['operation_id'] == plan['operation_id'] and request['step'] == step and request['container'] == cid and
            request['machine'] == bindings['machines'][target['host']], 'saved_identity_changed')
    if mode == 'status':
        return command.status(directory, request, io)
    try:
        return command.run(directory, request, io, lambda _:maintain(root, 'transition' if action == 'stop' and role == 'llm' or action == 'start' and role == 'media' else 'owned').get('owned') is True)
    except Exception:
        row = command.read_record(directory, request)
        if row is None or row['state'] == 'prepared':
            return {'state': 'refused', 'operation_id': plan['operation_id'], 'step': step, 'command_issued': False}
        # Once intent is durable, connection loss or an adapter exception is
        # uncertainty. Its original journal must be observed, never replaced.
        return command.summary(request, row, outcome='unconfirmed')


def invoke(folder, mode, step, cid, *, remote_factory=Remote, maintain=maintenance):
    require(mode in ('run', 'status') and step in command.STEPS and command.ID.fullmatch(cid), 'invocation_unverified')
    if mode == 'status':
        return _invoke(folder, mode, step, cid, remote_factory=remote_factory, maintain=maintain)
    root, plan = plan_at(folder)
    fd = transport_lease(root, 'media-command-' + step + '.lock')
    if fd is None:
        return {'state': 'transport_busy', 'operation_id': plan['operation_id'], 'step': step}
    try:
        return _invoke(folder, mode, step, cid, remote_factory=remote_factory, maintain=maintain)
    finally:
        os.close(fd)


def main():
    try:
        if len(sys.argv) == 3 and sys.argv[2] == 'prepare':
            result = prepare(sys.argv[1])
        else:
            require(len(sys.argv) == 5, 'invocation_unverified')
            result = invoke(*sys.argv[1:])
        print(json.dumps(result))
        return 0
    except Exception:
        print(json.dumps({'error': 'media_command_bridge_unavailable'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
