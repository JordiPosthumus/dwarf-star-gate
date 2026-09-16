"""Qualify only the stopped LLM produced by a new-Spark preparation receipt."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent))
from docker_profile import Docker, signature, native_address, native_idle, native_request
from serving_qualification import NativeQualification
from operation_runner import save

SOURCE = Path(__file__).resolve().parent.parent
PROFILE = SOURCE / 'examples/server-profiles/qwen38-nvfp4-vllm.json'


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def prepared(setup_root, docker):
    setup = json.loads((setup_root / 'engines/setup.json').read_text())
    if setup['state'] != 'prepared_stopped':
        raise ValueError('Complete engine preparation before qualification')
    engine = setup['engines']['qwen38-repaired']
    receipt = json.loads((Path(engine['data']) / 'container.json').read_text())
    profile_bytes = PROFILE.read_bytes()
    # Reference prose/evidence can change without changing any serving setting.
    # Retain both document revisions and compare actual command/env/runtime below.
    receipt = {**receipt, 'prepared_profile_sha256': receipt['profile_sha256'],
               'profile_sha256': hashlib.sha256(profile_bytes).hexdigest()}
    container = docker.inspect(receipt['container'])
    if not container or container['Id'] != engine['container'] or container['Image'] != engine['image'] or receipt['image'] != engine['image']:
        raise ValueError('Prepared container or image identity differs')
    profile = json.loads(profile_bytes)
    creator = module('selected_llm_creator', SOURCE / 'examples/spark-build/create-llm.py')
    command, environment = creator.serving_arguments(profile)
    actual = container['Config']
    if actual.get('Entrypoint') != ['vllm', 'serve'] or actual.get('Cmd') != command:
        raise ValueError('Prepared LLM serving command differs from the selected profile')
    effective = dict(item.split('=', 1) for item in actual.get('Env', []))
    if any(effective.get(key) != value for key, value in environment.items()):
        raise ValueError('Prepared LLM environment differs from the selected profile')
    host, runtime = container['HostConfig'], profile['container_runtime_settings']
    if (host['IpcMode'] != runtime['ipc'] or host['NetworkMode'] != runtime['network_mode']
            or host['ShmSize'] != int(runtime['shm_size'][:-1]) * 1024**3
            or host['RestartPolicy']['Name'] != runtime['restart_policy']
            or sorted(host.get('SecurityOpt') or []) != sorted(runtime['security_opt'])
            or not any(row.get('Count') == -1 and ['gpu'] in row.get('Capabilities', []) for row in host.get('DeviceRequests') or [])):
        raise ValueError('Prepared LLM runtime settings differ from the selected profile')
    mounts = {row['Destination']: row for row in container['Mounts']}
    model, cache = mounts.get('/models/qwen38', {}), mounts.get('/root/.cache', {})
    if (len(mounts) != 2 or model.get('Source') != engine['models'] or model.get('RW') is not False
            or cache.get('Source') != str(Path(engine['data']) / 'cache') or cache.get('RW') is not True):
        raise ValueError('Prepared LLM model/cache mounts differ')
    url = 'http://127.0.0.1:' + str(receipt['port'])
    native_address(url, container)
    flags = profile['server_command']['flags']
    contract = {'kind': 'qwen_vllm', 'model': flags['--served-model-name'], 'context_length': flags['--max-model-len'],
                'reasoning_eos': {'eos_token_ids': [248044, 248046], 'ordinary_token_id': 760}}
    return container, url, contract, receipt


def qualify(setup_root, directory, *, docker=None, request=native_request, idle=native_idle, qualifier=NativeQualification, wait=time.sleep):
    docker = docker or Docker()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    def progress(phase, detail):
        save(directory, 'progress.json', {'state': 'qualifying', 'phase': phase, 'detail': detail,
             'updated_at': datetime.now(timezone.utc).isoformat()}, replace=True)
    before = None
    started = False
    try:
        progress('checking_preparation', 'Comparing the prepared container with its selected serving profile.')
        before, url, contract, receipt = prepared(setup_root, docker)
        if before['State']['Running']:
            raise ValueError('Prepared container is already running; inspect it before starting a new qualification')
        # No serving machine is drained or repurposed by this new-host operation.
        gpu_work = subprocess.check_output(['nvidia-smi', '--query-compute-apps=pid', '--format=csv,noheader,nounits'], text=True).strip()
        if gpu_work:
            raise ValueError('GPU work is active; existing work was preserved')
        save(directory, 'container-before.json', before)
        save(directory, 'start-intent.json', {'container': before['Id'], 'image': before['Image'], 'contract': contract})
        started = True  # A lost start acknowledgement still needs observation.
        docker.start(before['Id'])
        while True:
            current = docker.inspect(before['Id'])
            if signature(current) != signature(before) or not current['State']['Running']:
                raise ValueError('Candidate changed or exited while loading')
            progress('loading_llm', 'Prepared LLM process is running; waiting for its native API.')
            try:
                if request(url, '/v1/models')['status'] == 200:
                    break
            except (OSError, ValueError):
                pass
            wait(5)
        if not idle(url):
            raise ValueError('Native work is already present; qualification did not submit requests')
        result = qualifier(request, url, contract, progress=progress).verify(directory / 'native')
        if result['state'] != 'passed':
            raise ValueError('Native qualification failed; inspect retained request/response evidence')
        if not idle(url):
            raise ValueError('Native work remains after qualification')
        current = docker.inspect(before['Id'])
        if signature(current) != signature(before) or not current['State']['Running']:
            raise ValueError('Container identity changed during qualification')
        proof = {'container': current['Id'], 'image': current['Image'], 'signature': signature(current),
                 'started_at': current['State']['StartedAt'], 'port': receipt['port'], 'contract': contract,
                 'profile_sha256': receipt['profile_sha256'], 'prepared_profile_sha256': receipt['prepared_profile_sha256'], 'native_result_sha256': hashlib.sha256((directory / 'native/result.json').read_bytes()).hexdigest()}
        save(directory, 'serving-proof.json', proof)
        value = {'state': 'qualified_serving', 'phase': 'complete', 'updated_at': datetime.now(timezone.utc).isoformat(),
                 'container': current['Id'], 'image': current['Image'], 'port': receipt['port'], 'checks_passed': result['checks_passed'],
                 'scope': 'New LLM passed native checks and remains running. Not yet registered with the gateway. H3/ACE generation and automatic recovery are not qualified by this result.'}
    except Exception as error:
        value = {'state': 'needs_attention', 'phase': 'failed', 'error': str(error), 'candidate_stopped': False,
                 'updated_at': datetime.now(timezone.utc).isoformat()}
        if started and before:
            try:
                current = docker.inspect(before['Id'])
                if signature(current) == signature(before):
                    if current['State']['Running'] and idle(url):
                        docker.stop(before['Id'])
                    value['candidate_stopped'] = not docker.inspect(before['Id'])['State']['Running']
            except Exception:
                value['cleanup_note'] = 'Idle state could not be confirmed; inspect the candidate before stopping it.'
        save(directory, 'progress.json', value, replace=True)
        raise
    save(directory, 'progress.json', value, replace=True)
    return value


def verify_serving(setup_root, *, docker=None, request=native_request):
    docker = docker or Docker()
    directory = setup_root / 'qualification'
    progress = json.loads((directory / 'progress.json').read_text())
    proof = json.loads((directory / 'serving-proof.json').read_text())
    if progress['state'] != 'qualified_serving' or hashlib.sha256((directory / 'native/result.json').read_bytes()).hexdigest() != proof['native_result_sha256']:
        raise ValueError('Native qualification proof is missing or changed')
    current = docker.inspect(proof['container'])
    if not current or not current['State']['Running'] or current['State']['StartedAt'] != proof['started_at'] or signature(current) != proof['signature']:
        raise ValueError('The qualified container instance is no longer serving unchanged')
    response = request('http://127.0.0.1:' + str(proof['port']), '/v1/models')
    import base64
    models = json.loads(base64.b64decode(response['body_base64']))
    if response['status'] != 200 or not any(row.get('id') == proof['contract']['model'] and row.get('max_model_len') == proof['contract']['context_length'] for row in models.get('data', [])):
        raise ValueError('Qualified model/context is not currently available')
    profile = json.loads(PROFILE.read_text())
    flags = profile['server_command']['flags']
    record = {'runtime': {'name': 'vllm', 'version': None, 'build': current['Image']},
              'model': {'name': proof['contract']['model'], 'quantization': 'NVFP4'},
              'settings': {'context_length': flags['--max-model-len'], 'server_concurrency': flags['--max-num-seqs'],
                  'max_output_tokens': flags['--override-generation-config']['max_new_tokens'],
                  'prefill_batch_tokens': flags['--max-num-batched-tokens'], 'kv_cache_dtype': flags['--kv-cache-dtype'],
                  'prefix_caching': flags['--enable-prefix-caching'],
                  'speculative_decoding': {'method': flags['--speculative-config']['method'], 'tokens': flags['--speculative-config']['num_speculative_tokens']}},
              'configuration': {'generation_defaults': flags['--override-generation-config'],
                  'chat_template_defaults': flags['--default-chat-template-kwargs'], 'reasoning_config': flags['--reasoning-config'],
                  'gpu_memory_utilization': flags['--gpu-memory-utilization'], 'container': proof['signature']},
              'profile_sha256': proof['profile_sha256'], 'native_result_sha256': proof['native_result_sha256']}
    return {**progress, 'verified_at': datetime.now(timezone.utc).isoformat(), 'contract': proof['contract'],
            'profile_sha256': proof['profile_sha256'], 'configuration_evidence': record}


if __name__ == '__main__':
    qualify(Path(sys.argv[1]), Path(sys.argv[2]))
