import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('profile', Path(__file__).with_name('docker_profile.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
OLD, NEW = 'a' * 64, 'b' * 64
IMAGE = 'sha256:' + 'c' * 64
OP = '12345678-1234-1234-1234-123456789abc'


class Docker:
    def __init__(self):
        self.old = {'Id': OLD, 'Image': IMAGE, 'Name': '/engine',
                    'State': {'Running': True, 'StartedAt': 'original'},
                    'Config': {'Image': IMAGE, 'Cmd': ['--max-model-len', '262144', '--max-num-seqs', '1'],
                               'Env': ['KEEP=me'], 'Volumes': None},
                    'HostConfig': {'Binds': ['/models:/models:ro'], 'OomKillDisable': None,
                                   'PortBindings': {'8000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8001'}]}},
                    'Mounts': [{'Type': 'bind', 'Source': '/models', 'Destination': '/models', 'RW': False}]}
        self.containers = {OLD: self.old}
        self.calls = []
        self.fail = None
        self.after_create = None

    def inspect(self, value):
        found = self.containers.get(value) or next((c for c in self.containers.values() if c['Name'] == '/' + value), None)
        return copy.deepcopy(found)

    def image(self, value):
        return {'Id': value} if value == IMAGE else None

    def record(self, name):
        self.calls.append(name)
        if self.fail == name:
            raise TimeoutError('uncertain acknowledgement')

    def create(self, name, body):
        self.record('create')
        body = copy.deepcopy(body)  # A Docker HTTP response cannot alias the caller's plan.
        c = copy.deepcopy(self.old)
        c.update(Id=NEW, Name='/' + name, Image=body['Image'], State={'Running': False, 'StartedAt': ''},
                 Config={k: v for k, v in body.items() if k != 'HostConfig'}, HostConfig=body['HostConfig'])
        self.containers[NEW] = c
        if self.after_create:
            self.after_create(c)
        return {'Id': NEW}

    def stop(self, cid):
        self.record('stop-' + cid[:1])
        self.containers[cid]['State']['Running'] = False

    def rename(self, cid, name):
        self.record('rename-' + cid[:1])
        self.containers[cid]['Name'] = '/' + name

    def start(self, cid):
        self.record('start-' + cid[:1])
        self.containers[cid]['State'] = {'Running': True, 'StartedAt': 'new-start'}


