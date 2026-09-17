import copy
import json
import unittest

import serving_operation_test as serving
import hourglass_native_test as native_fixture
from docker_profile import digest, signature
from docker_profile_test import NEW
from hourglass_operation import NativeStartRejected
from serving_trial import TrialMeasurement, prepare_trial


class TrialTest(unittest.TestCase):
    def setUp(self):
        self.f = serving.OperationTest('test_apply_full_qualification_publish_and_readmit')
        self.f.setUp(); self.addCleanup(self.f.doCleanups)
        f = self.f
        f.plan['trial'] = {'hourglass': {'endpoint': 'http://127.0.0.1:38011/v1'},
            'native_request': {'fixture': 'exact reviewed payload'}, 'model': 'fixture'}
        f.control.worker['url'] = f.plan['trial']['hourglass']['endpoint']
        self.submissions, self.observations, self.seen = [], iter(['running', 'completed']), []
        self.failure = None
        owner = self
        class Native:
            def __init__(self, plan, docker): owner.seen.append(copy.deepcopy(plan))
            def check_target(self): return f.docker.containers[NEW]['State']['Running']
            def idle(self): return True
            def submit(self, payload):
                owner.submissions.append(copy.deepcopy(payload))
                if owner.failure: raise owner.failure
                return {'job_id': 'e' * 32}
            def observe(self, job):
                owner.assertEqual(job, 'e' * 32)
                value = next(owner.observations)
                if isinstance(value, Exception): raise value
                return {'state': value}
        self.adapter = TrialMeasurement(f.plan, f.folder, f.docker, f.maintenance,
            lambda *a: f.events.append(a), factory=Native, sleep=lambda _: None)

    def test_successful_measurement_restores_original_and_never_adopts_candidate(self):
        f = self.f
        result = f.execute(self.adapter.run)
        self.assertEqual(result['state'], 'restored')
        self.assertEqual(result['trial']['state'], 'completed')
        self.assertEqual(f.published, ['previous'])
        self.assertTrue(f.docker.old['State']['Running'])
        self.assertFalse(f.docker.containers[NEW]['State']['Running'])
        self.assertFalse(f.control.worker['drained'])
        self.assertEqual(signature(f.docker.old), f.plan['profile']['before'])
        self.assertEqual(self.submissions, [f.plan['trial']['native_request']])
        self.assertEqual(self.seen[0]['native_target']['container_id'], NEW)
        self.assertEqual(self.seen[0]['native_target']['signature_sha256'], digest(signature(f.docker.containers[NEW])))
        count = len(f.docker.calls)
        self.assertEqual(f.execute(self.adapter.run), result)
        self.assertEqual(len(f.docker.calls), count)
        self.assertEqual(len(self.submissions), 1)

    def test_failed_qualification_skips_measurement_and_restores(self):
        self.f.apis['candidate'].context = 8192
        result = self.f.execute(self.adapter.run)
        self.assertEqual(result['trial']['state'], 'qualification_failed')
        self.assertEqual(self.submissions, [])
        self.assertEqual(self.f.published, ['previous'])

    def test_proven_measurement_rejection_restores_without_adoption(self):
        self.failure = NativeStartRejected()
        result = self.f.execute(self.adapter.run)
        self.assertEqual(result['trial']['state'], 'rejected_before_acceptance')
        self.assertEqual(self.f.published, ['previous'])
        self.assertFalse(self.f.control.worker['drained'])

    def test_transient_observation_keeps_same_job_without_restarting_it(self):
        self.observations = iter([OSError('fixture transport'), 'unknown', 'running', 'error'])
        result = self.f.execute(self.adapter.run)
        self.assertEqual(result['trial']['state'], 'error')
        self.assertEqual(len(self.submissions), 1)
        self.assertEqual(self.f.published, ['previous'])

    def test_uncertain_start_keeps_hold_and_does_not_cancel_possible_work(self):
        self.failure = RuntimeError('Lost acceptance')
        result = self.f.execute(self.adapter.run)
        self.assertEqual(result['state'], 'requires_reconciliation')
        self.assertTrue(self.f.control.worker['drained'])
        self.assertTrue(self.f.docker.containers[NEW]['State']['Running'])
        self.assertEqual(self.f.published, [])
        self.f.execute(self.adapter.run)
        self.assertEqual(len(self.submissions), 1)

    def test_missing_trial_adapter_fails_before_any_drain(self):
        with self.assertRaisesRegex(ValueError, 'measurement adapter'): self.f.execute()
        self.assertEqual(self.f.control.calls, [])
        self.assertEqual(self.f.docker.calls, [])


class PreparationTest(unittest.TestCase):
    def test_preparation_checks_actual_native_catalogue_without_posting(self):
        f = native_fixture.NativeAdapterTest('test_serving_identity_includes_full_configuration_startup_and_model')
        f.setUp(); self.addCleanup(f.doCleanups)
        p = f.plan
        prepared = {'url': p['hourglass']['url'], 'controller': 'fixture', 'payload': p['native_request'],
            'review': {'model_id': 'native-model', 'model': 'fixture', 'window_seconds': 3600, 'question_count': 1,
                **{k: p['native_request'][k] for k in ['models_revision', 'hardware_revision']},
                **{k: p['hourglass'][k] for k in ['endpoint', 'metric', 'benchmark_version', 'scoring_policy']}}}
        profile = {'native_url': p['native_target']['url'], 'before': signature(f.docker.old), 'started_at': 'original'}
        control = lambda _: {'conditional_resume_version': 1, 'workers': [{'id': 'fixture', 'url': p['hourglass']['endpoint']}]}
        trial = prepare_trial(prepared, profile, 'native-model', f.docker, control, 'fixture')
        self.assertEqual(trial['native_request'], p['native_request'])
        self.assertTrue(f.calls)
        self.assertFalse(any(row[0] == 'POST' for row in f.calls))
        f.state['model_configs'][0]['base_url'] = 'http://example.invalid/v1'
        with self.assertRaises(ValueError): prepare_trial(prepared, profile, 'native-model', f.docker, control, 'fixture')
        self.assertFalse(any(row[0] == 'POST' for row in f.calls))


if __name__ == '__main__': unittest.main()
