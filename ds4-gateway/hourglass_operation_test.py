import copy
import tempfile
from pathlib import Path
import unittest
import uuid

from hourglass_operation import HourglassOperation
from operation_maintenance import Maintenance
from operation_maintenance_test import Fixture
from operation_runner import read


class Native:
    def __init__(self):
        self.calls = []
        self.states = ['running', 'completed']
        self.target = True

    def check_target(self):
        return self.target

    def idle(self):
        self.calls.append(('idle',))
        return True

    def submit(self, request):
        self.calls.append(('submit', copy.deepcopy(request)))
        return {'job_id': 'a' * 32}

    def observe(self, job):
        self.calls.append(('observe', job))
        state = self.states.pop(0)
        if isinstance(state, Exception):
            raise state
        return {'state': state}


class MeasurementTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.control, self.native = Fixture(), Native()
        self.id = str(uuid.uuid4())
        self.plan = {'id': self.id, 'worker_id': 'fixture', 'native_request': {'model': 'fixture', 'models_revision': 'b' * 64}}
        self.maintenance = Maintenance(self.root, self.id, 'fixture', control=self.control,
            sleep=lambda _: None, purpose='hourglass')

    def operation(self, **kwargs):
        return HourglassOperation(self.plan, self.root, maintenance=self.maintenance,
            native=self.native, sleep=lambda _: None, **kwargs)

    def test_owned_measurement_finishes_and_readmits_without_changing_native_settings(self):
        result = self.operation().run()
        self.assertEqual(result['native_state'], 'completed')
        self.assertEqual(result['readmission']['state'], 'readmitted')
        self.assertFalse(self.control.worker['drained'])
        self.assertEqual([c for c in self.native.calls if c[0] == 'submit'], [('submit', self.plan['native_request'])])
        self.assertEqual(self.operation().run(), result)
        self.assertEqual(sum(c[0] == 'submit' for c in self.native.calls), 1)
        lock = next(body for route, body in self.control.calls if route == '/maintenance-lock')
        self.assertEqual(lock['name'], 'Approved Hourglass measurement')

    def test_uncertain_start_is_never_repeated_and_its_hold_remains(self):
        def lost(request):
            self.native.calls.append(('submit', request))
            raise RuntimeError('Lost acceptance')
        self.native.submit = lost
        with self.assertRaisesRegex(RuntimeError, 'Lost acceptance'):
            self.operation().run()
        with self.assertRaisesRegex(RuntimeError, 'uncertain'):
            self.operation().run()
        self.assertEqual(sum(c[0] == 'submit' for c in self.native.calls), 1)
        self.assertTrue(self.control.worker['maintenance_locks'])

    def test_observation_timeout_and_unknown_state_follow_same_receipt(self):
        self.native.states = [TimeoutError(), 'unknown', 'completed']
        events = []
        self.operation(progress=lambda *e: events.append(e)).run()
        self.assertEqual(sum(c[0] == 'submit' for c in self.native.calls), 1)
        self.assertEqual([c[1] for c in self.native.calls if c[0] == 'observe'], ['a' * 32] * 3)
        self.assertEqual(sum(e[0] == 'observation_unavailable' for e in events), 2)

    def test_resume_known_receipt_after_observer_exit_does_not_submit_again(self):
        def interruption(*event):
            if event[0] == 'measuring':
                raise RuntimeError('Observer stopped')
        with self.assertRaisesRegex(RuntimeError, 'Observer stopped'):
            self.operation(progress=interruption).run()
        self.assertIsNotNone(read(self.root / 'native-acceptance.json'))
        self.operation().run()
        self.assertEqual(sum(c[0] == 'submit' for c in self.native.calls), 1)

    def test_new_manual_pause_is_preserved(self):
        def pause(*event):
            if event[0] == 'measuring':
                self.control.worker['operator_paused'] = True
                self.control.worker['last_operator_action'] = {'id': 'new-pause'}
        with self.assertRaisesRegex(RuntimeError, 'operator decision changed'):
            self.operation(progress=pause).run()
        self.assertTrue(self.control.worker['drained'])
        self.assertFalse(any(route == '/resume-workers' for route, _ in self.control.calls))

    def test_changed_target_after_measurement_is_not_readmitted(self):
        checks = iter([True, True, False])
        self.native.check_target = lambda: next(checks)
        with self.assertRaisesRegex(RuntimeError, 'Native target changed'):
            self.operation().run()
        self.assertTrue(self.control.worker['maintenance_locks'])
        self.assertFalse(any(route == '/resume-workers' for route, _ in self.control.calls))

    def test_changed_plan_cannot_reuse_a_saved_acceptance(self):
        def interrupted(*event):
            if event[0] == 'measuring':
                raise RuntimeError('Observer stopped')
        with self.assertRaises(RuntimeError):
            self.operation(progress=interrupted).run()
        self.plan['native_request']['model'] = 'different'
        with self.assertRaisesRegex(RuntimeError, 'plan changed'):
            self.operation().run()
        self.assertEqual(sum(c[0] == 'submit' for c in self.native.calls), 1)

    def test_unverified_target_cannot_acquire_a_hold_or_start_a_measurement(self):
        self.native.target = False
        with self.assertRaisesRegex(RuntimeError, 'not verified'):
            self.operation().run()
        self.assertEqual(self.control.calls, [])
        self.assertEqual(self.native.calls, [])

    def test_controller_terminal_waits_for_direct_work_to_end_before_release(self):
        idle = iter([True, True, False, True, True])
        self.native.idle = lambda: next(idle)
        self.native.states = ['error']
        result = self.operation().run()
        self.assertEqual(result['native_state'], 'error')
        self.assertEqual(result['readmission']['state'], 'readmitted')
        self.assertEqual(list(idle), [])

    def test_lost_readmission_response_is_not_replayed(self):
        self.control.lose_reply = '/resume-workers'
        with self.assertRaisesRegex(RuntimeError, 'Reply lost'):
            self.operation().run()
        with self.assertRaisesRegex(RuntimeError, 'readmission requires reconciliation'):
            self.operation().run()
        self.assertEqual(sum(route == '/resume-workers' for route, _ in self.control.calls), 1)


if __name__ == '__main__':
    unittest.main()
