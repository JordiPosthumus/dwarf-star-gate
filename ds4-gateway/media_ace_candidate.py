"""Retain an exact stopped ACE installation while preparing an API-field upgrade.

Internal primitive, not a mutation CLI or qualification/promotion authority.
The owning coordinator must supply current authorization and host ownership.
An uncertain command is never repeated. No start, stop, rename or removal occurs.
Mounted model/cache/output data stays on the original bind mounts; the retained
container snapshot covers its writable filesystem, not those mounted files.
"""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from datetime import datetime, timezone

from docker_profile import Docker, digest, signature, require_retention
from recovery_pair_native import private_read, private_save
from recovery_media_command import runtime, root_directory
from media_recipe_contract import inspect_recipe, SUPPORTED

UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
HEX = re.compile(r'[a-f0-9]{64}')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}')
SOURCES = ('apply-recipe-fields.py', 'verify-api-fields.py')
DEFAULT_SOURCE = Path(__file__).resolve().parent.parent / 'examples/spark-build/ace-step'
DELTA = 'Separate image with explicit ACE sampler/DCW API forwarding, per-audio generation-parameter receipts and build witness; original container, image, runtime settings and bind mounts retained. No start, stop, rename, removal or enrollment.'


def require(value, reason):
    if not value:
        raise ValueError('ace_candidate_' + reason)


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sources(root=DEFAULT_SOURCE):
    result = {}
    for name in SOURCES:
        p = Path(root) / name
        require(p.is_file() and not p.is_symlink(), 'source_unverified')
        data = p.read_bytes()
        require(len(data) < 1024 * 1024, 'source_size')
        result[name] = data
    return result


def validate(request):
    require(isinstance(request, dict) and set(request) == {'version', 'operation_id', 'machine', 'before', 'epoch', 'source_sha256'} and
            type(request['version']) is int and request['version'] == 1, 'request_unverified')
    require(isinstance(request['operation_id'], str) and UUID.fullmatch(request['operation_id']) and
            isinstance(request['machine'], str) and HEX.fullmatch(request['machine']), 'identity_unverified')
    before = request['before']
    require(isinstance(before, dict) and set(before) == {'Id', 'Image', 'Config', 'HostConfig', 'Mounts'} and
            HEX.fullmatch(before['Id']) and IMAGE.fullmatch(before['Image']) and signature(before) == before, 'profile_unverified')
    require_retention(before)
    cfg = before['Config']
    require(cfg.get('WorkingDir') == '/opt/ace-step' and 'acestep.api_server' in (cfg.get('Cmd') or []), 'engine_unverified')
    require(request['epoch'] == runtime({'State': {'Running': False, 'StartedAt': request['epoch'].get('started_at'),
            'FinishedAt': request['epoch'].get('finished_at')}}), 'epoch_unverified')
    require(set(request['source_sha256']) == set(SOURCES) and all(isinstance(v, str) and HEX.fullmatch(v)
            for v in request['source_sha256'].values()), 'source_unverified')
    return request


def check_original(request, io):
    require(io.machine() == request['machine'], 'machine_changed')
    current = io.inspect(request['before']['Id'])
    require(current is not None and signature(current) == request['before'] and
            runtime(current) == request['epoch'], 'original_changed')
    # Config/HostConfig alone cannot reproduce extra network attachments or
    # explicit aliases/static addresses. Refuse these instead of losing them.
    require(current['HostConfig'].get('NetworkMode', 'default') in ('default', 'bridge', 'host', 'none'),
            'network_retention_unverified')
    networks = current.get('NetworkSettings', {}).get('Networks', {})
    require(isinstance(networks, dict) and len(networks) <= 1 and
            all(name in ('bridge', 'host', 'none') and not any(values.get(k) for k in ('IPAMConfig', 'Links', 'Aliases'))
                for name, values in networks.items()), 'network_retention_unverified')
    return current


def candidate_signature(request, cid, image):
    expected = copy.deepcopy(request['before'])
    expected.update(Id=cid, Image=image)
    expected['Config']['Image'] = image
    return expected


def read_record(root, request):
    folder = root / request['operation_id']
    if not folder.exists():
        return None
    root_directory(folder)
    backup = private_read(folder / 'original.json')
    require(set(backup) == {'request', 'request_hash', 'created_at', 'delta'} and
            backup['request'] == request and backup['request_hash'] == digest(request) and
            backup['delta'] == DELTA and isinstance(backup['created_at'], str) and
            datetime.fromisoformat(backup['created_at']).utcoffset() == timezone.utc.utcoffset(None), 'backup_changed')
    row = private_read(folder / 'candidate.json')
    require(row.get('request_hash') == digest(request) and row.get('state') in
            ('prepared', 'snapshot_intent', 'snapshot_acknowledged', 'build_intent', 'build_acknowledged',
             'create_intent', 'create_acknowledged', 'prepared_stopped'), 'record_changed')
    return row


