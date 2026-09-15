import copy
from pathlib import Path
import types
import unittest
from unittest.mock import patch

import serving_executor
import serving_records_test as fixture
from docker_profile import RetainedProfile
from operation_maintenance import Maintenance
from serving_qualification_test import CONTRACT
from serving_prepare import prepare


class EntryTest(unittest.TestCase):
    def setUp(self):
        self.rig = fixture.PublicationTest('test_real_git_publication_retains_evidence_and_unrelated_staged_work')
        self.rig.setUp(); self.addCleanup(self.rig.doCleanups)
        f = self.f = self.rig.fixture
        f.plan.update(target={'ssh':'fixture.invalid','docker_socket':'/var/run/docker.sock','gateway_socket':'/tmp/fixture.sock'},
            qualification={'candidate':copy.deepcopy(CONTRACT),'previous':copy.deepcopy(CONTRACT)})
        self.rig.approve()

    def execute(self):
        f = self.f
        def remote(host, socket, *, source):
            self.assertEqual((host,socket),('fixture.invalid','/var/run/docker.sock'))
            self.assertEqual(source,Path(__file__).with_name('docker_profile.py').read_text())
            f.docker.host = host; f.docker.idle = lambda _: True
            def request(docker,url,route,body=None):
                candidate = docker.containers.get('b' * 64)
                which = 'candidate' if candidate and candidate['State']['Running'] else 'previous'
                return f.apis[which](url,route,body)
            f.docker.native_request = types.MethodType(request,f.docker)
            return f.docker
        def maintenance(*args, **kwargs): return Maintenance(*args,**kwargs,sleep=lambda _:None)
        def driver(*args, **kwargs): return RetainedProfile(*args,**kwargs,sleep=lambda _:None)
        with patch.object(serving_executor,'_BUNDLED_SOURCES',{'docker_profile':Path(__file__).with_name('docker_profile.py').read_text()},create=True), \
                patch.object(serving_executor,'SSHDocker',remote), \
                patch.object(serving_executor,'GatewayControl',lambda socket:f.control), \
                patch.object(serving_executor,'Maintenance',maintenance), patch.object(serving_executor,'RetainedProfile',driver):
            return serving_executor.execute(f.plan,f.folder,lambda *args:f.events.append(args))

    def test_entry_connects_candidate_qualification_publication_and_readmission(self):
        result = self.execute()
        self.assertEqual(result['state'],'completed'); self.assertFalse(self.f.control.worker['drained'])
        self.assertEqual(result['publication']['commit'],self.rig.git('rev-parse','HEAD'))
        self.assertEqual(self.rig.git('diff','--cached','--name-only'),'other.txt')
        self.assertTrue((self.f.folder / 'containers' / self.f.folder.name / 'start-candidate.result.json').exists())

    def test_entry_restores_failed_candidate_and_qualifies_original(self):
        self.f.apis['candidate'].context = 8192
        result = self.execute()
        self.assertEqual(result['state'],'restored'); self.assertFalse(self.f.control.worker['drained'])
        self.assertTrue(self.f.docker.old['State']['Running'])
        self.assertTrue((self.f.folder / 'qualification-previous/result.json').exists())

    def test_read_only_preparation_feeds_entry_and_archives_exact_executable(self):
        f = self.f
        def no_inference(*args): raise AssertionError('Preparation must not query the model')
        f.docker.native_request = no_inference
        command = f.plan['profile']['create']['Cmd'] + ['--override-generation-config',
            '{"temperature":0.8,"max_new_tokens":16384}', '--default-chat-template-kwargs', '{"enable_thinking":true}']
        proposal = {'id':f.folder.name,'worker_id':'fixture','image':f.plan['profile']['create']['Image'],'command':command,
            'target':{'ssh':'untrusted.invalid'}}
        enrollment = {**f.plan['target'],'worker_id':'fixture','container':'engine','native_url':f.plan['profile']['native_url'],
            'records_directory':str(self.rig.library),'qualification':f.plan['qualification']}
        approval_before = (f.folder / 'approved.json').read_bytes()
        result = prepare(proposal,enrollment,f.folder,f.plan['record_revision'],docker=f.docker)
        self.assertEqual(f.docker.calls,[]); self.assertEqual(f.control.calls,[])
        self.assertEqual(result['plan']['target']['ssh'],'fixture.invalid')
        self.assertEqual((f.folder / 'approved.json').read_bytes(),approval_before)
        self.assertFalse((f.folder / 'runner-started.json').exists())
        f.plan = result['plan']; self.rig.approve()
        finished = self.execute(); self.assertEqual(finished['state'],'completed')
        import json
        record = json.loads(f.record_file.read_text())
        self.assertEqual(record['configuration']['generation_defaults']['max_new_tokens'],16384)
        self.assertTrue(record['configuration']['chat_template_defaults']['enable_thinking'])
        self.assertEqual(record['configuration']['owner_note'],'Preserve this personal annotation')
        self.assertEqual(record['configuration']['recreation_capture']['container_id'],'b' * 64)
        artifact = self.rig.library / finished['publication']['artifact']
        self.assertEqual((artifact / 'executor.py').read_bytes(),Path(f.plan['execution']['path']).read_bytes())

    def test_preparation_requires_restoration_and_does_not_write_an_executable_on_failure(self):
        f = self.f; f.docker.native_request = lambda *args: None
        proposal = {'id':f.folder.name,'worker_id':'fixture','image':f.plan['profile']['create']['Image'],'command':f.plan['profile']['create']['Cmd']}
        enrollment = {**f.plan['target'],'worker_id':'fixture','container':'engine','native_url':f.plan['profile']['native_url'],
            'records_directory':str(self.rig.library),'qualification':f.plan['qualification']}
        import hashlib,json
        f.record['restoration'].pop('change_classes'); raw=json.dumps(f.record).encode(); f.record_file.write_bytes(raw)
        self.rig.git('add','--','records/approved/fixture.json'); self.rig.git('commit','--only','-m','Fixture without restoration','--','records/approved/fixture.json')
        with self.assertRaisesRegex(ValueError,'retained restoration'):
            prepare(proposal,enrollment,f.folder,hashlib.sha256(raw).hexdigest(),docker=f.docker)
        self.assertEqual(f.docker.calls,[]); self.assertEqual(f.control.calls,[])
        self.assertFalse((f.folder / 'executor.py').exists())

    def test_mutable_installed_entry_has_no_authority_to_start(self):
        with self.assertRaisesRegex(ValueError,'frozen approved'): serving_executor.execute(self.f.plan,self.f.folder,lambda *args:None)
        self.assertEqual(self.f.docker.calls,[]); self.assertEqual(self.f.control.calls,[])

    def test_missing_qualification_contract_stops_before_gateway_calls(self):
        self.f.plan['qualification'].pop('previous')
        with self.assertRaisesRegex(ValueError,'Both serving versions'): self.execute()
        self.assertEqual(self.f.docker.calls,[]); self.assertEqual(self.f.control.calls,[])


if __name__ == '__main__': unittest.main()
