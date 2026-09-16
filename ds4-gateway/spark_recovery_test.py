import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from spark_recovery import restart_new_llm, verify_recovery_proof


class SparkRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.container = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64,
                          'Config': {'Cmd': ['model', '--port', '8000']},
                          'HostConfig': {}, 'Mounts': [],
                          'State': {'Running': True, 'StartedAt': 'original'}}
        self.before = copy.deepcopy(self.container)
        self.identity = {'active': True, 'listener': True, 'fault': None,
                         'instance': 'c' * 32, 'machine': 'd' * 64, 'profile': 'e' * 64}
        self.calls = []
        self.docker = Mock()
        self.docker.inspect.side_effect = lambda _: copy.deepcopy(self.container)

    def call(self, helper, config, request):
        self.calls.append(request)
        self.assertEqual(json.loads(Path(config).read_text()), {'container': 'a' * 64, 'port': 8000})
        self.assertEqual(Path(config).stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(helper).read_bytes(), Path(__file__).with_name('recovery-docker.py').read_bytes())
        if request['action'] == 'restart':
            self.assertTrue(request['canary'])
            self.assertEqual(request['instance'], self.identity['instance'])
            self.identity['instance'] = 'f' * 32
            self.container['State']['StartedAt'] = 'restarted'
            return {'state': 'issued', 'instance': request['instance']}
        return dict(self.identity)

    def execute(self, **changes):
        options = dict(docker=self.docker, idle=lambda _: True,
                       request=lambda *_: {'status': 200}, progress=lambda *_: None,
                       call=self.call, wait=lambda _: None)
        options.update(changes)
        return restart_new_llm(self.root, self.before, 'http://127.0.0.1:8003', **options)

    def test_actual_helper_bytes_dedicated_config_and_one_restart(self):
        proof = self.execute()
        self.assertEqual([c['action'] for c in self.calls], ['inspect', 'restart', 'inspect'])
        self.assertEqual(proof['instance'], 'f' * 32)
        self.assertEqual(verify_recovery_proof(proof, call=self.call), self.identity)
        self.assertEqual(self.container['Config'], self.before['Config'])
        self.assertEqual(self.container['HostConfig'], self.before['HostConfig'])
        self.assertEqual(self.container['Mounts'], self.before['Mounts'])
        # Rerunning cannot replay a restart or replace a helper/config.
        count = len(self.calls)
        with self.assertRaises(FileExistsError):
            self.execute()
        self.assertEqual(len(self.calls), count)

    def test_direct_work_prevents_restart(self):
        with self.assertRaisesRegex(ValueError, 'Native work is active'):
            self.execute(idle=lambda _: False)
        self.assertEqual([c['action'] for c in self.calls], ['inspect'])
        self.assertFalse((self.root / 'recovery/restart-intent.json').exists())

    def test_changed_configuration_prevents_restart(self):
        self.container['Config']['Cmd'] += ['--changed']
        with self.assertRaisesRegex(ValueError, 'changed before'):
            self.execute()
        self.assertEqual([c['action'] for c in self.calls], ['inspect'])

    def test_lost_ack_is_retained_without_retry(self):
        def call(helper, config, request):
            result = self.call(helper, config, request)
            if request['action'] == 'restart':
                raise OSError('Lost acknowledgement')
            return result
        with self.assertRaises(OSError):
            self.execute(call=call)
        self.assertTrue((self.root / 'recovery/restart-intent.json').exists())
        self.assertFalse((self.root / 'recovery/restart-receipt.json').exists())
        self.assertEqual(len([c for c in self.calls if c['action'] == 'restart']), 1)

    def test_read_only_proof_rejects_changed_helper_or_live_instance(self):
        proof = self.execute()
        self.identity['instance'] = '0' * 32
        with self.assertRaisesRegex(ValueError, 'instance is no longer'):
            verify_recovery_proof(proof, call=self.call)
        self.identity['instance'] = proof['instance']
        Path(proof['helper']).write_text('changed')
        with self.assertRaisesRegex(ValueError, 'helper/config changed'):
            verify_recovery_proof(proof, call=self.call)


if __name__ == '__main__':
    unittest.main()