def observe(directory, request, io):
    """Read only; observing does not grant permission or create missing files."""
    validate(request)
    root = root_directory(directory)
    row = read_record(root, request)
    result = {'operation_id': request['operation_id'], 'request_hash': digest(request),
              'state': 'missing' if row is None else 'requires_reconciliation',
              'stage': row['state'] if row else None,
              'stage_at': row.get('at') if row else None,
              'scope': 'Candidate preparation only. No native audio qualification, promotion or enrollment.'}
    if row is None:
        return result
    if row['state'] != 'prepared_stopped':
        return result
    check_original(request, io)
    base, built = io.image(row['snapshot_image']), io.image(row['candidate_image'])
    require(base is not None and built is not None and base['Id'] == row['snapshot_image'] and
            built['Id'] == row['candidate_image'] and base.get('RootFS', {}).get('Layers') and
            built.get('RootFS', {}).get('Layers', [])[:len(base['RootFS']['Layers'])] == base['RootFS']['Layers'],
            'retained_image_changed')
    current = io.inspect(row['candidate_container'])
    require(current is not None and signature(current) == candidate_signature(request, row['candidate_container'], row['candidate_image']) and
            runtime(current) == row['candidate_epoch'] and not row['candidate_epoch']['running'], 'candidate_changed')
    proof = io.recipe_fields(row['candidate_container'], row['candidate_image'])
    require(proof == row['recipe_contract'], 'candidate_source_changed')
    return {**result, 'state': 'prepared_stopped', 'container': row['candidate_container'],
            'image': row['candidate_image'], 'snapshot_image': row['snapshot_image'],
            'recipe_contract': proof, 'original_preserved': True}


