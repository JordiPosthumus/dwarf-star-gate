import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('qualification', Path(__file__).with_name('spark_qualify.py'))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


class Docker:
    def __init__(self, value): self.value, self.calls = value, []
    def inspect(self, cid):
        assert cid == self.value['Id']
        return copy.deepcopy(self.value)
    def start(self, cid):
        self.calls.append(('start', cid)); self.value['State'].update(Running=True, StartedAt='first-start')
    def stop(self, cid):
        self.calls.append(('stop', cid)); self.value['State']['Running'] = False


class Passing:
    def __init__(self, *args, **kwargs): pass
    def verify(self, folder):
        folder.mkdir()
        result = {'state': 'passed', 'checks_passed': sorted(q.NativeQualification.checks_supported)}
        (folder / 'result.json').write_text(json.dumps(result))
        return result


class Failing(Passing):
    def verify(self, folder): return {'state': 'failed'}


class QualificationTests(unittest.TestCase):
    def fixture(self, root):
        profile = json.loads(q.PROFILE.read_text())
        creator = q.module('fixture_creator', q.SOURCE / 'examples/spark-build/create-llm.py')
        command, env = creator.serving_arguments(profile)
        data = root / 'engines/qwen38-repaired/data'; data.mkdir(parents=True)
        models = root / 'engines/qwen38-repaired/models'
        cid, image = 'a' * 64, 'sha256:' + 'b' * 64
        (data / 'container.json').write_text(json.dumps({'container': cid, 'image': image, 'port': 8001, 'profile_sha256': hashlib.sha256(q.PROFILE.read_bytes()).hexdigest()}))
        (root / 'engines/setup.json').write_text(json.dumps({'state': 'prepared_stopped', 'engines': {'qwen38-repaired': {'container': cid, 'image': image, 'data': str(data), 'models': str(models)}}}))
        docker = Docker({'Id': cid, 'Image': image, 'State': {'Running': False, 'StartedAt': ''},
                         'Config': {'Entrypoint': ['vllm', 'serve'], 'Cmd': command, 'Env': [k + '=' + v for k, v in env.items()]},
                         'HostConfig': {'IpcMode': 'host', 'NetworkMode': 'bridge', 'ShmSize': 16 * 1024**3, 'RestartPolicy': {'Name': 'unless-stopped'}, 'SecurityOpt': ['label=disable'], 'DeviceRequests': [{'Count': -1, 'Capabilities': [['gpu']]}], 'PortBindings': {'8000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8001'}]}},
                         'Mounts': [{'Destination': '/models/qwen38', 'Source': str(models), 'RW': False}, {'Destination': '/root/.cache', 'Source': str(data / 'cache'), 'RW': True}]})
        return docker

    def request(self, *_):
        return {'status': 200, 'body_base64': base64.b64encode(json.dumps({'data': [{'id': 'qwen3.8-flash-next', 'max_model_len': 262144}]}).encode()).decode()}

    def test_pass_keeps_exact_container_running_and_fresh_proof_rejects_a_restart(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(q.subprocess, 'check_output', return_value=''):
            root = Path(tmp); docker = self.fixture(root); before = q.signature(docker.value)
            value = q.qualify(root, root / 'qualification', docker=docker, request=self.request, idle=lambda _: True, qualifier=Passing)
            self.assertEqual(value['state'], 'qualified_serving')
            self.assertEqual(q.signature(docker.value), before)
            self.assertEqual(docker.calls, [('start', 'a' * 64)])
            self.assertEqual(q.verify_serving(root, docker=docker, request=self.request)['state'], 'qualified_serving')
            docker.value['State']['StartedAt'] = 'another-instance'
            with self.assertRaisesRegex(ValueError, 'no longer serving unchanged'):
                q.verify_serving(root, docker=docker, request=self.request)

    def test_reference_prose_revision_is_retained_without_changing_serving_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); docker = self.fixture(root)
            file = root / 'engines/qwen38-repaired/data/container.json'
            receipt = json.loads(file.read_text());receipt['profile_sha256'] = 'older-document';file.write_text(json.dumps(receipt))
            _container, _url, _contract, compared = q.prepared(root, docker)
            self.assertEqual(compared['prepared_profile_sha256'], 'older-document')
            self.assertEqual(compared['profile_sha256'], hashlib.sha256(q.PROFILE.read_bytes()).hexdigest())
            self.assertEqual(docker.calls, [])

    def test_rejects_changed_flags_and_active_gpu_without_starting(self):
        for changed in ('command', 'gpu'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as tmp, patch.object(q.subprocess, 'check_output', return_value='123\n'):
                root = Path(tmp); docker = self.fixture(root)
                if changed == 'command': docker.value['Config']['Cmd'].append('--different')
                with self.assertRaises(ValueError):
                    q.qualify(root, root / 'qualification', docker=docker, request=self.request, idle=lambda _: True, qualifier=Passing)
                self.assertEqual(docker.calls, [])

    def test_failed_checks_stop_only_owned_idle_candidate(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(q.subprocess, 'check_output', return_value=''):
            root = Path(tmp); docker = self.fixture(root)
            with self.assertRaisesRegex(ValueError, 'Native qualification failed'):
                q.qualify(root, root / 'qualification', docker=docker, request=self.request, idle=lambda _: True, qualifier=Failing)
            self.assertEqual(docker.calls, [('start', 'a' * 64), ('stop', 'a' * 64)])
            self.assertTrue(json.loads((root / 'qualification/progress.json').read_text())['candidate_stopped'])

    def test_unobserved_native_idle_is_not_permission_to_stop(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(q.subprocess, 'check_output', return_value=''):
            root = Path(tmp); docker = self.fixture(root)
            with self.assertRaisesRegex(ValueError, 'already present'):
                q.qualify(root, root / 'qualification', docker=docker, request=self.request, idle=lambda _: False, qualifier=Failing)
            self.assertEqual(docker.calls, [('start', 'a' * 64)])
            self.assertFalse(json.loads((root / 'qualification/progress.json').read_text())['candidate_stopped'])


if __name__ == '__main__': unittest.main()
