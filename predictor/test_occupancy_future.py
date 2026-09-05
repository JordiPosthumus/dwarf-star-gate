import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest

import occupancy_future as audit


class OccupancyFutureTests(unittest.TestCase):
    def test_remaining_age_support_counts_jobs_not_repeated_progress_and_excludes_future_labels(self):
        tr=[self.row('a',100,200,'remaining') for _ in range(50)]+[self.row('b',100,200,'remaining')]
        for row in tr:row['features']['elapsed_s']=900
        tr[-1]['features']['elapsed_s']=300;tr[-1]['node']='b'
        rows=[self.row('future',1000,2000,'remaining') for _ in range(3)]
        for row,age in zip(rows,[300,900,901]):row['features']['elapsed_s']=age
        original=copy.deepcopy((tr,rows))
        result=audit.remaining_age_support(tr,rows)
        fleet=result['scopes']['fleet'];local=result['scopes']['same_worker']
        self.assertEqual(fleet['two_to_nine']['points'],1)
        self.assertEqual(fleet['one']['points'],1);self.assertEqual(fleet['none']['points'],1)
        self.assertEqual(local['one']['points'],2);self.assertEqual(local['one']['requests'],1)
        self.assertEqual(local['none']['points'],1)
        self.assertEqual((tr,rows),original)
        self.assertNotIn('future',json.dumps(result));self.assertNotIn('node',json.dumps(result))

    def test_remaining_age_support_keeps_unknown_and_run_identity_and_handles_empty_rows(self):
        tr=[self.row('a',100,200,'remaining'),self.row('a',100,200,'remaining')]
        tr[1]['run_id']='other-run'
        for row in tr:row['features']['elapsed_s']=100
        rows=[self.row(str(i),1000,2000,'remaining') for i in range(5)]
        for row,age in zip(rows,[100,None,-1,float('nan'),True]):row['features']['elapsed_s']=age
        result=audit.remaining_age_support(tr,rows)
        self.assertEqual(result['scopes']['fleet']['two_to_nine']['points'],1)
        self.assertEqual(result['scopes']['fleet']['unknown']['points'],4)
        self.assertEqual(result['scopes']['same_worker']['unknown']['support_min'],None)
        self.assertTrue(all(row['points']==0 for row in audit.remaining_age_support(tr,[])['scopes']['fleet'].values()))
        rows[0]['node']='unseen'
        self.assertEqual(audit.remaining_age_support(tr,rows)['scopes']['same_worker']['none']['points'],1)

    def test_remaining_age_support_thresholds_and_evaluation_integration(self):
        tr=[self.row(str(i),100,200,'remaining') for i in range(10)]
        for row in tr:row['features']['elapsed_s']=100
        rows=[self.row('query',1000,2000,'remaining')];rows[0]['features']['elapsed_s']=100
        result=audit.remaining_age_support(tr,rows)
        self.assertEqual(result['scopes']['fleet']['ten_plus']['support_min'],10)
        self.assertEqual(audit.remaining_age_support(tr[:-1],rows)['scopes']['fleet']['two_to_nine']['support_max'],9)
        # Evaluation must attach support only to remaining, including empty evidence.
        result=self.evaluate()
        self.assertNotIn('age_support',result['reports']['admission'])
        self.assertEqual(result['reports']['remaining']['age_support']['scopes']['fleet']['none']['points'],0)
        self.future['rows']=[self.row('new',self.cut+1,self.cut+1000,'remaining')]
        self.future['rows'][0]['features']['elapsed_s']=900
        result=self.evaluate()
        self.assertEqual(result['reports']['remaining']['age_support']['scopes']['fleet']['none']['points'],1,
                         'the long future point cannot manufacture its own training support')

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

    def test_cohort_selection_is_bound_to_its_candidate_but_future_snapshot_can_be_unfiltered(self):
        metadata={'schema':1,'kind':'admitted_since','since':'2019-01-01T00:00:00Z','selector_sha256':'selector'}
        self.training['snapshot']['cohort']=metadata
        self.write('training',self.training)
        with self.assertRaisesRegex(ValueError,'snapshot does not match'):
            audit.freeze(self.root/'candidate',self.root/'training',self.root/'mismatch-receipt')
        self.assertFalse((self.root/'mismatch-receipt').exists())
        self.candidate['snapshot']=copy.deepcopy(self.training['snapshot']);self.write('candidate',self.candidate)
        receipt=audit.freeze(self.root/'candidate',self.root/'training',self.root/'cohort-receipt')
        cut=audit.timestamp(receipt['frozen_at'])
        # Future replay may include all historical evidence. Admission cutoff
        # and frozen artifact identity, not repetition of the cohort filter,
        # determine which new labels the audit can use.
        self.future['rows']=[self.row('new',cut+1,cut+1000)]
        self.future['snapshot']['created_at']=dt.datetime.fromtimestamp((cut+10000)/1000,dt.timezone.utc).isoformat()
        self.assertNotIn('cohort',self.future['snapshot']);self.write('future',self.future)
        result=audit.evaluate(self.root/'candidate',self.root/'training',self.root/'cohort-receipt',self.root/'future')
        self.assertEqual(result['reports']['admission']['metrics']['requests'],1)
        self.training['snapshot']['cohort']['since']='2018-01-01T00:00:00Z';self.write('training',self.training)
        with self.assertRaises(ValueError):
            audit.evaluate(self.root/'candidate',self.root/'training',self.root/'cohort-receipt',self.root/'future')

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

    def test_delivery_aware_freeze_cannot_mix_legacy_and_new_feature_contracts(self):
        self.candidate['feature_schema']='dsg-occupancy-v2'
        self.training.update(schema='dsg-occupancy-v2',feature_schema='dsg-delivery-aware-v1')
        self.write('candidate',self.candidate);self.write('training',self.training)
        receipt=audit.freeze(self.root/'candidate',self.root/'training',self.root/'delivery-receipt');cut=audit.timestamp(receipt['frozen_at'])
        self.future['rows']=[self.row('new',cut+1,cut+1000)]
        self.future['snapshot']['created_at']=dt.datetime.fromtimestamp((cut+10000)/1000,dt.timezone.utc).isoformat();self.write('future',self.future)
        with self.assertRaisesRegex(ValueError,'feature builder'):
            audit.evaluate(self.root/'candidate',self.root/'training',self.root/'delivery-receipt',self.root/'future')
        self.future.update(schema='dsg-occupancy-v2',feature_schema='dsg-delivery-aware-v1');self.write('future',self.future)
        result=audit.evaluate(self.root/'candidate',self.root/'training',self.root/'delivery-receipt',self.root/'future')
        self.assertEqual(result['reports']['admission']['metrics']['requests'],1);self.assertFalse(result['routing_enabled'])
        for key in ('prior_generation_tps','worker_generation_tps','history_generation_estimate_s'):
            self.future['rows'][0]['features'][key]=100
            self.write('future',self.future)
            with self.assertRaisesRegex(ValueError,'Legacy generation anchor'):
                audit.evaluate(self.root/'candidate',self.root/'training',self.root/'delivery-receipt',self.root/'future')
            del self.future['rows'][0]['features'][key]

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

    def test_remaining_age_slices_use_elapsed_not_remaining_target(self):
        self.future['snapshot']['created_at']=dt.datetime.fromtimestamp((self.cut+7200000)/1000,dt.timezone.utc).isoformat()
        self.future['rows']=[{**self.row('new',self.cut+1,self.cut+3600000,'remaining'),
            'features':{'x':1,'elapsed_s':age},'target_s':target}
            for age,target in [(0,100),(29.999,100),(30,10),(299.999,10),(300,10)]]
        original=copy.deepcopy(self.future)
        report=self.evaluate()['reports']['remaining'];bands=report['by_elapsed']
        self.assertEqual(set(bands),{'under_30s','30s_to_5m','5m_plus','unknown'})
        for name,points,error in [('under_30s',2,90),('30s_to_5m',2,0),('5m_plus',1,0)]:
            self.assertEqual(bands[name]['points'],points)
            self.assertEqual(bands[name]['metrics']['requests'],1)
            self.assertEqual(bands[name]['metrics']['mae_s'],error)
            self.assertEqual(bands[name]['baselines']['worker_mean']['mae_s'],error)
        self.assertEqual(bands['unknown']['points'],0)
        self.assertIsNone(bands['unknown']['metrics']);self.assertIsNone(bands['unknown']['baselines'])
        self.assertEqual(report['metrics']['requests'],1)
        self.assertEqual(self.future,original)
        self.assertNotIn('request_id',json.dumps(bands))
        self.assertNotIn('by_elapsed',self.evaluate()['reports']['admission'])

    def test_elapsed_slices_balance_jobs_and_keep_missing_age_unknown(self):
        rows=[{**self.row('a',1,100,'remaining'),'target_s':30,'features':{'elapsed_s':30+i}} for i in range(20)]
        rows.append({**self.row('b',1,100,'remaining'),'features':{'elapsed_s':100}})
        tr=[self.row('train',1,100,'remaining')]
        bands=audit.elapsed_slices(tr,rows,[10]*len(rows))
        self.assertEqual(bands['30s_to_5m']['points'],21)
        self.assertEqual(bands['30s_to_5m']['metrics']['requests'],2)
        self.assertAlmostEqual(bands['30s_to_5m']['metrics']['mae_s'],10)
        self.assertAlmostEqual(bands['30s_to_5m']['baselines']['worker_mean']['mae_s'],10)
        unknown=[{**self.row(str(i),1,100,'remaining'),'features':{'elapsed_s':value}}
                 for i,value in enumerate([None,'30',True,-1,float('nan'),float('inf')])]
        unknown.append(self.row('missing',1,100,'remaining'))
        bands=audit.elapsed_slices(tr,unknown,[10]*len(unknown))
        self.assertEqual(bands['unknown']['points'],7)
        self.assertEqual(bands['unknown']['metrics']['requests'],7)
        self.assertEqual(bands['under_30s']['points'],0)
        self.future['rows']=[]
        empty=self.evaluate()['reports']['remaining']
        self.assertEqual(empty['status'],'no_future_labels')
        self.assertTrue(all(v['points']==0 and v['metrics'] is None for v in empty['by_elapsed'].values()))