def prepare(directory, request, io, authorize, source_root=DEFAULT_SOURCE):
    """One preparation attempt under OS leases and current coordinator authority."""
    request = copy.deepcopy(validate(request))
    root = root_directory(directory)
    descriptors = []
    try:
        for name in ('action-' + request['operation_id'], 'container-' + request['machine'] + '-' + request['before']['Id']):
            fd = os.open(root / (name + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            descriptors.append(fd)
            st = os.fstat(fd)
            require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o077, 'lock_unverified')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        prior = read_record(root, request)
        if prior is not None:
            return observe(root, request, io)  # Never reissue snapshot/build/create.
        for folder in root.iterdir():
            if UUID.fullmatch(folder.name):
                root_directory(folder)
                other = private_read(folder / 'original.json')['request']
                require(other['machine'] != request['machine'] or other['before']['Id'] != request['before']['Id'],
                        'original_already_has_candidate_attempt')
        payload = sources(source_root)
        require({k: hashlib.sha256(v).hexdigest() for k, v in payload.items()} == request['source_sha256'], 'source_changed')
        def permitted():
            require(authorize(copy.deepcopy(request)) is True, 'ownership_or_permission_missing')
            return check_original(request, io)
        permitted()
        # The operation owns these names. Never overwrite an unrelated image tag
        # or container, even if its current contents happen to look compatible.
        snapshot_tag = 'stargate-ace-snapshot:' + request['operation_id']
        candidate_tag = 'stargate-ace-candidate:' + request['operation_id']
        candidate_name = 'stargate-ace-candidate-' + request['operation_id']
        require(io.image(snapshot_tag) is None and io.image(candidate_tag) is None and
                io.inspect(candidate_name) is None, 'candidate_name_in_use')
        folder = root / request['operation_id']
        folder.mkdir(mode=0o700)
        sync_directory(root)
        private_save(folder / 'original.json', {'request': request, 'request_hash': digest(request),
                     'created_at': datetime.now(timezone.utc).isoformat(), 'delta': DELTA})
        row = {'request_hash': digest(request), 'state': 'prepared'}
        def save(state, **values):
            row.update(state=state, at=datetime.now(timezone.utc).isoformat(), **values)
            private_save(folder / 'candidate.json', row)
        save('prepared')
        context = folder / 'context'
        context.mkdir(mode=0o700)
        for name, data in payload.items():
            with (context / name).open('xb') as f:
                os.chmod(f.name, 0o600);f.write(data);f.flush();os.fsync(f.fileno())
        # No package installation, model access, GPU operation or networked RUN.
        dockerfile = (f'FROM {snapshot_tag}\n'
                      'COPY apply-recipe-fields.py verify-api-fields.py /opt/stargate/\n'
                      'RUN ["python", "/opt/stargate/apply-recipe-fields.py"]\n'
                      'RUN ["/bin/sh", "-c", "python /opt/stargate/verify-api-fields.py > /opt/stargate/recipe-fields-verification.json"]\n')
        with (context / 'Dockerfile').open('x') as f:
            os.chmod(f.name, 0o600);f.write(dockerfile);f.flush();os.fsync(f.fileno())
        sync_directory(context)
        context_hashes = {**request['source_sha256'], 'Dockerfile': hashlib.sha256(dockerfile.encode()).hexdigest()}
        def check_context():
            require(set(p.name for p in context.iterdir()) == set(context_hashes) and
                    all((context/name).is_file() and not (context/name).is_symlink() and
                        hashlib.sha256((context/name).read_bytes()).hexdigest() == expected
                        for name, expected in context_hashes.items()), 'build_context_changed')
        check_context()
        permitted();save('snapshot_intent')
        snapshot = io.snapshot(request['before']['Id'], snapshot_tag)
        require(isinstance(snapshot, str) and IMAGE.fullmatch(snapshot), 'snapshot_acknowledgement_unverified')
        save('snapshot_acknowledged', snapshot_image=snapshot)
        base = io.image(snapshot)
        require(base is not None and base['Id'] == snapshot and io.image(snapshot_tag)['Id'] == snapshot and
                base.get('RootFS', {}).get('Layers') and not base.get('Config', {}).get('OnBuild'), 'snapshot_unverified')
        check_context();permitted();save('build_intent', context_sha256=context_hashes)
        image = io.build(context, candidate_tag)
        require(isinstance(image, str) and IMAGE.fullmatch(image), 'build_acknowledgement_unverified')
        save('build_acknowledged', candidate_image=image)
        check_context()
        built = io.image(image)
        layers = base['RootFS']['Layers']
        require(built is not None and built['Id'] == image and io.image(candidate_tag)['Id'] == image and
                built.get('RootFS', {}).get('Layers', [])[:len(layers)] == layers, 'candidate_base_changed')
        # Pass the full captured runtime configuration. The image's own defaults
        # cannot silently substitute model, LM, flags, limits or environment.
        body = copy.deepcopy(request['before']['Config'])
        body.update(Image=image, HostConfig=copy.deepcopy(request['before']['HostConfig']))
        permitted();save('create_intent')
        created = io.create(candidate_name, body)
        cid = created.get('Id')
        require(isinstance(cid, str) and HEX.fullmatch(cid), 'create_acknowledgement_unverified')
        save('create_acknowledged', candidate_container=cid)
        current = io.inspect(cid)
        require(current is not None and current.get('Name') == '/' + candidate_name and
                signature(current) == candidate_signature(request, cid, image) and not runtime(current)['running'], 'candidate_settings_changed')
        proof = io.recipe_fields(cid, image)
        require(proof.get('state') == 'verified' and proof.get('container') == cid and proof.get('image') == image and
                proof.get('container_state_unchanged') is True and proof.get('supported') == SUPPORTED, 'candidate_recipe_unverified')
        permitted()
        save('prepared_stopped', candidate_epoch=runtime(current), recipe_contract=proof)
        return observe(root, request, io)
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


class NativeIO:
    """Fixed local Docker operations; coordinator supplies the native host binding."""
    def __init__(self, machine, docker=None):
        self.machine = machine
        self.docker = docker or Docker()
        require(isinstance(self.docker.filename, str) and Path(self.docker.filename).is_absolute(), 'docker_endpoint_unverified')

    def cli(self, *args):
        # Docker API inspection and CLI preparation must use the same daemon;
        # an inherited remote context must not redirect a snapshot or build.
        return ['docker', '--host', 'unix://' + self.docker.filename, *args]

    def environment(self):
        return {k: v for k, v in os.environ.items() if k not in
                ('DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'BUILDX_BUILDER')}

    def inspect(self, value): return self.docker.inspect(value)
    def image(self, value): return self.docker.image(value)
    def create(self, name, body): return self.docker.create(name, body)
    def recipe_fields(self, cid, image):
        def execute(args, **kwargs):
            require(args[0] == 'docker', 'reader_command_unverified')
            return subprocess.run(self.cli(*args[1:]), env=self.environment(), **kwargs)
        return inspect_recipe(cid, image, execute)

    def snapshot(self, cid, tag):
        return subprocess.check_output(self.cli('commit', '--pause=false', cid, tag),
                                       text=True, env=self.environment()).strip()

    def build(self, context, tag):
        output = context.parent / 'image.id'
        with (context.parent / 'build.log').open('xb') as log:
            os.chmod(log.name, 0o600)
            subprocess.run(self.cli('build', '--builder', 'default', '--pull=false', '--network=none', '--load',
                                   '--iidfile', str(output), '--tag', tag, str(context)),
                           stdout=log, stderr=subprocess.STDOUT, check=True, env=self.environment())
        return output.read_text().strip()
