import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery_docker', Path(__file__).with_name('recovery-docker.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class DockerRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = Path(self.temp.name) / 'actions.json'
        self.config = {'container': 'a' * 64, 'port': 8001}
        self.current = dict(active=True, listener=True, instance='b' * 32, machine='c' * 64,
                            profile='d' * 64, fault={'at': 100, 'reason': 'fatal_accelerator_error'})
        self.request = dict(action='restart', action_id='12345678-1234-1234-1234-123456789abc',
                            instance=self.current['instance'], machine=self.current['machine'],
                            profile=self.current['profile'], canary=False, fault_after=90)

    def test_restart_same_container_once_and_preserve_lost_acknowledgement(self):
        with patch.object(m, 'inspect', return_value=self.current), patch.object(m, 'run', side_effect=TimeoutError) as run:
            with self.assertRaises(TimeoutError):
                m.handle(self.config, self.request, self.journal)
            self.assertEqual(m.handle(self.config, self.request, self.journal)['state'], 'intent')
            run.assert_called_once_with(['docker', 'restart', 'a' * 64])
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)

    def test_success_receipt_and_new_id_cannot_restart_same_instance_again(self):
        with patch.object(m, 'inspect', return_value=self.current), patch.object(m, 'run') as run:
            self.assertEqual(m.handle(self.config, self.request, self.journal)['state'], 'issued')
            changed = dict(self.request, action_id='22345678-1234-1234-1234-123456789abc')
            with self.assertRaisesRegex(ValueError, 'instance_already_attempted'):
                m.handle(self.config, changed, self.journal)
            run.assert_called_once()

    def test_stopped_paused_wrong_identity_and_missing_fault_never_issue_restart(self):
        for delta in [dict(active=False), dict(listener=False), dict(profile='e' * 64),
                      dict(instance='f' * 32), dict(machine='f' * 64), dict(fault=None),
                      dict(fault={'at': 80})]:
            with self.subTest(delta=delta), patch.object(m, 'inspect', return_value=dict(self.current, **delta)), patch.object(m, 'run') as run:
                with self.assertRaises(ValueError):
                    m.handle(self.config, self.request, self.journal)
                run.assert_not_called()
                self.assertFalse(self.journal.exists())
        with self.assertRaises(ValueError):
            m.handle(self.config, dict(self.request, action='start'), self.journal)

    def test_separate_canary_can_restart_exact_idle_enrolled_instance_without_fault(self):
        with patch.object(m, 'inspect', return_value=dict(self.current, fault=None)), patch.object(m, 'run') as run:
            self.assertEqual(m.handle(self.config, dict(self.request, canary=True), self.journal)['state'], 'issued')
            run.assert_called_once_with(['docker', 'restart', self.config['container']])

    def test_current_instance_fatal_logs_only(self):
        started = m.milliseconds('2026-09-15T01:00:00Z')
        self.assertIsNone(m.fault_evidence('2026-09-14T01:00:00Z CUDA error: an illegal memory access was encountered', started))
        self.assertIsNone(m.fault_evidence('2026-09-15T01:00:01Z INFO request completed', started))
        value = m.fault_evidence('2026-09-15T01:00:01.123456789Z (EngineCore) torch.AcceleratorError: CUDA error: an illegal memory access was encountered', started)
        self.assertEqual(value, {'at': started + 1123, 'reason': 'fatal_accelerator_error'})

    def test_inspection_profile_stable_across_restart_but_sensitive_to_settings(self):
        value = dict(Id=self.config['container'], Image='sha256:' + 'e' * 64, Config={'Cmd': ['serve', '--max-num-seqs', '1']},
                     HostConfig={'RestartPolicy': {'Name': 'unless-stopped'}}, Mounts=[{'Destination': '/b'}, {'Destination': '/a'}],
                     State={'Running': True, 'Status': 'running', 'Pid': 123, 'StartedAt': '2026-09-15T01:00:00Z'})
        def run(args):
            return json.dumps([value]) if args[1] == 'inspect' else ''
        with patch.object(m, 'run', side_effect=run), patch.object(m, 'owns_listener', return_value=True), patch.object(Path, 'read_bytes', return_value=b'fixture-machine'):
            first = m.inspect(self.config)
            value['Mounts'].reverse()
            self.assertEqual(m.inspect(self.config)['profile'], first['profile'])
            value['State'].update(Pid=456, StartedAt='2026-09-15T02:00:00Z')
            second = m.inspect(self.config)
            self.assertNotEqual(first['instance'], second['instance'])
            self.assertEqual(first['profile'], second['profile'])
            self.assertEqual(second['restart_policy'], 'unless-stopped')
            value['Config']['Cmd'][-1] = '2'
            self.assertNotEqual(m.inspect(self.config)['profile'], first['profile'])
            value['State'].update(Running=False, Status='exited', Pid=0)
            stopped = m.inspect(self.config)
            self.assertTrue(stopped['stopped'])
            self.assertFalse(stopped['active'])
            self.assertFalse(stopped['listener'])


if __name__ == '__main__':
    unittest.main()
