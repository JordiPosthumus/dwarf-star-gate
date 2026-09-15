import base64
import copy
import json
import hashlib
import inspect
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import tempfile
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch
import uuid

from docker_profile import digest, signature
from docker_profile_test import Docker, OLD
from hourglass_native import HourglassNative
from hourglass_operation import NativeStartRejected
import hourglass_executor
from operation_maintenance import Maintenance
from operation_maintenance_test import Fixture
from serving_bundle import MEASUREMENT_MODULES, build_executor


class NativeAdapterTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.health = {'app': 'Hourglass', 'version': 2, 'controller_instance': 'fixture', 'shutting_down': False}
        self.state = {'app': 'Hourglass', 'version': 2, 'benchmark_version': '4.1.0',
            'models_revision': 'b' * 64, 'endpoint_hardware': {'revision': 'c' * 64},
            'model_configs': [{'name': 'fixture', 'model': 'native-model', 'base_url': 'http://127.0.0.1:38011/v1'}],
            'tasks': [{'id': 'question', 'task_bundle_sha': 'd' * 64, 'issues': []}],
            'score_policy': {'window_s': 3600, 'metric': 'total-points-v1', 'scoring_policy': 'net-hour-v3'},
            'jobs': {'running': [], 'pending': [], 'done': []}}
        self.reply_status, self.reply = 200, {'ok': True, 'job': 'e' * 32}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.calls.append(('GET', self.path))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(owner.health if self.path == '/api/health' else owner.state).encode())

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.calls.append(('POST', self.path, body, self.headers['Origin']))
                self.send_response(owner.reply_status)
                if getattr(owner, 'redirect', False):
                    self.send_header('Location', '/must-not-follow')
                self.end_headers()
                self.wfile.write(json.dumps(owner.reply).encode())

            def log_message(self, *args):
                pass

        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join()))
        self.docker = Docker()
        self.docker.native_request = lambda url, route: {'status': 200,
            'body_base64': base64.b64encode(json.dumps({'data': [{'id': 'native-model'}]}).encode()).decode()}
        self.docker.idle = lambda url: True
        self.plan = {'id': str(uuid.uuid4()), 'worker_id': 'fixture',
            'target': {'ssh': 'fixture', 'docker_socket': '/var/run/docker.sock', 'gateway_socket': '/fixture.sock'},
            'hourglass': {'url': f'http://127.0.0.1:{server.server_port}', 'controller_instance': 'fixture',
                'endpoint': 'http://127.0.0.1:38011/v1', 'metric': 'total-points-v1', 'benchmark_version': '4.1.0', 'scoring_policy': 'net-hour-v3'},
            'native_target': {'container_id': OLD, 'signature_sha256': digest(signature(self.docker.old)),
                'started_at': 'original', 'url': 'http://127.0.0.1:8001', 'model': 'native-model'},
            'native_request': {'model': 'fixture', 'tasks': ['question'], 'repeat': 1,
                'models_revision': 'b' * 64, 'hardware_revision': 'c' * 64, 'task_bundles': {'question': 'd' * 64}}}
        self.native = HourglassNative(self.plan, self.docker)

    def test_serving_identity_includes_full_configuration_startup_and_model(self):
        self.assertTrue(self.native.check_target())
        self.docker.old['Config']['Cmd'].append('--changed')
        self.assertFalse(self.native.check_target())
        self.docker.old['Config']['Cmd'].pop()
        self.docker.old['State']['StartedAt'] = 'restarted'
        self.assertFalse(self.native.check_target())
        self.assertEqual(self.docker.calls, [])

    def test_submit_preserves_exact_payload_and_observe_follows_identity_after_controller_restart(self):
        receipt = self.native.submit(self.plan['native_request'])
        self.assertEqual(receipt, {'job_id': 'e' * 32})
        post = next(c for c in self.calls if c[0] == 'POST')
        self.assertEqual(post[1:3], ('/api/run', self.plan['native_request']))
        self.assertEqual(post[3], self.plan['hourglass']['url'])
        self.health['controller_instance'] = 'replacement'
        self.state['jobs']['done'] = [{'id': receipt['job_id'], 'model': 'fixture', 'state': 'completed'}]
        self.assertEqual(self.native.observe(receipt['job_id']), {'state': 'completed'})
        self.state['jobs']['done'][0]['model'] = 'different'
        self.assertEqual(self.native.observe(receipt['job_id']), {'state': 'unknown'})
        self.assertEqual(sum(c[0] == 'POST' for c in self.calls), 1)

    def test_changed_controller_route_model_bank_metric_and_revisions_reject_before_post(self):
        changes = [lambda: self.health.update(controller_instance='other'),
            lambda: self.state['model_configs'][0].update(base_url='http://example.invalid/v1'),
            lambda: self.state['model_configs'][0].update(model='other'),
            lambda: self.state.update(models_revision='f' * 64),
            lambda: self.state['endpoint_hardware'].update(revision='f' * 64),
            lambda: self.state['tasks'][0].update(task_bundle_sha='f' * 64),
            lambda: self.state['tasks'].append({'id': 'added', 'task_bundle_sha': 'f' * 64, 'issues': []}),
            lambda: self.state['score_policy'].update(window_s=60),
            lambda: self.state['score_policy'].update(metric='other'),
            lambda: self.state['score_policy'].update(scoring_policy='other'),
            lambda: self.state['jobs']['running'].append({'id': 'busy'}),
            lambda: self.state['jobs']['pending'].append({'id': 'queued'}),
            lambda: self.state.update(benchmark_version='other')]
        for change in changes:
            saved = copy.deepcopy((self.health, self.state))
            change()
            with self.assertRaises(NativeStartRejected):
                self.native.submit(self.plan['native_request'])
            self.health, self.state = saved
        self.assertFalse(any(c[0] == 'POST' for c in self.calls))

    def test_native_400_is_rejection_but_500_redirect_and_invalid_receipt_are_uncertain(self):
        self.reply_status = 400
        with self.assertRaises(NativeStartRejected):
            self.native.submit(self.plan['native_request'])
        for status in [500, 302, 200]:
            self.reply_status, self.redirect, self.reply = status, status == 302, {'error': 'PRIVATE_BODY'}
            with self.assertRaises(RuntimeError) as error:
                self.native.submit(self.plan['native_request'])
            self.assertNotIn('PRIVATE_BODY', str(error.exception))
        self.assertEqual(sum(c[0] == 'POST' for c in self.calls), 4)
        self.assertFalse(any(c[1] == '/must-not-follow' for c in self.calls))

    def test_only_enrolled_loopback_console_and_fixed_routes_are_available(self):
        for url in ['http://example.invalid', 'http://127.0.0.1:1/path', 'http://127.0.0.1:1/?key=secret']:
            with self.assertRaises(ValueError):
                HourglassNative({**self.plan, 'hourglass': {**self.plan['hourglass'], 'url': url}}, self.docker)
        for route, body in [('/api/shutdown', {}), ('/api/run', None), ('/api/state', {})]:
            with self.assertRaises(ValueError):
                self.native.request(route, body)
        self.assertEqual(self.calls, [])

    def test_actual_entry_joins_native_http_to_maintenance_without_docker_mutations(self):
        control = Fixture()
        control.worker['url'] = self.plan['hourglass']['endpoint']
        self.state['jobs']['done'] = [{'id': 'e' * 32, 'model': 'fixture', 'state': 'completed'}]
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / self.plan['id']
            folder.mkdir()
            def maintenance(*args, **kw):
                return Maintenance(*args, **kw, sleep=lambda _: None)
            with patch.object(hourglass_executor, '_BUNDLED_SOURCES', {'docker_profile': 'fixture source'}, create=True), \
                    patch.object(hourglass_executor, 'SSHDocker', return_value=self.docker), \
                    patch.object(hourglass_executor, 'GatewayControl', return_value=control), \
                    patch.object(hourglass_executor, 'Maintenance', side_effect=maintenance):
                result = hourglass_executor.execute(self.plan, folder, lambda *a: None)
            self.assertEqual(result['state'], 'completed')
            self.assertEqual(result['measurement']['native_state'], 'completed')
            self.assertFalse(control.worker['drained'])
            self.assertEqual(self.docker.calls, [])
            self.assertEqual(sum(c[0] == 'POST' for c in self.calls), 1)

    def test_existing_runner_executes_frozen_measurement_entry_after_checkout_changes(self):
        self.state['jobs']['done'] = [{'id': 'e' * 32, 'model': 'fixture', 'state': 'completed'}]
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            folder, sources = root / self.plan['id'], root / 'sources'
            folder.mkdir()
            sources.mkdir()
            for name in MEASUREMENT_MODULES:
                (sources / (name + '.py')).write_bytes(Path(__file__).with_name(name + '.py').read_bytes())
            # Only the external Docker/gateway dependencies are synthetic. The
            # real entry, native HTTP adapter, lifecycle and receipt code execute.
            wrapper = '\nimport copy, uuid, base64, json\nfrom operation_maintenance import CHANNEL\n' + inspect.getsource(Fixture) + '''
_actual_execute = execute
_actual_maintenance = Maintenance
def execute(plan, folder, progress):
    class ReadOnlyDocker:
        def inspect(self, name): return plan['fixture_container']
        def idle(self, url): return True
        def native_request(self, url, route):
            assert route == '/v1/models'
            return {'status':200,'body_base64':base64.b64encode(b'{"data":[{"id":"native-model"}]}').decode()}
    control = Fixture()
    control.worker['url'] = plan['hourglass']['endpoint']
    globals()['SSHDocker'] = lambda *a, **kw: ReadOnlyDocker()
    globals()['GatewayControl'] = lambda *a: control
    globals()['Maintenance'] = lambda *a, **kw: _actual_maintenance(*a, **kw, sleep=lambda _:None)
    result = _actual_execute(plan, folder, progress)
    assert not control.worker['drained']
    return result
'''
            with (sources / 'hourglass_executor.py').open('a') as stream:
                stream.write(wrapper)
            execution = build_executor(folder, source_directory=sources, kind='hourglass')
            record = root / 'record.json'
            record.write_text(json.dumps({'worker_id': 'fixture'}))
            revision = hashlib.sha256(record.read_bytes()).hexdigest()
            plan = {**self.plan, 'record_file': str(record), 'record_revision': revision,
                'execution': execution, 'fixture_container': self.docker.old}
            raw = json.dumps(plan).encode()
            (folder / 'plan.json').write_bytes(raw)
            binding = {'plan_revision': hashlib.sha256(raw).hexdigest(), 'record_revision': revision, 'actor': 'owner'}
            for name in ['prepared.json', 'approved.json', 'launch-intent.json']:
                (folder / name).write_text(json.dumps(binding))
            (folder / 'proposal.json').write_text(json.dumps({'id': folder.name, 'worker_id': 'fixture'}))
            for path in sources.glob('*.py'):
                path.write_text('raise RuntimeError("Changed source must not execute")\n')
            command = [sys.executable, '-I', str(Path(__file__).with_name('operation_runner.py')), 'run', str(folder)]
            result = subprocess.run(command, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            saved = json.loads((folder / 'runner-result.json').read_text())
            self.assertEqual(saved['state'], 'completed', saved)
            self.assertEqual(saved['measurement']['native_state'], 'completed')
            self.assertEqual(sum(c[0] == 'POST' for c in self.calls), 1)
            self.assertEqual(subprocess.run(command, capture_output=True, timeout=30).returncode, 0)
            self.assertEqual(sum(c[0] == 'POST' for c in self.calls), 1)

    def test_gateway_route_changed_after_preparation_does_not_hold_or_start(self):
        control = Fixture()
        control.worker['url'] = 'http://127.0.0.1:9/v1'
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / self.plan['id']
            folder.mkdir()
            with patch.object(hourglass_executor, '_BUNDLED_SOURCES', {'docker_profile': 'fixture source'}, create=True), \
                    patch.object(hourglass_executor, 'SSHDocker', return_value=self.docker), \
                    patch.object(hourglass_executor, 'GatewayControl', return_value=control):
                with self.assertRaisesRegex(RuntimeError, 'target is not verified'):
                    hourglass_executor.execute(self.plan, folder, lambda *a: None)
            self.assertFalse(control.worker['drained'])
            self.assertTrue(all(c == ('/workers', None) for c in control.calls))
            self.assertFalse(any(c[0] == 'POST' for c in self.calls))


if __name__ == '__main__':
    unittest.main()
