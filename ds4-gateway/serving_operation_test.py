import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from docker_profile import RetainedProfile, digest, signature
from docker_profile_remote import RemoteObservationUnavailable
from docker_profile_test import Docker, IMAGE, OLD, NEW
from operation_maintenance import Maintenance
from operation_maintenance_test import Fixture
from serving_operation import ServingOperation
from serving_qualification import NativeQualification
from serving_qualification_test import API, CONTRACT, ParallelAPI


class OperationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.folder = self.root / str(uuid.uuid4()); self.folder.mkdir()
        self.docker, self.control = Docker(), Fixture()
        self.docker.old['Config']['Cmd'][1] = str(CONTRACT['context_length'])
        self.events, self.published = [], []
        self.maintenance = Maintenance(self.folder, self.folder.name, 'fixture', control=self.control, sleep=lambda _: None)
        self.driver = RetainedProfile(self.root / 'containers', docker=self.docker, lease_check=self.maintenance.owned, idle=lambda _: True, sleep=lambda _: None)
        profile = self.driver.prepare('engine', IMAGE, ['--max-model-len', str(CONTRACT['context_length']), '--max-num-seqs', '1', '--max-num-batched-tokens', '8192'], 'http://127.0.0.1:8001', 'd' * 64)
        library = self.root / 'records'; (library / 'approved').mkdir(parents=True); (library / 'artifacts').mkdir()
        proof = {'schema': 1, 'worker_id': 'fixture', 'state': 'restored-in-drill', 'checks_passed': True, 'at': '2026-09-15T00:00:00Z',
                 'restored_configuration_sha256': digest(profile['before'])}
        reference = library / 'artifacts/restore.json'; reference.write_text(json.dumps(proof))
        rule = {'mode': 'automatic', 'retention': 'retained', 'external_state_preserved': True,
                'retained_container_id': OLD, 'retained_configuration_sha256': digest(profile['before']),
                'restore_steps': ['Restore exact retained container'], 'success_checks': ['model_context', 'tools', 'prefix_cache', 'runtime_identity', 'native_idle'],
                'drill_reference': {'path': 'artifacts/restore.json', 'sha256': hashlib.sha256(reference.read_bytes()).hexdigest()}}
        self.record = {'schema': 1, 'kind': 'approved', 'worker_id': 'fixture', 'approval': {'at': '2026-09-15T00:00:00Z', 'reference': 'Synthetic fixture approval'}, 'restoration': {'change_classes': {'serving_flags': rule}}}
        self.record_file = library / 'approved/fixture.json'; self.record_file.write_text(json.dumps(self.record))
        revision = hashlib.sha256(self.record_file.read_bytes()).hexdigest(); profile['record_revision'] = revision
        self.plan = {'worker_id': 'fixture', 'record_file': str(self.record_file), 'record_revision': revision, 'profile': profile}
        self.apis = {'candidate': API(), 'previous': API()}
        for api in self.apis.values(): api.cache_tokens = 500000
        self.qualifiers = {key: NativeQualification(value, profile['native_url'], copy.deepcopy(CONTRACT)) for key, value in self.apis.items()}
        self.publisher = self.publish

    def publish(self, plan, folder, which, current):
        self.assertTrue(self.control.worker['drained'])
        self.assertEqual(json.loads((folder / ('qualification-' + which) / 'result.json').read_text())['state'], 'passed')
        self.published.append(which)
        return {'state': 'recorded', 'scope': 'Fixture publisher, not a real configuration-library update.'}

    def execute(self, measurement=None):
        return ServingOperation(self.plan, self.folder, driver=self.driver, maintenance=self.maintenance,
            candidate_qualifier=self.qualifiers['candidate'], previous_qualifier=self.qualifiers['previous'],
            publish=self.publisher, progress=lambda *args: self.events.append(args), sleep=lambda _: None, measurement=measurement).run()

    def test_apply_full_qualification_publish_and_readmit(self):
        result = self.execute()
        self.assertEqual(result['state'], 'completed'); self.assertEqual(self.published, ['candidate'])
        self.assertFalse(self.docker.old['State']['Running']); self.assertTrue(self.docker.containers[NEW]['State']['Running'])
        self.assertFalse(self.control.worker['drained']); self.assertEqual(len(self.apis['candidate'].calls), 16)
        count = len(self.docker.calls); self.assertEqual(self.execute(), result); self.assertEqual(len(self.docker.calls), count)

    def test_failed_candidate_restores_and_qualifies_previous_before_readmission(self):
        self.apis['candidate'].context = 8192
        result = self.execute()
        self.assertEqual(result['state'], 'restored'); self.assertEqual(self.published, ['previous'])
        self.assertTrue(self.docker.old['State']['Running']); self.assertFalse(self.docker.containers[NEW]['State']['Running'])
        self.assertFalse(self.control.worker['drained']); self.assertEqual(signature(self.docker.old), self.plan['profile']['before'])

    def test_temporary_return_observation_failure_does_not_strand_original_or_repeat_actions(self):
        self.apis['candidate'].context = 8192
        ready = self.qualifiers['previous'].ready
        observe = self.driver.observe
        pending = [False]
        def first_ready():
            self.qualifiers['previous'].ready = ready
            pending[0] = True
            return False
        def transient_observe(*args):
            if pending[0]:
                pending[0] = False
                raise RemoteObservationUnavailable('Fixture read timeout')
            return observe(*args)
        self.qualifiers['previous'].ready = first_ready
        self.driver.observe = transient_observe
        self.assertEqual(self.execute()['state'], 'restored')
        self.assertFalse(self.control.worker['drained'])
        self.assertEqual(self.docker.calls.count('start-a'), 1)
        self.assertEqual(self.docker.calls.count('start-b'), 1)
        self.assertEqual(len(self.apis['previous'].calls), 17)  # baseline metric + normal full qualification
        self.assertTrue(any(phase == 'waiting_observation' for phase, _ in self.events))

    def test_confirmed_return_identity_failure_is_not_retried(self):
        self.apis['candidate'].context = 8192
        observe = self.driver.observe
        def drift(*args):
            state = observe(*args)
            if state['state'] == 'restored_unverified': state['state'] = 'requires_reconciliation'
            return state
        self.driver.observe = drift
        self.assertEqual(self.execute()['state'], 'requires_reconciliation')
        self.assertTrue(self.control.worker['drained'])
        self.assertEqual(self.published, [])
        self.assertFalse(any(phase == 'waiting_observation' for phase, _ in self.events))

    def test_cache_loss_restores_original_even_when_original_startup_capacity_varies(self):
        self.apis['candidate'].cache_tokens = 499999
        restore = self.driver.restore
        def restore_with_less_cache(*args):
            restore(*args)
            self.apis['previous'].cache_tokens = 480000
        self.driver.restore = restore_with_less_cache
        result = self.execute()
        self.assertEqual(result['state'], 'restored'); self.assertEqual(self.published, ['previous'])
        self.assertFalse(self.control.worker['drained'])
        proof = json.loads((self.folder / 'qualified-candidate.json').read_text())
        self.assertEqual(proof['cache_capacity_acceptance']['reason'], 'exceeds_reviewed_allowance')
        comparison = json.loads((self.folder / 'cache-comparison-previous.json').read_text())
        self.assertEqual(comparison['delta_tokens'], -20000)

    def test_explicit_reviewed_allowance_accepts_exact_boundary(self):
        self.plan['cache_capacity_policy'] = {'max_loss_percent': 4}
        self.apis['candidate'].cache_tokens = 480000
        self.assertEqual(self.execute()['state'], 'completed')

    def test_loss_beyond_reviewed_allowance_restores(self):
        self.plan['cache_capacity_policy'] = {'max_loss_percent': 4}
        self.apis['candidate'].cache_tokens = 479999
        self.assertEqual(self.execute()['state'], 'restored')

    def test_missing_baseline_returns_unchanged_without_docker_mutations(self):
        self.apis['previous'].cache_tokens = None
        self.assertEqual(self.execute()['state'], 'failed_unchanged')
        self.assertEqual(self.docker.calls, []); self.assertFalse(self.control.worker['drained'])
        self.assertEqual(json.loads((self.folder / 'cache-preflight.json').read_text())['reason'], 'baseline_capacity_unavailable')

    def test_missing_candidate_measurement_restores_even_with_allowance(self):
        self.plan['cache_capacity_policy'] = {'max_loss_percent': 4}
        self.apis['candidate'].cache_tokens = None
        self.assertEqual(self.execute()['state'], 'restored')

    def test_missing_final_capacity_cannot_use_an_earlier_sample_to_adopt(self):
        def lose_final_metric(route, body, result):
            if route == '/v1/chat/completions': self.apis['candidate'].cache_tokens = None
            return result
        self.apis['candidate'].mutate = lose_final_metric
        self.assertEqual(self.execute()['state'], 'restored')
        proof = json.loads((self.folder / 'qualified-candidate.json').read_text())
        self.assertEqual(proof['cache_capacity_acceptance']['reason'], 'capacity_unavailable')

    def test_invalid_allowances_fail_before_drain(self):
        for loss in (True, -1, 100, float('nan'), float('inf'), '4'):
            self.plan['cache_capacity_policy'] = {'max_loss_percent': loss}
            with self.assertRaises(ValueError): self.execute()
        self.assertEqual(self.control.calls, []); self.assertEqual(self.docker.calls, [])

    def test_acknowledged_candidate_startup_failure_restores_without_waiting_for_a_dead_api(self):
        start = self.docker.start
        def fail_candidate(cid):
            start(cid)
            if cid == NEW: self.docker.containers[cid]['State']['Running'] = False
        self.docker.start = fail_candidate
        result = self.execute()
        self.assertEqual(result['state'], 'restored'); self.assertEqual(len(self.apis['candidate'].calls), 0)
        self.assertTrue(self.docker.old['State']['Running']); self.assertFalse(self.control.worker['drained'])

    def test_failed_restoration_qualification_keeps_hold_and_never_reports_healthy(self):
        self.apis['candidate'].context = self.apis['previous'].context = 8192
        result = self.execute()
        self.assertEqual(result['state'], 'requires_reconciliation'); self.assertTrue(self.control.worker['drained'])
        self.assertEqual(len(self.control.worker['maintenance_locks']), 1); self.assertEqual(self.published, [])

    def test_missing_or_wrongly_scoped_restoration_evidence_stops_before_drain(self):
        self.record['restoration']['change_classes']['serving_flags']['retained_container_id'] = NEW
        self.record_file.write_text(json.dumps(self.record)); self.plan['record_revision'] = hashlib.sha256(self.record_file.read_bytes()).hexdigest()
        self.plan['profile']['record_revision'] = self.plan['record_revision']
        with self.assertRaisesRegex(ValueError, 'retained restoration'): self.execute()
        self.assertEqual(self.control.calls, []); self.assertEqual(self.docker.calls, [])

    def test_additional_recorded_success_checks_cannot_be_silently_ignored(self):
        self.record['restoration']['change_classes']['serving_flags']['success_checks'].append('hourglass_score')
        self.record_file.write_text(json.dumps(self.record))
        self.plan['profile']['record_revision'] = self.plan['record_revision'] = hashlib.sha256(self.record_file.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'every success check'): self.execute()
        self.assertEqual(self.control.calls, []); self.assertEqual(self.docker.calls, [])

    def test_ambiguous_apply_does_not_replay(self):
        self.docker.fail = 'start-b'
        result = self.execute()
        self.assertEqual(result['state'], 'requires_reconciliation'); self.assertTrue(self.control.worker['drained'])
        count = len(self.docker.calls); self.execute(); self.assertEqual(len(self.docker.calls), count)
        self.assertNotIn('start-a', self.docker.calls)

    def test_failed_stopped_candidate_creation_returns_unchanged_worker(self):
        self.docker.fail = 'create'
        result = self.execute()
        self.assertEqual(result['state'], 'failed_unchanged')
        self.assertTrue(self.docker.old['State']['Running']); self.assertEqual(self.docker.old['State']['StartedAt'], 'original')
        self.assertFalse(self.control.worker['drained']); self.assertEqual(self.published, [])
        self.assertEqual(self.docker.calls, ['create'])

    def test_uncertain_stop_is_not_treated_as_an_unchanged_worker(self):
        self.docker.fail = 'stop-a'
        result = self.execute()
        self.assertEqual(result['state'], 'requires_reconciliation'); self.assertTrue(self.control.worker['drained'])
        self.assertTrue(self.docker.old['State']['Running'])

    def test_record_drift_during_startup_stops_further_actions(self):
        def change(route, body, result):
            if route == '/v1/models': self.record_file.write_text(self.record_file.read_text() + ' ')
            return result
        self.apis['candidate'].mutate = change
        result = self.execute()
        self.assertEqual(result['state'], 'requires_reconciliation')
        self.assertTrue(self.control.worker['drained']); self.assertEqual(self.published, [])
        self.assertNotIn('start-a', self.docker.calls)

    def test_a_serial_api_qualifier_cannot_claim_changed_concurrency_is_qualified(self):
        self.plan['profile']['create']['Cmd'][3] = '2'
        with self.assertRaisesRegex(ValueError, 'changed native concurrency'): self.execute()
        self.assertEqual(self.control.calls, []); self.assertEqual(self.docker.calls, [])

    def test_enrolled_two_request_candidate_runs_full_checks_before_readmission(self):
        self.plan['profile']['create']['Cmd'][3]='2'
        api=ParallelAPI();api.cache_tokens=500000
        self.qualifiers['candidate']=NativeQualification(api,self.plan['profile']['native_url'],{**CONTRACT,'concurrency':2})
        result=self.execute()
        self.assertEqual(result['state'],'completed');self.assertEqual(self.published,['candidate'])
        proof=json.loads((self.folder/'qualification-candidate/result.json').read_text())
        self.assertEqual(proof['concurrency']['peak_running'],2);self.assertFalse(self.control.worker['drained'])

    def test_failed_concurrent_tools_restore_and_qualify_the_original_serial_server(self):
        self.plan['profile']['create']['Cmd'][3]='2'
        api=ParallelAPI();api.bad_tool=True
        self.qualifiers['candidate']=NativeQualification(api,self.plan['profile']['native_url'],{**CONTRACT,'concurrency':2})
        result=self.execute()
        self.assertEqual(result['state'],'restored');self.assertEqual(self.published,['previous'])
        self.assertTrue(self.docker.old['State']['Running']);self.assertFalse(self.control.worker['drained'])
        previous=json.loads((self.folder/'qualification-previous/result.json').read_text())
        self.assertEqual(previous['state'],'passed');self.assertNotIn('native_concurrency',previous['checks_passed'])

    def test_qualification_of_another_endpoint_cannot_approve_this_candidate(self):
        self.qualifiers['candidate'].url = 'http://127.0.0.1:9999'
        with self.assertRaisesRegex(ValueError, 'reviewed direct serving endpoint'): self.execute()
        self.assertEqual(self.control.calls, []); self.assertEqual(self.docker.calls, [])

    def test_holding_another_worker_does_not_authorize_this_server_change(self):
        self.maintenance.worker_id = 'another-worker'
        with self.assertRaisesRegex(ValueError, 'same operation'): self.execute()
        self.assertEqual(self.control.calls, []); self.assertEqual(self.docker.calls, [])

    def test_unexpected_gateway_work_prevents_qualification_inference(self):
        def busy(route, body, result):
            if route == '/v1/models': self.control.worker['load'] = 1
            return result
        self.apis['candidate'].mutate = busy
        result = self.execute()
        self.assertEqual(result['state'], 'requires_reconciliation')
        self.assertFalse(any(body is not None for _, body in self.apis['candidate'].calls))
        self.assertTrue(self.control.worker['drained']); self.assertEqual(self.published, [])

    def test_unconfirmed_record_publication_keeps_hold_and_does_not_repeat_it(self):
        calls = []
        def fail(*args): calls.append('published-or-uncertain'); raise OSError('Lost publication acknowledgement')
        self.publisher = fail
        self.assertEqual(self.execute()['state'], 'requires_reconciliation')
        self.assertTrue(self.control.worker['drained']); self.assertEqual(calls, ['published-or-uncertain'])
        self.execute(); self.assertEqual(calls, ['published-or-uncertain'])

    def test_restart_during_record_publication_cannot_inherit_old_qualification(self):
        def publish(*args):
            self.docker.containers[NEW]['State']['StartedAt'] = 'unexpected-later-start'
            return {'state': 'recorded'}
        self.publisher = publish
        result = self.execute()
        self.assertEqual(result['state'], 'requires_reconciliation')
        self.assertTrue(self.control.worker['drained']); self.assertEqual(len(self.control.worker['maintenance_locks']), 1)

    def test_preexisting_owner_pause_survives_a_successful_serving_change(self):
        self.control.worker.update(operator_paused=True, drained=True)
        result = self.execute()
        self.assertEqual(result['state'], 'completed'); self.assertEqual(result['readmission']['state'], 'left_to_operator')
        self.assertTrue(self.control.worker['drained'])


if __name__ == '__main__': unittest.main()
