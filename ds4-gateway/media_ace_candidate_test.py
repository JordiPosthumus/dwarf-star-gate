import copy
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

import media_ace_candidate as m


class FakeIO:
    def __init__(self):
        self.calls = []
        self.original = {'Id': 'a'*64, 'Image': 'sha256:'+'b'*64, 'Name': '/working-ace',
            'Config': {'Image': 'original-tag', 'WorkingDir': '/opt/ace-step',
                       'Cmd': ['python','-m','acestep.api_server','--init-llm'],
                       'Env': ['MODEL=original-xl', 'LM=original-4b', 'KEEP=all'], 'User': '', 'Volumes': None},
            'HostConfig': {'Binds':['/models:/models:ro','/cache:/cache:rw'], 'Memory': 0,
                           'RestartPolicy': {'Name':'no'}, 'OomKillDisable': False, 'DeviceRequests':[{'Count':-1}],
                           'PortBindings': {'8002/tcp':[{'HostIp':'127.0.0.1','HostPort':'8002'}]}},
            'Mounts':[{'Type':'bind','Source':'/models','Destination':'/models','RW':False},
                      {'Type':'bind','Source':'/cache','Destination':'/cache','RW':True}],
            'State': {'Running': False, 'StartedAt':'old-start', 'FinishedAt':'old-finish'}}
        self.containers = {self.original['Id']: self.original}
        self.images = {}
        self.failure = None
        self.callback = None
        self.changed_candidate = False
        self.changed_recipe = False
        self.bad_base = False

    def machine(self): return 'f'*64
    def inspect(self, cid): return copy.deepcopy(self.containers.get(cid))
    def image(self, iid): return copy.deepcopy(self.images.get(iid))
    def call(self, stage):
        self.calls.append(stage)
        if self.callback: self.callback(stage)
        if self.failure == stage: raise OSError('Lost native reply')
    def snapshot(self, cid, tag):
        self.call('snapshot')
        assert cid == self.original['Id']
        iid = 'sha256:'+'c'*64
        self.images[tag] = self.images[iid] = {'Id':iid,'RootFS':{'Layers':['original','writable']}}
        return iid
    def build(self, context, tag):
        self.call('build')
        assert (context/'apply-recipe-fields.py').is_file()
        self.dockerfile = (context/'Dockerfile').read_text()
        iid = 'sha256:'+'d'*64
        self.images[tag] = self.images[iid] = {'Id':iid,'RootFS':{'Layers':['different'] if self.bad_base else ['original','writable','patch']}}
        return iid
    def create(self, name, body):
        self.call('create')
        self.created_body = copy.deepcopy(body)
        cid = 'e'*64
        candidate = copy.deepcopy(self.original)
        candidate.update(Id=cid,Image=body['Image'],Name='/'+name,
                         Config={k:v for k,v in body.items() if k!='HostConfig'},HostConfig=body['HostConfig'])
        candidate['State']={'Running':False,'StartedAt':'never','FinishedAt':'never'}
        if self.changed_candidate: candidate['Config']['Env']=['MODEL=other']
        self.containers[cid]=self.containers[name]=candidate
        return {'Id':cid}
    def recipe_fields(self, cid, image):
        return {'state':'verified','container':cid,'image':image,'container_state_unchanged':True,
                'supported':m.SUPPORTED,'source_sha256':{'source':'changed' if self.changed_recipe else 'fixed'}}


