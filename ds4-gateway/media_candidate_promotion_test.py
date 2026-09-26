import copy
import hashlib
import json
import os
from pathlib import Path
import unittest
import uuid

import media_candidate_promotion as p
import media_ace_candidate as candidate
from media_ace_candidate_test import FakeIO, request
import recovery_media_bridge_test as bridge_fixture
from recovery_pair_native import private_save


class PromotionObservationTests(unittest.TestCase):
    def setUp(self):
        b = self.b = bridge_fixture.BridgeTests();b.setUp();self.addCleanup(b.doCleanups)
        self.io = FakeIO();self.io.original['Id']='f'*64;self.io.containers={'f'*64:self.io.original}
        self.io.machine=lambda:'f'*64
        self.io.images[self.io.original['Image']]={'Id':self.io.original['Image'],'RootFS':{'Layers':['original']}}
        recipe=self.io.recipe_fields
        self.io.recipe_fields=lambda cid,image:{**recipe(cid,image),'receipt_sha256':'c'*64,'generation_receipt':{'schema':1,'source':'acestep.inference.audio.params','per_audio':True,'query_paths':['cache','store']}}
        self.request=request(self.io);self.prep=b.root.parent/self.request['operation_id'];self.prep.mkdir(mode=0o700)
        native=self.prep/'native';native.mkdir(mode=0o700)
        result=candidate.prepare(native,self.request,self.io,lambda _:True)
        private_save(self.prep/'request.json',self.request)
        result['request_file_sha256']=hashlib.sha256((self.prep/'request.json').read_bytes()).hexdigest()
        private_save(self.prep/'bundle.json',{'modules':{}})
        private_save(self.prep/'plan.json',{'operation_id':self.request['operation_id'],'host':'rank-host','engine':{'container':self.request['before']['Id'],'image':self.request['before']['Image']},'bundle_sha256':hashlib.sha256((self.prep/'bundle.json').read_bytes()).hexdigest()})
        target=self.prep/'qualification'/b.root.name;target.parent.mkdir(mode=0o700);b.root.rename(target);b.root=target
        b.plan.pop('media_lanes');b.plan.update(host='rank-host',llm_container='b'*64,engine={'kind':'ace-step','member':1,'container':result['container'],'image':result['image'],'port':8002},required_recipe_fields=['sampler_mode','dcw_enabled'],results_directory=str(self.prep/'results'))
        b.plan['llm_pair']['media_member']=1
        b.plan['ace_qualification']={'schema':1,'candidate_operation_id':self.request['operation_id'],'preparation_directory':str(self.prep),'source_proof':result['recipe_contract'],'prepared_result':result}
        b.containers[('rank-host','e'*64)]=copy.deepcopy(self.io.containers['e'*64])
        b.Remote.recipe_fields=lambda _remote,cid,image:self.io.recipe_fields(cid,image)
        b.save('plan.json',b.plan);b.save('containers-before.json',{'llm':b.containers[('rank-host','b'*64)],'media':b.containers[('rank-host','e'*64)]})
        b.prepare()
        for step,cid in [('llm-stop-0','a'),('llm-stop-1','b'),('media-start-1','e'),('media-stop-1','e'),('llm-start-1','b'),('llm-start-0','a')]:
            self.assertEqual(b.invoke(step,cid)['state'],'completed')
        b.save('completion.json',{'native_generation_verified':True,'llm_return_verified':True,'qualification':{'state':'qualified_returned','candidate_operation_id':self.request['operation_id']}})
        b.save('readmission.json',{'state':'readmitted'})
        file_id=str(uuid.uuid4());self.audio=Path(b.plan['results_directory'])/b.root.name/file_id;self.audio.parent.mkdir(parents=True,mode=0o700);self.audio.write_bytes(b'qualified fixture bytes');self.audio.chmod(0o600)
        b.save('ace-audio-proof.json',{'state':'audio_verified','job_id':b.root.name,'container':'e'*64,'image':result['image'],'source_receipt_sha256':result['recipe_contract']['receipt_sha256'],'output':{'id':file_id,'bytes':self.audio.stat().st_size,'sha256':hashlib.sha256(self.audio.read_bytes()).hexdigest(),'content_type':'audio/flac','decoded':{'full_decode':True}}})

    def observe(self):
        return p.observe(self.b.root,remote_factory=self.b.Remote,candidate_io=lambda *_:self.io)

    def test_observation_uses_final_native_epochs_and_retains_original_without_any_command_or_record_write(self):
        files={str(f):f.read_bytes() for f in self.prep.rglob('*') if f.is_file()}
        before=list(self.b.commands),list(self.io.calls)
        result=self.observe();self.assertEqual(result['state'],'qualified_current')
        self.assertEqual([c['epoch']['running'] for c in result['commands']],[False,True,True])
        self.assertTrue(result['original']['preserved'])
        self.assertEqual((self.b.commands,self.io.calls),before)
        self.assertEqual(files,{str(f):f.read_bytes() for f in self.prep.rglob('*') if f.is_file()})

    def test_recorded_success_does_not_hide_external_restart_or_changed_profile(self):
        for key,field,value in [(('rank-host','e'*64),'StartedAt','external'),(('head-host','a'*64),'StartedAt','external'),(('rank-host','b'*64),'FinishedAt','external')]:
            saved=self.b.containers[key]['State'][field];self.b.containers[key]['State'][field]=value
            with self.assertRaisesRegex(ValueError,'epoch_changed'):self.observe()
            self.b.containers[key]['State'][field]=saved
        self.b.pins={'changed':{'sha256':'x','mode':384}}
        with self.assertRaisesRegex(ValueError,'files_changed'):self.observe()

    def test_changed_original_candidate_source_images_or_retained_audio_refuses(self):
        self.io.original['State']['StartedAt']='external'
        with self.assertRaisesRegex(ValueError,'original_changed'):self.observe()
        self.io.original['State']['StartedAt']='old-start';self.io.changed_recipe=True
        with self.assertRaisesRegex(ValueError,'source_changed'):self.observe()
        self.io.changed_recipe=False;image=self.io.images.pop(self.io.original['Image'])
        with self.assertRaisesRegex(ValueError,'images_changed'):self.observe()
        self.io.images[self.io.original['Image']]=image;self.audio.write_bytes(b'changed bytes')
        with self.assertRaisesRegex(ValueError,'audio_'):self.observe()

    def test_missing_or_unconfirmed_final_journal_cannot_be_replaced_by_current_running_state(self):
        path=self.b.root/'commands'/(''+self.b.root.name+'-llm-start-0.json')
        saved=json.loads(path.read_text());saved['state']='intent';private_save(path,saved)
        with self.assertRaisesRegex(ValueError,'command_incomplete'):self.observe()
        path.unlink()
        with self.assertRaisesRegex(ValueError,'saved_record_missing'):self.observe()

    def test_active_native_command_lease_prevents_promotion_observation(self):
        saved=p.private_read(self.b.root/'commands'/'media-stop-1.request')
        lease=p.bridge.command.lease(self.b.root/'commands',saved['request'],create=False)
        try:
            with self.assertRaisesRegex(ValueError,'still_owned'):self.observe()
        finally:p.bridge.command.release(lease)
