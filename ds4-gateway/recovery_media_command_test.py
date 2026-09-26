"""Media command journal faults and actual disposable runner/OS-lock tests."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import recovery_media_command as m


class FixtureIO:
    def __init__(self):
        self.container = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, 'Config': {'Env': ['CONTEXT=400000']},
                          'HostConfig': {'OomKillDisable': False}, 'Mounts': [],
                          'State': {'Running': True, 'StartedAt': 'start-1', 'FinishedAt': 'end-0'}}
        self.calls = []
        self.is_idle = True
        self.machine_id = 'c' * 64

    def machine(self):
        return self.machine_id

    def inspect(self, cid):
        assert cid == self.container['Id']
        return copy.deepcopy(self.container)

    def idle(self, cid):
        return self.is_idle

    def stop(self, cid):
        self.calls.append(('stop', cid))
        self.container['State'].update(Running=False, FinishedAt='end-1')

    def start(self, cid):
        self.calls.append(('start', cid))
        self.container['State'].update(Running=True, StartedAt='start-2')


class CommandTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='media-command-')
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.io = FixtureIO()
        self.req = self.request('stop', 'llm-stop-0')

    def request(self, action, step):
        return {'version': 1, 'operation_id': '11111111-1111-4111-8111-111111111111', 'step': step,
                'machine': self.io.machine(), 'container': self.io.container['Id'], 'action': action,
                'definition': copy.deepcopy(m.signature(self.io.container)), 'before': m.runtime(self.io.container)}

    def run_command(self, request=None, owned=lambda _: True):
        return m.run(self.root, request or self.req, self.io, owned)

    def test_stop_start_receipts_are_distinct_and_original_backup_is_retained(self):
        original = copy.deepcopy(self.req)
        self.assertEqual(self.run_command()['state'], 'completed')
        start = self.request('start', 'llm-start-0')
        self.assertEqual(self.run_command(start)['state'], 'completed')
        self.assertEqual(self.run_command()['state'], 'completed')
        self.assertEqual([v[0] for v in self.io.calls], ['stop', 'start'])
        self.assertEqual(m.read_record(self.root, original)['request'], original)
        self.assertEqual(m.status(self.root, original, self.io)['outcome'], 'recorded')
        self.assertEqual(m.signature(self.io.container), original['definition'])

    def test_uncertain_ack_is_observed_after_permission_revocation_without_another_command(self):
        stop = self.io.stop
        def lost(cid):
            stop(cid)
            raise OSError('fixture lost acknowledgement')
        self.io.stop = lost
        with self.assertRaises(OSError):
            self.run_command()
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        self.assertEqual(m.status(self.root, self.req, self.io)['outcome'], 'observed')
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})
        self.assertEqual(self.run_command(owned=lambda _: False)['state'], 'completed')
        self.assertEqual(len(self.io.calls), 1)

    def exited_start(self):
        self.io.container['State']['Running'] = False
        request = self.request('start', 'media-start-0')
        def start(cid):
            self.io.calls.append(('start', cid))
            self.io.container['State'].update(Running=False, StartedAt='start-2', FinishedAt='end-2')
        self.io.start = start
        return request

    def test_acknowledged_start_that_immediately_exits_is_terminal_without_replay(self):
        request = self.exited_start()
        self.assertEqual(self.run_command(request)['state'], 'exited')
        self.assertEqual(self.run_command(request, owned=lambda _:False)['state'], 'exited')
        self.assertEqual(m.status(self.root, request, self.io)['outcome'], 'recorded')
        self.assertEqual(len(self.io.calls), 1)

    def test_exit_after_durable_ack_observes_failed_start_without_replay(self):
        request = self.exited_start()
        class Crash(BaseException): pass
        save = m.private_save
        def crash(file, value):
            save(file, value)
            if value.get('state') == 'acknowledged': raise Crash()
        with patch.object(m, 'private_save', crash), self.assertRaises(Crash): self.run_command(request)
        self.assertEqual(m.status(self.root, request, self.io)['outcome'], 'observed')
        self.assertEqual(self.run_command(request, owned=lambda _:False)['state'], 'exited')
        self.assertEqual(len(self.io.calls), 1)

    def test_lost_start_ack_with_exited_container_remains_uncertain(self):
        request = self.exited_start();start = self.io.start
        def lost(cid):
            start(cid)
            raise OSError('fixture lost acknowledgement')
        self.io.start = lost
        with self.assertRaises(OSError): self.run_command(request)
        self.assertEqual(m.status(self.root, request, self.io)['outcome'], 'unconfirmed')
        self.assertEqual(self.run_command(request)['state'], 'intent')
        self.assertEqual(len(self.io.calls), 1)

    def test_acknowledged_row_requires_a_saved_positive_acknowledgement(self):
        request = self.exited_start();self.run_command(request)
        row = m.read_record(self.root, request);row['state'] = 'acknowledged';row.pop('command_acknowledged')
        m.private_save(m.record_path(self.root, request), row)
        with self.assertRaisesRegex(ValueError, 'acknowledgement_unverified'):
            self.run_command(request)

    def test_exit_after_intent_before_command_never_replays_or_escapes_to_new_operation(self):
        class Crash(BaseException):
            pass
        save = m.private_save
        def crash(file, value):
            save(file, value)
            if value.get('state') == 'intent':
                raise Crash()
        with patch.object(m, 'private_save', crash), self.assertRaises(Crash):
            self.run_command()
        self.assertEqual(self.run_command()['state'], 'intent')
        self.assertEqual(self.io.calls, [])
        different = {**self.req, 'operation_id': '22222222-2222-4222-8222-222222222222'}
        with self.assertRaisesRegex(ValueError, 'other_command_unresolved'):
            self.run_command(different)

    def test_prepared_only_recovers_and_durable_save_failure_prevents_dispatch(self):
        save = m.private_save
        def fail(file, value):
            if value.get('state') == 'intent':
                raise OSError('fixture full disk')
            save(file, value)
        with patch.object(m, 'private_save', fail), self.assertRaises(OSError):
            self.run_command()
        self.assertEqual(self.io.calls, [])
        self.assertEqual(m.read_record(self.root, self.req)['state'], 'prepared')
        self.assertEqual(self.run_command()['state'], 'completed')
        self.assertEqual(len(self.io.calls), 1)

    def test_busy_or_unowned_or_drifted_native_state_never_mutates(self):
        self.io.is_idle = False
        with self.assertRaisesRegex(ValueError, 'not_idle'):
            self.run_command()
        self.io.is_idle = True
        with self.assertRaisesRegex(ValueError, 'ownership_unavailable'):
            self.run_command(owned=lambda _: False)
        self.io.machine_id = 'd' * 64
        with self.assertRaisesRegex(ValueError, 'machine_changed'):
            self.run_command()
        self.io.machine_id = self.req['machine']
        self.io.container['State']['StartedAt'] = 'different-instance'
        with self.assertRaisesRegex(ValueError, 'epoch_changed'):
            self.run_command()
        self.io.container['Config']['Env'] = ['CONTEXT=1']
        with self.assertRaisesRegex(ValueError, 'profile_changed'):
            self.run_command()
        self.assertEqual(self.io.calls, [])

    def test_last_ownership_and_native_idle_checks_happen_after_backup(self):
        calls = 0
        def ownership(_):
            nonlocal calls
            calls += 1
            return calls == 1
        with self.assertRaisesRegex(ValueError, 'ownership_unavailable'):
            self.run_command(owned=ownership)
        self.assertEqual(m.read_record(self.root, self.req)['state'], 'prepared')
        self.assertEqual(self.io.calls, [])

    def test_changed_request_or_backup_is_not_adopted(self):
        self.run_command()
        changed = copy.deepcopy(self.req)
        changed['definition']['Config']['Env'] = ['CONTEXT=1']
        with self.assertRaisesRegex(ValueError, 'saved_request_changed'):
            self.run_command(changed)
        backup = self.root / (self.req['operation_id'] + '-' + self.req['step'] + '.backup')
        m.private_save(backup, {})
        with self.assertRaisesRegex(ValueError, 'backup_changed'):
            m.status(self.root, self.req, self.io)
        self.assertEqual(len(self.io.calls), 1)

    def test_read_only_missing_observation_creates_no_files(self):
        absent = self.root / 'absent'
        self.assertEqual(m.status(absent, self.req, self.io)['state'], 'missing')
        self.assertFalse(absent.exists())
        self.assertEqual(m.status(self.root, self.req, self.io)['state'], 'missing')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_missing_record_with_retained_backup_never_replays(self):
        self.run_command()
        m.record_path(self.root, self.req).unlink()
        # Even if an external actor restores the original epoch, the retained
        # backup is evidence of prior execution, not authority to start over.
        self.io.container['State'].update(Running=True, StartedAt='start-1', FinishedAt='end-0')
        with self.assertRaisesRegex(ValueError, 'saved_record_missing'): self.run_command()
        with self.assertRaisesRegex(ValueError, 'saved_record_missing'): m.status(self.root, self.req, self.io)
        self.assertEqual(len(self.io.calls), 1)

    def test_same_logical_action_cannot_race_under_a_different_container_lock(self):
        held = m.lease(self.root, self.req, create=True)
        self.assertIsNotNone(held)
        try:
            conflict = copy.deepcopy(self.req)
            conflict['container'] = 'd' * 64
            conflict['definition']['Id'] = conflict['container']
            self.assertTrue(m.run(self.root, conflict, self.io, lambda _:True)['runner_active'])
            self.assertEqual(self.io.calls, [])
            self.assertIsNone(m.read_record(self.root, self.req))
        finally:
            m.release(held)

    def test_private_lease_and_profile_validation_fail_closed(self):
        for change in [{'container': 'friendly-name'}, {'step': 'anything'}, {'step': 'anything', 'action': None}, {'action': 'kill'}, {'extra': 'authority'}, {'version': True}]:
            with self.assertRaises(ValueError):
                self.run_command({**self.req, **change})
        outside = self.root / 'outside'
        outside.write_text('preserve')
        (self.root / ('container-' + self.req['machine'] + '-' + self.req['container'] + '.lock')).symlink_to(outside)
        with self.assertRaises(OSError):
            self.run_command()
        self.assertEqual(outside.read_text(), 'preserve')
        self.assertEqual(self.io.calls, [])

    def test_real_runner_lease_exit_and_native_effect_observation(self):
        for effect in (False, True):
            with self.subTest(effect=effect), tempfile.TemporaryDirectory(prefix='media-command-process-') as directory:
                root = Path(directory)
                fixture = root / 'fixture'
                fixture.mkdir(mode=0o700)
                m.private_save(fixture / 'request', self.req)
                m.private_save(fixture / 'container', self.io.container)
                code = '''import json,sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1]);import recovery_media_command as m
r=Path(sys.argv[2]);f=r/'fixture';q=m.private_read(f/'request')
class IO:
 def machine(self):return q['machine']
 def inspect(self,cid):return m.private_read(f/'container')
 def idle(self,cid):return True
 def stop(self,cid):
  (f/'calls').write_text('one command')
  if sys.argv[3]=='effect':
   c=self.inspect(cid);c['State'].update(Running=False,FinishedAt='end-1');m.private_save(f/'container',c)
  (f/'ready').write_text('ready')
  while True:time.sleep(1)
m.run(r,q,IO(),lambda _:True)
'''
                child = subprocess.Popen([sys.executable, '-I', '-c', code, str(Path(m.__file__).parent), str(root), 'effect' if effect else 'pending'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 10
                    while not (fixture / 'ready').exists() and child.poll() is None and time.monotonic() < deadline:
                        time.sleep(.01)
                    self.assertTrue((fixture / 'ready').exists())
                    self.assertIsNone(child.poll(), 'lease assertion requires a live process')
                    self.assertTrue(m.status(root, self.req, self.io)['runner_active'])
                    self.assertTrue(m.run(root, self.req, self.io, lambda _:True)['runner_active'])
                    self.assertEqual(self.io.calls, [])
                    child.kill()
                    child.wait(timeout=5)
                    self.assertIsNotNone(child.returncode)
                    self.io.container = m.private_read(fixture / 'container')
                    observed = m.status(root, self.req, self.io)
                    self.assertFalse(observed['runner_active'])
                    self.assertEqual(observed['outcome'], 'observed' if effect else 'unconfirmed')
                    result = m.run(root, self.req, self.io, lambda _:False)
                    self.assertEqual(result['state'], 'completed' if effect else 'intent')
                    self.assertEqual(self.io.calls, [])
                    self.assertEqual((fixture / 'calls').read_text(), 'one command')
                finally:
                    if child.poll() is None:
                        child.kill()
                    child.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
