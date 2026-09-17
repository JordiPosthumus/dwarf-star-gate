import copy
import hashlib
import json
import subprocess
import unittest

import serving_operation_test as fixture
from docker_profile import digest
from serving_qualification_test import CONTRACT
from serving_records import ServingRecordPublisher
from genie_inspection import read_artifact_reference, reference_at


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.OperationTest('test_apply_full_qualification_publish_and_readmit')
        self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.library = f.record_file.parent.parent
        self.repo = f.root
        self.git('init', '-q')
        for name, value in [('user.name', 'Serving fixture'), ('user.email', 'fixture@example.invalid'), ('commit.gpgsign', 'false')]:
            self.git('config', name, value)
        f.record.update(runtime={'name': 'vllm', 'version': 'fixture'}, model={'name': CONTRACT['model']},
            settings={'context_length': CONTRACT['context_length']}, configuration={'owner_note': 'Preserve this personal annotation'})
        f.record_file.write_text(json.dumps(f.record))
        f.plan['record_revision'] = f.plan['profile']['record_revision'] = hashlib.sha256(f.record_file.read_bytes()).hexdigest()
        self.old_bytes = f.record_file.read_bytes()
        candidate = copy.deepcopy(f.record)
        candidate['configuration']['planned_recipe_sha256'] = digest(f.plan['profile']['create'])
        candidate['restoration'] = {'previous_approved_revision': f.plan['record_revision'], 'retention': 'retained', 'drill': {'status': 'unproven'}}
        f.plan['candidate_record'] = candidate
        self.approve()
        self.git('add', '--', 'records')
        self.git('commit', '-qm', 'Initial private configuration')
        self.before = self.git('rev-parse', 'HEAD')
        (self.repo / 'other.txt').write_text('Unrelated owner work\n')
        self.git('add', '--', 'other.txt')
        (self.repo / 'unstaged.txt').write_text('Unstaged personal file\n')
        f.publisher = ServingRecordPublisher(self.library)

    def approve(self):
        f = self.fixture
        raw = json.dumps(f.plan).encode(); (f.folder / 'plan.json').write_bytes(raw)
        (f.folder / 'approved.json').write_text(json.dumps({'actor': 'owner',
            'record_revision': f.plan['record_revision'], 'plan_revision': hashlib.sha256(raw).hexdigest()}))

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], capture_output=True, check=True).stdout.decode().strip()

    def test_real_git_publication_retains_evidence_and_unrelated_staged_work(self):
        f = self.fixture
        result = f.execute()
        self.assertEqual(result['state'], 'completed')
        self.assertFalse(f.control.worker['drained'])
        receipt = result['publication']
        self.assertEqual(receipt['commit'], self.git('rev-parse', 'HEAD'))
        artifact = self.library / receipt['artifact']
        self.assertEqual((artifact / 'previous-approved.json').read_bytes(), self.old_bytes)
        self.assertEqual((artifact / 'published-record.json').read_bytes(), f.record_file.read_bytes())
        record = json.loads(f.record_file.read_bytes())
        self.assertEqual(record['configuration']['owner_note'], 'Preserve this personal annotation')
        self.assertEqual(record['restoration']['drill']['status'], 'unproven')
        self.assertEqual(record['configuration']['qualified_container_reference']['container_id'], fixture.NEW)
        self.assertTrue((artifact / 'qualification-candidate/context-boundary.request.json').exists())
        self.assertEqual(self.git('diff', '--cached', '--name-only'), 'other.txt')
        self.assertEqual((self.repo / 'unstaged.txt').read_text(), 'Unstaged personal file\n')
        changed = self.git('diff-tree', '--no-commit-id', '--name-only', '-r', receipt['commit']).splitlines()
        self.assertTrue(all(p == 'records/approved/fixture.json' or p.startswith('records/artifacts/serving-') for p in changed))

    def test_ignored_private_library_publishes_only_its_exact_evidence(self):
        # A private library can live under an ignored directory in a larger repo.
        # Its approved record is already explicitly tracked; new receipts are not.
        (self.repo / '.gitignore').write_text('/records/\n')
        private = self.library / 'unrelated-private.json'
        private.write_text('{"private":true}\n')
        f = self.fixture
        result = f.execute()
        self.assertEqual(result['state'], 'completed')
        self.assertFalse(f.control.worker['drained'])
        changed = self.git('diff-tree', '--no-commit-id', '--name-only', '-r', result['publication']['commit']).splitlines()
        self.assertTrue(any(p.startswith('records/artifacts/serving-') for p in changed))
        self.assertTrue(all(p == 'records/approved/fixture.json' or p.startswith('records/artifacts/serving-') for p in changed))
        self.assertEqual(self.git('diff', '--cached', '--name-only'), 'other.txt')
        self.assertEqual(self.git('ls-files', '--', 'records/unrelated-private.json'), '')
        self.assertEqual(private.read_text(), '{"private":true}\n')

    def test_measured_trial_archives_candidate_evidence_but_keeps_original_approval(self):
        f = self.fixture
        f.plan['trial'] = {'fixture': 'reviewed measurement'}
        self.approve()
        result = f.execute(lambda _: {'state': 'completed', 'job_id': 'e' * 32})
        self.assertEqual(result['state'], 'restored')
        artifact = self.library / result['publication']['artifact']
        self.assertEqual((artifact / 'qualification-candidate/result.json').read_bytes(),
            (f.folder / 'qualification-candidate/result.json').read_bytes())
        self.assertEqual(json.loads((artifact / 'trial-result.json').read_text())['job_id'], 'e' * 32)
        record = json.loads(f.record_file.read_text())
        self.assertEqual(record['approval'], f.record['approval'])
        self.assertEqual(read_artifact_reference(self.library, record['evidence'][-1])['state'], 'completed')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), 'other.txt')

    def test_rejected_cache_capacity_keeps_native_pass_and_overall_failure_distinct(self):
        f=self.fixture;f.apis['candidate'].cache_tokens=480000
        result=f.execute();self.assertEqual(result['state'],'restored')
        record=json.loads(f.record_file.read_bytes())
        index=read_artifact_reference(self.library,record['evidence'][-1])
        attempt=index['candidate_attempt']
        self.assertEqual(read_artifact_reference(self.library,attempt['native_result'])['state'],'passed')
        verdict=read_artifact_reference(self.library,attempt['verdict'])
        self.assertEqual(verdict['state'],'failed')
        self.assertEqual(verdict['cache_capacity_acceptance']['reason'],'exceeds_reviewed_allowance')
        self.assertEqual(read_artifact_reference(self.library,attempt['cache_comparison'])['delta_tokens'],-20000)
        self.assertEqual(record['approval'],f.record['approval'])

    def test_published_links_reach_actual_tool_request_and_reply_without_rewriting_evidence(self):
        f = self.fixture
        result = f.execute(); self.assertEqual(result['state'], 'completed')
        record = json.loads(f.record_file.read_bytes())
        index = read_artifact_reference(self.library, record['evidence'][-1])
        original = (f.folder / 'qualification-candidate/result.json').read_bytes()
        self.assertEqual((self.library / index['result']['path']).read_bytes(), original)
        self.assertEqual(read_artifact_reference(self.library, index['result'])['state'], 'passed')
        for i, case in enumerate(index['cases']):
            for kind in ['intent', 'receipt', 'response'] + (['request'] if 'request' in case else []):
                ref = reference_at(index, f'/cases/{i}/{kind}')
                self.assertEqual(hashlib.sha256((self.library / ref['path']).read_bytes()).hexdigest(), ref['sha256'])
        tool = next(c for c in index['cases'] if c['case'] == 'tool')
        request = read_artifact_reference(self.library, tool['request'])
        reply = read_artifact_reference(self.library, tool['response'])
        self.assertEqual(request['tool_choice'], 'auto')
        call = reply['choices'][0]['message']['tool_calls'][0]
        self.assertEqual(call['function']['name'], 'report_value')
        self.assertEqual(json.loads(call['function']['arguments']), {'value': 7319})
        # The existing reader must reject later changes instead of presenting
        # them as the qualified response. Publication remains a private commit.
        (self.library / tool['response']['path']).write_text('{}')
        with self.assertRaisesRegex(ValueError, 'recorded hash'):
            read_artifact_reference(self.library, tool['response'])
        self.assertEqual(self.git('diff', '--cached', '--name-only'), 'other.txt')

    def test_restored_record_keeps_original_approval_and_new_startup_evidence(self):
        f = self.fixture; f.apis['candidate'].context = 8192
        result = f.execute(); self.assertEqual(result['state'], 'restored')
        record = json.loads(f.record_file.read_bytes())
        self.assertEqual(record['approval'], f.record['approval'])
        self.assertEqual(record['restoration'], f.record['restoration'])
        self.assertEqual(record['configuration']['qualified_container_reference']['container_id'], fixture.OLD)
        self.assertEqual(record['configuration']['qualified_container_reference']['started_at'], 'new-start')
        index = read_artifact_reference(self.library, record['evidence'][-1])
        self.assertIn('/qualification-previous/', index['result']['path'])
        self.assertEqual(index['serving_version'],'previous')
        self.assertEqual(read_artifact_reference(self.library,index['result'])['state'],'passed')
        attempt=index['candidate_attempt']
        self.assertEqual(read_artifact_reference(self.library,attempt['native_result'])['state'],'failed')
        self.assertEqual(read_artifact_reference(self.library,attempt['verdict'])['state'],'failed')
        self.assertEqual(read_artifact_reference(self.library, index['result'])['state'], 'passed')

    def test_published_cache_comparison_is_reachable_and_preserves_baseline_bytes(self):
        f=self.fixture;f.apis['previous'].cache_tokens=500000;f.apis['candidate'].cache_tokens=480000
        f.plan['cache_capacity_policy']={'max_loss_percent':4};self.approve()
        result=f.execute();self.assertEqual(result['state'],'completed')
        record=json.loads(f.record_file.read_bytes())
        index=read_artifact_reference(self.library,record['evidence'][-1])
        comparison=read_artifact_reference(self.library,index['cache_comparison'])
        self.assertEqual(comparison['state'],'decreased');self.assertEqual(comparison['delta_tokens'],-20000)
        baseline=read_artifact_reference(self.library,index['cache_baseline'])
        artifact=self.library/result['publication']['artifact']
        raw=(artifact/'baseline-cache'/baseline['raw_reference']['file']).read_bytes()
        self.assertEqual(raw,(f.folder/'baseline-cache/metrics.response.bin').read_bytes())
        self.assertEqual(hashlib.sha256(raw).hexdigest(),baseline['raw_reference']['sha256'])
        proof=json.loads((artifact/'qualified-candidate.json').read_text())
        self.assertEqual(proof['cache_capacity_acceptance']['policy'],{'max_loss_percent':4})
        self.assertEqual(proof['cache_capacity_acceptance']['state'],'passed')
        # The comparison remains evidence; the separate reviewed policy grants the allowance.
        self.assertIn('not cache hits',comparison['scope'])

    def test_uncommitted_owner_record_stops_publication_without_overwriting_it(self):
        f = self.fixture
        # Same bytes as prepared but not the Git version: preparing/approving a
        # dirty record must not silently sweep it into a machine-written commit.
        f.record['configuration']['owner_note'] = 'New owner change'
        f.record_file.write_text(json.dumps(f.record))
        f.plan['record_revision'] = f.plan['profile']['record_revision'] = hashlib.sha256(f.record_file.read_bytes()).hexdigest()
        f.plan['candidate_record']['restoration']['previous_approved_revision'] = f.plan['record_revision']
        self.approve(); expected = f.record_file.read_bytes()
        with self.assertRaisesRegex(ValueError, 'existing edits'): f.execute()
        self.assertEqual(f.record_file.read_bytes(), expected)
        self.assertFalse(f.control.worker['drained']); self.assertEqual(self.git('rev-parse', 'HEAD'), self.before)
        self.assertEqual(f.docker.calls, [])

    def test_hook_failure_preserves_evidence_and_hold_without_repeating_commit(self):
        hook = self.repo / '.git/hooks/pre-commit'
        hook.write_text('#!/bin/sh\nexit 1\n'); hook.chmod(0o700)
        result = self.fixture.execute()
        self.assertEqual(result['state'], 'requires_reconciliation')
        self.assertTrue(self.fixture.control.worker['drained'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.before)
        self.assertEqual(len(list((self.library / 'artifacts').glob('serving-*'))), 1)
        self.assertEqual(self.fixture.execute()['state'], 'requires_reconciliation')
        self.assertIn('other.txt', self.git('diff', '--cached', '--name-only'))

    def test_git_assume_unchanged_cannot_hide_an_uncommitted_record(self):
        f = self.fixture
        self.git('update-index','--assume-unchanged','--','records/approved/fixture.json')
        f.record['configuration']['owner_note'] = 'Hidden uncommitted owner edit'
        raw = json.dumps(f.record).encode(); f.record_file.write_bytes(raw)
        f.plan['record_revision'] = f.plan['profile']['record_revision'] = hashlib.sha256(raw).hexdigest()
        f.plan['candidate_record']['restoration']['previous_approved_revision'] = f.plan['record_revision']
        self.approve()
        self.assertEqual(self.git('status','--porcelain','--','records/approved/fixture.json'),'')
        with self.assertRaisesRegex(ValueError,'existing edits'): f.execute()
        self.assertEqual(f.docker.calls,[]); self.assertEqual(f.control.calls,[])
        self.assertEqual(f.record_file.read_bytes(),raw)

    def test_unreviewed_candidate_record_never_publishes(self):
        f = self.fixture; f.plan['candidate_record']['configuration']['planned_recipe_sha256'] = '0' * 64
        self.approve()
        with self.assertRaisesRegex(ValueError, 'candidate record'): f.execute()
        self.assertEqual(f.record_file.read_bytes(), self.old_bytes)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.before)

    def test_changed_raw_qualification_evidence_prevents_publication(self):
        f = self.fixture; publisher = f.publisher
        def tamper(plan, folder, which, current):
            (folder / ('qualification-' + which) / 'text.response.bin').write_bytes(b'Changed result')
            return publisher(plan, folder, which, current)
        f.publisher = tamper
        self.assertEqual(f.execute()['state'], 'requires_reconciliation')
        self.assertEqual(f.record_file.read_bytes(), self.old_bytes)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.before)
        self.assertTrue(f.control.worker['drained'])

    def test_changed_raw_baseline_is_not_published_as_original_evidence(self):
        f=self.fixture;publisher=f.publisher
        def tamper(plan,folder,which,current):
            (folder/'baseline-cache/metrics.response.bin').write_bytes(b'Changed baseline')
            return publisher(plan,folder,which,current)
        f.publisher=tamper
        self.assertEqual(f.execute()['state'],'requires_reconciliation')
        self.assertEqual(f.record_file.read_bytes(),self.old_bytes)
        self.assertEqual(self.git('rev-parse','HEAD'),self.before)


if __name__ == '__main__':
    unittest.main()
