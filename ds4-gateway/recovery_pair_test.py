import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from recovery_pair import enrollment_identity, file_pins, fingerprint, observe_pair, recover_pair, signature
from recovery_pair_native import PairJournal, RemotePair, private_read, private_save


class Fixture:
    def __init__(self, stopped=False):
        self.observations = []
        self.enrollment = {'schema': 1, 'kind': 'glm53-docker-pair', 'worker_id': 'custom-pair',
                           'model': 'fixture-model', 'port': 8000, 'context_length': 400000, 'concurrency': 2, 'members': []}
        for i in range(2):
            root = '/fixture/recipe'
            files = {root + '/' + name: {'sha256': 'e' * 64, 'mode': 0o600}
                     for name in ('.env', 'start.sh', '.glm53-exl3-head.inner.sh')}
            container = {'Id': str(i + 1) * 64, 'Image': 'sha256:' + 'f' * 64,
                         'Config': {'Env': ['MAX_MODEL_LEN=400000', 'MAX_NUM_SEQS=2', 'MAX_TOKENS=65536', 'THINKING=enabled'], 'Cmd': ['unchanged']},
                         'HostConfig': {'OomKillDisable': False, 'RestartPolicy': {'Name': 'unless-stopped'}},
                         'Mounts': [{'Destination': '/config', 'Source': root + '/.env', 'Type': 'bind'}],
                         'State': {'Running': not stopped, 'Status': 'exited' if stopped else 'running', 'Paused': False,
                                   'Restarting': False, 'Dead': False, 'StartedAt': '2026-01-01T00:00:00Z', 'FinishedAt': '2026-01-01T00:00:01Z' if stopped else '0001-01-01T00:00:00Z'}}
            member = {'ssh': f'fixture-{i}', 'machine': ('a' if i == 0 else 'b') * 64,
                      'container': container['Id'], 'recipe_root': root, 'definition': signature(container), 'files': files}
            self.enrollment['members'].append(member)
            self.observations.append({'machine': member['machine'], 'container': container, 'files': copy.deepcopy(files),
                                      'started_at': 1000, 'listener_owned': not stopped,
                                      'fault': None if stopped else {'reason': 'fatal_accelerator_error', 'at': 2000}})
        identity = enrollment_identity(self.enrollment)
        self.request = {'action': 'start' if stopped else 'restart', 'action_id': '12345678-1234-1234-1234-123456789abc',
                        'epoch': observe_pair(self.enrollment, self.observations)['epoch'], **identity, 'canary': False, 'fault_after': 1500}
        self.journal = None
        self.commands = []
        self.saves = []
        self.owned = True
        self.hook = None

    def save(self, value):
        self.journal = copy.deepcopy(value)
        self.saves.append(copy.deepcopy(value))

    def command(self, action, host, container):
        index = [m['ssh'] for m in self.enrollment['members']].index(host)
        assert self.enrollment['members'][index]['container'] == container
        assert self.journal['steps'][-1]['state'] == 'intent'
        assert self.journal['steps'][-1]['action'] == action
        self.commands.append((action, index, container))
        row = self.observations[index]
        state = row['container']['State']
        state.update(Running=action == 'start', Status='running' if action == 'start' else 'exited')
        state['StartedAt' if action == 'start' else 'FinishedAt'] = f'2026-01-01T00:00:{len(self.commands) + 10:02}Z'
        row.update(listener_owned=action == 'start', fault=None)
        if self.hook:
            self.hook(action, index)

    def run(self):
        return recover_pair(self.enrollment, self.request, read_journal=lambda: copy.deepcopy(self.journal),
                            save_journal=self.save, observe=lambda: copy.deepcopy(self.observations),
                            stop=lambda host, container: self.command('stop', host, container),
                            start=lambda host, container: self.command('start', host, container),
                            ownership=lambda: self.owned, now=lambda: 5000)


