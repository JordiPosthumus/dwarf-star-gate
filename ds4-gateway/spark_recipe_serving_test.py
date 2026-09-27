import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from spark_recipe_remote import Remote
from spark_recipe_trial import Executor, validate
from operation_maintenance import Maintenance
from operation_maintenance_test import Fixture


class CurrentServingQualification(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name);recipe=self.root/'recipe';recipe.mkdir()
        (recipe/'.env').write_text('MAX_MODEL_LEN=400000\nMAX_NUM_SEQS=2\n')
        (recipe/'start.sh').write_text('# unchanged fixture launcher\n')
        self.plan={'schema':1,'kind':'glm53-spark-pair-long-coding','qualification_mode':'serving-only',
                   'candidate_profile':'baseline-cache-400k','worker':'fixture-pair','ssh':'fixture-head','rank_ssh':'fixture-rank',
                   'trial_id':'12345678-1234-4234-8234-123456789012','trial_root':str(self.root),
                   'recipe_root':str(recipe),'remote_root':str(self.root/'trials'),'source_archive':str(self.root/'source.tar'),
                   'source_revision':'a'*40,'baseline_revision':'a'*40,'source_sha256':'b'*64,
                   'baseline_env_sha256':'c'*64,'baseline_start_sha256':'d'*64,'baseline_image':'sha256:'+'e'*64,
                   'serving_containers':{'head':'1'*64,'rank':'2'*64}}
        self.containers={name:{'Id':value,'Image':self.plan['baseline_image'],
            'State':{'Running':True,'StartedAt':'2026-01-01T00:00:00Z'},
            'Config':{'Env':['MAX_MODEL_LEN=400000','MAX_NUM_SEQS=2','DEFAULT_MAX_NEW_TOKENS=65536','KV_CACHE_DTYPE=fp8'],
                      'Cmd':['bash','/start.sh']},'HostConfig':{'NetworkMode':'host'},
            'Mounts':[{'Type':'bind','Source':'/fixture/'+name+'.sh','Destination':'/start.sh','RW':True}]}
            for name,value in self.plan['serving_containers'].items()}
        self.remote=Remote(self.plan);self.commands=[];self.events=[]
        self.remote.baseline_unchanged=lambda:self.events.append('baseline')
        self.remote.inspect=lambda rank=False:copy.deepcopy(self.containers['rank' if rank else 'head'])
        def command(args,**kwargs):
            self.commands.append(args)
            self.assertEqual(args[0],'cat','serving-only may read launchers, never mutate Docker or serving files')
            return b'unchanged fixture serving launcher'
        self.remote.command=command;self.remote.rank=command
        self.remote.wait_idle=lambda:self.events.append('idle')
        self.remote.request=lambda *a,**kw:json.dumps({'data':[{'id':'GLM-5.3-Flash-EXL3','max_model_len':400000}]}).encode()
        self.remote.chat=lambda *a,**kw:({'finish_reason':'stop'},{'content':'READY_7319'})
        self.rows=[{'label':key,'passed':True} for key in ['arithmetic','tool_call_and_followup','cold-A','cold-B','append-A','append-B','edit-90-percent','branch-90-percent']]
        for row in self.rows:
            if row['label'].startswith('cold-'):row['cold_cache_proved']=True
            if row['label'].startswith('append-'):row['substantial_reuse_proved']=True
        self.rows += [{'label':'context-boundary','accepted':True},{'label':'concurrency-two','two_active_requests_observed':True}]
        self.remote.checks=lambda phase,context:(self.events.append((phase,context)) or copy.deepcopy(self.rows))

    def test_current_pair_qualifies_without_build_restart_or_configuration_changes(self):
        before=copy.deepcopy(self.containers);recipe_bytes={p.name:p.read_bytes() for p in self.remote.recipe.iterdir()}
        prepared=self.remote.prepare();self.assertEqual(prepared['qualification_mode'],'serving-only')
        self.assertNotIn('candidate_image',prepared)
        result=self.remote.run()
        self.assertEqual(result['state'],'complete');self.assertTrue(result['qualification_passed'])
        self.assertTrue(result['restoration']['serving_unchanged']);self.assertIn(('current',400000),self.events)
        self.assertEqual(self.containers,before);self.assertEqual(recipe_bytes,{p.name:p.read_bytes() for p in self.remote.recipe.iterdir()})
        self.assertTrue(self.commands);self.assertTrue(all(command[0]=='cat' for command in self.commands))
        with self.assertRaisesRegex(RuntimeError,'already submitted'):self.remote.run()
        self.assertEqual(self.events.count(('current',400000)),1)

    def test_missing_cache_boundary_or_concurrency_evidence_cannot_pass(self):
        for label,key in [('arithmetic','passed'),('cold-A','cold_cache_proved'),('cold-B','cold_cache_proved'),
                          ('append-A','substantial_reuse_proved'),('append-B','substantial_reuse_proved'),
                          ('context-boundary','accepted'),('concurrency-two','two_active_requests_observed')]:
            with self.subTest(label=label):
                if not (self.root/'prepared.json').exists():self.remote.prepare()
                original=copy.deepcopy(self.rows)
                next(row for row in self.rows if row['label']==label)[key]=False
                result=self.remote.run();self.assertFalse(result['qualification_passed'])
                self.assertEqual(result['restoration']['state'],'verified','failed diagnostic does not falsify unchanged live serving')
                self.rows=original;(self.root/'run-intent.json').unlink()

    def test_restart_or_settings_drift_before_run_prevents_inference(self):
        self.remote.prepare();self.containers['head']['State']['StartedAt']='2026-01-02T00:00:00Z'
        with self.assertRaisesRegex(RuntimeError,'changed since preparation'):self.remote.run()
        self.assertNotIn(('current',400000),self.events);self.assertFalse((self.root/'run-intent.json').exists())

    def test_owner_settings_change_during_check_cannot_authorize_readmission(self):
        self.remote.prepare()
        def change(phase,context):
            self.containers['rank']['Config']['Env'].append('OWNER_NEW_SETTING=preserved')
            return copy.deepcopy(self.rows)
        self.remote.checks=change;result=self.remote.run()
        self.assertEqual(result['state'],'restoration_required');self.assertEqual(result['restoration']['state'],'unverified')
        self.assertIn('OWNER_NEW_SETTING=preserved',self.containers['rank']['Config']['Env'])

    def test_preparation_rejects_wrong_image_capacity_container_or_stopped_rank(self):
        for mutation in [lambda c:c.update(Image='sha256:'+'f'*64),lambda c:c.update(Id='3'*64),
                         lambda c:c['State'].update(Running=False),lambda c:c['Config'].update(Env=['MAX_MODEL_LEN=262144','MAX_NUM_SEQS=2'])]:
            before=copy.deepcopy(self.containers['rank']);mutation(self.containers['rank'])
            with self.assertRaisesRegex(RuntimeError,'differs'):self.remote.prepare()
            self.containers['rank']=before
        self.assertFalse((self.root/'prepared.json').exists())

    def test_native_model_and_readiness_failures_are_explicit(self):
        self.remote.prepare();self.remote.request=lambda *a,**kw:b'{"data":[]}'
        result=self.remote.run();self.assertFalse(result['qualification_passed']);self.assertIn('model/context',result['error'])
        self.assertEqual(result['restoration']['state'],'verified')
        (self.root/'run-intent.json').unlink();self.remote.chat=lambda *a,**kw:({'finish_reason':'length'},{'content':''})
        result=self.remote.run();self.assertEqual(result['state'],'restoration_required')

    def test_schema_requires_exact_current_containers_and_unchanged_recipe(self):
        self.assertEqual(validate(self.plan)['qualification_mode'],'serving-only')
        for patch in [{'serving_containers':{}},{'serving_containers':{'head':'1'*64,'rank':'1'*64}},
                      {'source_revision':'f'*40},{'kind':'glm53-spark-pair-rollout'},{'candidate_profile':'long-coding'}]:
            with self.assertRaises(ValueError):validate({**self.plan,**patch})

    def execute_owned(self,*,owner_change=False,spare=True):
        prepared=self.remote.prepare();folder=self.root/self.plan['trial_id'];folder.mkdir()
        (folder/'plan.json').write_text(json.dumps({**self.plan,'worker':'fixture','separate_workers':['spare']}))
        (folder/'prepare.result.json').write_text(json.dumps(prepared))
        (folder/'run.status.json').write_text(json.dumps({'stage':'run','state':'starting'}))
        control=Fixture();control.worker.update(is_healthy=True,load=1)
        def call(route,body=None):
            result=control(route,body)
            if route=='/workers' and spare:result['workers'].append({'id':'spare','is_healthy':True,'drained':False})
            return result
        runner=Executor(folder,call);runner.native_idle=lambda:control.worker['load']==0
        def native(action,**kwargs):
            self.assertEqual(action,'run');self.assertTrue(control.worker['drained']);self.assertEqual(control.worker['load'],0)
            result=self.remote.run()
            if owner_change:control.worker.update(operator_paused=True,last_operator_action={'id':'owner-new-pause'})
            return result
        runner.remote_action=native
        def window(*args,**kwargs):
            return Maintenance(*args,**kwargs,sleep=lambda _:control.worker.update(load=0))
        with patch('spark_recipe_trial.Maintenance',window):result=runner.execute('run')
        return result,control,folder

    def test_real_maintenance_waits_for_existing_work_and_conditionally_readmits(self):
        result,control,folder=self.execute_owned()
        self.assertEqual(result['state'],'complete');self.assertTrue(result['result']['qualification_passed'])
        self.assertEqual(result['readmission']['state'],'readmitted');self.assertFalse(control.worker['drained'])
        locks=[body for route,body in control.calls if route=='/maintenance-lock']
        self.assertEqual(len(locks),1);self.assertEqual(locks[0]['minimum_other_llms'],1)
        self.assertTrue((folder/'gateway/before.json').exists());self.assertTrue((folder/'gateway/resume.result.json').exists())

    def test_owner_pause_after_measurement_is_preserved_and_blocks_readmission(self):
        result,control,folder=self.execute_owned(owner_change=True)
        self.assertEqual(result['state'],'restoration_required');self.assertTrue(control.worker['operator_paused'])
        self.assertEqual(control.worker['last_operator_action']['id'],'owner-new-pause')
        self.assertFalse(any(route in ['/resume-workers','/release-maintenance-lock'] for route,_ in control.calls))

    def test_no_separate_serving_worker_means_no_hold_or_inference(self):
        result,control,folder=self.execute_owned(spare=False)
        self.assertEqual(result['state'],'restoration_required');self.assertNotIn(('current',400000),self.events)
        self.assertFalse(any(route=='/maintenance-lock' for route,_ in control.calls));self.assertFalse(control.worker['drained'])


if __name__=='__main__':unittest.main()
