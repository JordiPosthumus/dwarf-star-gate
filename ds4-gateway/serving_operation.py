"""Serving-operation sequence using the existing retained Docker/maintenance adapters.

This sequence is for the independently approved runner. Production enrollment
still needs its entry point and trusted record preparation. The qualifier and publisher
are trusted code, not model-supplied commands. No generic recovery policy is
changed by an approved plan or configuration record.
"""
import hashlib
import json
from datetime import datetime
from pathlib import Path
import time

from docker_profile import digest, signature
from operation_runner import read, read_bytes, save


def dated(value):
    try:
        return isinstance(value, str) and bool(datetime.fromisoformat(value.replace('Z', '+00:00')))
    except ValueError:
        return False


def restoration_authority(record, profile, root):
    changes = []
    if profile['before']['Image'] != profile['create']['Image']: changes.append('engine_image')
    if profile['before']['Config']['Cmd'] != profile['create']['Cmd']: changes.append('serving_flags')
    if not changes:
        raise ValueError('This recipe already matches the observed server; no serving operation is needed')
    evidence = []
    for change in changes:
        rule = record.get('restoration', {}).get('change_classes', {}).get(change, {})
        if (rule.get('mode') != 'automatic' or rule.get('retention') != 'retained'
                or rule.get('external_state_preserved') is not True
                or rule.get('retained_container_id') != profile['before']['Id']
                or rule.get('retained_configuration_sha256') != digest(profile['before'])
                or not isinstance(rule.get('restore_steps'), list) or not rule['restore_steps']
                or not all(isinstance(step, str) and step.strip() for step in rule['restore_steps'])
                or not isinstance(rule.get('success_checks'), list) or not rule['success_checks']
                or not all(isinstance(check, str) and check.strip() for check in rule['success_checks'])):
            raise ValueError('The approved record does not establish retained restoration for this change class')
        reference = rule.get('drill_reference', {})
        relative = Path(reference.get('path', ''))
        if relative.is_absolute() or '..' in relative.parts or not relative.parts or relative.parts[0] != 'artifacts':
            raise ValueError('Restoration proof must be a recorded library artifact')
        file = Path(root) / relative
        if not file.resolve().is_relative_to(Path(root).resolve() / 'artifacts'):
            raise ValueError('Restoration evidence escaped the configuration library')
        raw = read_bytes(file)
        if hashlib.sha256(raw).hexdigest() != reference.get('sha256'):
            raise ValueError('Recorded restoration evidence changed')
        proof = json.loads(raw)
        if (proof.get('schema') != 1 or proof.get('worker_id') != record['worker_id']
                or proof.get('state') != 'restored-in-drill' or proof.get('checks_passed') is not True
                or not dated(proof.get('at'))
                or proof.get('restored_configuration_sha256') != digest(profile['before'])):
            raise ValueError('Restoration proof does not cover the retained configuration')
        evidence.append({'change_class': change, 'sha256': reference['sha256'], 'path': reference['path'], 'success_checks': rule['success_checks']})
    return evidence


