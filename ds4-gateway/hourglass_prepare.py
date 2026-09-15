"""Prepare an owned measurement from an installation-owned native review.

The dashboard supplies HourglassConsole.prepared, never a model's guessed
payload. Preparation observes configuration and writes only its source snapshot.
It does not approve, drain, enqueue, restart, or change the approved record.
"""
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

from docker_profile import digest, native_address, signature
from docker_profile_remote import SSHDocker
from hourglass_native import HourglassNative, gateway_target_matches
from operation_maintenance import GatewayControl
from operation_runner import folder_at, read_bytes
from serving_bundle import build_executor
from serving_records import ServingRecordPublisher


def prepare(proposal, enrollment, prepared, directory, record_revision, *, docker=None, control=None, opener=None):
    folder = folder_at(directory).resolve()
    worker = proposal.get('worker_id')
    if (set(proposal) != {'id', 'worker_id'} or proposal.get('id') != folder.name
            or not re.fullmatch(r'[a-zA-Z0-9][\w-]{0,63}', worker or '')
            or worker != enrollment.get('worker_id')):
        raise ValueError('Identify the enrolled worker and measurement')
    review, payload = copy.deepcopy(prepared['review']), copy.deepcopy(prepared['payload'])
    connection = enrollment['hourglass']
    if (review['id'] != folder.name or review['model'] != connection['model']
            or payload['model'] != connection['model'] or review['endpoint'] != connection['endpoint']
            or review['models_revision'] != payload['models_revision']
            or review['hardware_revision'] != payload['hardware_revision']
            or review['question_count'] != len(payload['tasks']) or review['window_seconds'] != 3600
            or not all(re.fullmatch(r'[a-f0-9]{64}', payload.get(k, '')) for k in ['models_revision', 'hardware_revision'])
            or not all(re.fullmatch(r'[a-f0-9]{64}', h) for h in payload['task_bundles'].values())):
        raise ValueError('Use the exact native review for this enrolled measurement')
    target = {key: enrollment[key] for key in ['ssh', 'docker_socket', 'gateway_socket']}
    control = control if control is not None else GatewayControl(target['gateway_socket'])
    gateway = control('/workers')
    if not gateway_target_matches(gateway, worker, connection['endpoint']):
        raise ValueError('The reviewed direct endpoint must match the current gateway worker')
    library = Path(enrollment['records_directory']).resolve()
    record_file = library / 'approved' / (worker + '.json')
    raw = read_bytes(record_file)
    if hashlib.sha256(raw).hexdigest() != record_revision:
        raise ValueError('The reviewed approved record changed')
    ServingRecordPublisher(library).require_committed_record(record_file, raw)
    record = json.loads(raw)
    if (record.get('schema') != 1 or record.get('worker_id') != worker or record.get('kind') != 'approved'
            or not record.get('approval', {}).get('reference') or not record.get('approval', {}).get('at')
            or record.get('model', {}).get('name') != review['model_id']):
        raise ValueError('Use the approved worker record and its serving model')
    datetime.fromisoformat(record['approval']['at'].replace('Z', '+00:00'))
    docker = docker if docker is not None else SSHDocker(target['ssh'], target['docker_socket'])
    container = docker.inspect(enrollment['container'])
    if not container or not container['State']['Running']:
        raise ValueError('The enrolled serving container is not running')
    native_address(enrollment['native_url'], container)
    plan = {'id': folder.name, 'worker_id': worker, 'record_file': str(record_file),
        'record_revision': record_revision, 'target': target,
        'hourglass': {'url': connection['url'], 'controller_instance': prepared['controller'],
            'endpoint': connection['endpoint'], **{key: review[key] for key in ['metric', 'benchmark_version', 'scoring_policy']}},
        'native_target': {'container_id': container['Id'], 'signature_sha256': digest(signature(container)),
            'started_at': container['State']['StartedAt'], 'url': enrollment['native_url'], 'model': review['model_id']},
        'native_request': payload}
    native = HourglassNative(plan, docker, opener=opener)
    native.verify_request(payload)
    if not native.check_target():
        raise ValueError('Serving identity changed during preparation')
    # No restoration proof is required: this operation does not replace a server.
    # The record is a versioned reference; a matching model name alone does not
    # establish that every observed launch setting matches that record.
    plan['execution'] = build_executor(folder, kind='hourglass')
    return {'plan': plan, 'review': {'at': datetime.now(timezone.utc).isoformat(),
        'worker_id': worker, 'measurement': review,
        'observed': {'container_id': container['Id'], 'image': container['Image'],
            'command': container['Config']['Cmd'], 'started_at': container['State']['StartedAt'],
            'signature_sha256': plan['native_target']['signature_sha256']},
        'record_revision': record_revision,
        'scope': 'Wait for current gateway and direct work, measure the unchanged server, then release only this measurement hold. The approved record is a reference, not proof that every current setting matches it. Endpoint association uses the enrolled mapping and current gateway registry; this does not independently trace SSH forwarding. No serving settings, recovery bindings or launchers change.'}}
