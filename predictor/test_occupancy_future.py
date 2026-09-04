import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest

import occupancy_future as audit


class OccupancyFutureTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        snapshot={'created_at':'2020-01-01T00:00:00Z','feature_builder_sha256':'builder','hashes':{'worker-inventory.json':'profiles'}}
        self.training={'schema':'dsg-occupancy-v1','feature_schema':'dsg-latency-v4','snapshot':snapshot,'rows':[self.row('old',100,110),self.row('old2',200,210),self.row('old',101,110,'remaining')]}
        model={'encoding':{'names':['x'],'categorical':[],'vocabulary':{}},'base_margin':10,'trees':[],'transform':'raw','factor':1}
        self.candidate={'schema':2,'feature_schema':'dsg-occupancy-v1','routing_enabled':False,'created_at':'2020-01-02T00:00:00Z','snapshot':snapshot,'models':{'admission':model,'remaining':model},'reports':{'admission':{'cutoff':500},'remaining':{'cutoff':500}}}
        self.write('candidate',self.candidate);self.write('training',self.training)
        self.receipt=audit.freeze(self.root/'candidate',self.root/'training',self.root/'receipt')
        self.cut=audit.timestamp(self.receipt['frozen_at'])
        self.future=copy.deepcopy(self.training)
        self.future['snapshot']['created_at']=dt.datetime.fromtimestamp((self.cut+10000)/1000,dt.timezone.utc).isoformat()
        self.future['rows']=[self.row('new',self.cut+1,self.cut+1000)]

    def row(self,identifier,decision,finish,kind='admission'):
        return {'run_id':'r','request_id':identifier,'group':'session','node':'a','kind':kind,'decision_time':decision,'finish_time':finish,'target_s':10,'target_contract':'observed_terminal_occupancy','terminal_class':'normal','features':{'x':1}}

    def write(self,name,value):
        (self.root/name).write_text(json.dumps(value))

    def evaluate(self):
        self.write('future',self.future)
        return audit.evaluate(self.root/'candidate',self.root/'training',self.root/'receipt',self.root/'future')

    def test_freeze_is_private_exclusive_and_candidate_changes_are_rejected(self):
        self.assertEqual((self.root/'receipt').stat().st_mode&0o777,0o600)
        with self.assertRaises(FileExistsError):audit.freeze(self.root/'candidate',self.root/'training',self.root/'receipt')
        self.candidate['models']['admission']['base_margin']=99;self.write('candidate',self.candidate)
        with self.assertRaisesRegex(ValueError,'identity changed'):self.evaluate()

    def test_future_only_excludes_boundary_seen_jobs_preexisting_jobs_and_unfinished_labels(self):
        self.future['rows'] += [self.row('boundary',self.cut,self.cut+1000),self.row('old',self.cut+1,self.cut+1000),self.row('preexisting',self.cut-100,self.cut+1000),self.row('preexisting',self.cut+1,self.cut+1000,'remaining'),self.row('not_finished',self.cut+1,self.cut+20000)]
        result=self.evaluate();report=result['reports']['admission']
        self.assertEqual(report['metrics']['requests'],1);self.assertEqual(report['metrics']['mae_s'],0)
        self.assertEqual(result['reports']['remaining']['status'],'no_future_labels')
        self.assertEqual(result['authority'],'none');self.assertFalse(result['routing_enabled'])
        self.assertNotIn('request_id',json.dumps(result));self.assertNotIn('new',json.dumps(report))

    def test_no_future_data_does_not_invent_accuracy(self):
        self.future['rows']=self.training['rows']
        report=self.evaluate()['reports']['admission']
        self.assertEqual(report['status'],'no_future_labels');self.assertNotIn('metrics',report)
        self.assertIsNone(report['input_support']['hardware']['future_point_coverage'])

    def test_hardware_collection_is_not_model_selection_or_tree_use(self):
        model=copy.deepcopy(self.candidate['models']['admission'])
        model['encoding']['names']=['hardware_family','hardware_power_watts','hardware_gpu_utilization_pct']
        model['encoding']['categorical']=['hardware_family']
        model['encoding']['vocabulary']={'hardware_family':['example-family']}
        # Encoded indexes 0/1 are the category and unknown bucket; power is 2.
        model['trees']=[{'left_children':[1,-1,-1],'split_indices':[2,0,0]}]
        training=[{'features':{'hardware_family':'example-family','hardware_power_watts':None}}]
        future=[{'features':{'hardware_power_watts':0,'hardware_gpu_utilization_pct':80}},
                {'features':{'hardware_power_watts':50,'hardware_gpu_utilization_pct':None}}]
        original=copy.deepcopy((model,training,future))
        result=audit.input_support(model,training,future,['hardware_power_watts','hardware_gpu_utilization_pct','hardware_ram_used_bytes'])
        self.assertEqual(result['selected_features'],3);self.assertEqual(result['split_features'],1)
        h=result['hardware']
        self.assertEqual(h['used_in_splits'],{'hardware_power_watts':1})
        self.assertNotIn('hardware_family',h['selected'])
        self.assertNotIn('hardware_ram_used_bytes',h['selected'])
        self.assertEqual(h['training_point_coverage']['hardware_power_watts'],0)
        self.assertEqual(h['future_point_coverage']['hardware_power_watts'],1)
        self.assertEqual(h['future_point_coverage']['hardware_gpu_utilization_pct'],.5)
        self.assertEqual((model,training,future),original)
        self.assertNotIn('example-family',json.dumps(result))
        model['encoding']['names']=['x'];model['encoding']['categorical']=[];model['trees']=[]
        h=audit.input_support(model,training,future,['hardware_power_watts'])['hardware']
        self.assertEqual(h['selected'],[]);self.assertEqual(h['used_in_splits'],{})
        self.assertEqual(h['future_point_coverage']['hardware_power_watts'],1)

    def test_future_stage_metrics_do_not_mix_upload_and_embedded_errors(self):
        self.training['rows']=[self.row('old',100,110,'updated')]
        self.training['rows'][0]['stage']='upload'
        self.candidate['models']={'updated':self.candidate['models']['admission']}
        self.candidate['reports']={'updated':{'cutoff':500}}
        # A fixed tree predicts 10 for x=1 and 20 for x=2. Both points have target 10.
        self.candidate['models']['updated'].update(base_margin=0,trees=[{'left_children':[1,-1,-1],
            'right_children':[2,-1,-1],'split_indices':[0,0,0],'split_conditions':[1.5,10,20],'default_left':[True,False,False]}])
        self.write('candidate',self.candidate);self.write('training',self.training)
        # The changed model needs its own freeze, not reuse of the earlier receipt.
        self.receipt=audit.freeze(self.root/'candidate',self.root/'training',self.root/'tree-receipt')
        cut=audit.timestamp(self.receipt['frozen_at'])
        self.future['rows']=[{**self.row('new',cut+1,cut+1000,'updated'),'stage':'upload'},
                             {**self.row('new',cut+1,cut+1000,'updated'),'stage':'embedded','features':{'x':2}}]
        self.future['snapshot']['created_at']=dt.datetime.fromtimestamp((cut+10000)/1000,dt.timezone.utc).isoformat()
        self.write('future',self.future)
        r=audit.evaluate(self.root/'candidate',self.root/'training',self.root/'tree-receipt',self.root/'future')['reports']['updated']
        self.assertEqual(r['metrics']['requests'],1);self.assertEqual(r['metrics']['mae_s'],5)
        self.assertEqual(r['by_stage']['upload']['metrics']['mae_s'],0)
        self.assertEqual(r['by_stage']['embedded']['metrics']['mae_s'],10)
        self.assertEqual(r['by_stage']['embedded']['baselines']['worker_mean']['mae_s'],0)
        self.assertNotIn('request_id',json.dumps(r))

    def test_changed_builder_profile_or_invalid_labels_fail_closed(self):
        for change in ('builder','profile','label','time'):
            previous=copy.deepcopy(self.future)
            if change=='builder':self.future['snapshot']['feature_builder_sha256']='changed'
            elif change=='profile':self.future['snapshot']['hashes']['worker-inventory.json']='changed'
            elif change=='label':self.future['rows'][0]['target_s']=float('nan')
            else:self.future['snapshot']['created_at']='2020-01-01T00:00:00Z'
            with self.assertRaises(ValueError):self.evaluate()
            self.future=previous