class ServingOperation:
    runtime_checks = frozenset(['runtime_identity', 'native_idle'])
    def __init__(self, plan, directory, *, driver, maintenance, candidate_qualifier, previous_qualifier,
                 publish, progress=lambda *args: None, sleep=time.sleep):
        if not callable(publish):
            raise ValueError('An enrolled configuration record publisher is required')
        self.plan, self.folder = plan, Path(directory)
        self.driver, self.maintenance = driver, maintenance
        self.qualifiers = {'candidate': candidate_qualifier, 'previous': previous_qualifier}
        self.publish, self.progress, self.sleep = publish, progress, sleep
        self.id, self.profile = self.folder.name, plan['profile']
        self.binding = digest(self.profile)
        if (self.maintenance.operation_id != self.id or self.maintenance.worker_id != plan['worker_id']
                or self.profile['record_revision'] != plan['record_revision']):
            raise ValueError('Maintenance, profile and approved record must identify the same operation')
        for which, qualifier in self.qualifiers.items():
            if qualifier.url != self.profile['native_url']:
                raise ValueError('Qualification must use the reviewed direct serving endpoint')
            if hasattr(self.driver.docker, 'host') and (plan.get('target', {}).get('ssh') != self.driver.docker.host
                    or getattr(qualifier.transport, '__self__', None) is not self.driver.docker):
                raise ValueError('Remote mutation and qualification must use the same enrolled SSH transport')
            qualifier.validate_profile(self.profile, which)

    def check_record(self):
        raw = read_bytes(self.plan['record_file'])
        if hashlib.sha256(raw).hexdigest() != self.plan['record_revision']:
            raise ValueError('The approved configuration record changed')
        record = json.loads(raw)
        if (record.get('schema') != 1 or record.get('kind') != 'approved' or record.get('worker_id') != self.plan['worker_id']
                or not dated(record.get('approval', {}).get('at')) or not isinstance(record.get('approval', {}).get('reference'), str)
                or not record['approval']['reference'].strip()):
            raise ValueError('The approved record does not identify this worker')
        return restoration_authority(record, self.profile, Path(self.plan['record_file']).parent.parent)

    def current(self, which):
        state = self.driver.observe(self.id)
        container = state['candidate' if which == 'candidate' else 'previous']
        expected_state = 'started_unverified' if which == 'candidate' else 'restored_unverified'
        if state['state'] != expected_state or not container or not container['State']['Running']:
            raise RuntimeError('Serving identity or startup state requires reconciliation')
        return container

    def require_owned_idle(self):
        if self.maintenance.owned(self.id) is not True:
            raise RuntimeError('Gateway work is active; no serving operation may proceed')

    def qualify(self, which):
        self.progress('waiting_' + which, 'Waiting for the ' + which + ' native API to respond.')
        folder = self.folder / ('qualification-' + which)
        def stopped():
            state = self.driver.observe(self.id)
            failed = 'candidate_stopped_unverified' if which == 'candidate' else 'restoration_stopped_unverified'
            if state['state'] != failed: return False
            self.require_owned_idle()
            self.check_record()
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            if read(folder / 'result.json') is None:
                save(folder, 'result.json', {'state': 'failed', 'cases': [], 'error': 'The identified container stopped after its acknowledged startup.'})
            save(self.folder, 'qualified-' + which + '.json', {'state': 'failed', 'at': time.time(), 'startup_state': failed,
                 'result_sha256': hashlib.sha256(read_bytes(folder / 'result.json')).hexdigest()})
            return True
        if stopped(): return False
        started = self.current(which)['State']['StartedAt']
        qualifier = self.qualifiers[which]
        while True:
            self.require_owned_idle()
            if stopped(): return False
            current = self.current(which)
            if current['State']['StartedAt'] != started:
                raise RuntimeError('The server restarted during qualification')
            try:
                if qualifier.ready(): break
            except (OSError, RuntimeError, ValueError):
                pass  # Read-only readiness observation, not an inference retry.
            self.sleep(5)
        self.check_record()
        self.require_owned_idle()
        before = self.current(which)
        result = qualifier.verify(folder)
        # Completion is not enough: retain exact evidence and fresh identity.
        saved = read(folder / 'result.json')
        if saved != result:
            raise RuntimeError('Qualification result was not durably recorded')
        if stopped(): return False
        after = self.current(which)
        if signature(before) != signature(after) or after['State']['StartedAt'] != started:
            raise RuntimeError('Serving identity changed during qualification')
        self.maintenance.wait_idle(lambda: self.driver.idle(self.profile['native_url']))
        final = self.current(which)
        if signature(final) != signature(after) or final['State']['StartedAt'] != started:
            raise RuntimeError('Serving identity changed while waiting for native work to finish')
        requirements = self.check_record()
        missing = sorted({check for rule in requirements for check in rule['success_checks']} - (set(result.get('checks_passed', [])) | self.runtime_checks))
        passed = result['state'] == 'passed' and not missing
        save(self.folder, 'qualified-' + which + '.json', {'at': time.time(), 'container_id': after['Id'],
             'started_at': started, 'signature_sha256': digest(signature(after)),
             'result_sha256': hashlib.sha256(read_bytes(folder / 'result.json')).hexdigest(), 'state': 'passed' if passed else 'failed', 'missing_checks': missing})
        return passed

    def finish(self, which, state):
        self.require_owned_idle()
        self.check_record()
        def qualified_current():
            proof = read(self.folder / ('qualified-' + which + '.json'))
            current = self.current(which)
            if (not proof or proof.get('state') != 'passed' or proof.get('container_id') != current['Id']
                    or proof.get('started_at') != current['State']['StartedAt'] or proof.get('signature_sha256') != digest(signature(current))):
                raise RuntimeError('Current serving identity no longer matches its completed qualification')
            return current
        self.progress('recording_' + which, 'Saving the verified serving configuration and its evidence.')
        current = qualified_current()
        save(self.folder, 'publish.intent.json', {'at': time.time(), 'which': which, 'record_revision': self.plan['record_revision']})
        # The publisher must retain/version the old record and bind the new one
        # to this approval and actual receipts before the server is readmitted.
        publication = self.publish(self.plan, self.folder, which, current)
        if not isinstance(publication, dict) or publication.get('state') != 'recorded':
            raise RuntimeError('Configuration record publication was not confirmed')
        save(self.folder, 'publish.result.json', publication)
        self.maintenance.wait_idle(lambda: self.driver.idle(self.profile['native_url']))
        qualified_current()
        self.require_owned_idle()
        self.progress('returning_' + which, 'Releasing this operation\'s hold and checking whether routing may resume.')
        self.maintenance.release()
        readmission = self.maintenance.resume_if_unchanged()
        result = {'state': state, 'at': time.time(), 'serving': which, 'publication': publication,
                  'readmission': readmission, 'scope': 'Use the recorded qualification and readmission receipts; a preserved owner pause is not overridden.'}
        save(self.folder, 'serving-result.json', result)
        return result

    def unchanged_return(self):
        # Before any stop intent, this adapter cannot have changed the serving
        # process. Do not leave a demonstrably unchanged worker out of traffic
        # merely because preparing its stopped replacement failed.
        if (self.driver.directory / self.id / 'stop-previous.intent.json').exists(): return None
        if not self.maintenance.owned(self.id): return None
        self.check_record()
        current = self.driver.docker.inspect(self.profile['before']['Id'])
        if (not current or not current['State']['Running'] or signature(current) != self.profile['before']
                or current['State']['StartedAt'] != self.profile['started_at'] or current['Name'] != '/' + self.profile['name']): return None
        self.maintenance.wait_idle(lambda: self.driver.idle(self.profile['native_url']))
        latest = self.driver.docker.inspect(self.profile['before']['Id'])
        if (not latest or not latest['State']['Running'] or signature(latest) != signature(current)
                or latest['State']['StartedAt'] != current['State']['StartedAt'] or latest['Name'] != current['Name']): return None
        self.check_record()
        save(self.folder, 'unchanged-serving.json', {'at': time.time(), 'signature_sha256': digest(signature(current)),
             'started_at': current['State']['StartedAt'], 'scope': 'No stop intent was issued and the serving identity/settings match the original. This is not a new model qualification.'})
        self.maintenance.release()
        admission = self.maintenance.resume_if_unchanged()
        return {'state': 'failed_unchanged', 'at': time.time(), 'readmission': admission,
                'scope': 'The serving process was not changed; inspect retained replacement artifacts separately.'}

    def run(self):
        # The independent runner owns the one-attempt claim. This second intent
        # protects direct adapter use and survives a lost caller acknowledgement.
        existing = read(self.folder / 'serving-result.json')
        if existing is not None: return existing
        if read(self.folder / 'serving.intent.json') is not None:
            return {'state': 'requires_reconciliation', 'scope': 'Existing serving attempt is only observed; no stage was replayed.'}
        authority = self.check_record()
        required = {check for rule in authority for check in rule['success_checks']}
        if any(required - (qualifier.checks_supported | self.runtime_checks) for qualifier in self.qualifiers.values()):
            raise ValueError('The enrolled qualification does not cover every success check required by the approved record')
        if hasattr(self.publish, 'preflight'):
            self.publish.preflight(self.plan, self.folder)
        save(self.folder, 'serving.intent.json', {'at': time.time(), 'profile_sha256': self.binding, 'restoration_evidence': authority})
        try:
            self.progress('draining', 'Holding the selected worker while its existing work finishes.')
            self.maintenance.acquire()
            self.maintenance.wait_idle(lambda: self.driver.idle(self.profile['native_url']))
            self.check_record()
            self.progress('applying', 'Applying the exact approved recipe while retaining the previous container.')
            self.driver.apply(self.id, self.profile, self.binding)
            if self.qualify('candidate'):
                return self.finish('candidate', 'completed')
            self.progress('restoring', 'The candidate failed qualification. Restoring the proven retained version.')
            self.check_record()
            self.driver.restore(self.id, self.binding)
            if not self.qualify('previous'):
                raise RuntimeError('The retained version did not pass qualification; routing remains held')
            return self.finish('previous', 'restored')
        except Exception:
            # Never interpret a transport timeout, incomplete step or uncertain
            # record publication as permission to repeat a mutation or readmit.
            result = None
            try: result = self.unchanged_return()
            except Exception: pass
            result = result or {'state': 'requires_reconciliation', 'at': time.time(),
                               'error': 'The operation did not reach a confirmed verified outcome. Inspect its saved stages and current hold; nothing was replayed.'}
            save(self.folder, 'serving-result.json', result)
            return result
