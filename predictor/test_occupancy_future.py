import copy
import datetime as dt
import json
import random
from pathlib import Path
import tempfile
import unittest

import occupancy_future as audit


class OccupancyFutureTests(unittest.TestCase):
    def test_selection_counts_match_original_predicate_and_preserve_point_order(self):
        rng=random.Random(17);cutoff=1000;end=2000
        rows=[]
        for i in range(120):
            decision=rng.choice([999,1000,1001,1999,2000,2001])
            finish=decision+rng.choice([0,1,1000])
            row=self.row(str(i%23),decision,finish,rng.choice(['admission','updated','remaining']))
            # Reused request identifiers across runs must not collide.
            row['run_id']='a' if i%2 else 'b';rows.append(row)
        first={}
        for row in rows:
            key=(row['run_id'],row['request_id']);first[key]=min(first.get(key,float('inf')),row['decision_time'])
        seen={('a','2'),('b','3')}
        original=copy.deepcopy((rows,seen,first));reference={}
        for _ in range(8):
            for kind in ('admission','updated','remaining'):
                points=[r for r in rows if r['kind']==kind]
                expected=[r for r in points if cutoff<r['decision_time']<=r['finish_time']<=end
                          and first[(r['run_id'],r['request_id'])]>cutoff
                          and (r['run_id'],r['request_id']) not in seen]
                selected,counts=audit.select_future_rows(points,seen,first,cutoff,end)
                self.assertEqual(selected,expected)
                self.assertTrue(all(a is b for a,b in zip(selected,expected,strict=True)))
                self.assertEqual(counts['source_points'],counts['selected_points']+sum(counts['excluded_points'].values()))
                self.assertEqual(counts['source_requests'],counts['selected_requests']+counts['fully_excluded_requests'])
                self.assertLessEqual(counts['partially_selected_requests'],counts['selected_requests'])
                if kind in reference:self.assertEqual(counts,reference[kind])
                reference[kind]=counts
            rng.shuffle(rows)
        self.assertCountEqual(rows,original[0]);self.assertEqual((seen,first),original[1:])

    def test_selection_boundary_precedence_partial_requests_and_private_identifiers(self):
        rows=[self.row('private-overlap',100,3000),self.row('private-boundary',1000,3000),
              self.row('private-partial',1001,2000),self.row('private-partial',1002,2001),
              self.row('private-finish-boundary',2000,2000)]
        first={('r',r['request_id']):r['decision_time'] for r in rows}
        # Actual first checkpoint is shared across kinds, not limited to these rows.
        first[('r','private-partial')]=1001
        for row in rows:row['run_id']='r'
        selected,counts=audit.select_future_rows(rows,{('r','private-overlap')},first,1000,2000)
        self.assertEqual(selected,[rows[2],rows[4]])
        self.assertEqual(counts['excluded_points'],{'in_training_snapshot':1,
                         'first_checkpoint_at_or_before_freeze':1,'finishes_after_snapshot':1})
        self.assertEqual(counts['source_points'],5);self.assertEqual(counts['source_requests'],4)
        self.assertEqual(counts['selected_requests'],2);self.assertEqual(counts['fully_excluded_requests'],2)
        self.assertEqual(counts['partially_selected_requests'],1)
        self.assertNotIn('private-',json.dumps(counts));self.assertNotIn('request_id',json.dumps(counts))
        selected,empty=audit.select_future_rows([],set(),{},1000,2000)
        self.assertEqual(selected,[])
        self.assertTrue(all(empty[key]==0 for key in ('source_points','selected_points','source_requests','selected_requests','fully_excluded_requests','partially_selected_requests')))
        self.assertTrue(all(n==0 for n in empty['excluded_points'].values()))

    def updated(self,identifier,stage,**changes):
        return {**self.row(identifier,1000,2000,'updated'),'stage':stage,**changes}

    def test_paired_stages_do_not_confuse_missing_checkpoints_with_improvement(self):
        rows=[self.updated('paired','upload'),self.updated('paired','embedded'),self.updated('upload-only','upload')]
        predictions=[20,30,1010]
        # Marginal upload MAE is 505s versus embedded 20s: looks much better,
        # but the one matched request actually worsened from 10s to 20s.
        before=copy.deepcopy((rows,predictions))
        result=audit.updated_stage_pairs(rows,predictions)
        self.assertEqual(result['requests'],2);self.assertEqual(result['paired_requests'],1)
        self.assertEqual(result['upload_mae_s'],10);self.assertEqual(result['embedded_mae_s'],20)
        self.assertEqual(result['mean_absolute_error_change_s'],10)
        self.assertEqual(result['worsened_requests'],1);self.assertEqual(result['improved_requests'],0)
        self.assertEqual(result['excluded_requests']['missing_embedded'],1)
        self.assertEqual((rows,predictions),before)
        encoded=json.dumps(result)
        for private in ('paired\"','upload-only','request_id','run_id','target_s'):
            self.assertNotIn(private,encoded)

    def test_paired_stages_count_changes_ties_and_improvements_once_per_job(self):
        rows=[self.updated(name,stage) for name in ('better','tie','same') for stage in ('upload','embedded')]
        result=audit.updated_stage_pairs(rows,[30,15,0,20,10,10])
        self.assertEqual(result['paired_requests'],3)
        self.assertEqual(result['prediction_changed_requests'],2)
        self.assertEqual(result['improved_requests'],1);self.assertEqual(result['unchanged_error_requests'],2)
        self.assertEqual(result['worsened_requests'],0)
        self.assertEqual(result['mean_absolute_error_change_s'],-5)
        self.assertEqual(audit.updated_stage_pairs(list(reversed(rows)),[10,10,20,0,15,30]),result)

    def test_paired_stages_abstain_on_ambiguous_missing_or_different_targets(self):
        rows=[self.updated('duplicate','upload'),self.updated('duplicate','upload'),self.updated('duplicate','embedded'),
              self.updated('missing','embedded'),self.updated('run-local','upload'),self.updated('run-local','embedded',run_id='other')]
        keys={'target_s':11,'node':'other','decision_time':1001,'finish_time':2001,
              'terminal_class':'output_limited','target_contract':'other'}
        for key,value in keys.items():
            rows += [self.updated(key,'upload'),self.updated(key,'embedded',**{key:value})]
        result=audit.updated_stage_pairs(rows,[10]*len(rows))
        self.assertEqual(result['paired_requests'],0)
        self.assertEqual(result['excluded_requests'],{'ambiguous_checkpoint':1,'missing_upload':2,'missing_embedded':1,'different_target':6})
        self.assertEqual(sum(result['excluded_requests'].values()),result['requests'])
        self.assertIsNone(result['upload_mae_s']);self.assertIsNone(result['mean_absolute_error_change_s'])
        empty=audit.updated_stage_pairs([],[])
        self.assertEqual(empty['requests'],0);self.assertIsNone(empty['embedded_mae_s'])
        with self.assertRaises(ValueError):audit.updated_stage_pairs(rows,[])
        with self.assertRaises(ValueError):audit.updated_stage_pairs([self.updated('x','unsupported')],[10])
        for invalid in (float('nan'),float('inf'),True):
            with self.assertRaises(ValueError):audit.updated_stage_pairs([self.updated('x','upload')],[invalid])

    def test_evaluate_attaches_paired_stages_only_to_updated_including_empty(self):
        self.training['rows'].append(self.updated('training','upload',decision_time=100,finish_time=200))
        self.candidate['models']['updated']=copy.deepcopy(self.candidate['models']['admission'])
        self.candidate['reports']['updated']={'cutoff':500}
        self.write('training',self.training);self.write('candidate',self.candidate)
        receipt=audit.freeze(self.root/'candidate',self.root/'training',self.root/'paired-receipt')
        cut=audit.timestamp(receipt['frozen_at'])
        self.future['snapshot']['created_at']=dt.datetime.fromtimestamp((cut+10000)/1000,dt.timezone.utc).isoformat()
        for rows,count in (([],0),([self.updated('future',stage,decision_time=cut+1,finish_time=cut+1000) for stage in ('upload','embedded')],1)):
            self.future['rows']=rows;self.write('future',self.future)
            result=audit.evaluate(self.root/'candidate',self.root/'training',self.root/'paired-receipt',self.root/'future')
            self.assertEqual(result['reports']['updated']['paired_stages']['paired_requests'],count)
            self.assertNotIn('paired_stages',result['reports']['admission'])
            self.assertNotIn('paired_stages',result['reports']['remaining'])

    def test_group_support_distinguishes_collected_embeddings_from_selected_inputs(self):
        model=copy.deepcopy(self.candidate['models']['admission'])
        model['encoding']['names']=['elapsed_s']
        model['encoding']['categorical']=[]
        model['encoding']['vocabulary']={}
        model['trees']=[]
        rows=[{'kind':'updated','stage':'upload','features':{'semantic_0':None,'elapsed_s':0}},
              {'kind':'updated','stage':'embedded','features':{'semantic_0':.25,'elapsed_s':0}}]
        groups={'semantic':['semantic_0'],'progress':['elapsed_s'],'hardware':['hardware_power_watts']}
        before=copy.deepcopy((model,rows,groups))
        result=audit.input_support(model,[],rows,groups['hardware'],groups)
        semantic=result['feature_groups']['semantic']
        self.assertEqual(semantic['selected'],[])
        self.assertEqual(semantic['used_in_splits'],{})
        self.assertEqual(semantic['future_point_coverage'],{'semantic_0':.5})
        self.assertIsNone(semantic['training_point_coverage'])
        self.assertEqual(result['future_by_stage']['upload']['point_coverage']['semantic'],{'semantic_0':0})
        self.assertEqual(result['future_by_stage']['embedded']['point_coverage']['semantic'],{'semantic_0':1})
        self.assertEqual(result['future_by_stage']['remaining']['points'],0)
        self.assertIsNone(result['future_by_stage']['remaining']['point_coverage']['semantic'])
        self.assertEqual(result['feature_groups']['progress']['selected'],['elapsed_s'])
        self.assertEqual(result['feature_groups']['progress']['used_in_splits'],{})
        self.assertEqual(result['feature_groups']['hardware'],result['hardware'])
        self.assertEqual((model,rows,groups),before)

    def test_evaluate_reports_all_manifest_groups_with_no_feature_values(self):
        self.training['groups']={'base':['x'],'semantic':['semantic_0']}
        self.write('training',self.training)
        receipt=audit.freeze(self.root/'candidate',self.root/'training',self.root/'groups-receipt')
        cut=audit.timestamp(receipt['frozen_at'])
        self.future['rows']=[self.row('new',cut+1,cut+1000)]
        self.future['snapshot']['created_at']=dt.datetime.fromtimestamp((cut+10000)/1000,dt.timezone.utc).isoformat()
        self.future['rows'][0]['features']['semantic_0']=.123456789
        self.write('future',self.future)
        r=audit.evaluate(self.root/'candidate',self.root/'training',self.root/'groups-receipt',self.root/'future')
        support=r['reports']['admission']['input_support']
        self.assertEqual(support['feature_groups']['base']['selected'],['x'])
        self.assertEqual(support['feature_groups']['semantic']['future_point_coverage'],{'semantic_0':1})
        self.assertEqual(support['future_by_stage']['admission']['points'],1)
        self.assertNotIn('.123456789',json.dumps(support))

    def test_future_strata_expose_worker_failure_and_unseen_sessions_without_names(self):
        tr=[self.row('train',100,200)]
        tr[0]['group']='private-familiar-session'
        rows=[self.row('a',1000,2000),self.row('b',1000,2000),self.row('c',1000,2000)]
        rows[0]['group']='private-familiar-session'
        rows[1]['group']='private-unseen-session';rows[1]['node']='b'
        rows[2]['group']='unknown-session';rows[2]['node']='b'
        original=copy.deepcopy((tr,rows))
        result=audit.future_strata(tr,rows,[10,110,10])
        self.assertEqual(result['by_worker']['a']['metrics']['mae_s'],0)
        self.assertEqual(result['by_worker']['b']['metrics']['mae_s'],50)
        self.assertEqual(result['by_session_familiarity']['seen_in_training']['metrics']['mae_s'],0)
        self.assertEqual(result['by_session_familiarity']['unseen_in_training']['metrics']['mae_s'],100)
        unknown=result['by_session_familiarity']['unknown']
        self.assertEqual(unknown['metrics']['requests'],1)
        self.assertEqual(unknown['baselines']['worker_mean']['mae_s'],0)
        self.assertEqual((tr,rows),original)
        encoded=json.dumps(result)
        self.assertNotIn('private-familiar-session',encoded)
        self.assertNotIn('private-unseen-session',encoded)
        self.assertNotIn('request_id',encoded)

    def test_future_strata_rebalance_progress_within_worker_and_keep_empty_unknown(self):
        tr=[self.row('train',100,200)]
        rows=[self.row('a',1000,2000,'remaining') for _ in range(40)]+[self.row('b',1000,2000,'remaining')]
        result=audit.future_strata(tr,rows,[10]*40+[110])
        self.assertEqual(result['by_worker']['a']['points'],41)
        self.assertEqual(result['by_worker']['a']['metrics']['requests'],2)
        self.assertAlmostEqual(result['by_worker']['a']['metrics']['mae_s'],50)
        empty=result['by_session_familiarity']['unseen_in_training']
        self.assertEqual(empty,{'points':0,'metrics':None,'baselines':None})
        self.assertEqual(audit.future_strata(tr,[],[])['by_worker'],{})
        with self.assertRaises(ValueError):audit.future_strata(tr,rows,[10])

    def test_evaluation_familiarity_uses_actual_fitted_partition_not_entire_snapshot(self):
        self.training['rows'].append({**self.row('holdout',600,700),'group':'only-in-holdout'})
        self.training['rows'].append({**self.row('unfinished-at-cut',100,900),'group':'purged-training'})
        self.write('training',self.training)
        self.receipt=audit.freeze(self.root/'candidate',self.root/'training',self.root/'strata-receipt')
        cut=audit.timestamp(self.receipt['frozen_at'])
        self.future['snapshot']['created_at']=dt.datetime.fromtimestamp((cut+10000)/1000,dt.timezone.utc).isoformat()
        self.future['rows']=[{**self.row(str(i),cut+1,cut+1000),'group':group}
                             for i,group in enumerate(('session','only-in-holdout','purged-training'))]
        self.write('future',self.future)
        result=audit.evaluate(self.root/'candidate',self.root/'training',self.root/'strata-receipt',self.root/'future')
        r=result['reports']['admission']['future_strata']
        self.assertEqual(r['by_session_familiarity']['seen_in_training']['metrics']['requests'],1)
        self.assertEqual(r['by_session_familiarity']['unseen_in_training']['metrics']['requests'],2)
        self.assertEqual(result['reports']['remaining']['future_strata']['by_worker'],{})

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
        selection=report['cohort_selection']
        self.assertEqual(selection['source_points'],5);self.assertEqual(selection['selected_points'],1)
        self.assertEqual(selection['excluded_points'],{'in_training_snapshot':1,
                         'first_checkpoint_at_or_before_freeze':2,'finishes_after_snapshot':1})
        self.assertEqual(result['reports']['remaining']['cohort_selection']['excluded_points']['first_checkpoint_at_or_before_freeze'],1)
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
