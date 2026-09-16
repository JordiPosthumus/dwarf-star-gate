"""Small SSH entry point for detached, enrolled new-Spark preparation."""
import base64
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
from datetime import datetime, timezone


def save(file, value):
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(file)


def status(root):
    if not root.exists():
        return {'state': 'not_started'}
    receipt = root / 'launch.json'
    if not receipt.exists():
        return {'state': 'needs_attention', 'error': 'Existing directory has no launch receipt; preserved.'}
    launch = json.loads(receipt.read_text())
    qualifying = launch.get('operation') == 'qualify'
    progress_file = root / ('progress.json' if qualifying else 'engines/setup.json')
    progress = json.loads(progress_file.read_text()) if progress_file.exists() else {}
    running = False
    with (root / 'running.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            running = True
    complete = 'qualified_serving' if qualifying else 'prepared_stopped'
    state = 'running' if running else (complete if launch.get('exit_code') == 0 and progress.get('state') == complete else 'needs_attention')
    return {'state': state, 'process_running': running, 'bundle_sha256': launch['bundle_sha256'],
            'started_at': launch['started_at'], 'finished_at': launch.get('finished_at'),
            'exit_code': launch.get('exit_code'), 'error': launch.get('error') or progress.get('error'), 'progress': progress,
            'qualification': status(root / 'qualification') if not qualifying and (root / 'qualification').exists() else None,
            'scope': 'LLM qualification is separate from gateway registration, media generation checks and recovery proof.'}


def media_plan(root, *, require_idle=True):
    """Read exact stopped preparations; this call never starts or stops anything."""
    setup = json.loads((root / 'engines/setup.json').read_text())
    if setup['state'] != 'prepared_stopped':
        raise ValueError('Complete preparation before testing media')
    if require_idle and subprocess.check_output(['nvidia-smi', '--query-compute-apps=pid', '--format=csv,noheader,nounits'], text=True).strip():
        raise ValueError('GPU work is active; existing work was preserved')
    engines = {}
    for key in ('qwen38-repaired', 'h3', 'ace-step'):
        item = setup['engines'][key]
        receipt = json.loads((Path(item['data']) / 'container.json').read_text())
        actual = json.loads(subprocess.check_output(['docker', 'inspect', item['container']], text=True))[0]
        if actual['Id'] != receipt['container'] or actual['Image'] != item['image'] or receipt['image'] != item['image'] or (actual['State']['Running'] and (require_idle or key != 'qwen38-repaired')):
            raise ValueError('Prepared engine identity or stopped state differs: ' + key)
        if key != 'qwen38-repaired':
            image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', item['image']], text=True))[0]
            for field in ('Cmd', 'Entrypoint'):
                if actual['Config'].get(field) != image['Config'].get(field):
                    raise ValueError('Prepared media launch command differs: ' + key)
            port = 8002 if key == 'ace-step' else 8188
            if actual['HostConfig']['PortBindings'].get(str(port) + '/tcp') != [{'HostIp': '127.0.0.1', 'HostPort': str(receipt['port'])}]:
                raise ValueError('Prepared native port differs: ' + key)
            mounts = {m['Destination']: m for m in actual['Mounts']}
            model_dest = '/models/ace-step' if key == 'ace-step' else '/opt/ComfyUI/models'
            if mounts.get(model_dest, {}).get('Source') != item['models'] or mounts.get('/data', {}).get('Source') != item['data']:
                raise ValueError('Prepared model/data mounts differ: ' + key)
            engines[key] = {**receipt, 'inspection': actual}
    return {'state': 'prepared_stopped', 'engines': engines, 'llm_container': setup['engines']['qwen38-repaired']['container']}


def start(root, payload):
    # Repeated/uncertain submissions inspect the same durable receipt, never rerun.
    if root.exists():
        return status(root)
    raw = base64.b64decode(payload['bundle'], validate=True)
    if len(raw) > 8 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != payload['bundle_sha256']:
        raise ValueError('Invalid recipe bundle')
    archive = tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz')
    members = archive.getmembers()
    if any(not member.isfile() or Path(member.name).is_absolute() or '..' in Path(member.name).parts for member in members):
        raise ValueError('Recipe bundle must contain only relative regular files')
    if sum(member.size for member in members) > 16 * 1024 * 1024:
        raise ValueError('Recipe bundle is too large')
    # Run the exact bundled preflight before creating files or launching work.
    setup = archive.extractfile('examples/spark-build/setup-spark.py').read().decode()
    namespace = {'__name__': 'preflight_only', '__file__': str(root / 'source/examples/spark-build/setup-spark.py')}
    exec(compile(setup, 'setup-spark.py', 'exec'), namespace)
    namespace['preflight']()
    # One setup per SSH account/host, including aliases pointing at the same host.
    host_lock_path = Path.home() / '.cache/star-gate-spark-setup.lock'
    host_lock_path.parent.mkdir(parents=True, exist_ok=True)
    host_lock = host_lock_path.open('a')
    try:
        fcntl.flock(host_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        host_lock.close()
        raise ValueError('Another Spark preparation is running on this host; inspect it first')
    try:
        root.mkdir(mode=0o700, parents=True, exist_ok=False)
        source = root / 'source'
        source.mkdir()
        archive.extractall(source, members=members, filter='data')
        receipt = root / 'launch.json'
        save(receipt, {'bundle_sha256': payload['bundle_sha256'], 'started_at': datetime.now(timezone.utc).isoformat(),
                       'operation': payload.get('operation', 'prepare'), 'setup_directory': payload.get('setup_directory')})
        with (root / 'running.lock').open('a') as lock, (root / 'launch.log').open('a') as log:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            child = subprocess.Popen([sys.executable, '-I', '-B', str(source / 'ds4-gateway/spark_setup_remote.py'), '--run', str(root), str(host_lock.fileno()), str(lock.fileno())],
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
                                     pass_fds=(host_lock.fileno(), lock.fileno()))
        return {'state': 'accepted', 'pid': child.pid, 'bundle_sha256': payload['bundle_sha256'],
                'operation': payload.get('operation', 'prepare'),
                'scope': 'Detached work accepted. This acknowledgement does not prove qualification or registration.'}
    finally:
        host_lock.close()


def run(root, lock_fds):
    receipt = root / 'launch.json'
    launch = json.loads(receipt.read_text())
    try:
        command = ([sys.executable, '-I', '-B', str(root / 'source/ds4-gateway/spark_qualify.py'), launch['setup_directory'], str(root)]
                   if launch.get('operation') == 'qualify' else
                   [sys.executable, '-I', '-B', str(root / 'source/examples/spark-build/setup-spark.py'), str(root / 'engines')])
        result = subprocess.run(command, pass_fds=lock_fds)
        launch['exit_code'] = result.returncode
    except Exception as error:
        launch.update(exit_code=1, error=str(error))
    launch['finished_at'] = datetime.now(timezone.utc).isoformat()
    save(receipt, launch)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--run':
        run(Path(sys.argv[2]), tuple(map(int, sys.argv[3:])))
    else:
        try:
            payload = json.loads(sys.stdin.read(12 * 1024 * 1024))
            root = Path(payload['directory'])
            if not root.is_absolute() or root.is_symlink() or '..' in root.parts or root == Path('/'):
                raise ValueError('Use an absolute dedicated remote setup directory')
            if payload['action'] not in ('status', 'start', 'qualify', 'verify_serving', 'media_plan', 'media_state'):
                raise ValueError('Unknown setup action')
            if payload['action'] in ('media_plan', 'media_state'):
                result = media_plan(root, require_idle=payload['action'] == 'media_plan')
            elif payload['action'] == 'qualify':
                current = status(root)
                if current['state'] != 'prepared_stopped':
                    raise ValueError('Preparation is not complete')
                result = start(root / 'qualification', {**payload, 'operation': 'qualify', 'setup_directory': str(root)})
            elif payload['action'] == 'verify_serving':
                import importlib.util
                spec = importlib.util.spec_from_file_location('spark_qualification', root / 'qualification/source/ds4-gateway/spark_qualify.py')
                worker = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(worker)
                result = worker.verify_serving(root)
            else:
                result = status(root) if payload['action'] == 'status' else start(root, payload)
            print(json.dumps(result))
        except Exception as error:
            print(json.dumps({'state': 'unconfirmed', 'error': str(error)}))
            sys.exit(1)
