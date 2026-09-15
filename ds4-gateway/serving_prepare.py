"""Read-only preparation from a Genie proposal and installation-owned enrollment.

Only the proposal's image and complete command can become a serving change.
Connections, record paths, qualification contracts and executable code come from
the installation. Preparing never drains, starts, stops or approves anything.
"""
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

from docker_profile import RetainedProfile, digest
from docker_profile_remote import SSHDocker
from operation_runner import read_bytes
from serving_bundle import build_executor
from serving_operation import dated, restoration_authority
from serving_qualification import NativeQualification


def option(command, name):
    found = []
    for index, value in enumerate(command):
        if value == name:
            if index + 1 == len(command) or command[index + 1].startswith('--'):
                raise ValueError('Incomplete serving argument: ' + name)
            found.append(command[index + 1])
        elif value.startswith(name + '='):
            found.append(value.split('=', 1)[1])
    if len(found) > 1: raise ValueError('Ambiguous serving argument: ' + name)
    return found[0] if found else None


def json_option(command, name):
    value = option(command, name)
    parsed = json.loads(value) if value is not None else {}
    if not isinstance(parsed, dict): raise ValueError('Expected a serving configuration object: ' + name)
    return parsed


def candidate_record(old, profile, contract):
    command = profile['create']['Cmd']
    same_image = profile['before']['Image'] == profile['create']['Image']
    record = copy.deepcopy(old)
    record['runtime'] = copy.deepcopy(old.get('runtime', {})) if same_image else {'name': 'vllm', 'version': None, 'build': None}
    record['model'] = {'name': contract['model']}
    quantization = option(command, '--quantization')
    if quantization is not None: record['model']['quantization'] = quantization
    elif command[0] == profile['before']['Config']['Cmd'][0] and not command[0].startswith('--'):
        # The adapter preserves bind mounts and the model path. The recorded
        # weight format is retained; it is not a fresh model-file inspection.
        record['model']['quantization'] = old.get('model', {}).get('quantization')
    settings = {'context_length': contract['context_length']}
    for key, flag, converter in [('server_concurrency','--max-num-seqs',int),
            ('prefill_batch_tokens','--max-num-batched-tokens',int), ('kv_cache_dtype','--kv-cache-dtype',str)]:
        value = option(command,flag)
        if value is not None: settings[key] = converter(value)
    if '--enable-prefix-caching' in command: settings['prefix_caching'] = True
    elif '--no-enable-prefix-caching' in command: settings['prefix_caching'] = False
    speculative = json_option(command,'--speculative-config')
    if speculative: settings['speculative_decoding'] = {'method':speculative.get('method'),'tokens':speculative.get('num_speculative_tokens')}
    generation = json_option(command,'--override-generation-config')
    if 'max_new_tokens' in generation: settings['max_output_tokens'] = generation['max_new_tokens']
    record['settings'] = settings
    config = record.setdefault('configuration',{})
    # Older captures are retained in the previous record/artifacts. Do not label
    # their container identity, package metadata or defaults as the new capture.
    for key in ('captured_container','recreation_capture','baseline_reconciliation','qualified_container_reference'):
        config.pop(key,None)
    config.update(planned_recipe_sha256=digest(profile['create']),
        generation_defaults=generation,
        chat_template_defaults=json_option(command,'--default-chat-template-kwargs'),
        reasoning_config=json_option(command,'--reasoning-config'))
    memory = option(command,'--gpu-memory-utilization')
    config['gpu_memory_utilization'] = float(memory) if memory is not None else None
    config['record_scope'] = 'Reviewed launch settings, with native qualification added after execution. Omitted engine defaults are unknown; older captures remain in the prior approved record.'
    record['restoration'] = {'previous_approved_revision':profile['record_revision'], 'retention':'retained','drill':{'status':'unproven'}}
    record['discrepancies'] = sorted(set(record.get('discrepancies',[])) | {'launcher_differs'})
    return record


def prepare(proposal, enrollment, folder, record_revision, *, docker=None):
    folder = Path(folder).resolve()
    worker = proposal.get('worker_id')
    if (not re.fullmatch(r'[a-zA-Z0-9][\w-]{0,63}', worker or '')
            or enrollment.get('worker_id') != worker or proposal.get('id') != folder.name
            or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', folder.name)):
        raise ValueError('Proposal does not identify this enrolled worker and operation')
    library = Path(enrollment['records_directory']).resolve()
    record_file = library / 'approved' / (worker + '.json')
    raw = read_bytes(record_file)
    if hashlib.sha256(raw).hexdigest() != record_revision: raise ValueError('The approved record changed')
    old = json.loads(raw)
    if (old.get('schema') != 1 or old.get('worker_id') != worker or old.get('kind') != 'approved'
            or not dated(old.get('approval',{}).get('at')) or not old.get('approval',{}).get('reference')):
        raise ValueError('An actual approved configuration record is required')
    target = {key:enrollment[key] for key in ('ssh','docker_socket','gateway_socket')}
    transport = docker if docker is not None else SSHDocker(target['ssh'],target['docker_socket'])
    driver = RetainedProfile(folder / 'containers',docker=transport)
    profile = driver.prepare(enrollment['container'],proposal['image'],proposal['command'],enrollment['native_url'],record_revision)
    contracts = copy.deepcopy(enrollment['qualification'])
    if set(contracts) != {'candidate','previous'}: raise ValueError('Enroll both native qualification contracts')
    for which, contract in contracts.items():
        NativeQualification(transport.native_request,profile['native_url'],contract).validate_profile(profile,which)
    restoration = restoration_authority(old,profile,library)
    supported = NativeQualification.checks_supported | {'runtime_identity','native_idle'}
    if any(set(rule['success_checks']) - supported for rule in restoration):
        raise ValueError('The enrolled native checks do not cover the recorded restoration requirements')
    record = candidate_record(old,profile,contracts['candidate'])
    # All remote preparation above is observation only. Freeze source only after
    # prerequisites are established; no runner is launched by this function.
    execution = build_executor(folder)
    plan = {'worker_id':worker,'record_file':str(record_file),'record_revision':record_revision,
        'target':target,'profile':profile,'qualification':contracts,'candidate_record':record,'execution':execution}
    return {'plan':plan,'review':{'at':datetime.now(timezone.utc).isoformat(),'worker_id':worker,
        'before':{'image':profile['before']['Image'],'command':profile['before']['Config']['Cmd']},
        'after':{'image':proposal['image'],'command':proposal['command']},
        'checks':sorted(supported),'restoration':restoration,
        'scope':'Drain after current work finishes, retain the prior container, apply and qualify, then record and return. Launcher files and recovery bindings are unchanged. A missing or uncertain result is not retried. Native concurrency increases and fresh-machine setup are not qualified by this adapter.'}}