class Profiles(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.docker = Docker()
        self.owned = True
        self.idle = True
        self.driver = m.RetainedProfile(self.root, docker=self.docker, lease_check=lambda _: self.owned,
                                       idle=lambda _: self.idle, sleep=lambda _: None)
        self.command = ['--max-model-len', '262144', '--max-num-seqs', '2']
        self.plan = self.driver.prepare('engine', IMAGE, self.command, 'http://127.0.0.1:8001', 'd' * 64)
        self.digest = m.digest(self.plan)

    def apply(self):
        return self.driver.apply(OP, self.plan, self.digest)

    def test_prepare_is_read_only_and_preserves_unrelated_settings(self):
        self.assertEqual(self.docker.calls, [])
        self.assertEqual(self.plan['create']['Env'], ['KEEP=me'])
        self.assertEqual(self.plan['create']['HostConfig']['Binds'], ['/models:/models:ro'])
        self.assertEqual(self.plan['before']['Config']['Cmd'][-1], '1')
        self.assertEqual(self.plan['create']['Cmd'][-1], '2')

    def test_rejected_approval_or_changed_current_never_stops_server(self):
        with self.assertRaises(ValueError):
            self.driver.apply(OP, self.plan, 'e' * 64)
        self.docker.old['Config']['Env'] = ['OWNER_EDIT=yes']
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.apply()
        self.assertEqual(self.docker.calls, [])
        self.assertTrue(self.docker.old['State']['Running'])

    def test_plan_cannot_smuggle_changed_mounts_under_same_adapter(self):
        self.plan['create']['HostConfig']['Binds'] = ['/private:/models']
        self.digest = m.digest(self.plan)
        with self.assertRaisesRegex(ValueError, 'Only the reviewed'):
            self.apply()
        self.assertEqual(self.docker.calls, [])

    def test_busy_or_missing_lease_never_changes_a_container(self):
        for case in ['busy', 'unowned']:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as root:
                self.driver.directory = Path(root)
                self.idle, self.owned = case != 'busy', case != 'unowned'
                with self.assertRaises(RuntimeError):
                    self.apply()
                self.assertEqual(self.docker.calls, [])

    def test_candidate_with_changed_environment_is_retained_but_never_started(self):
        self.docker.after_create = lambda c: c['Config']['Env'].append('UNREVIEWED=value')
        with self.assertRaisesRegex(RuntimeError, 'unrelated'):
            self.apply()
        self.assertEqual(self.docker.calls, ['create'])
        self.assertTrue(self.docker.old['State']['Running'])
        self.assertFalse(self.docker.containers[NEW]['State']['Running'])

    def test_lease_loss_after_create_preserves_current_server(self):
        def lose(_):
            self.owned = False
        self.docker.after_create = lose
        with self.assertRaisesRegex(RuntimeError, 'maintenance'):
            self.apply()
        self.assertEqual(self.docker.calls, ['create'])

    def test_apply_retains_original_and_never_claims_qualification(self):
        result = self.apply()
        self.assertEqual(result['state'], 'started_unverified')
        self.assertFalse(self.docker.old['State']['Running'])
        self.assertTrue(self.docker.containers[NEW]['State']['Running'])
        self.assertEqual(self.docker.old['Config']['Cmd'][-1], '1')
        self.assertEqual(self.docker.containers[NEW]['Config']['Cmd'][-1], '2')
        for intent in (self.root / OP).glob('*.intent.json'):
            self.assertTrue(intent.with_name(intent.name.replace('.intent.', '.result.')).exists())

    def test_uncertain_create_and_interrupted_cutover_are_never_replayed(self):
        for phase in ['create', 'stop-a', 'rename-a', 'start-b']:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as root:
                self.docker = Docker()
                self.driver.docker = self.docker
                self.driver.directory = Path(root)
                self.docker.fail = phase
                with self.assertRaises(TimeoutError):
                    self.apply()
                before = list(self.docker.calls)
                self.assertEqual(self.apply()['state'], 'requires_reconciliation')
                self.assertEqual(self.docker.calls, before)

    def test_restore_retains_candidate_and_repeat_is_observation_only(self):
        self.apply()
        result = self.driver.restore(OP, self.digest)
        self.assertEqual(result['state'], 'restored_unverified')
        self.assertTrue(self.docker.old['State']['Running'])
        self.assertFalse(self.docker.containers[NEW]['State']['Running'])
        self.assertEqual(self.docker.old['Name'], '/engine')
        before = list(self.docker.calls)
        self.assertEqual(self.driver.restore(OP, self.digest)['state'], 'restored_unverified')
        self.assertEqual(self.apply()['state'], 'restored_unverified')
        self.assertEqual(before, self.docker.calls)

    def test_restore_refuses_active_native_work_or_changed_candidate(self):
        self.apply()
        self.idle = False
        before = list(self.docker.calls)
        with self.assertRaisesRegex(RuntimeError, 'Native'):
            self.driver.restore(OP, self.digest)
        self.idle = True
        self.docker.containers[NEW]['Config']['Env'].append('OWNER_EDIT=yes')
        with self.assertRaisesRegex(RuntimeError, 'reconciled candidate'):
            self.driver.restore(OP, self.digest)
        self.assertEqual(before, self.docker.calls)

    def test_changed_previous_version_is_not_automatic_restoration(self):
        self.apply()
        self.docker.old['Config']['Cmd'] = ['different']
        before = list(self.docker.calls)
        with self.assertRaises(RuntimeError):
            self.driver.restore(OP, self.digest)
        self.assertEqual(before, self.docker.calls)

    def test_anonymous_volume_or_missing_image_requires_other_preparation(self):
        self.docker.old['Config']['Volumes'] = {'/data': {}}
        with self.assertRaisesRegex(ValueError, 'volume-retention'):
            self.driver.prepare('engine', IMAGE, self.command, 'http://127.0.0.1:8001', 'd' * 64)
        self.docker.old['Config']['Volumes'] = None
        with self.assertRaisesRegex(ValueError, 'retained locally'):
            self.driver.prepare('engine', 'sha256:' + 'e' * 64, self.command, 'http://127.0.0.1:8001', 'd' * 64)

    def test_retention_incompatible_lifecycle_is_not_silently_rewritten(self):
        self.docker.old['HostConfig']['AutoRemove'] = True
        with self.assertRaisesRegex(ValueError, 'retention'):
            self.driver.prepare('engine', IMAGE, self.command, 'http://127.0.0.1:8001', 'd' * 64)
        self.assertEqual(self.docker.calls, [])
        self.assertTrue(self.docker.old['HostConfig']['AutoRemove'])

    def test_duplicate_operation_id_with_different_plan_is_rejected(self):
        self.apply()
        self.plan['record_revision'] = 'e' * 64
        before = list(self.docker.calls)
        with self.assertRaisesRegex(ValueError, 'different plan'):
            self.driver.apply(OP, self.plan, m.digest(self.plan))
        self.assertEqual(self.docker.calls, before)

    def test_identity_change_during_idle_check_prevents_restoration(self):
        self.apply()
        before = list(self.docker.calls)
        def change(_):
            self.docker.old['Config']['Env'].append('OWNER_EDIT=yes')
            return True
        self.driver.idle = change
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            self.driver.restore(OP, self.digest)
        self.assertEqual(self.docker.calls, before)

    def test_idle_endpoint_cannot_observe_another_server(self):
        with self.assertRaisesRegex(ValueError, 'not bound'):
            self.driver.prepare('engine', IMAGE, self.command, 'http://127.0.0.1:8002', 'd' * 64)
        self.plan['native_url'] = 'http://127.0.0.1:8002'
        with self.assertRaisesRegex(ValueError, 'not bound'):
            self.driver.apply(OP, self.plan, m.digest(self.plan))
        self.assertEqual(self.docker.calls, [])

    def test_matching_port_on_another_address_or_udp_is_not_idle_evidence(self):
        for bindings in [{'8000/tcp': [{'HostIp': '192.0.2.10', 'HostPort': '8001'}]},
                         {'8000/udp': [{'HostIp': '127.0.0.1', 'HostPort': '8001'}]}]:
            self.docker.old['HostConfig']['PortBindings'] = bindings
            with self.assertRaisesRegex(ValueError, 'not bound'):
                self.driver.prepare('engine', IMAGE, self.command, 'http://127.0.0.1:8001', 'd' * 64)

    def test_receipt_write_failure_prevents_the_next_external_action(self):
        save = self.driver._save
        def fail_before_stop(folder, name, value):
            if name == 'stop-previous.intent.json':
                raise OSError('fixture disk full')
            return save(folder, name, value)
        self.driver._save = fail_before_stop
        with self.assertRaises(OSError):
            self.apply()
        self.assertEqual(self.docker.calls, ['create'])
        self.assertTrue(self.docker.old['State']['Running'])

    def test_uncertain_restore_is_observed_without_restarting_again(self):
        self.apply()
        self.docker.fail = 'start-a'
        with self.assertRaises(TimeoutError):
            self.driver.restore(OP, self.digest)
        before = list(self.docker.calls)
        self.assertEqual(self.driver.restore(OP, self.digest)['state'], 'requires_reconciliation')
        self.assertEqual(self.docker.calls, before)

    def test_saved_plan_is_rechecked_for_retention_before_execution(self):
        self.plan['before']['HostConfig']['AutoRemove'] = True
        self.plan['create']['HostConfig']['AutoRemove'] = True
        self.docker.old['HostConfig']['AutoRemove'] = True
        with self.assertRaisesRegex(ValueError, 'retention'):
            self.driver.apply(OP, self.plan, m.digest(self.plan))
        self.assertEqual(self.docker.calls, [])


if __name__ == '__main__':
    unittest.main()
