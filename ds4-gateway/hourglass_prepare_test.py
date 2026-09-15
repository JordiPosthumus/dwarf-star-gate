import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import hourglass_native_test as native_fixture
from hourglass_prepare import prepare
from operation_maintenance_test import Fixture
from operation_runner import approved_plan


class PreparationTest(unittest.TestCase):
    def setUp(self):
        self.native = native_fixture.NativeAdapterTest()
        self.native.setUp()
        self.addCleanup(self.native.doCleanups)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.folder = self.root / self.native.plan['id']
        self.folder.mkdir()
        self.library = self.root / 'records'
        (self.library / 'approved').mkdir(parents=True)
        self.file = self.library / 'approved/fixture.json'
        self.file.write_text(json.dumps({'schema': 1, 'worker_id': 'fixture', 'kind': 'approved',
            'approval': {'at': '2026-09-15T00:00:00Z', 'reference': 'fixture-owner'},
            'model': {'name': 'native-model'}}))
        self.raw = self.file.read_bytes()
        self.revision = hashlib.sha256(self.raw).hexdigest()
        self.git('init', '-q')
        self.git('add', 'approved/fixture.json')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
            '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture approved record')
        p = self.native.plan
        self.enrollment = {'worker_id': 'fixture', 'records_directory': str(self.library),
            'container': p['native_target']['container_id'], 'native_url': p['native_target']['url'], **p['target'],
            'hourglass': {'url': p['hourglass']['url'], 'model': 'fixture', 'endpoint': p['hourglass']['endpoint']}}
        self.prepared = {'controller': 'fixture', 'payload': copy.deepcopy(p['native_request']),
            'review': {'id': self.folder.name, 'model': 'fixture', 'model_id': 'native-model',
                'endpoint': p['hourglass']['endpoint'], 'window_seconds': 3600, 'question_count': 1,
                'models_revision': 'b' * 64, 'hardware_revision': 'c' * 64,
                **{k: p['hourglass'][k] for k in ['metric', 'scoring_policy', 'benchmark_version']}}}
        self.proposal = {'id': self.folder.name, 'worker_id': 'fixture'}
        self.control = Fixture()
        self.control.worker.update(url=p['hourglass']['endpoint'], load=1, queued=2)
        self.native.docker.idle = lambda _: self.fail('Preparation must not wait for or require an idle server')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.library), *args], capture_output=True, check=True).stdout

    def prepare(self):
        return prepare(self.proposal, self.enrollment, self.prepared, self.folder, self.revision,
            docker=self.native.docker, control=self.control)

    def assert_read_only(self):
        self.assertTrue(all(c[0] == 'GET' for c in self.native.calls))
        self.assertTrue(all(c == ('/workers', None) for c in self.control.calls))
        self.assertEqual(self.native.docker.calls, [])
        self.assertFalse(self.control.worker['drained'])
        self.assertFalse((self.folder / 'approved.json').exists())
        self.assertFalse((self.folder / 'native-start-intent.json').exists())

    def test_busy_worker_can_prepare_exact_frozen_plan_without_start_or_record_change(self):
        result = self.prepare()
        self.assert_read_only()
        self.assertEqual(self.file.read_bytes(), self.raw)
        self.assertEqual(self.git('status', '--porcelain'), b'')
        plan = result['plan']
        self.assertEqual(plan['native_request'], self.prepared['payload'])
        self.assertEqual(plan['native_target'], self.native.plan['native_target'])
        self.assertEqual(result['review']['observed']['command'], self.native.docker.old['Config']['Cmd'])
        self.assertEqual(plan['execution']['sha256'], hashlib.sha256((self.folder / 'executor.py').read_bytes()).hexdigest())
        self.assertEqual({p.name for p in self.folder.iterdir()}, {'executor.py', 'executor-sources.json'})
        # Actual runner approval validation accepts this preparation. It still
        # requires independent owner approval and launch receipts to be written.
        data = json.dumps(plan).encode()
        (self.folder / 'plan.json').write_bytes(data)
        (self.folder / 'proposal.json').write_text(json.dumps(self.proposal))
        binding = {'plan_revision': hashlib.sha256(data).hexdigest(), 'record_revision': self.revision, 'actor': 'owner'}
        for name in ['prepared.json', 'approved.json', 'launch-intent.json']:
            (self.folder / name).write_text(json.dumps(binding))
        self.assertEqual(approved_plan(self.folder)[0], plan)
        self.file.write_text(self.file.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, 'record changed'):
            approved_plan(self.folder)

    def test_changed_native_review_rejected_before_freezing_or_posting(self):
        changes = [lambda: self.native.health.update(controller_instance='replacement'),
            lambda: self.native.state['tasks'][0].update(task_bundle_sha='f' * 64),
            lambda: self.native.state.update(models_revision='f' * 64),
            lambda: self.native.state['model_configs'][0].update(base_url='http://127.0.0.1:9/v1'),
            lambda: self.prepared['review'].update(question_count=2)]
        for change in changes:
            saved = copy.deepcopy((self.native.health, self.native.state, self.prepared))
            change()
            with self.assertRaises(ValueError): self.prepare()
            self.assertFalse((self.folder / 'executor.py').exists())
            self.native.health, self.native.state, self.prepared = saved
        self.assert_read_only()

    def test_stale_route_missing_worker_and_missing_readmission_support_rejected(self):
        changes = [lambda: self.control.worker.update(url='http://127.0.0.1:38001/v1'),
            lambda: self.control.worker.update(id='another'), lambda: setattr(self.control, 'version', 0)]
        for change in changes:
            saved = copy.deepcopy((self.control.worker, self.control.version))
            change()
            with self.assertRaisesRegex(ValueError, 'gateway worker'): self.prepare()
            self.control.worker, self.control.version = saved
        self.assert_read_only()
        self.assertFalse((self.folder / 'executor.py').exists())

    def test_uncommitted_or_changed_reference_is_not_bound_as_approved(self):
        self.file.write_text(self.file.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, 'record changed'): self.prepare()
        self.revision = hashlib.sha256(self.file.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'Commit or reconcile'): self.prepare()
        self.assert_read_only()
        self.assertFalse((self.folder / 'executor.py').exists())

    def test_model_cannot_supply_connections_or_executor(self):
        self.proposal['execution'] = {'path': '/untrusted.py'}
        with self.assertRaisesRegex(ValueError, 'Identify'): self.prepare()
        self.assert_read_only()
        self.assertEqual(self.native.calls, [])

    def test_restart_during_observation_invalidates_preparation(self):
        original = self.native.docker.inspect
        count = 0
        def inspect(name):
            nonlocal count
            count += 1
            if count == 2: self.native.docker.old['State']['StartedAt'] = 'restarted'
            return original(name)
        self.native.docker.inspect = inspect
        with self.assertRaisesRegex(ValueError, 'identity changed'): self.prepare()
        self.assert_read_only()
        self.assertFalse((self.folder / 'executor.py').exists())


if __name__ == '__main__':
    unittest.main()
