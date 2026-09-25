import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler

from recovery_pair_test import Fixture
from recovery_pair import fingerprint
from recovery_pair_native import PairJournal, RemotePair, private_read, private_save

SOURCE = Path(__file__).parent.resolve()
spec = importlib.util.spec_from_file_location('pair_bridge', SOURCE / 'recovery-pair.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class PairBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='pair-bridge-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.f = Fixture()
        self.config = {'schema': 1, 'enrollment': self.f.enrollment, 'journal_directory': str(self.root),
                       'gateway_socket': str(self.root / 'control.sock')}
        self.file = self.root / 'config.json'
        private_save(self.file, self.config)

    def test_configuration_and_public_inspection_preserve_pins_without_exposing_definitions(self):
        self.assertEqual(bridge.configuration(self.file), self.config)
        result = bridge.inspect(self.config, remote_factory=lambda _: type('Reader', (), {'observe': lambda _: self.f.observations})())
        self.assertEqual(result['pair_epoch'], self.f.request['epoch'])
        self.assertEqual(result['context_length'], 400000)
        self.assertEqual(result['concurrency'], 2)
        self.assertNotIn('fixture-0', json.dumps(result))
        self.assertNotIn('THINKING', json.dumps(result))
        stopped = Fixture(stopped=True)
        for row in stopped.observations:
            row['started_at'] = None
        result = bridge.inspect({**self.config, 'enrollment': stopped.enrollment}, remote_factory=lambda _: type('Reader', (), {'observe': lambda _: stopped.observations})())
        self.assertTrue(result['stopped'])
        self.assertEqual(result['started_at'], 0)
        self.file.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'private_journal'):
            bridge.configuration(self.file)

    def test_dispatch_persists_exact_request_and_uses_detached_fixed_command(self):
        calls = []
        def spawn(args, **kwargs):
            saved = private_read(self.root / (self.f.request['action_id'] + '.request'))
            self.assertEqual(saved, {'request': self.f.request, 'enrollment': fingerprint(self.config)})
            calls.append((args, kwargs))
            return type('Child', (), {'pid': 42})()
        result = bridge.launch(self.file, self.config, self.f.request, permitted=lambda *args: True, popen=spawn)
        self.assertEqual(result['runner_pid'], 42)
        self.assertEqual(calls[0][0], [sys.executable, '-I', str(SOURCE / 'recovery-pair.py'), str(self.file.resolve()), '--run', self.f.request['action_id']])
        self.assertTrue(calls[0][1]['start_new_session'])
        self.assertTrue(calls[0][1]['close_fds'])
        self.assertEqual(calls[0][1]['stdin'], subprocess.DEVNULL)
        with self.assertRaisesRegex(ValueError, 'action_id_conflict'):
            bridge.launch(self.file, self.config, {**self.f.request, 'canary': True}, permitted=lambda *args: True, popen=spawn)
        self.assertEqual(len(calls), 1)

    def test_current_controller_permission_required_and_live_lease_prevents_another_spawn(self):
        def never(*args, **kwargs):
            self.fail('Unexpected second native runner')
        with self.assertRaisesRegex(ValueError, 'ownership'):
            bridge.launch(self.file, self.config, self.f.request, permitted=lambda *args: False, popen=never)
        self.assertFalse((self.root / (self.f.request['action_id'] + '.request')).exists())
        with PairJournal(self.root, self.f.enrollment, self.f.request):
            result = bridge.launch(self.file, self.config, self.f.request, permitted=lambda *args: True, popen=never)
        self.assertEqual(result['state'], 'running')

    def test_real_unix_socket_attests_exact_operation_and_fails_closed_when_missing_or_public(self):
        expected = self.f.request
        replies = [{'allowed': True, **{k: expected[k] for k in ('action_id', 'epoch', 'profile')}}]
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                received.append((self.path, json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                data = json.dumps(replies[0]).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        server = socketserver.UnixStreamServer(self.config['gateway_socket'], Handler)
        socket = Path(self.config['gateway_socket'])
        socket.chmod(0o600)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            self.assertTrue(bridge.owned(self.config, expected))
            self.assertEqual(received, [('/recovery-pair-permit', expected)])
            replies[0]['epoch'] = 'f' * 64
            self.assertFalse(bridge.owned(self.config, expected))
            socket.chmod(0o666)
            self.assertFalse(bridge.owned(self.config, expected))
            self.assertEqual(len(received), 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)
        socket.unlink()
        self.assertFalse(bridge.owned(self.config, expected))

    def test_detached_native_runner_finishes_after_launching_process_exits(self):
        # Real subprocess/session/lease/journal, with simulated Docker only.
        child_code = r'''
import importlib.util,os,sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from recovery_pair_test import Fixture
from recovery_pair import recover_pair
from recovery_pair_native import PairJournal,private_save
spec=importlib.util.spec_from_file_location('bridge',Path(sys.argv[1])/'recovery-pair.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
time.sleep(.15)
def native(directory,enrollment,request,ownership):
    f=Fixture()
    with PairJournal(directory,enrollment,request) as journal:
        def save(value):journal.save(value);f.save(value)
        result=recover_pair(enrollment,request,read_journal=journal.read,save_journal=save,observe=lambda:f.observations,
            stop=lambda h,c:f.command('stop',h,c),start=lambda h,c:f.command('start',h,c),ownership=ownership)
        private_save(Path(directory)/'finished.fixture',{'pid':os.getpid(),'pgid':os.getpgrp(),'commands':f.commands,'state':result['state']})
        return result
bridge.run(sys.argv[2],sys.argv[3],native=native,permitted=lambda *args:True)
'''
        parent_code = r'''
import importlib.util,os,subprocess,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from recovery_pair_test import Fixture
from recovery_pair_native import private_save
spec=importlib.util.spec_from_file_location('bridge',Path(sys.argv[1])/'recovery-pair.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
config=bridge.configuration(sys.argv[2])
def spawn(args,**kwargs):
    return subprocess.Popen([sys.executable,'-I','-c',sys.argv[3],sys.argv[1],sys.argv[2],args[-1]],**kwargs)
result=bridge.launch(sys.argv[2],config,Fixture().request,permitted=lambda *args:True,popen=spawn)
private_save(Path(config['journal_directory'])/'parent.fixture',{'pgid':os.getpgrp(),'child':result['runner_pid']})
os._exit(17)
'''
        result = subprocess.run([sys.executable, '-I', '-c', parent_code, str(SOURCE), str(self.file), child_code], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 17, result.stderr.decode())
        deadline = time.monotonic() + 5
        output = self.root / 'finished.fixture'
        while not output.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(output.exists())
        saved, parent = private_read(output), private_read(self.root / 'parent.fixture')
        self.assertEqual(saved['state'], 'completed')
        self.assertEqual(len(saved['commands']), 4)
        self.assertEqual(saved['pid'], saved['pgid'])
        self.assertNotEqual(saved['pgid'], parent['pgid'])
        self.assertEqual(saved['pid'], parent['child'])
        self.assertEqual(bridge.launch(self.file, self.config, self.f.request, permitted=lambda *args: True,
                                      popen=lambda *args, **kwargs: self.fail('Completed operation replayed'))['state'], 'completed')

    def test_runner_rejects_changed_config_and_unknown_operation_before_native_io(self):
        private_save(self.root / (self.f.request['action_id'] + '.request'), {'request': self.f.request, 'enrollment': fingerprint(self.config)})
        config = copy.deepcopy(self.config)
        config['gateway_socket'] += '.different'
        private_save(self.file, config)
        with self.assertRaisesRegex(ValueError, 'enrollment_changed'):
            bridge.run(self.file, self.f.request['action_id'], native=lambda *args: self.fail('Native I/O'))
        with self.assertRaisesRegex(ValueError, 'invalid_pair_action_id'):
            bridge.run(self.file, '../another', native=lambda *args: self.fail('Native I/O'))

    def test_completed_receipt_requires_all_exact_steps_and_changed_final_epoch(self):
        self.f.run()
        original = copy.deepcopy(self.f.journal)
        for change in ('steps', 'member', 'epoch', 'initial', 'unchanged'):
            row = copy.deepcopy(original)
            if change == 'steps': row['steps'].pop()
            elif change == 'member': row['steps'][0]['member'] = 1
            elif change == 'epoch': row['final_epoch'] = 'f' * 64
            elif change == 'initial': row['initial_epochs'][0][1] += 'changed'
            else:
                row['steps'][-1]['epochs'] = row['initial_epochs']
                row['final_epoch'] = self.f.request['epoch']
            private_save(self.root / (self.f.request['action_id'] + '.json'), row)
            with self.assertRaisesRegex(ValueError, 'journal_invalid'):
                bridge.summary(self.config, self.f.request)

    def test_native_idle_metrics_require_both_zero_counters_and_known_head_state(self):
        remote = RemotePair(self.f.enrollment)
        remote.observe = lambda: copy.deepcopy(self.f.observations)
        for text, expected in [('vllm:num_requests_running 0\nvllm:num_requests_waiting 0\n', True),
                               ('vllm:num_requests_running{model_name="fixture"} 0\nvllm:num_requests_waiting 0\n', True),
                               ('vllm:num_requests_running 1\nvllm:num_requests_waiting 0\n', False),
                               ('vllm:num_requests_running 0\n', False),
                               ('vllm:num_requests_running NaN\nvllm:num_requests_waiting 0\n', False)]:
            def fake_remote(host, args, **kwargs):
                output = io.StringIO()
                with patch('urllib.request.urlopen', return_value=io.BytesIO(text.encode())), patch.object(sys, 'argv', ['reader', '8000']), contextlib.redirect_stdout(output):
                    exec(args[3], {})
                return output.getvalue().encode()
            remote.remote = fake_remote
            self.assertEqual(remote.idle(), expected, text)
        self.f.observations[0]['container']['State'].update(Running=False, Status='exited')
        remote.remote = lambda *args, **kwargs: self.fail('Stopped pinned head needs no metrics request')
        self.assertTrue(remote.idle())
        self.f.observations[0]['machine'] = 'f' * 64
        self.assertFalse(remote.idle())


if __name__ == '__main__':
    unittest.main()
