import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from recovery_pair_test import Fixture
from recovery_pair import fingerprint
from recovery_pair_native import capture_pair, private_read, private_save

spec = importlib.util.spec_from_file_location('enrollment_bridge', Path(__file__).with_name('recovery-pair-enrollment.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.f = Fixture()
        self.reads = 0
        for i, row in enumerate(self.f.observations):
            row['fault'] = None
            row['machine_identity'] = {'scheme': 'linux-machine-id-and-gpu-uuid-v1', 'os_machine_id_sha256': 'a' * 64,
                                       'gpu_uuids': ['GPU-' + str(uuid4())]}
            row['machine'] = fingerprint(row['machine_identity'])
        self.binding = {k: self.f.enrollment[k] for k in ('worker_id', 'model', 'port', 'context_length', 'concurrency')}
        self.binding['members'] = [{k: m[k] for k in ('ssh', 'container', 'recipe_root')} for m in self.f.enrollment['members']]
        owner = self
        class Reader:
            def __init__(self, binding): self.enrollment = binding
            def observe(self):
                owner.reads += 1
                return copy.deepcopy(owner.f.observations)
        self.reader = Reader
        self.evidence = capture_pair(self.binding, Reader)
        self.route = {'id': self.binding['worker_id'], 'url': 'http://192.0.2.1:8888/v1'}
        self.evidence['route'] = self.route
        self.action = str(uuid4())
        self.capture = self.root / self.action
        self.capture.mkdir(mode=0o700)
        self.request = {'action_id': self.action, 'worker_id': self.binding['worker_id'], 'binding': self.binding, 'route': self.route}
        self.expected = {'worker_id': self.binding['worker_id'], 'binding': self.binding, 'route': self.route,
                         'gateway_socket': str(self.root / 'control.sock')}
        self.destination = self.root / 'enrolled'
        self.save_capture()

    def save_capture(self):
        private_save(self.capture / 'request.json', self.request)
        private_save(self.capture / 'evidence.json', self.evidence)
        private_save(self.capture / 'receipt.json', {'state': 'prepared', 'action_id': self.action,
                     'worker_id': self.binding['worker_id'], 'request_hash': fingerprint(self.request),
                     'evidence_sha256': fingerprint(self.evidence)})

    def run_export(self):
        return bridge.materialize(self.capture, self.destination, self.expected, self.reader)

    def test_pins_current_native_pair_and_preserves_identical_private_materialization(self):
        result = self.run_export()
        first = (self.destination / 'pair.json').read_bytes()
        again = self.run_export()
        self.assertEqual(result, again)
        self.assertEqual(first, (self.destination / 'pair.json').read_bytes())
        self.assertEqual(private_read(self.destination / 'pair.json')['enrollment'], self.evidence['enrollment'])
        self.assertEqual(result['context_length'], 400000)
        self.assertEqual(result['concurrency'], 2)
        self.assertEqual(self.reads, 6)
        self.assertEqual(self.f.commands, [])

    def test_tampered_receipt_and_changed_route_refuse_before_creating_binding(self):
        receipt = private_read(self.capture / 'receipt.json');receipt['evidence_sha256'] = '0' * 64
        private_save(self.capture / 'receipt.json', receipt)
        with self.assertRaisesRegex(ValueError, 'receipt_unverified'): self.run_export()
        self.save_capture();self.expected['route'] = {**self.route, 'url': 'http://192.0.2.2:8888/v1'}
        with self.assertRaisesRegex(ValueError, 'binding_changed'): self.run_export()
        self.assertFalse(self.destination.exists())

    def test_current_native_epoch_configuration_file_and_capacity_drift_refuse(self):
        original = copy.deepcopy(self.f.observations)
        changes = [lambda r: r[0]['container']['State'].update(StartedAt='2026-02-02T00:00:00Z'),
                   lambda r: r[1]['container']['Config'].update(Cmd=['other']),
                   lambda r: r[0]['files']['/fixture/recipe/.env'].update(sha256='f' * 64),
                   lambda r: r[0].update(listener_owned=False)]
        for change in changes:
            self.f.observations = copy.deepcopy(original);change(self.f.observations)
            with self.assertRaises(ValueError): self.run_export()
            self.assertFalse(self.destination.exists())

    def test_legacy_hardware_evidence_is_not_enrollment_authority(self):
        self.evidence['after'][0].pop('machine_identity');self.save_capture()
        with self.assertRaisesRegex(ValueError, 'hardware_identity_unverified'): self.run_export()

    def test_existing_private_definition_is_never_overwritten(self):
        self.run_export();p = self.destination / 'pair.json';old = private_read(p)
        old['gateway_socket'] = '/different/socket';private_save(p, old);before = p.read_bytes()
        with self.assertRaisesRegex(ValueError, 'existing_enrollment_changed'): self.run_export()
        self.assertEqual(p.read_bytes(), before)


if __name__ == '__main__': unittest.main()
