"""Read-only native postqualification proof. No preparation or lifecycle commands."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recovery_media_bridge as bridge
import media_ace_candidate as candidate
from media_candidate_remote import RemoteIO
from recovery_pair_native import private_read
from docker_profile import digest, signature


def require(value, reason):
    if not value:
        raise ValueError('ace_promotion_' + reason)


def retained_audio(root, plan):
    proof = private_read(root/'ace-audio-proof.json')
    require(proof.get('state') == 'audio_verified' and proof.get('job_id') == plan['operation_id'] and
            proof.get('container') == plan['engine']['container'] and proof.get('image') == plan['engine']['image'] and
            proof.get('source_receipt_sha256') == plan['ace_qualification']['source_proof']['receipt_sha256'], 'audio_binding_changed')
    output = proof['output']
    require(bridge.command.UUID.fullmatch(output['id']) and output['decoded']['full_decode'] is True and
            output['content_type'] == 'audio/flac', 'audio_proof_unverified')
    target = Path(plan['results_directory']) / plan['operation_id'] / output['id']
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size == output['bytes'], 'audio_file_changed')
        sha = hashlib.sha256()
        while True:
            data = os.read(fd, 1024*1024)
            if not data: break
            sha.update(data)
        after = os.fstat(fd); current = target.lstat()
        pin = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(pin(before) == pin(after) == pin(current) and sha.hexdigest() == output['sha256'], 'audio_bytes_changed')
    finally:
        os.close(fd)
    return {'id': output['id'], 'sha256': output['sha256'], 'bytes': output['bytes']}


def final_command(root, plan, bindings, role, action, member, remote_factory):
    step = f'{role}-{action}-{member}'
    target = bindings['targets'][f'{role}-{member}']
    original, snapshot = bridge.original(root, plan, role, member)
    saved = private_read(root/'commands'/(step+'.request'))
    pins = {'plan_hash': digest(plan), 'bindings_hash': digest(bindings), 'snapshot_hash': digest(snapshot),
            'step': step, 'container': original['Id']}
    require(all(saved.get(k) == v for k,v in pins.items()), 'command_binding_changed')
    request = bridge.command.validate(saved['request'])
    require(request['operation_id'] == plan['operation_id'] and request['step'] == step and
            request['container'] == original['Id'] and request['definition'] == signature(original) and
            request['machine'] == bindings['machines'][target['host']], 'command_identity_changed')
    # A final stop/start must continue the acknowledged prior start/stop epoch,
    # not the initial snapshot and never a new baseline captured during promotion.
    previous = bridge.prior_result(root, plan, bindings, role, 'start' if action == 'stop' else 'stop', member)
    require(request['before'] == previous, 'command_chain_changed')
    directory = bridge.command.root_directory(root/'commands')
    lease = bridge.command.lease(directory, request, create=False)
    require(lease is not None, 'command_still_owned')
    try:
        row = bridge.command.read_record(directory, request)
        require(row is not None and row['state'] == 'completed', 'command_incomplete')
        io = bridge.BoundIO(root, plan, target, bindings, remote_factory)
        current = bridge.command.current(request, io)
        require(current == row['after'], 'native_epoch_changed')
        require(current['running'] is (role == 'llm'), 'native_state_changed')
        return {'step': step, 'container': request['container'], 'image': original['Image'],
                'machine': request['machine'], 'request_hash': digest(request), 'epoch': current}
    finally:
        bridge.command.release(lease)


def observe(folder, *, remote_factory=bridge.Remote, candidate_io=RemoteIO):
    root, plan = bridge.plan_at(folder)
    qualification = plan.get('ace_qualification', {})
    operation = qualification.get('candidate_operation_id')
    require(qualification.get('schema') == 1 and bridge.command.UUID.fullmatch(operation or '') and
            plan.get('llm_pair') and not plan.get('media_lanes') and not plan.get('job_ids'), 'plan_unverified')
    prep = root.parent.parent
    require(prep.name == operation and str(prep) == qualification['preparation_directory'], 'preparation_path_changed')
    prepared_plan = private_read(prep/'plan.json');request = candidate.validate(private_read(prep/'request.json'))
    bundle = private_read(prep/'bundle.json')
    require(hashlib.sha256((prep/'bundle.json').read_bytes()).hexdigest() == prepared_plan['bundle_sha256'] and
            hashlib.sha256((prep/'request.json').read_bytes()).hexdigest() == qualification['prepared_result']['request_file_sha256'] and
            request['operation_id'] == operation and prepared_plan['operation_id'] == operation and
            prepared_plan['engine']['container'] == request['before']['Id'] and prepared_plan['engine']['image'] == request['before']['Image'], 'preparation_changed')
    completion = private_read(root/'completion.json')
    require(completion.get('native_generation_verified') is True and completion.get('llm_return_verified') is True and
            completion.get('qualification', {}).get('state') == 'qualified_returned' and
            completion['qualification'].get('candidate_operation_id') == operation and
            private_read(root/'readmission.json').get('state') == 'readmitted', 'qualification_incomplete')
    bindings = bridge.load_bindings(root, plan)
    member = plan['llm_pair']['media_member'];require(member in (0,1), 'member_changed')
    require(plan['engine']['container'] == qualification['prepared_result']['container'] and
            plan['engine']['image'] == qualification['prepared_result']['image'] and
            plan['host'] == prepared_plan['host'] and bindings['machines'][plan['host']] == request['machine'], 'candidate_identity_changed')
    old = candidate_io(prepared_plan['host'], bundle['modules'], request)
    candidate.check_original(request, old)
    prepared = qualification['prepared_result']
    original_image, snapshot, image = [old.image(i) for i in (request['before']['Image'], prepared['snapshot_image'], plan['engine']['image'])]
    require(original_image is not None and original_image['Id'] == request['before']['Image'] and
            snapshot is not None and snapshot['Id'] == prepared['snapshot_image'] and
            image is not None and image['Id'] == plan['engine']['image'] and snapshot.get('RootFS', {}).get('Layers') and
            image.get('RootFS', {}).get('Layers', [])[:len(snapshot['RootFS']['Layers'])] == snapshot['RootFS']['Layers'], 'rollback_images_changed')
    before = private_read(root/'containers-before.json')['media']
    require(signature(before) == candidate.candidate_signature(request, plan['engine']['container'], plan['engine']['image']), 'candidate_profile_changed')
    source = old.recipe_fields(plan['engine']['container'], plan['engine']['image'])
    require(source == qualification['source_proof'] == prepared['recipe_contract'], 'candidate_source_changed')
    outputs = retained_audio(root, plan)
    commands = [final_command(root, plan, bindings, role, action, i, remote_factory)
                for role,action,i in [('media','stop',member),('llm','start',0),('llm','start',1)]]
    return {'schema': 1, 'state': 'qualified_current', 'operation_id': operation, 'qualification_job_id': plan['operation_id'],
            'container': plan['engine']['container'], 'image': plan['engine']['image'], 'source_receipt_sha256': source['receipt_sha256'],
            'original': {'container': request['before']['Id'], 'image': request['before']['Image'], 'preserved': True},
            'snapshot_image': prepared['snapshot_image'], 'commands': commands, 'retained_output': outputs,
            'observed_at': datetime.now(timezone.utc).isoformat(),
            'scope': 'Read-only exact original retention, stopped candidate source/profile/epoch, retained audio bytes and returned LLM profile/files/epochs. No new generation, performance or maximum-capacity measurement.'}


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2, 'saved_folder_required')
        print(json.dumps(observe(sys.argv[1])))
    except Exception:
        print(json.dumps({'state': 'unverified', 'reason': 'native_promotion_proof_unavailable'}))
        sys.exit(1)
