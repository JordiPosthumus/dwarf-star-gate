"""Install and exercise the bundled recovery helper for an unregistered new LLM.

Called under the new-host setup lock, before gateway admission. No existing
helper/config is replaced; accepted restart requests are never retried.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

from docker_profile import signature
from operation_runner import save


def helper_call(helper, config, request):
    result = subprocess.run([sys.executable, '-I', '-B', str(helper), str(config)],
                            input=json.dumps(request), text=True, capture_output=True)
    if result.returncode:
        raise ValueError('Recovery helper failed; inspect the retained request before retrying')
    return json.loads(result.stdout)


def file_hash(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def restart_new_llm(directory, before, url, *, docker, idle, request, progress,
                    call=helper_call, wait=time.sleep):
    folder = directory / 'recovery'
    folder.mkdir(mode=0o700, exist_ok=False)
    helper = folder / 'recovery-docker.py'
    source = Path(__file__).with_name('recovery-docker.py')
    with helper.open('xb') as stream:
        os.chmod(helper, 0o600)
        stream.write(source.read_bytes())
    # The helper checks the listener INSIDE the container, not the host mapping.
    # This recipe's vLLM command listens on 8000; enrollment separately records
    # the externally mapped port used by the gateway.
    config = folder / 'config.json'
    save(folder, 'config.json', {'container': before['Id'], 'port': 8000})
    progress('checking_recovery', 'Checking the dedicated recovery helper before admitting this new LLM.')
    prior = call(helper, config, {'action': 'inspect'})
    save(folder, 'before.json', prior)
    if not prior.get('active') or not prior.get('listener') or prior.get('fault'):
        raise ValueError('Prepared LLM recovery identity/listener is not healthy')
    for index in range(2):
        if not idle(url):
            raise ValueError('Native work is active; recovery qualification did not restart it')
        if not index:
            wait(3)
    current = docker.inspect(before['Id'])
    if (signature(current) != signature(before) or not current['State']['Running']
            or current['State']['StartedAt'] != before['State']['StartedAt']):
        raise ValueError('Prepared LLM changed before recovery qualification')
    action = {'action': 'restart', 'action_id': str(uuid.uuid4()), 'canary': True,
              'fault_after': 0, **{key: prior[key] for key in ('instance', 'machine', 'profile')}}
    save(folder, 'restart-intent.json', action)
    progress('restarting_new_llm', 'Testing one same-container restart before gateway admission.')
    issued = call(helper, config, action)
    save(folder, 'restart-receipt.json', issued)
    if issued.get('state') != 'issued' or issued.get('instance') != prior['instance']:
        raise ValueError('Recovery restart acknowledgement is unconfirmed; do not replay it')
    while True:
        current = docker.inspect(before['Id'])
        if signature(current) != signature(before) or not current['State']['Running']:
            raise ValueError('Prepared LLM changed or exited after the recovery restart')
        progress('loading_restarted_llm', 'Waiting for the restarted LLM; native qualification follows.')
        try:
            if request(url, '/v1/models')['status'] == 200:
                break
        except (OSError, ValueError):
            pass
        wait(5)
    after = call(helper, config, {'action': 'inspect'})
    save(folder, 'after.json', after)
    if (not after.get('active') or not after.get('listener') or after.get('fault')
            or after.get('instance') == prior['instance']
            or any(after.get(key) != prior[key] for key in ('machine', 'profile'))):
        raise ValueError('Unchanged recovery identity and a new healthy instance were not demonstrated')
    return {'helper': str(helper), 'config': str(config), 'helper_sha256': file_hash(helper),
            'config_sha256': file_hash(config), 'machine': after['machine'], 'profile': after['profile'],
            'instance': after['instance'], 'action_id': action['action_id'],
            'restart_receipt_sha256': file_hash(folder / 'restart-receipt.json'),
            'scope': 'Restart observed. Native serving checks must still pass; this is not recovery enrollment.'}


def verify_recovery_proof(proof, *, call=helper_call):
    """Read-only check of the qualified helper, config and live instance."""
    for key in ('helper', 'config'):
        if file_hash(proof[key]) != proof[key + '_sha256']:
            raise ValueError('Qualified recovery helper/config changed')
    receipt = Path(proof['config']).parent / 'restart-receipt.json'
    if file_hash(receipt) != proof['restart_receipt_sha256']:
        raise ValueError('Recovery restart receipt changed')
    current = call(proof['helper'], proof['config'], {'action': 'inspect'})
    if (not current.get('active') or not current.get('listener') or current.get('fault')
            or any(current.get(key) != proof[key] for key in ('machine', 'profile', 'instance'))):
        raise ValueError('Qualified recovery instance is no longer healthy and unchanged')
    return current
