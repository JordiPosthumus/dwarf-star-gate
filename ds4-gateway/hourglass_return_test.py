import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import hourglass_executor as entry
import hourglass_native_test as fixture
from docker_profile import digest
from operation_maintenance import Maintenance
from operation_maintenance_test import Fixture
from operation_runner import reconciliation, save, lock_file


class ReturnTest(unittest.TestCase):
    def setUp(self):
        self.f = fixture.NativeAdapterTest(); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name) / self.f.plan['id']; self.folder.mkdir()
        self.control = Fixture(); self.control.worker['url'] = self.f.plan['hourglass']['endpoint']
        self.maintenance = Maintenance(self.folder, self.folder.name, 'fixture', control=self.control,
            purpose='hourglass', sleep=lambda _: None)
        self.maintenance.acquire(); self.control.calls.clear()
        save(self.folder, 'native-acceptance.json', {'job_id': 'e' * 32})
        self.f.state['jobs']['done'] = [{'id': 'e' * 32, 'model': 'fixture', 'state': 'completed'}]
        self.patcher = patch.object(entry, 'components', return_value=(self.maintenance, self.f.native))
        self.patcher.start(); self.addCleanup(self.patcher.stop)

    def review(self): return entry.inspect_reconciliation(self.f.plan, self.folder, lambda *a: None)

    def approve(self, revision=None):
        save(self.folder, 'reconcile-approved.json', {'actor': 'owner', 'review_revision': revision or digest(self.review())})

    def test_review_is_read_only_and_approved_return_releases_only_original_hold(self):
        old = b'{"state":"requires_reconciliation","original":"preserved"}\n'
        (self.folder / 'runner-result.json').write_bytes(old)
        review = self.review(); self.assertEqual(review['job_id'], 'e' * 32)
        self.assertTrue(all(c == ('/workers', None) for c in self.control.calls))
        self.approve(); result = entry.reconcile(self.f.plan, self.folder, lambda *a: None)
        self.assertEqual(result['state'], 'completed')
        self.assertEqual(result['measurement']['readmission']['state'], 'readmitted')
        self.assertFalse(self.control.worker['drained'])
        self.assertEqual((self.folder / 'runner-result.json').read_bytes(), old)
        self.assertFalse(any(c[0] == 'POST' for c in self.f.calls))

    def test_missing_acceptance_and_running_native_job_cannot_be_returned(self):
        self.f.state['jobs']['done'][0]['state'] = 'running'
        with self.assertRaisesRegex(ValueError, 'not confirmed finished'): self.review()
        (self.folder / 'native-acceptance.json').unlink()
        with self.assertRaisesRegex(ValueError, 'acceptance is unknown'): self.review()
        self.assertTrue(self.control.worker['drained'])
        self.assertTrue(all(c == ('/workers', None) for c in self.control.calls))

    def test_busy_native_changed_target_and_operator_decision_block_return(self):
        self.f.docker.idle = lambda _: False
        with self.assertRaises(ValueError): self.review()
        self.f.docker.idle = lambda _: True
        self.f.docker.old['State']['StartedAt'] = 'changed'
        with self.assertRaises(ValueError): self.review()
        self.f.docker.old['State']['StartedAt'] = 'original'
        self.control.worker['last_operator_action'] = {'id': 'later'}
        with self.assertRaises(RuntimeError): self.review()
        self.assertTrue(all(c == ('/workers', None) for c in self.control.calls))

    def test_stale_review_does_not_release_and_uncertain_readmission_is_not_repeated(self):
        self.approve('f' * 64)
        with self.assertRaisesRegex(ValueError, 'exact observed'): entry.reconcile(self.f.plan, self.folder, lambda *a: None)
        self.assertTrue(all(c == ('/workers', None) for c in self.control.calls))
        save(self.folder, 'readmission-intent.json', {'job_id': 'e' * 32})
        with self.assertRaisesRegex(ValueError, 'already began'): self.review()


class ReturnSupervisorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve(); self.folder = root / '11111111-1111-1111-1111-111111111111'; self.folder.mkdir()
        record = root / 'record.json'; record.write_text('{}')
        source = self.folder / 'executor.py'
        source.write_text("def inspect_reconciliation(plan, folder, progress): return {'worker_id':'fixture'}\n"
            "def reconcile(plan, folder, progress):\n (folder/'called-once').open('x').close()\n return {'state':'completed'}\n")
        record_revision = hashlib.sha256(record.read_bytes()).hexdigest()
        plan = {'worker_id': 'fixture', 'record_file': str(record), 'record_revision': record_revision,
            'execution': {'path': str(source), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}}
        raw = json.dumps(plan).encode(); (self.folder / 'plan.json').write_bytes(raw)
        binding = {'plan_revision': hashlib.sha256(raw).hexdigest(), 'record_revision': record_revision, 'actor': 'owner'}
        for name in ['prepared.json', 'approved.json', 'launch-intent.json']: save(self.folder, name, binding)
        save(self.folder, 'proposal.json', {'id': self.folder.name, 'worker_id': 'fixture'})
        save(self.folder, 'runner-started.json', {'pid': os.getpid()})

    def test_live_original_process_or_owned_lock_cannot_be_reconciled(self):
        with self.assertRaisesRegex(ValueError, 'may still be active'): reconciliation(self.folder)
        save(self.folder, 'runner-result.json', {'state': 'requires_reconciliation'})
        fd = lock_file(self.folder)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            with self.assertRaisesRegex(ValueError, 'owns the runner lock'): reconciliation(self.folder)
        finally: os.close(fd)
        self.assertFalse((self.folder / 'reconcile-started.json').exists())

    def test_exact_owner_return_is_once_and_preserves_original_outcome(self):
        save(self.folder, 'runner-result.json', {'state': 'requires_reconciliation'})
        original = (self.folder / 'runner-result.json').read_bytes()
        review = reconciliation(self.folder)
        with self.assertRaisesRegex(ValueError, 'owner approval'): reconciliation(self.folder, execute=True)
        binding = {k: review[k] for k in ['plan_revision', 'review_revision']}
        save(self.folder, 'reconcile-approved.json', {**binding, 'actor': 'owner'})
        save(self.folder, 'reconcile-launch-intent.json', binding)
        result = reconciliation(self.folder, execute=True)
        self.assertEqual(result['result']['state'], 'completed')
        self.assertEqual(reconciliation(self.folder, execute=True)['state'], 'already_attempted')
        self.assertEqual((self.folder / 'runner-result.json').read_bytes(), original)


if __name__ == '__main__': unittest.main()
