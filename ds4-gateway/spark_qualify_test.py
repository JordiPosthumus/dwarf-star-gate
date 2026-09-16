import base64
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import spark_qualify as module


class SparkQualificationTests(unittest.TestCase):
    def test_full_checks_follow_restart_and_bind_the_returned_instance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            container = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64,
                         'Config': {}, 'HostConfig': {}, 'Mounts': [],
                         'State': {'Running': False, 'StartedAt': 'stopped'}}
            original = copy.deepcopy(container)
            events = []
            docker = Mock()
            docker.inspect.side_effect = lambda _: copy.deepcopy(container)
            def start(_):
                events.append('start')
                container['State'].update(Running=True, StartedAt='first-start')
            docker.start.side_effect = start
            def recovery(directory, before, url, **_):
                self.assertEqual(before['State']['StartedAt'], 'first-start')
                events.append('restart')
                container['State']['StartedAt'] = 'restarted'
                return {'instance': 'returned-instance'}
            class Qualification:
                def __init__(self, *args, **kwargs):
                    pass
                def verify(self, directory):
                    events.append('native-checks')
                    self_result = {'state': 'passed', 'checks_passed': ['text', 'prefix_cache', 'context_boundary']}
                    directory.mkdir()
                    (directory / 'result.json').write_text(json.dumps(self_result))
                    return self_result
            with patch.object(module, 'prepared', return_value=(original, 'http://127.0.0.1:8003', {'model': 'fixture', 'context_length': 262144}, {'port': 8003, 'profile_sha256': 'profile', 'prepared_profile_sha256': 'profile'})), patch.object(module.subprocess, 'check_output', return_value=''), patch.object(module, 'verify_recovery_proof') as verify:
                result = module.qualify(root, root / 'qualification', docker=docker,
                                        request=lambda *_: {'status': 200}, idle=lambda _: True,
                                        qualifier=Qualification, recovery=recovery, wait=lambda _: None)
                self.assertEqual(events, ['start', 'restart', 'native-checks'])
                self.assertEqual(result['state'], 'qualified_serving')
                self.assertEqual(result['recovery_restart'], 'passed')
                proof = json.loads((root / 'qualification/serving-proof.json').read_text())
                self.assertEqual(proof['started_at'], 'restarted')
                self.assertEqual(proof['recovery']['instance'], 'returned-instance')
                verify.assert_called_once_with({'instance': 'returned-instance'})
                docker.stop.assert_not_called()


if __name__ == '__main__':
    unittest.main()
