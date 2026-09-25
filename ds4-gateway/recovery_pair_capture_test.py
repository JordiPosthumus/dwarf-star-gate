import copy
import contextlib
import io
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch
from recovery_pair_test import Fixture
from recovery_pair_native import PairReader, capture_pair, private_read, private_save

spec = importlib.util.spec_from_file_location('capture_bridge', Path(__file__).with_name('recovery-pair-capture.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        for row in self.f.observations:
            row['fault'] = None
        self.binding = {k: self.f.enrollment[k] for k in ('worker_id', 'model', 'port', 'context_length', 'concurrency')}
        self.binding['members'] = [{k: m[k] for k in ('ssh', 'container', 'recipe_root')} for m in self.f.enrollment['members']]

    def reader(self, change=None):
        owner = self
        class Reader(PairReader):
            def observe(self):
                if hasattr(self, 'seen') and change:
                    change(owner.f.observations)
                self.seen = True
                return copy.deepcopy(owner.f.observations)
        return Reader

    def test_two_pass_capture_pins_native_ids_definitions_files_and_never_gives_authority(self):
        self.binding['members'][0]['container'] = 'existing-head'
        self.binding['members'][1]['container'] = 'existing-rank'
        result = capture_pair(self.binding, self.reader())
        self.assertEqual(result['enrollment'], self.f.enrollment)
        self.assertEqual(result['before'], result['after'])
        self.assertFalse(hasattr(PairReader, 'start'))
        self.assertFalse(hasattr(PairReader, 'stop'))
        self.assertEqual(self.f.commands, [])

    def test_drift_rejects_capture_at_every_native_identity_boundary(self):
        changes = [lambda rows: rows[0].update(machine='c' * 64),
                   lambda rows: rows[1]['container']['State'].update(StartedAt='2026-01-02T00:00:00Z'),
                   lambda rows: rows[0]['container']['Config'].update(Cmd=['changed']),
                   lambda rows: rows[1]['files']['/fixture/recipe/.env'].update(sha256='0' * 64)]
        for change in changes:
            with self.subTest(change=change):
                self.setUp()
                with self.assertRaises(ValueError):
                    capture_pair(self.binding, self.reader(change))

    def test_live_listener_capacity_and_distinct_hosts_required(self):
        for patch in ('listener', 'capacity', 'fault', 'host'):
            with self.subTest(patch=patch):
                self.setUp()
                if patch == 'listener': self.f.observations[0]['listener_owned'] = False
                if patch == 'capacity': self.binding['context_length'] = 8192
                if patch == 'fault': self.f.observations[1]['fault'] = {'reason': 'fatal_accelerator_error', 'at': 2000}
                if patch == 'host': self.binding['members'][1]['ssh'] = self.binding['members'][0]['ssh']
                with self.assertRaises(ValueError): capture_pair(self.binding, self.reader())

    def test_invalid_capture_target_never_reaches_native_io(self):
        for key, value in [('ssh', '-oProxyCommand=bad'), ('container', 'name;bad'), ('recipe_root', '/tmp/../secret')]:
            binding = copy.deepcopy(self.binding)
            binding['members'][0][key] = value
            with self.assertRaises(ValueError): PairReader(binding)

    def test_actual_remote_program_resolves_name_to_id_and_refuses_name_retargeting(self):
        for drift in (False, True):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as tmp:
                binding = copy.deepcopy(self.binding)
                binding['members'][0].update(container='named-head', recipe_root=tmp)
                container = copy.deepcopy(self.f.observations[0]['container'])
                container['Mounts'] = []
                for name in ('.env', 'start.sh', '.glm53-exl3-head.inner.sh'): (Path(tmp) / name).write_text('fixture bytes')
                calls = []
                def execute(args, **kwargs):
                    calls.append(args)
                    if args[:2] == ['docker', 'inspect']:
                        row = copy.deepcopy(container)
                        if drift and len([c for c in calls if c[:2] == ['docker', 'inspect']]) == 3: row['Id'] = '9' * 64
                        out = json.dumps([row])
                    elif args[:2] == ['docker', 'exec']: out = 'true'
                    elif args[:2] == ['docker', 'logs']: out = ''
                    else: self.fail('Unexpected native command')
                    return subprocess.CompletedProcess(args, 0, out.encode(), b'')
                reader = PairReader(binding)
                original = Path.read_bytes
                def remote(host, args, timeout=120):
                    output = io.StringIO()
                    with patch('subprocess.run', side_effect=execute), patch.object(sys, 'argv', ['collector', args[4]]), contextlib.redirect_stdout(output), \
                         patch.object(Path, 'read_bytes', lambda p: b'fixture-machine' if str(p) == '/etc/machine-id' else original(p)):
                        exec(compile(args[3], '<native-pair-collector>', 'exec'), {})
                    return output.getvalue()
                reader.remote = remote
                if drift:
                    with self.assertRaisesRegex(ValueError, 'pair_changed_during_inspection'): reader.inspect_member(binding['members'][0])
                else:
                    row = reader.inspect_member(binding['members'][0])
                    self.assertEqual(row['container']['Id'], container['Id'])
                    self.assertTrue(row['listener_owned'])
                    self.assertEqual(len(row['files']), 3)
                inspections = [c[-1] for c in calls if c[:2] == ['docker', 'inspect']]
                self.assertEqual(inspections, ['named-head', container['Id'], 'named-head'])

    def request(self, root):
        folder = root / self.f.request['action_id']
        folder.mkdir(mode=0o700)
        request = {'action_id': folder.name, 'worker_id': self.binding['worker_id'], 'created_at': '2026-01-01T00:00:00Z',
                   'binding': self.binding, 'route': {'id': self.binding['worker_id'], 'url': 'http://127.0.0.1:8000/v1'}}
        private_save(folder / 'request.json', request)
        return folder, request

    def test_private_receipts_survive_reader_reconstruction_without_replaying_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder, request = self.request(Path(tmp))
            evidence = capture_pair(self.binding, self.reader())
            count = []
            def capture(binding): count.append(binding); return evidence
            receipt = bridge.run(folder, request, capture)
            self.assertEqual(receipt['state'], 'prepared')
            self.assertNotIn('enrollment', receipt)
            self.assertEqual(bridge.run(folder, request, capture), receipt)
            self.assertEqual(len(count), 1)
            self.assertEqual(bridge.status(*bridge.folder(str(folder))), receipt)
            actual = json.loads(subprocess.check_output([sys.executable, '-I', '-B', str(Path(bridge.__file__).resolve()), str(folder), '--status']))
            self.assertEqual(actual, receipt)
            self.assertEqual(private_read(folder / 'evidence.json')['enrollment'], self.f.enrollment)
            self.assertEqual((folder / 'evidence.json').stat().st_mode & 0o777, 0o600)

    def test_only_a_live_os_lease_reports_preparing_and_lost_intent_never_replays(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder, request = self.request(Path(tmp))
            self.assertEqual(bridge.status(folder, request)['state'], 'unverified')
            fd = bridge.lease(folder)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(bridge.status(folder, request)['state'], 'preparing')
            finally: os.close(fd)
            self.assertEqual(bridge.status(folder, request)['state'], 'unverified')
            (folder / 'capture-intent').touch(mode=0o600)
            with self.assertRaises(FileExistsError): bridge.run(folder, request, lambda _: self.fail('capture replayed'))

    def test_capture_waits_for_concurrent_status_probe_without_losing_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder, request = self.request(Path(tmp))
            fd = bridge.lease(folder)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with ThreadPoolExecutor(max_workers=1) as executor:
                task = executor.submit(bridge.run, folder, request, lambda _: capture_pair(self.binding, self.reader()))
                os.close(fd)
                self.assertEqual(task.result(timeout=5)['state'], 'prepared')

    def test_native_errors_do_not_expose_private_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder, request = self.request(Path(tmp))
            def capture(_): raise RuntimeError('private host and command output')
            receipt = bridge.run(folder, request, capture)
            self.assertEqual(receipt['reason'], 'pair_native_capture_unavailable')
            self.assertNotIn('private host', json.dumps(receipt))
            self.assertEqual(private_read(folder / 'failure.json')['message'], 'private host and command output')
            self.assertEqual((folder / 'failure.json').stat().st_mode & 0o777, 0o600)


if __name__ == '__main__': unittest.main()