def request(io):
    return {'version':1,'operation_id':str(uuid.uuid4()),'machine':io.machine(),
            'before':copy.deepcopy(m.signature(io.original)),'epoch':m.runtime(io.original),
            'source_sha256':{k:hashlib.sha256(v).hexdigest() for k,v in m.sources().items()}}


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.root.chmod(0o700)
        self.io=FakeIO();self.req=request(self.io)

    def run_candidate(self, authorize=lambda _:True):
        return m.prepare(self.root,self.req,self.io,authorize)

    def test_retains_original_and_all_runtime_settings_without_start(self):
        before=copy.deepcopy(self.io.original)
        result=self.run_candidate()
        self.assertEqual(result['state'],'prepared_stopped')
        self.assertEqual(self.io.original,before)
        self.assertEqual(self.io.calls,['snapshot','build','create'])
        body=copy.deepcopy(before['Config']);body.update(Image=result['image'],HostConfig=before['HostConfig'])
        self.assertEqual(self.io.created_body,body)
        self.assertEqual(m.signature(self.io.inspect(result['container'])),m.candidate_signature(self.req,result['container'],result['image']))
        self.assertEqual(self.run_candidate(lambda _:False),result)
        self.assertEqual(self.io.calls,['snapshot','build','create'])
        self.assertEqual(m.private_read(self.root/self.req['operation_id']/'original.json')['request'],self.req)
        self.assertNotIn('pip',self.io.dockerfile);self.assertNotIn('apt',self.io.dockerfile)

    def test_every_uncertain_native_step_is_retained_and_never_replayed(self):
        for stage in ('snapshot','build','create'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as folder:
                io=FakeIO();io.failure=stage;req=request(io)
                with self.assertRaises(OSError):m.prepare(folder,req,io,lambda _:True)
                calls=io.calls[:];io.failure=None
                state=m.prepare(folder,req,io,lambda _:True)
                self.assertEqual(state['state'],'requires_reconciliation');self.assertEqual(io.calls,calls)
                self.assertEqual(state['stage'],stage+'_intent')

    def test_lost_acknowledgement_after_native_effect_keeps_artifacts_without_replay(self):
        for stage in ('snapshot','build','create'):
            with self.subTest(stage=stage),tempfile.TemporaryDirectory() as folder:
                io=FakeIO();req=request(io);action=getattr(io,stage)
                def lose(*args):
                    action(*args)
                    raise OSError('Native effect happened, acknowledgement lost')
                setattr(io,stage,lose)
                with self.assertRaises(OSError):m.prepare(folder,req,io,lambda _:True)
                count=len(io.calls);images=copy.deepcopy(io.images);containers=copy.deepcopy(io.containers)
                result=m.prepare(folder,req,io,lambda _:True)
                self.assertEqual(result['state'],'requires_reconciliation')
                self.assertEqual(len(io.calls),count);self.assertEqual(io.images,images);self.assertEqual(io.containers,containers)
                if stage=='create':self.assertFalse(io.containers['e'*64]['State']['Running'])

    def test_existing_candidate_names_are_preserved(self):
        for kind in ('image','container'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as folder:
                io=FakeIO();req=request(io)
                if kind=='image':io.images['stargate-ace-snapshot:'+req['operation_id']]={'Id':'sha256:'+'1'*64}
                else:io.containers['stargate-ace-candidate-'+req['operation_id']]=copy.deepcopy(io.original)
                with self.assertRaisesRegex(ValueError,'name_in_use'):m.prepare(folder,req,io,lambda _:True)
                self.assertEqual(io.calls,[])

    def test_authority_machine_epoch_settings_and_source_drift_refuse_before_mutation(self):
        cases=('authority','machine','epoch','settings','sources','active','volume','restart','network','aliases')
        for case in cases:
            with self.subTest(case=case),tempfile.TemporaryDirectory() as folder:
                io=FakeIO();req=request(io)
                if case=='machine':req['machine']='0'*64
                if case=='epoch':io.original['State']['StartedAt']='external'
                if case=='settings':io.original['Config']['Env'].append('CHANGED=1')
                if case=='sources':req['source_sha256']['apply-recipe-fields.py']='0'*64
                if case=='active':io.original['State']['Running']=True
                if case=='volume':req['before']['Mounts'][0]['Type']='volume'
                if case=='restart':req['before']['HostConfig']['RestartPolicy']['Name']='always'
                if case=='network':io.original['NetworkSettings']={'Networks':{'bridge':{},'custom':{}}}
                if case=='aliases':io.original['NetworkSettings']={'Networks':{'bridge':{'Aliases':['established-name']}}}
                with self.assertRaises(ValueError):m.prepare(folder,req,io,lambda _:case!='authority')
                self.assertEqual(io.calls,[])

    def test_authority_revoked_after_snapshot_prevents_build(self):
        allowed=True
        def revoke(stage):
            nonlocal allowed
            if stage=='snapshot':allowed=False
        self.io.callback=revoke
        with self.assertRaises(ValueError):self.run_candidate(lambda _:allowed)
        self.assertEqual(self.io.calls,['snapshot'])
        self.assertEqual(m.observe(self.root,self.req,self.io)['stage'],'snapshot_acknowledged')

    def test_candidate_base_settings_and_source_drift_never_qualify(self):
        self.io.bad_base=True
        with self.assertRaises(ValueError):self.run_candidate()
        self.assertEqual(self.io.calls,['snapshot','build'])
        with tempfile.TemporaryDirectory() as folder:
            io=FakeIO();io.changed_candidate=True;req=request(io)
            with self.assertRaises(ValueError):m.prepare(folder,req,io,lambda _:True)
            self.assertEqual(m.observe(folder,req,io)['state'],'requires_reconciliation')
        with tempfile.TemporaryDirectory() as folder:
            io=FakeIO();req=request(io);m.prepare(folder,req,io,lambda _:True);io.changed_recipe=True
            with self.assertRaises(ValueError):m.observe(folder,req,io)
            self.assertEqual(io.calls,['snapshot','build','create'])

    def test_original_drift_during_build_prevents_create(self):
        def drift(stage):
            if stage=='build':self.io.original['State']['StartedAt']='external'
        self.io.callback=drift
        with self.assertRaises(ValueError):self.run_candidate()
        self.assertEqual(self.io.calls,['snapshot','build'])

    def test_context_change_and_inherited_build_hooks_refuse(self):
        build=self.io.build
        def changed(context,tag):
            result=build(context,tag);(context/'apply-recipe-fields.py').write_text('changed');return result
        self.io.build=changed
        with self.assertRaisesRegex(ValueError,'build_context_changed'):self.run_candidate()
        self.assertEqual(self.io.calls,['snapshot','build'])
        with tempfile.TemporaryDirectory() as folder:
            io=FakeIO();req=request(io);snapshot=io.snapshot
            def hook(cid,tag):
                iid=snapshot(cid,tag);io.images[iid]['Config']={'OnBuild':['RUN unknown-command']};return iid
            io.snapshot=hook
            with self.assertRaisesRegex(ValueError,'snapshot_unverified'):m.prepare(folder,req,io,lambda _:True)
            self.assertEqual(io.calls,['snapshot'])

    def test_another_identity_cannot_prepare_again_from_same_original(self):
        self.run_candidate();other=copy.deepcopy(self.req);other['operation_id']=str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError,'already_has_candidate'):m.prepare(self.root,other,self.io,lambda _:True)
        self.assertEqual(self.io.calls,['snapshot','build','create'])

    def test_missing_or_changed_receipts_do_not_grant_replay(self):
        self.run_candidate();folder=self.root/self.req['operation_id'];(folder/'candidate.json').unlink()
        with self.assertRaises(FileNotFoundError):self.run_candidate()
        self.assertEqual(self.io.calls,['snapshot','build','create'])
        other=copy.deepcopy(self.req);other['machine']='0'*64
        with self.assertRaisesRegex(ValueError,'backup_changed'):m.observe(self.root,other,self.io)

    def test_status_is_read_only_and_rejects_symlink(self):
        original=list(self.root.iterdir())
        self.assertEqual(m.observe(self.root,self.req,self.io)['state'],'missing')
        self.assertEqual(list(self.root.iterdir()),original)
        folder=self.root/self.req['operation_id'];folder.symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(ValueError):self.run_candidate()
        self.assertEqual(self.io.calls,[])

    def test_native_adapter_never_signals_or_installs_dependencies(self):
        native=m.NativeIO(lambda:'f'*64)
        calls=[]
        with patch.object(m.subprocess,'check_output',side_effect=lambda args,**kw:calls.append(args) or 'sha256:'+'c'*64):
            self.assertEqual(native.snapshot('a'*64,'tag'),'sha256:'+'c'*64)
        context=self.root/'context';context.mkdir()
        def build(args,**kw):
            calls.append(args);Path(args[args.index('--iidfile')+1]).write_text('sha256:'+'d'*64)
        with patch.object(m.subprocess,'run',side_effect=build):native.build(context,'tag')
        self.assertEqual(calls[0],['docker','--host','unix:///var/run/docker.sock','commit','--pause=false','a'*64,'tag'])
        self.assertEqual(calls[1][0:9],['docker','--host','unix:///var/run/docker.sock','build','--builder','default','--pull=false','--network=none','--load'])
        with patch.dict(os.environ, {'DOCKER_CONTEXT':'foreign','DOCKER_HOST':'tcp://foreign','BUILDX_BUILDER':'foreign'}):
            self.assertTrue(all(k not in native.environment() for k in ('DOCKER_CONTEXT','DOCKER_HOST','BUILDX_BUILDER')))
        def reader(cid,image,execute):
            return execute(['docker','inspect',cid],capture_output=True,check=True,timeout=30)
        with patch.object(m,'inspect_recipe',side_effect=reader), patch.object(m.subprocess,'run') as run:
            native.recipe_fields('a'*64,'sha256:'+'b'*64)
            self.assertEqual(run.call_args.args[0],['docker','--host','unix:///var/run/docker.sock','inspect','a'*64])


def leased_child(folder, req, marker):
    io=FakeIO()
    def wait(stage):
        if stage=='build':
            marker.set()
            import time
            while True:time.sleep(0.1)
    io.callback=wait
    m.prepare(folder,req,io,lambda _:True)


class ProcessLeaseTests(unittest.TestCase):
    def test_live_os_lease_and_dead_runner_never_reissue_build(self):
        with tempfile.TemporaryDirectory() as folder:
            io=FakeIO();req=request(io);ctx=multiprocessing.get_context('spawn');marker=ctx.Event()
            child=ctx.Process(target=leased_child,args=(folder,req,marker));child.start()
            try:
                self.assertTrue(marker.wait(15),'Fixture build did not enter its live lease')
                with self.assertRaises(BlockingIOError):m.prepare(folder,req,io,lambda _:True)
                self.assertEqual(io.calls,[])
                child.terminate();child.join(10);self.assertFalse(child.is_alive())
                result=m.prepare(folder,req,io,lambda _:True)
                self.assertEqual(result['stage'],'build_intent');self.assertEqual(result['state'],'requires_reconciliation')
                self.assertEqual(io.calls,[])
            finally:
                if child.is_alive():child.terminate();child.join(10)


if __name__=='__main__':unittest.main()
