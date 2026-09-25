"""Exact-container GLM pair recovery transaction.

The caller owns enrollment, admission and the detached runner. This transaction
requires a pinned enrollment and an exclusive journal lease. It never rebuilds,
pulls, recreates or changes a container. Inspection is not enrollment authority.
"""
import copy
import hashlib
import json
import math
import re
import time


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def require(value, reason):
    if not value:
        raise ValueError(reason)


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def signature(container):
    result = {key: copy.deepcopy(container[key]) for key in ('Id', 'Image', 'Config', 'HostConfig', 'Mounts')}
    # Docker may omit this default on older daemons; match paired-media capture.
    result['HostConfig']['OomKillDisable'] = result['HostConfig'].get('OomKillDisable') or False
    result['Mounts'].sort(key=lambda mount: mount['Destination'])
    return result


def file_pins(files):
    require(isinstance(files, dict), 'pair_file_snapshot_unverified')
    result = {}
    for name, value in files.items():
        require(isinstance(name, str) and name.startswith('/') and '\x00' not in name, 'pair_file_path_unverified')
        require(isinstance(value, dict), 'pair_file_snapshot_unverified')
        if value == {'absent': True}:
            result[name] = value
        else:
            require(set(value) <= {'sha256', 'mode', 'data'} and digest(value.get('sha256'))
                    and type(value.get('mode')) is int and 0 <= value['mode'] <= 0o777, 'pair_file_snapshot_unverified')
            result[name] = {'sha256': value['sha256'], 'mode': value['mode']}
    return result


