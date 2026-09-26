import copy
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import recovery_media_bridge as b


class BridgeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='media-bridge-');self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / '11111111-1111-4111-8111-111111111111';self.root.mkdir(mode=0o700)
        self.commands = [];self.allowed = True;self.idle = True;self.fail_after = None;self.pins = {}
        self.machines = {'head-host': 'e'*64, 'rank-host': 'f'*64}
        self.containers = {}
        for host, llm, media in [('head-host','a','c'),('rank-host','b','d')]:
            for letter, running in [(llm,True),(media,False)]:
                self.containers[(host,letter*64)] = {'Id':letter*64,'Image':'sha256:'+'9'*64,'Config':{'Env':['CONTEXT=400000']},
                    'HostConfig':{'OomKillDisable':False},'Mounts':[], 'State':{'Running':running,'StartedAt':'before','FinishedAt':'before-end'}}
        engine=lambda member,cid:{'kind':'comfyui','container':cid*64,'image':'sha256:'+'9'*64,'port':8188,'member':member}
        self.plan={'operation_id':self.root.name,'command_journal_version':1,'worker_id':'pair','host':'head-host','llm_container':'a'*64,
            'engine':engine(0,'c'),'python':'/python','control_socket':'/fixture.sock','recovery':{'url':'http://127.0.0.1:1234'},
            'llm_pair':{'members':[{'ssh':'head-host','container':'a'*64},{'ssh':'rank-host','container':'b'*64}],'media_member':0},
            'media_lanes':[{'member':0,'host':'head-host','engine':engine(0,'c')},{'member':1,'host':'rank-host','engine':engine(1,'d')}]}
        self.save('plan.json',self.plan)
        self.save('llm-pair-before.json',{'members':self.plan['llm_pair']['members'],'containers':[self.containers[('head-host','a'*64)],self.containers[('rank-host','b'*64)]]})
        self.save('llm-pair-files-before.json',{'files':[{},{}]})
        self.save('parallel-engines-before.json',{'members':[{'member':0,'container':self.containers[('head-host','c'*64)]},{'member':1,'container':self.containers[('rank-host','d'*64)]}]})
        owner=self
        class Remote:
            def __init__(self,host):self.host=host
            def machine(self):return owner.machines[self.host]
            def inspect(self,cid):return copy.deepcopy(owner.containers[(self.host,cid)])
            def files(self,*_):return copy.deepcopy(owner.pins)
            def media_idle(self,*_):return owner.idle
            def start(self,cid):self.act('start',cid)
            def stop(self,cid):self.act('stop',cid)
            def act(self,action,cid):
                owner.commands.append((self.host,action,cid));state=owner.containers[(self.host,cid)]['State']
                state.update({'Running':True,'StartedAt':'started-'+str(len(owner.commands))} if action=='start' else {'Running':False,'FinishedAt':'stopped-'+str(len(owner.commands))})
                if owner.fail_after==action:raise OSError('fixture acknowledgement lost')
        self.Remote=Remote
        self.metrics=patch.object(b.urllib.request,'urlopen',lambda *a,**kw:io.BytesIO(b'vllm:num_requests_running 0\nvllm:num_requests_waiting 0\n'))
        self.metrics.start();self.addCleanup(self.metrics.stop)

    def save(self,name,value):b.private_save(self.root/name,copy.deepcopy(value))
    def prepare(self):return b.prepare(self.root,self.Remote)
    def invoke(self,step,cid,mode='run'):
        return b.invoke(self.root,mode,step,cid*64,remote_factory=self.Remote,maintain=lambda *_:{'owned':self.allowed})

    def test_parallel_targets_execute_each_fixed_step_once_and_preserve_original_snapshots(self):
        before=(self.root/'llm-pair-before.json').read_bytes();self.prepare();self.assertEqual(self.commands,[])
        steps=[('llm-stop-0','a'),('llm-stop-1','b'),('media-start-0','c'),('media-start-1','d'),
               ('media-stop-0','c'),('media-stop-1','d'),('llm-start-1','b'),('llm-start-0','a')]
        for step,cid in steps:self.assertEqual(self.invoke(step,cid)['state'],'completed')
        self.assertEqual(len(self.commands),8)
        self.assertEqual(self.invoke('llm-stop-0','a')['state'],'completed');self.assertEqual(len(self.commands),8)
        self.assertEqual((self.root/'llm-pair-before.json').read_bytes(),before)
        self.assertEqual([c['State']['Running'] for (host,cid),c in self.containers.items()],[True,False,True,False])

    def test_serial_member_one_uses_its_own_snapshot_and_host(self):
        self.plan.pop('media_lanes');self.plan['host']='rank-host';self.plan['llm_container']='b'*64
        self.plan['engine']={'kind':'comfyui','container':'d'*64,'image':'sha256:'+'9'*64,'port':8188,'member':1}
        self.plan['llm_pair']['media_member']=1;self.save('plan.json',self.plan)
        self.save('containers-before.json',{'llm':self.containers[('rank-host','b'*64)],'media':self.containers[('rank-host','d'*64)]})
        self.prepare();self.assertEqual(self.invoke('media-start-1','d')['state'],'completed')
        self.assertEqual(self.commands,[('rank-host','start','d'*64)])
        with self.assertRaisesRegex(ValueError,'member_not_enrolled'):self.invoke('media-start-0','c')

    def test_lost_ack_observes_original_command_after_ownership_revocation(self):
        self.prepare();self.fail_after='stop'
        self.assertEqual(self.invoke('llm-stop-0','a')['state'],'intent');self.allowed=False
        before={str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(self.invoke('llm-stop-0','a','status')['outcome'],'observed')
        self.assertEqual(before,{str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        self.assertEqual(self.invoke('llm-stop-0','a')['state'],'completed');self.assertEqual(len(self.commands),1)

    def test_capture_never_adopts_changed_plan_machine_profile_or_recipe(self):
        self.prepare();self.machines['head-host']='8'*64
        self.assertEqual(self.invoke('llm-stop-0','a')['state'],'refused')
        self.machines['head-host']='e'*64;self.pins={'fixture':{'sha256':'7'*64,'mode':384}}
        self.assertEqual(self.invoke('llm-stop-0','a')['state'],'refused')
        self.pins={};self.containers[('head-host','a'*64)]['Config']['Env']=['CONTEXT=1']
        self.assertEqual(self.invoke('llm-stop-0','a')['state'],'refused')
        self.plan['host']='changed-host';self.save('plan.json',self.plan)
        with self.assertRaisesRegex(ValueError,'plan_binding_changed'):self.prepare()
        self.assertEqual(self.commands,[])

    def test_unowned_and_busy_commands_have_no_native_effect(self):
        self.prepare();self.allowed=False
        self.assertEqual(self.invoke('llm-stop-0','a'),{'state':'refused','operation_id':self.root.name,'step':'llm-stop-0','command_issued':False})
        self.allowed=True;self.invoke('media-start-0','c');self.idle=False
        self.assertEqual(self.invoke('media-stop-0','c')['state'],'refused');self.assertEqual(len(self.commands),1)

    def test_missing_status_is_read_only_and_same_step_transport_is_exclusive(self):
        self.prepare();before={str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(self.invoke('llm-stop-0','a','status')['state'],'missing')
        self.assertEqual(before,{str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        fd=b.transport_lease(self.root,'media-command-llm-stop-0.lock')
        try:self.assertEqual(self.invoke('llm-stop-0','a')['state'],'transport_busy')
        finally:os.close(fd)
        self.assertEqual(self.commands,[])

    def test_original_and_return_epochs_never_adopt_external_transitions(self):
        self.prepare()
        llm=self.containers[('head-host','a'*64)]['State'];llm['StartedAt']='external-start'
        self.assertEqual(self.invoke('llm-stop-0','a')['state'],'refused');llm['StartedAt']='before'
        media=self.containers[('head-host','c'*64)]['State'];media['FinishedAt']='external-stop'
        self.assertEqual(self.invoke('media-start-0','c')['state'],'refused');media['FinishedAt']='before-end'
        self.assertEqual(self.commands,[])
        self.assertEqual(self.invoke('llm-stop-0','a')['state'],'completed')
        llm['FinishedAt']='external-stop'
        self.assertEqual(self.invoke('llm-start-0','a')['state'],'refused')
        self.assertEqual(self.invoke('llm-stop-1','b')['state'],'refused')
        self.assertEqual(self.invoke('media-start-0','c')['state'],'completed')
        media['StartedAt']='external-start'
        self.assertEqual(self.invoke('media-stop-0','c')['state'],'refused')
        self.assertEqual(len(self.commands),2)

    def test_missing_transport_request_with_prior_intent_is_never_nonexecution(self):
        self.prepare();self.fail_after='stop'
        self.assertEqual(self.invoke('llm-stop-0','a')['state'],'intent')
        (self.root/'commands'/'llm-stop-0.request').unlink()
        with self.assertRaisesRegex(ValueError,'request_missing_with_prior_journal'):
            self.invoke('llm-stop-0','a')
        self.assertEqual(len(self.commands),1)

    def test_native_transport_uses_exact_ids_graceful_stop_and_no_command_timeout(self):
        calls=[]
        def execute(args,**kwargs):
            calls.append((args,kwargs));return type('Reply',(),{'stdout':b''})()
        remote=b.Remote('head-host',execute);remote.stop('a'*64);remote.start('a'*64)
        self.assertEqual(calls[0][0][-1],'docker stop -t -1 '+'a'*64)
        self.assertEqual(calls[1][0][-1],'docker start '+'a'*64)
        self.assertTrue(all(options['timeout'] is None for _,options in calls))
        self.assertTrue(all('StrictHostKeyChecking=yes' in args for args,_ in calls))


if __name__=='__main__':unittest.main()
