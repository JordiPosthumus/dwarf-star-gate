"""Execute the frozen SSH program in real disposable Python processes.

Docker operations use a persistent fixture; no SSH or native model services.
"""
import copy
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

import media_candidate_remote as transport
import media_ace_candidate as candidate
from media_ace_candidate_test import FakeIO

ROOT = Path(__file__).resolve().parent


class CandidateTransport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name);self.actions=[]
        source=transport.bundle(ROOT)
        fixture = inspect.getsource(FakeIO).replace('m.SUPPORTED','SUPPORTED')
        # Persist native effects between independently launched transport calls.
        fixture += '''
class DiskIO(FakeIO):
    def __init__(self, machine):
        super().__init__()
        self.file=Path(STATE_FILE)
        if self.file.exists():self.__dict__.update(json.loads(self.file.read_text()))
    def persist(self):
        data={k:v for k,v in self.__dict__.items() if k!='file'}
        self.file.write_text(json.dumps(data))
    def snapshot(self,*args):
        value=super().snapshot(*args);self.persist();return value
    def build(self,*args):
        value=super().build(*args);self.persist();return value
    def create(self,*args):
        value=super().create(*args);self.persist();return value
NativeIO=DiskIO
'''
        source['media_ace_candidate']+='\nSTATE_FILE='+repr(str(self.root/'native.json'))+'\n'+fixture
        self.frozen=source
        self.machine_code="\nfrom pathlib import Path\nPath.home=classmethod(lambda cls:Path("+repr(str(self.root))+"))\ndef native_machine():return 'f'*64\n"
        self.io=transport.RemoteIO('fixture-host',source,execute=self.execute)
        # Override only hardware discovery and fixture home, keeping actual
        # transport validation, dispatch, private build files and module loader.
        with patch.object(transport,'MACHINE',self.machine_code):self.io.code=transport.program(source)
        native=FakeIO().original
        self.request={'version':1,'operation_id':str(uuid.uuid4()),'machine':'f'*64,'before':candidate.signature(native),'epoch':candidate.runtime(native),
            'source_sha256':{k:hashlib.sha256(v).hexdigest() for k,v in candidate.sources().items()}}
        self.io.request=self.request

    def execute(self,args,**kwargs):
        self.assertEqual(args[0],'ssh');self.assertIn('StrictHostKeyChecking=yes',args)
        command=shlex.split(args[-1]);self.assertEqual(command[:4],['python3','-I','-B','-c'])
        self.actions.append(json.loads(kwargs['input'])['action'])
        return subprocess.run([sys.executable,*command[1:]],**kwargs)

    def test_entire_preparation_crosses_serialized_subprocess_transport(self):
        journal=self.root/'journal';journal.mkdir(mode=0o700)
        result=candidate.prepare(journal,self.request,self.io,lambda _:True)
        self.assertEqual(result['state'],'prepared_stopped')
        before=list(self.actions);again=candidate.observe(journal,self.request,self.io)
        self.assertEqual(again,result)
        self.assertFalse(set(self.actions[len(before):])&{'snapshot','build','create'})
        for action in ('snapshot','build','create'):self.assertEqual(self.actions.count(action),1)
        self.assertEqual(self.io.inspect(self.request['before']['Id'])['State']['Running'],False)
        context=self.root/'.local/share/star-gate/ace-candidates'/self.request['operation_id']/'context'
        self.assertEqual(set(p.name for p in context.iterdir()),set(candidate.SOURCES)|{'Dockerfile'})

    def test_remote_rejects_changed_original_and_arbitrary_source(self):
        changed=copy.deepcopy(self.request);changed['before']['Config']['Env'].append('changed=1');self.io.request=changed
        with self.assertRaisesRegex(RuntimeError,'unconfirmed'):self.io.snapshot(changed['before']['Id'],'stargate-ace-snapshot:'+changed['operation_id'])
        self.assertFalse((self.root/'native.json').exists())
        self.io.request=self.request
        self.io.snapshot(self.request['before']['Id'],'stargate-ace-snapshot:'+self.request['operation_id'])
        import base64
        files={k:base64.b64encode(v).decode() for k,v in candidate.sources().items()};files['Dockerfile']=base64.b64encode(b'RUN arbitrary').decode()
        with self.assertRaisesRegex(RuntimeError,'unconfirmed'):self.io.call('build',files=files)
        self.assertEqual(json.loads((self.root/'native.json').read_text())['calls'],['snapshot'])

    def test_lost_build_reply_retains_native_effect_without_replay(self):
        journal=self.root/'journal';journal.mkdir(mode=0o700)
        execute=self.io.execute
        def lost(args,**kwargs):
            result=execute(args,**kwargs)
            if json.loads(kwargs['input'])['action']=='build' and result.returncode==0:
                return subprocess.CompletedProcess(args,255,b'',b'fixture disconnected after build')
            return result
        self.io.execute=lost
        with self.assertRaisesRegex(RuntimeError,'unconfirmed'):candidate.prepare(journal,self.request,self.io,lambda _:True)
        before=list(self.actions)
        result=candidate.prepare(journal,self.request,self.io,lambda _:True)
        self.assertEqual(result['state'],'requires_reconciliation');self.assertEqual(self.actions,before)
        self.assertEqual(json.loads((self.root/'native.json').read_text())['calls'],['snapshot','build'])

    def test_readonly_status_failure_does_not_write_runner_attention(self):
        operation=self.root/str(uuid.uuid4());operation.mkdir(mode=0o700)
        # Invalid bundle fails before any native read; status must remain read-only.
        before=list(operation.iterdir())
        result=subprocess.run([sys.executable,'-I','-B',str(ROOT/'media-candidate-runner.py'),str(operation),'status'],capture_output=True)
        self.assertNotEqual(result.returncode,0);self.assertEqual(list(operation.iterdir()),before)

    def test_runner_binds_source_and_never_replays_after_saved_intent(self):
        spec=importlib.util.spec_from_file_location('candidate_runner_fixture',ROOT/'media-candidate-runner.py')
        runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        folder=self.root/self.request['operation_id'];folder.mkdir(mode=0o700)
        frozen={'modules':transport.bundle(ROOT),'patch':{k:v.decode() for k,v in candidate.sources().items()}}
        candidate.private_save(folder/'bundle.json',frozen)
        plan={'operation_id':folder.name,'host':'fixture-host','engine':{'container':self.request['before']['Id'],'image':self.request['before']['Image']},'control_socket':str(self.root/'socket'),
            'runner_sha256':hashlib.sha256((ROOT/'media-candidate-runner.py').read_bytes()).hexdigest(),
            'transport_sha256':hashlib.sha256((ROOT/'media_candidate_remote.py').read_bytes()).hexdigest(),
            'bundle_sha256':hashlib.sha256((folder/'bundle.json').read_bytes()).hexdigest(),'source_sha256':self.request['source_sha256']}
        candidate.private_save(folder/'plan.json',plan)
        calls=[]
        def factory(host,source,request=None):return self.io
        def control(socket,route,body):calls.append(route);return {'allowed':True}
        # Runner intentionally replaces module globals with frozen definitions;
        # restore this test process's module registry after the isolated exercise.
        modules={name:sys.modules.get(name) for name in transport.MODULES}
        try:
            with patch.object(runner,'RemoteIO',factory),patch.object(runner,'control',control):
                bad={**plan,'transport_sha256':'0'*64};candidate.private_save(folder/'plan.json',bad)
                with self.assertRaisesRegex(ValueError,'transport_changed'):runner.main(str(folder),'run')
                self.assertFalse((folder/'runner-intent.json').exists());self.assertEqual(self.actions,[])
                candidate.private_save(folder/'plan.json',plan)
                result=runner.main(str(folder),'run');self.assertEqual(result['state'],'prepared_stopped')
                actions=list(self.actions);self.assertEqual(runner.main(str(folder),'run')['state'],'requires_reconciliation');self.assertEqual(actions,self.actions)
                self.assertIn('/media-candidate-complete',calls);self.assertGreaterEqual(calls.count('/media-candidate-permit'),4)
        finally:
            for name,value in modules.items():
                if value is not None:sys.modules[name]=value
                else:sys.modules.pop(name,None)

if __name__=='__main__':unittest.main()