def enrollment_identity(enrollment):
    require(isinstance(enrollment, dict) and set(enrollment) == {'schema', 'kind', 'worker_id', 'model', 'port', 'members', 'context_length', 'concurrency'}, 'invalid_pair_enrollment')
    require(enrollment['schema'] == 1 and enrollment['kind'] == 'glm53-docker-pair'
            and isinstance(enrollment['worker_id'], str) and re.fullmatch(r'[A-Za-z0-9][\w-]{0,63}', enrollment['worker_id'])
            and isinstance(enrollment['model'], str) and enrollment['model'].strip(), 'invalid_pair_enrollment')
    require(type(enrollment['context_length']) is int and enrollment['context_length'] > 0
            and type(enrollment['concurrency']) is int and enrollment['concurrency'] > 0
            and type(enrollment['port']) is int and 1 <= enrollment['port'] <= 65535, 'invalid_pair_capacity')
    members = enrollment['members']
    require(isinstance(members, list) and len(members) == 2, 'invalid_pair_members')
    for member in members:
        require(isinstance(member, dict) and set(member) == {'ssh', 'machine', 'container', 'recipe_root', 'definition', 'files'}, 'invalid_pair_member')
        require(isinstance(member['ssh'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*', member['ssh'])
                and digest(member['machine']) and digest(member['container']), 'invalid_pair_member_identity')
        require(member['recipe_root'] is None or isinstance(member['recipe_root'], str) and member['recipe_root'].startswith('/')
                and '\x00' not in member['recipe_root'], 'invalid_pair_recipe_root')
        definition = member['definition']
        require(isinstance(definition, dict) and set(definition) == {'Id', 'Image', 'Config', 'HostConfig', 'Mounts'}
                and definition['Id'] == member['container'] and re.fullmatch(r'sha256:[a-f0-9]{64}', definition['Image']), 'invalid_pair_definition')
        require(signature(definition) == definition, 'pair_definition_not_canonical')
        pins = file_pins(member['files'])
        require(pins == member['files'] and (member['recipe_root'] is None or all(member['recipe_root'].rstrip('/') + '/' + name in pins
                for name in ('.env', 'start.sh', '.glm53-exl3-head.inner.sh'))), 'pair_recipe_files_unpinned')
    require(members[0]['recipe_root'] is not None, 'pair_head_recipe_unpinned')
    require(members[0]['machine'] != members[1]['machine'] and members[0]['ssh'] != members[1]['ssh'], 'pair_members_not_distinct')
    require(members[0]['definition']['Image'] == members[1]['definition']['Image'], 'pair_images_differ')
    environment = {}
    for item in members[0]['definition']['Config']['Env']:
        key, separator, value = item.partition('=')
        require(separator, 'pair_environment_unverified')
        environment[key] = value
    require(environment.get('MAX_MODEL_LEN') == str(enrollment['context_length'])
            and environment.get('MAX_NUM_SEQS') == str(enrollment['concurrency']), 'pair_capacity_differs_from_enrollment')
    return {'machine': fingerprint([m['machine'] for m in members]), 'profile': fingerprint(enrollment)}


def observe_pair(enrollment, observations):
    """Join two native observations to the retained pins; never adopt drift."""
    identity = enrollment_identity(enrollment)
    require(isinstance(observations, list) and len(observations) == 2, 'pair_observation_incomplete')
    states, epochs, faults = [], [], []
    for member, observation in zip(enrollment['members'], observations):
        require(observation.get('machine') == member['machine'], 'pair_machine_changed')
        container = observation['container']
        require(signature(container) == member['definition'], 'pair_container_or_configuration_changed')
        require(file_pins(observation['files']) == member['files'], 'pair_mounted_files_changed')
        state = container['State']
        require(type(state.get('Running')) is bool and state.get('Paused') is False
                and state.get('Restarting') is False and state.get('Dead') is False, 'pair_native_state_unverified')
        active = state['Running'] and state.get('Status') == 'running'
        stopped = not state['Running'] and state.get('Status') in ('created', 'exited')
        require(active or stopped, 'pair_native_state_unverified')
        require(isinstance(state.get('StartedAt'), str) and isinstance(state.get('FinishedAt'), str), 'pair_epoch_unverified')
        states.append('running' if active else 'stopped')
        epochs.append([container['Id'], state['StartedAt'], state['FinishedAt'], state['Status']])
        fault = observation.get('fault')
        if fault is not None:
            require(isinstance(fault, dict) and fault.get('reason') == 'fatal_accelerator_error'
                    and type(fault.get('at')) in (int, float) and math.isfinite(fault['at'])
                    and type(observation.get('started_at')) in (int, float) and math.isfinite(observation['started_at'])
                    and fault['at'] >= observation['started_at'], 'pair_fault_evidence_unverified')
            if active:
                faults.append(fault)
    return {'version': 1, **identity, 'members': states, 'epochs': epochs,
            'epoch': fingerprint(epochs), 'active': states == ['running', 'running'],
            'stopped': states == ['stopped', 'stopped'], 'partial': len(set(states)) == 2,
            'listener': states == ['running', 'running'] and observations[0].get('listener_owned') is True,
            'fault': max(faults, key=lambda value: value['at']) if faults else None}


def validate_request(enrollment, request):
    identity = enrollment_identity(enrollment)
    require(isinstance(request, dict) and set(request) == {'action', 'action_id', 'epoch', 'machine', 'profile', 'canary', 'fault_after'}, 'invalid_pair_request')
    require(request['action'] in ('restart', 'start') and isinstance(request['action_id'], str)
            and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', request['action_id'])
            and digest(request['epoch']) and type(request['canary']) is bool
            and type(request['fault_after']) in (int, float) and math.isfinite(request['fault_after'])
            and request['fault_after'] >= 0, 'invalid_pair_request')
    require(all(request[key] == identity[key] for key in identity), 'pair_enrollment_changed')
    return identity


def validate_journal(enrollment, request, journal):
    identity = validate_request(enrollment, request)
    require(isinstance(journal, dict) and journal.get('schema') == 1 and journal.get('action_id') == request['action_id']
            and journal.get('request_hash') == fingerprint(request) and journal.get('enrollment') == identity['profile'], 'pair_action_id_conflict')
    require(journal.get('state') in ('running', 'waiting_for_ownership', 'uncertain', 'completed'), 'pair_journal_invalid')
    def epochs_valid(epochs):
        return isinstance(epochs, list) and len(epochs) == 2 and all(isinstance(epoch, list) and len(epoch) == 4
            and epoch[0] == enrollment['members'][i]['container'] and all(isinstance(v, str) for v in epoch)
            and epoch[3] in ('created', 'exited', 'running') for i, epoch in enumerate(epochs))
    initial = journal.get('initial_epochs')
    require(epochs_valid(initial) and fingerprint(initial) == request['epoch'], 'pair_journal_invalid')
    sequence = [('stop', 0), ('stop', 1), ('start', 1), ('start', 0)]
    steps = journal.get('steps')
    require(isinstance(steps, list) and len(steps) <= 4, 'pair_journal_invalid')
    for index, step in enumerate(steps):
        require(isinstance(step, dict) and (step.get('action'), step.get('member')) == sequence[index]
                and step.get('state') in ('intent', 'observed'), 'pair_journal_invalid')
        require(epochs_valid(step.get('epochs')) if step['state'] == 'observed' else index == len(steps) - 1, 'pair_journal_invalid')
    if journal['state'] == 'completed':
        require(len(steps) == 4 and all(step['state'] == 'observed' for step in steps)
                and all(epoch[3] == 'running' for epoch in steps[-1]['epochs'])
                and journal.get('final_epoch') == fingerprint(steps[-1]['epochs'])
                and journal['final_epoch'] != request['epoch'], 'pair_journal_invalid')
    return journal


def recover_pair(enrollment, request, *, read_journal, save_journal, observe, stop, start, ownership, now=lambda: round(time.time() * 1000)):
    """Run/resume one leased operation; a saved command intent is never replayed.

    The caller must hold an exclusive native lock for the entire invocation.
    save_journal must atomically replace and fsync the private journal. Remote
    adapters must wait for Docker's command acknowledgement. After lost ack, a
    later invocation may advance only if native state proves the intended step.
    """
    identity = validate_request(enrollment, request)
    request_hash = fingerprint(request)
    journal = read_journal()
    if journal is not None:
        validate_journal(enrollment, request, journal)
        if journal.get('state') == 'completed':
            return copy.deepcopy(journal)
    else:
        current = observe_pair(enrollment, observe())
        require(current['epoch'] == request['epoch'], 'pair_epoch_changed')
        if request['action'] == 'restart':
            require(current['active'] and (request['canary'] or current['fault'] and current['fault']['at'] >= request['fault_after']), 'pair_current_fatal_evidence_required')
        else:
            require(current['stopped'], 'pair_stopped_identity_required')
        require(ownership() is True, 'pair_ownership_unavailable')
        journal = {'schema': 1, 'action_id': request['action_id'], 'request_hash': request_hash,
                   'enrollment': identity['profile'], 'state': 'running', 'created_at': now(),
                   'initial_epochs': current['epochs'], 'steps': []}
        save_journal(copy.deepcopy(journal))

    # Restart head before rank; restore rank before head. Even a stopped-start
    # transaction has explicit stop checkpoints, preserving one replay rule.
    sequence = [('stop', 0), ('stop', 1), ('start', 1), ('start', 0)]
    require(isinstance(journal.get('steps'), list) and len(journal['steps']) <= len(sequence), 'pair_journal_invalid')
    def valid_epochs(epochs):
        return isinstance(epochs, list) and len(epochs) == 2 and all(isinstance(epoch, list) and len(epoch) == 4
            and epoch[0] == enrollment['members'][i]['container'] and all(isinstance(v, str) for v in epoch)
            and epoch[3] in ('created', 'exited', 'running') for i, epoch in enumerate(epochs))
    require(valid_epochs(journal.get('initial_epochs')), 'pair_journal_invalid')
    for index, step in enumerate(journal['steps']):
        require(isinstance(step, dict) and (step.get('action'), step.get('member')) == sequence[index]
                and step.get('state') in ('intent', 'observed'), 'pair_journal_invalid')
        require(valid_epochs(step.get('epochs')) if step['state'] == 'observed' else index == len(journal['steps']) - 1, 'pair_journal_invalid')
    for index, (action, member_index) in enumerate(sequence):
        desired = 'stopped' if action == 'stop' else 'running'
        record = journal['steps'][index] if index < len(journal['steps']) else None
        if record is not None:
            require(record.get('action') == action and record.get('member') == member_index
                    and record.get('state') in ('intent', 'observed'), 'pair_journal_invalid')
            if record['state'] == 'observed':
                continue
        current = observe_pair(enrollment, observe())
        # Completed steps pin both member epochs, so an external restart during
        # a later step cannot silently become part of this operation's result.
        expected = journal['steps'][index-1]['epochs'] if index else journal['initial_epochs']
        for peer_index in (0, 1):
            if record is not None and peer_index == member_index:
                continue  # This exact member's in-flight command may have ended.
            require(current['epochs'][peer_index] == expected[peer_index], 'pair_epoch_changed_during_recovery')
        if current['members'][member_index] != desired:
            if record is not None:
                journal.update(state='uncertain', updated_at=now(), reason='pair_command_outcome_unverified')
                save_journal(copy.deepcopy(journal))
                return copy.deepcopy(journal)
            if ownership() is not True:
                journal.update(state='waiting_for_ownership', updated_at=now())
                save_journal(copy.deepcopy(journal))
                return copy.deepcopy(journal)
            record = {'action': action, 'member': member_index, 'state': 'intent', 'at': now()}
            journal['steps'].append(record)
            journal.update(state='running', updated_at=now())
            save_journal(copy.deepcopy(journal))  # Durable before native command.
            member = enrollment['members'][member_index]
            try:
                (stop if action == 'stop' else start)(member['ssh'], member['container'])
            except Exception:
                journal.update(state='uncertain', updated_at=now(), reason='pair_command_acknowledgement_lost')
                save_journal(copy.deepcopy(journal))
                return copy.deepcopy(journal)
            current = observe_pair(enrollment, observe())
            require(current['members'][member_index] == desired, 'pair_command_state_unverified')
            require(current['epochs'][1-member_index] == expected[1-member_index], 'pair_peer_changed_during_command')
        if record is None:
            record = {'action': action, 'member': member_index, 'at': now()}
            journal['steps'].append(record)
        record.update(state='observed', epochs=current['epochs'], observed_at=now())
        journal.update(state='running', updated_at=now())
        journal.pop('reason', None)
        save_journal(copy.deepcopy(journal))

    final = observe_pair(enrollment, observe())
    require(final['active'] and final['epochs'] == journal['steps'][-1]['epochs'], 'pair_final_identity_unverified')
    journal.update(state='completed', updated_at=now(), final_epoch=final['epoch'],
                   scope='Exact pinned containers and files restored. Native generation, cache verification and routing readmission remain required.')
    save_journal(copy.deepcopy(journal))
    return copy.deepcopy(journal)