class PairRecoveryTests(unittest.TestCase):
    def test_exact_restart_order_preserves_definitions_and_does_not_claim_serving(self):
        f = Fixture()
        before = copy.deepcopy(f.enrollment)
        result = f.run()
        self.assertEqual(result['state'], 'completed')
        self.assertEqual([(action, member) for action, member, _ in f.commands], [('stop', 0), ('stop', 1), ('start', 1), ('start', 0)])
        self.assertEqual(f.enrollment, before)
        self.assertIn('remain required', result['scope'])
        for i, row in enumerate(f.observations):
            self.assertEqual(signature(row['container']), before['members'][i]['definition'])
        self.assertEqual(f.run(), result)
        self.assertEqual(len(f.commands), 4)

    def test_stopped_start_never_sends_stop_or_recreates_containers(self):
        f = Fixture(stopped=True)
        self.assertEqual(f.run()['state'], 'completed')
        self.assertEqual([(action, member) for action, member, _ in f.commands], [('start', 1), ('start', 0)])

    def test_members_machines_image_launch_settings_and_mounted_files_are_pinned(self):
        for change in ('machine', 'container', 'image', 'environment', 'command', 'mount', 'file', 'mode', 'recipe_absent'):
            with self.subTest(change=change):
                f = Fixture()
                row = f.observations[1]
                if change == 'machine': row['machine'] = 'd' * 64
                elif change == 'container': row['container']['Id'] = '3' * 64
                elif change == 'image': row['container']['Image'] = 'sha256:' + 'd' * 64
                elif change == 'environment': row['container']['Config']['Env'][0] = 'MAX_MODEL_LEN=8192'
                elif change == 'command': row['container']['Config']['Cmd'] = ['replacement']
                elif change == 'mount': row['container']['Mounts'][0]['Source'] = '/other'
                elif change == 'file': row['files']['/fixture/recipe/.env']['sha256'] = 'd' * 64
                elif change == 'mode': row['files']['/fixture/recipe/.env']['mode'] = 0o644
                else: row['files']['/fixture/recipe/.env'] = {'absent': True}
                with self.assertRaises(ValueError): f.run()
                self.assertFalse(f.commands)
                self.assertIsNone(f.journal)

    def test_partial_unknown_and_paused_states_are_not_guessed(self):
        for patch in ({'Paused': True}, {'Restarting': True}, {'Dead': True}, {'Running': False, 'Status': 'removing'}, {'Running': False, 'Status': 'exited'}):
            f = Fixture()
            f.observations[1]['container']['State'].update(patch)
            with self.assertRaises(ValueError): f.run()
            self.assertFalse(f.commands)

    def test_changed_epoch_and_old_or_absent_fatal_evidence_refuse(self):
        for change in ('epoch', 'old', 'missing', 'previous_instance'):
            f = Fixture()
            if change == 'epoch': f.observations[0]['container']['State']['StartedAt'] = '2026-01-02T00:00:00Z'
            else:
                for row in f.observations:
                    row['fault'] = None if change == 'missing' else {'reason': 'fatal_accelerator_error', 'at': 1100 if change == 'old' else 999}
            with self.assertRaises(ValueError): f.run()
            self.assertFalse(f.commands)
        f = Fixture()
        for row in f.observations: row['fault'] = None
        f.request['canary'] = True
        self.assertEqual(f.run()['state'], 'completed')

    def test_lost_ack_after_every_step_advances_only_from_native_state_and_never_repeats(self):
        for failure in range(4):
            f = Fixture()
            def disconnect(action, index):
                if len(f.commands) == failure + 1: raise OSError('acknowledgement lost')
            f.hook = disconnect
            first = f.run()
            self.assertEqual(first['state'], 'uncertain')
            self.assertEqual(len(f.commands), failure + 1)
            f.hook = None
            self.assertEqual(f.run()['state'], 'completed')
            self.assertEqual(len(f.commands), 4)

    def test_intent_without_native_transition_is_observed_without_replay(self):
        f = Fixture()
        original = f.command
        def unacknowledged(action, host, container):
            self.assertEqual(f.journal['steps'][-1]['state'], 'intent')
            raise TimeoutError()
        f.command = unacknowledged
        self.assertEqual(f.run()['state'], 'uncertain')
        f.command = original
        self.assertEqual(f.run()['reason'], 'pair_command_outcome_unverified')
        self.assertFalse(f.commands)

    def test_ownership_loss_waits_and_continues_the_same_operation_without_repeating_commands(self):
        f = Fixture()
        f.owned = False
        with self.assertRaisesRegex(ValueError, 'ownership'): f.run()
        self.assertIsNone(f.journal)
        f.owned = True
        f.hook = lambda action, member: setattr(f, 'owned', False)
        self.assertEqual(f.run()['state'], 'waiting_for_ownership')
        self.assertEqual(len(f.commands), 1)
        self.assertEqual(f.run()['state'], 'waiting_for_ownership')
        self.assertEqual(len(f.commands), 1)
        f.owned = True
        f.hook = None
        self.assertEqual(f.run()['state'], 'completed')
        self.assertEqual(len(f.commands), 4)

    def test_external_peer_restart_during_command_cannot_be_adopted(self):
        f = Fixture()
        def change_peer(action, member):
            f.observations[1-member]['container']['State']['StartedAt'] = '2026-02-01T00:00:00Z'
        f.hook = change_peer
        with self.assertRaisesRegex(ValueError, 'peer_changed'): f.run()
        self.assertEqual(len(f.commands), 1)

    def test_configuration_change_between_commands_refuses(self):
        f = Fixture()
        f.hook = lambda action, member: f.observations[1]['container']['Config']['Env'].append('UNEXPECTED=1')
        with self.assertRaisesRegex(ValueError, 'configuration_changed'): f.run()
        self.assertEqual(len(f.commands), 1)

    def test_retained_request_cannot_be_rebound_or_silently_reenrolled(self):
        f = Fixture()
        f.hook = lambda action, member: setattr(f, 'owned', False)
        f.run()
        f.request['action_id'] = '87654321-1234-1234-1234-123456789abc'
        with self.assertRaisesRegex(ValueError, 'action_id_conflict'): f.run()
        self.assertEqual(len(f.commands), 1)

    def test_enrollment_refuses_missing_recipe_pins_and_capacity_mismatch(self):
        for modify in (lambda e: e.update(context_length=8192), lambda e: e.update(concurrency=1),
                       lambda e: e['members'][0].update(files={}),
                       lambda e: e['members'][1].update(machine=e['members'][0]['machine'])):
            f = Fixture()
            modify(f.enrollment)
            with self.assertRaises(ValueError): enrollment_identity(f.enrollment)

    def test_rank_without_recipe_root_matches_existing_paired_media_enrollment(self):
        f = Fixture()
        f.enrollment['members'][1].update(recipe_root=None, files={})
        f.observations[1]['files'] = {}
        f.request.update(enrollment_identity(f.enrollment))
        self.assertEqual(f.run()['state'], 'completed')

    def test_malformed_journal_cannot_skip_past_an_unresolved_command(self):
        f = Fixture()
        f.command = lambda *args: (_ for _ in ()).throw(TimeoutError())
        f.run()
        f.journal['steps'].append({'action': 'stop', 'member': 1, 'state': 'intent'})
        with self.assertRaisesRegex(ValueError, 'journal_invalid'): f.run()


class PairNativeIOTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_cross_process_lease_excludes_another_runner_without_waiting(self):
        f = Fixture()
        source = str(Path(__file__).parent.resolve())
        code = """import sys
sys.path.insert(0,sys.argv[2])
from recovery_pair_test import Fixture
from recovery_pair_native import PairJournal
f=Fixture()
try:
    with PairJournal(sys.argv[1],f.enrollment,f.request):pass
except ValueError as error:
    print(str(error))
else:
    raise RuntimeError('competing process acquired the lease')
"""
        with PairJournal(self.root, f.enrollment, f.request):
            result = subprocess.run([sys.executable, '-I', '-c', code, str(self.root), source], capture_output=True, text=True, timeout=5, check=True)
        self.assertEqual(result.stdout.strip(), 'pair_runner_already_active')
        with PairJournal(self.root, f.enrollment, f.request) as journal:
            self.assertIsNone(journal.read())

    def test_abrupt_runner_exit_after_native_transition_resumes_from_durable_intent(self):
        source = str(Path(__file__).parent.resolve())
        code = """import os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[2])
from recovery_pair_test import Fixture
from recovery_pair import recover_pair
from recovery_pair_native import PairJournal,private_save
f=Fixture()
def command(action,host,container):
    f.command(action,host,container)
    private_save(Path(sys.argv[1])/'native-fixture.json',{'observations':f.observations,'commands':f.commands})
    os._exit(19)
with PairJournal(sys.argv[1],f.enrollment,f.request) as journal:
    def save(value):
        journal.save(value)
        f.save(value)
    recover_pair(f.enrollment,f.request,read_journal=journal.read,save_journal=save,observe=lambda:f.observations,
                 stop=lambda host,container:command('stop',host,container),start=lambda host,container:command('start',host,container),ownership=lambda:True)
"""
        exited = subprocess.run([sys.executable, '-I', '-c', code, str(self.root), source], timeout=5, capture_output=True)
        self.assertEqual(exited.returncode, 19, exited.stderr.decode())
        native = private_read(self.root / 'native-fixture.json')
        f = Fixture()
        f.observations, f.commands = native['observations'], native['commands']
        with PairJournal(self.root, f.enrollment, f.request) as journal:
            self.assertEqual(journal.read()['steps'][0]['state'], 'intent')
            def save(value):
                journal.save(value)
                f.save(value)
            result = recover_pair(f.enrollment, f.request, read_journal=journal.read, save_journal=save,
                                  observe=lambda: f.observations, stop=lambda host, container: f.command('stop', host, container),
                                  start=lambda host, container: f.command('start', host, container), ownership=lambda: True)
            self.assertEqual(result['state'], 'completed')
            self.assertEqual(len(f.commands), 4)
            self.assertEqual(journal.read(), result)
        self.assertEqual((self.root / (f.request['action_id'] + '.json')).stat().st_mode & 0o777, 0o600)

    def test_unresolved_operation_or_same_original_epoch_cannot_be_replaced(self):
        f = Fixture()
        f.hook = lambda *args: setattr(f, 'owned', False)
        f.run()
        with PairJournal(self.root, f.enrollment, f.request) as journal:
            journal.save(f.journal)
        another = copy.deepcopy(f.request)
        another['action_id'] = '87654321-1234-1234-1234-123456789abc'
        with self.assertRaisesRegex(ValueError, 'other_operation_unresolved'):
            with PairJournal(self.root, f.enrollment, another): pass
        f.owned = True
        f.hook = None
        f.run()
        with PairJournal(self.root, f.enrollment, f.request) as journal:
            journal.save(f.journal)
        with self.assertRaisesRegex(ValueError, 'epoch_already_attempted'):
            with PairJournal(self.root, f.enrollment, another): pass

    def test_private_journal_rejects_world_readability_and_symlink_substitution(self):
        file = self.root / 'state.json'
        private_save(file, {'example': True})
        file.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'private_journal_unverified'): private_read(file)
        link = self.root / 'link.json'
        link.symlink_to(file)
        with self.assertRaises(OSError): private_read(link)

    def test_native_command_adapter_only_addresses_enrolled_exact_containers(self):
        f = Fixture()
        calls = []
        def execute(args, **options):
            calls.append((args, options))
            return subprocess.CompletedProcess(args, 0, b'', b'')
        remote = RemotePair(f.enrollment, execute=execute)
        for action, index in [('stop', 0), ('start', 1)]:
            member = f.enrollment['members'][index]
            remote.command(action, member['ssh'], member['container'])
        self.assertIn('StrictHostKeyChecking=yes', calls[0][0])
        self.assertEqual(calls[0][0][-1], 'docker stop -t 120 ' + '1' * 64)
        self.assertEqual(calls[1][0][-1], 'docker start ' + '2' * 64)
        self.assertEqual(calls[0][1]['timeout'], 150)
        for action, host, container in [('restart', 'fixture-0', '1' * 64), ('start', 'unregistered', '1' * 64), ('start', 'fixture-0', '2' * 64)]:
            with self.assertRaisesRegex(ValueError, 'not_enrolled'): remote.command(action, host, container)
        self.assertEqual(len(calls), 2)


if __name__ == '__main__':
    unittest.main()
