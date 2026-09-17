import json
import subprocess
import sys
import unittest
from unittest.mock import Mock

from docker_profile_remote import BOOTSTRAP, SSHDocker, RemoteObservationUnavailable


class RemoteTest(unittest.TestCase):
    def transport(self, value=None):
        run = Mock(return_value=subprocess.CompletedProcess([], 0, json.dumps({'ok': True, 'result': value}), ''))
        return SSHDocker('fixture-host', run=run), run

    def test_commands_are_json_data_not_remote_shell(self):
        transport, run = self.transport({'Id': 'a' * 64})
        command = ['serve', '$(touch /tmp/never-execute)', "'; echo PRIVATE; '"]
        transport.create('fixture; $(false)', {'Cmd': command})
        argv, kwargs = run.call_args.args[0], run.call_args.kwargs
        self.assertEqual(argv[-2], 'fixture-host')
        self.assertNotIn('never-execute', ' '.join(argv))
        self.assertEqual(json.loads(kwargs['input'])['body']['Cmd'], command)
        self.assertIsNone(kwargs['timeout'])

    def test_graceful_stop_has_no_invented_transport_or_kill_deadline(self):
        transport, run = self.transport()
        transport.stop('a' * 64)
        payload = json.loads(run.call_args.kwargs['input'])
        self.assertTrue(payload['path'].endswith('/stop?t=-1'))
        self.assertIsNone(payload['timeout'])
        self.assertIsNone(run.call_args.kwargs['timeout'])

    def test_read_timeout_does_not_repeat_observation_or_mutation(self):
        transport, run = self.transport()
        run.side_effect = subprocess.TimeoutExpired('ssh', 35)
        with self.assertRaisesRegex(RemoteObservationUnavailable, 'no action was retried'):
            transport.inspect('fixture')
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.kwargs['timeout'], 35)

    def test_uncertain_mutation_preserved_without_private_error_or_retry(self):
        transport, run = self.transport()
        run.return_value = subprocess.CompletedProcess([], 255, '', 'PRIVATE_SSH_HOST')
        with self.assertRaisesRegex(RuntimeError, '^Remote observation or operation could not be confirmed; no action was retried.$'):
            transport.start('a' * 64)
        self.assertEqual(run.call_count, 1)

    def test_only_read_only_failures_allow_later_reobservation(self):
        transport, run = self.transport()
        run.side_effect = subprocess.TimeoutExpired('ssh', 25)
        for call in [lambda: transport.idle('http://127.0.0.1:8001'),
                     lambda: transport.native_request('http://127.0.0.1:8001', '/v1/models')]:
            with self.assertRaises(RemoteObservationUnavailable): call()
        for call in [lambda: transport.start('a' * 64),
                     lambda: transport.native_request('http://127.0.0.1:8001', '/v1/chat/completions', {})]:
            with self.assertRaises(RuntimeError) as error: call()
            self.assertNotIsInstance(error.exception, RemoteObservationUnavailable)
        self.assertEqual(run.call_count, 4)

    def test_enrollment_and_native_endpoint_validation(self):
        for host in ['-oProxyCommand=bad', 'server; bad', '$(bad)', 'server\nother']:
            with self.assertRaises(ValueError): SSHDocker(host)
        transport, run = self.transport(True)
        with self.assertRaises(ValueError): transport.idle('http://external.invalid:8001')
        self.assertEqual(run.call_count, 0)
        self.assertTrue(transport.idle('http://127.0.0.1:8001'))

    def test_native_inference_has_no_new_transport_deadline_and_is_not_shell_text(self):
        transport, run = self.transport({'status': 200, 'body_base64': 'e30='})
        body = {'messages': [{'role': 'user', 'content': '$(do-not-execute)'}]}
        transport.native_request('http://127.0.0.1:8001', '/v1/chat/completions', body)
        self.assertIsNone(run.call_args.kwargs['timeout'])
        self.assertNotIn('do-not-execute', ' '.join(run.call_args.args[0]))
        self.assertEqual(json.loads(run.call_args.kwargs['input'])['body'], body)
        self.assertEqual(run.call_count, 1)

    def test_native_readiness_uses_bounded_observation(self):
        transport, run = self.transport({'status': 200, 'body_base64': 'e30='})
        transport.native_request('http://127.0.0.1:8001', '/v1/models')
        self.assertEqual(run.call_args.kwargs['timeout'], 25)

    def test_exact_bootstrap_roundtrip_with_separate_python_process(self):
        # Exercise real JSON stdin/stdout and exception handling without SSH or
        # Docker. This is transport protocol evidence, not a live host check.
        source = "class Docker:\n def __init__(self, socket): pass\n def request(self,*a,**k): return {'observed':a[1]}\n"
        payload = {'source': source, 'operation': 'docker', 'socket': '/fixture.sock',
                   'method': 'GET', 'path': '/containers/fixture/json', 'timeout': 20, 'missing': True}
        result = subprocess.run([sys.executable, '-I', '-c', BOOTSTRAP], input=json.dumps(payload), text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), {'ok': True, 'result': {'observed': '/containers/fixture/json'}})
        payload['method'] = 'DELETE'
        failed = subprocess.run([sys.executable, '-I', '-c', BOOTSTRAP], input=json.dumps(payload), text=True, capture_output=True)
        self.assertEqual(failed.returncode, 1)
        self.assertFalse(json.loads(failed.stdout)['ok'])


if __name__ == '__main__':
    unittest.main()
