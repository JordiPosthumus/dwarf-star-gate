import copy
from pathlib import Path
import tempfile
import unittest
import uuid

from operation_maintenance import Maintenance, CHANNEL


class Fixture:
    def __init__(self):
        self.worker = {'id': 'fixture', 'drained': False, 'operator_paused': False,
                       'load': 0, 'queued': 0, 'holds': [], 'maintenance_locks': [], 'last_operator_action': None}
        self.recovery = {'worker_id': 'fixture', 'state': 'monitoring'}
        self.calls, self.receipts = [], {}
        self.lose_reply = None
        self.version = 1
        self.before_resume = None

    def __call__(self, route, body=None):
        self.calls.append((route, copy.deepcopy(body)))
        if route == '/workers':
            return {'conditional_resume_version': self.version, 'workers': [copy.deepcopy(self.worker)], 'recovery': {'workers': [copy.deepcopy(self.recovery)]}}
        if route == '/maintenance-receipt':
            return self.receipts[body['request_id']]
        if route == '/resume-workers':
            if self.before_resume: self.before_resume()
            if body['expected_operator_actions']['fixture'] != (self.worker['last_operator_action'] or {}).get('id'):
                raise RuntimeError('Operator action changed')
            if body['expected_maintenance_actions']['fixture'] != list(self.receipts)[-1]:
                raise RuntimeError('Maintenance action changed')
            if self.worker['holds'] or self.worker['maintenance_locks']:
                raise RuntimeError('Other hold')
            self.worker.update(drained=False, operator_paused=False, last_operator_action={'id': str(uuid.uuid4()), 'action': 'resume', 'control_channel': CHANNEL})
        else:
            action = 'lock' if route == '/maintenance-lock' else 'release'
            lock_id = str(uuid.uuid4()) if action == 'lock' else body['lock_id']
            if action == 'lock':
                self.worker['maintenance_locks'].append({'id': lock_id, 'control_channel': CHANNEL})
                self.worker['drained'] = True
            else:
                self.worker['maintenance_locks'] = [row for row in self.worker['maintenance_locks'] if row['id'] != lock_id]
                self.worker.update(operator_paused=True, drained=True)
            self.receipts[body['request_id']] = {'request_id': body['request_id'], 'action': action, 'control_channel': CHANNEL,
                                               'result': {'worker_id': 'fixture', 'lock_id': lock_id}}
        if self.lose_reply == route:
            self.lose_reply = None
            raise RuntimeError('Reply lost after committed action')
        return self.receipts.get(body.get('request_id'), {})


class MaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.control = Fixture()
        self.id = str(uuid.uuid4())
        self.events = []
        self.options = {'control': self.control, 'sleep': lambda _: None, 'progress': lambda *a: self.events.append(a)}
        self.window = Maintenance(self.temp.name, self.id, 'fixture', **self.options)

    def count(self, route):
        return sum(path == route for path, _ in self.control.calls)

    def test_owned_window_waits_for_gateway_and_direct_work_without_cancelling(self):
        self.control.worker['load'] = 1
        self.window.acquire()
        self.assertFalse(self.window.owned())
        def finish(_): self.control.worker['load'] = 0
        self.window.sleep = finish
        native = iter([False, True, True])
        self.window.wait_idle(lambda: next(native))
        self.assertTrue(self.window.owned())
        self.assertTrue(any(row[0] == 'waiting_idle' for row in self.events))
        self.assertEqual(set(path for path, _ in self.control.calls), {'/workers', '/maintenance-lock'})

    def test_uncertain_acquire_queries_same_receipt_without_second_lock(self):
        self.control.lose_reply = '/maintenance-lock'
        with self.assertRaisesRegex(RuntimeError, 'Reply lost'): self.window.acquire()
        restarted = Maintenance(self.temp.name, self.id, 'fixture', **self.options)
        receipt = restarted.acquire()
        self.assertEqual(receipt['request_id'], self.id)
        self.assertEqual(self.count('/maintenance-lock'), 1)
        self.assertEqual(self.count('/maintenance-receipt'), 1)
        self.assertEqual(len(self.control.worker['maintenance_locks']), 1)

    def test_missing_uncertain_receipt_is_not_permission_to_resubmit(self):
        self.control.lose_reply = '/maintenance-lock'
        with self.assertRaises(RuntimeError): self.window.acquire()
        self.control.receipts.clear()
        with self.assertRaises(KeyError): self.window.acquire()
        self.assertEqual(self.count('/maintenance-lock'), 1)

    def test_release_and_resume_are_distinct_and_only_the_owned_lock_is_released(self):
        self.window.acquire()
        self.window.release()
        self.assertTrue(self.control.worker['drained'])
        self.assertEqual(self.count('/resume-workers'), 0)
        result = self.window.resume_if_unchanged()
        self.assertEqual(result['state'], 'readmitted')
        self.assertFalse(self.control.worker['drained'])
        self.assertEqual(self.count('/resume-workers'), 1)
        self.assertEqual(self.window.resume_if_unchanged(), result)
        self.assertEqual(self.count('/resume-workers'), 1)

    def test_uncertain_release_is_observed_not_repeated(self):
        self.window.acquire(); self.control.lose_reply = '/release-maintenance-lock'
        with self.assertRaises(RuntimeError): self.window.release()
        self.window.release()
        self.assertEqual(self.count('/release-maintenance-lock'), 1)
        self.assertEqual(self.count('/maintenance-receipt'), 1)

    def test_preexisting_manual_pause_is_preserved(self):
        self.control.worker.update(drained=True, operator_paused=True)
        self.window.acquire(); self.window.release()
        result = self.window.resume_if_unchanged()
        self.assertEqual(result['state'], 'left_to_operator')
        self.assertEqual(result['reason'], 'preexisting_operator_pause')
        self.assertEqual(self.count('/resume-workers'), 0)

    def test_new_pause_stops_further_mutation_and_is_never_undone(self):
        self.window.acquire()
        self.control.worker.update(operator_paused=True, last_operator_action={'id': str(uuid.uuid4())})
        with self.assertRaisesRegex(RuntimeError, 'ownership or operator'): self.window.owned()
        self.window.release(); result = self.window.resume_if_unchanged()
        self.assertEqual(result['state'], 'left_to_operator')
        self.assertEqual(self.count('/resume-workers'), 0)

    def test_other_hold_survives_owned_release(self):
        self.window.acquire()
        other = {'id': str(uuid.uuid4()), 'control_channel': 'other_agent'}
        self.control.worker['maintenance_locks'].append(other)
        with self.assertRaises(RuntimeError): self.window.owned()
        self.window.release(); self.window.resume_if_unchanged()
        self.assertEqual(self.control.worker['maintenance_locks'], [other])
        self.assertEqual(self.count('/resume-workers'), 0)

    def test_new_pause_during_resume_is_rejected_by_gateway_and_not_retried(self):
        self.window.acquire(); self.window.release()
        self.control.before_resume = lambda: self.control.worker.update(last_operator_action={'id': str(uuid.uuid4())})
        with self.assertRaisesRegex(RuntimeError, 'Operator action changed'): self.window.resume_if_unchanged()
        with self.assertRaisesRegex(RuntimeError, 'uncertain'): self.window.resume_if_unchanged()
        self.assertEqual(self.count('/resume-workers'), 1)
        self.assertTrue(self.control.worker['drained'])

    def test_uncertain_resume_does_not_replay_even_when_worker_is_now_serving(self):
        self.window.acquire(); self.window.release(); self.control.lose_reply = '/resume-workers'
        with self.assertRaises(RuntimeError): self.window.resume_if_unchanged()
        self.assertFalse(self.control.worker['drained'])
        with self.assertRaisesRegex(RuntimeError, 'uncertain'): self.window.resume_if_unchanged()
        self.assertEqual(self.count('/resume-workers'), 1)

    def test_old_gateway_or_other_owner_cannot_start_new_workflow(self):
        self.control.version = None
        with self.assertRaisesRegex(RuntimeError, 'conditional readmission'): self.window.acquire()
        self.control.version = 1; self.control.recovery['state'] = 'recovering'
        with self.assertRaisesRegex(RuntimeError, 'Another maintenance'): self.window.acquire()
        self.assertEqual(self.count('/maintenance-lock'), 0)


if __name__ == '__main__': unittest.main()
