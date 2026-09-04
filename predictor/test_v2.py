"""Synthetic tests only. No private fleet data or model weights committed."""
import json
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import numpy as np
import fit_v2 as v

ROOT=Path(__file__).resolve().parent.parent


class PredictorV2Tests(unittest.TestCase):
    def test_hardware_challenger_trains_and_exports_real_hardware_splits(self):
        rows=self.rows(100)
        for i,r in enumerate(rows):
            r['features']['hardware_power_watts']=float((i%11)*10)
            r['target_s']=20+2*r['features']['hardware_power_watts']
        groups={k:[] for k in ('base','admission_state','client','history','ratios','semantic','request','progress')}
        groups['base']=['server_id'];groups['hardware']=['hardware_power_watts']
        data={'schema':'dsg-latency-v4','rows':rows,'snapshot':{'hashes':{}},'groups':groups,'categorical':['server_id']}
        with tempfile.TemporaryDirectory() as directory:
            prepared=Path(directory)/'prepared.json';prepared.write_text(json.dumps(data));result=v.train(prepared)
        report=result['reports']['admission']
        self.assertIn('hardware',report['selected']['family'])
        self.assertGreater(report['split_usage'].get('hardware_power_watts',0),0)
        self.assertEqual(report['feature_coverage']['hardware_power_watts'],1)
        self.assertEqual(report['holdout_feature_coverage']['hardware_power_watts'],1)
        self.assertTrue(report['hardware_coverage']['holdout'])
        self.assertFalse(result['routing_enabled'])

    def test_hardware_coverage_separates_workers_stages_and_missing_values(self):
        rows=self.rows(4)
        for row,node,stage,value in zip(rows,['a','a','a','b'],['upload','upload','embedded','upload'],[0,None,80,float('nan')]):
            row['node']=node;row['stage']=stage;row['features']['hardware_power_watts']=value
        result={(r['node'],r['stage']):r for r in v.hardware_coverage(rows,['hardware_power_watts'])}
        self.assertEqual(result['a','upload']['points'],2)
        self.assertEqual(result['a','upload']['feature_coverage']['hardware_power_watts'],.5)
        self.assertEqual(result['a','embedded']['feature_coverage']['hardware_power_watts'],1)
        self.assertEqual(result['b','upload']['feature_coverage']['hardware_power_watts'],0)
        self.assertEqual(v.hardware_coverage([],['hardware_power_watts']),[])

    def test_hardware_challenger_keeps_no_hardware_ablations(self):
        for kind in ('admission','updated','remaining'):
            old=v.feature_families({'schema':'dsg-latency-v3'},kind)
            new=v.feature_families({'schema':'dsg-latency-v4'},kind)
            self.assertEqual(new[:-2],old)
            self.assertTrue(all('hardware' in f for f in new[-2:]))
            self.assertLessEqual(len(new),9)

    def test_duration_bands_expose_hour_long_misses_and_boundaries(self):
        rows=self.rows(5)
        for r, target in zip(rows, (299, 300, 3599, 3600, 7200)):
            r['target_s']=target
        result=v.metrics(rows, [50]*5)
        bands=result['target_duration_bands']
        self.assertEqual([b['requests'] for b in bands.values()], [1, 2, 2])
        self.assertEqual(bands['1h_plus']['mae_s'], 5350)
        self.assertEqual(bands['1h_plus']['bias_s'], -5350)
        self.assertEqual(bands['1h_plus']['mean_actual_s'], 5400)
        self.assertEqual(bands['1h_plus']['mean_predicted_s'], 50)

    def test_duration_bands_balance_progress_and_do_not_invent_empty_accuracy(self):
        rows=self.rows(2)
        rows[0]['target_s']=7200; rows[1]['target_s']=3600
        result=v.metrics([rows[0]]*10+[rows[1]], [0]*11)
        bands=result['target_duration_bands']
        self.assertEqual(bands['1h_plus']['requests'], 2)
        self.assertAlmostEqual(bands['1h_plus']['mae_s'], 5400)
        self.assertIsNone(bands['under_5m']['mae_s'])
        self.assertEqual(bands['under_5m']['requests'], 0)

    def rows(self,n=100):
        return [{'run_id':'r','request_id':str(i),'group':f's{i%7}','decision_time':i*100,'finish_time':i*100+10,'kind':'admission','node':'a','profile':'p','target_s':float(20+i%10),'features':{'history_count':i%5,'server_id':'a','worker_service_median':25,'stage':'admission'}} for i in range(n)]

    def test_future_labels_are_purged_and_unseen_split_remains_available(self):
        rows=self.rows();rows[0]['finish_time']=99999
        tr,te=v.split(rows,8000)
        self.assertTrue(all(r['finish_time']<8000 for r in tr));self.assertTrue(all(r['decision_time']>=8000 for r in te))
        self.assertNotIn(rows[0],tr)
        tr,te=v.split(rows,8000,disjoint=True);self.assertFalse({r['group'] for r in tr}&{r['group'] for r in te})

    def test_ntrees_folds_never_touch_outer_holdout(self):
        tr,te=v.split(self.rows(),8000)
        for training,validation in v.folds(tr):
            self.assertLess(max(r['finish_time'] for r in training),min(r['decision_time'] for r in validation))
            self.assertLess(max(r['decision_time'] for r in validation),min(r['decision_time'] for r in te))

    def test_v3_cross_validates_bounded_feature_blocks_without_forcing_every_signal(self):
        data={'schema':'dsg-latency-v3','groups':{k:[] for k in ('base','admission_state','client','history','ratios','semantic','request','progress')}}
        for kind in ('admission','updated','remaining'):
            families=v.feature_families(data,kind)
            self.assertLessEqual(len(families),7)
            self.assertEqual(len(families),len({tuple(x) for x in families}))
            self.assertTrue(all(x[0]=='base' for x in families))
            self.assertEqual('progress' in families[0],kind=='remaining')
        used={group for kind in ('admission','updated','remaining') for family in v.feature_families(data,kind) for group in family}
        self.assertEqual(used,set(data['groups']))

    def test_model_identity_separates_releases_and_forecast_contracts(self):
        export={'trees':[], 'base_margin':10}
        snapshot={'created_at':'2026-01-01T00:00:00Z','hashes':{'fixture':'a'}}
        identity=v.model_identity(export,'admission',snapshot,'2026-01-01T00:01:00Z')
        self.assertEqual(identity,v.model_identity(export,'admission',snapshot,'2026-01-01T00:01:00Z'))
        self.assertNotEqual(identity,v.model_identity(export,'updated',snapshot,'2026-01-01T00:01:00Z'))
        self.assertNotEqual(identity,v.model_identity(export,'admission',snapshot,'2026-01-01T00:02:00Z'))
        self.assertNotEqual(identity,v.model_identity(export,'admission',{**snapshot,'hashes':{'fixture':'b'}},'2026-01-01T00:01:00Z'))

    def test_full_candidate_search_keeps_tree_cv_and_new_release_identity(self):
        data={'schema':v.SCHEMA,'rows':self.rows(), 'snapshot':{'created_at':'2026-01-01T00:00:00Z','hashes':{}},
              'groups':{'base':['history_count','server_id'],'history':['worker_service_median'],'ratios':[],'semantic':[]},'categorical':['server_id']}
        with tempfile.TemporaryDirectory() as directory:
            prepared=Path(directory)/'prepared.json';prepared.write_text(json.dumps(data))
            first=v.train(prepared);second=v.train(prepared,'regularized-v1');third=v.train(prepared,'interactions-v1')
        report=first['reports']['admission']
        self.assertIn('target_duration_bands', report['holdout'])
        self.assertTrue(all('target_duration_bands' in m for m in report['baselines'].values()))
        self.assertTrue(all('target_duration_bands' in m for m in report['selected']['fold_metrics']))
        self.assertGreaterEqual(report['folds'],2)
        self.assertIn(report['selected']['rounds'],v.ROUNDS)
        self.assertEqual({c['rounds'] for c in report['ablations']},set(v.ROUNDS))
        self.assertIn('history_count',report['feature_coverage'])
        self.assertEqual(set(report['holdout_feature_coverage']),set(report['feature_coverage']))
        self.assertEqual(report['hardware_coverage'],{'training':[],'holdout':[]})
        self.assertEqual(set(report['feature_coverage']),{name for group in data['groups'].values() for name in group})
        self.assertTrue(report['split_usage'])
        self.assertFalse(first['routing_enabled'])
        self.assertNotEqual(first['models']['admission']['id'],second['models']['admission']['id'])
        for candidate,recipe_id in [(first,'standard-v1'),(second,'regularized-v1'),(third,'interactions-v1')]:
            self.assertEqual(candidate['training_recipe']['id'],recipe_id)
            self.assertEqual(candidate['training_recipe']['parameters'],v.recipe(recipe_id))
            self.assertEqual(candidate['training_recipe']['policy_sha256'],v.RECIPE_HASH)
            selected=candidate['reports']['admission']
            self.assertGreaterEqual(selected['folds'],2)
            self.assertEqual({c['rounds'] for c in selected['ablations']},set(v.ROUNDS))
            self.assertEqual(selected['holdout_requests'],20)
            self.assertFalse(candidate['routing_enabled'])

    def test_reviewed_recipes_preserve_default_and_cannot_change_objective_or_budget(self):
        self.assertEqual(v.PARAMS, {'objective':'reg:squarederror','tree_method':'hist','device':'cpu','nthread':2,
            'max_depth':2,'eta':.05,'min_child_weight':3,'lambda':10,'seed':42,'subsample':1,'colsample_bytree':1})
        with self.assertRaises(ValueError):v.train('/never-read-this-path','custom')
        for item in v.RECIPE_POLICY['recipes']:
            params=v.recipe(item['id'])
            self.assertEqual(params['objective'],'reg:squarederror');self.assertEqual(params['nthread'],2)
            self.assertLessEqual(params['max_depth'],3)
            self.assertEqual(v.ROUNDS,(16,64,128))

    def test_recipe_argument_changes_the_actual_xgboost_parameters(self):
        rows=self.rows(50)
        for item in v.RECIPE_POLICY['recipes']:
            with patch.object(v.xgb,'train',wraps=v.xgb.train) as train:
                model,enc,factor=v.fit(rows,['history_count'],[],16,'raw',item['id'])
            self.assertEqual(train.call_args.args[0],v.recipe(item['id']))
            self.assertEqual(train.call_args.kwargs['num_boost_round'],16)
            native=v.predict(model,enc,factor,rows,'raw')
            portable=v.portable(model,enc,factor,'raw')
            np.testing.assert_allclose([v.exported_prediction(portable,r['features']) for r in rows],native,rtol=2e-5,atol=.001)

    def test_one_long_job_cannot_dominate_by_having_more_progress_rows(self):
        rows=self.rows(2);rows=[rows[0]]*10+[rows[1]]
        w=v.weights(rows);self.assertAlmostEqual(sum(w[:10]),w[-1])

    def test_missing_numeric_and_unknown_category_do_not_impute_previous_time(self):
        e=v.encoding(self.rows(),['history_count','server_id'],['server_id']);x=v.vector({'server_id':'new'},e)
        self.assertTrue(np.isnan(x[0]));self.assertEqual(x[-1],1)

    def test_exported_forests_match_real_xgboost_and_javascript(self):
        node=shutil.which('node');self.assertIsNotNone(node)
        rows=self.rows(50)
        for transform in ('raw','log','relative_log'):
            m,e,f=v.fit(rows,['history_count','server_id'],['server_id'],16,transform)
            export=v.portable(m,e,f,transform);native=v.predict(m,e,f,rows,transform)
            np.testing.assert_allclose([v.exported_prediction(export,r['features']) for r in rows],native,rtol=2e-5,atol=.001)
            code="import fs from 'node:fs';import {predictTreeModel} from './ds4-gateway/xgb-runtime.mjs';const p=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(p.features.map(f=>predictTreeModel(p.model,f))));"
            result=subprocess.run([node,'--input-type=module','-e',code],input=json.dumps({'model':export,'features':[r['features'] for r in rows]}),text=True,capture_output=True,cwd=ROOT,check=True)
            np.testing.assert_allclose(json.loads(result.stdout),native,rtol=2e-5,atol=.001)

    def test_hardware_prior_not_fixed_sixty_seconds(self):
        self.assertEqual(v.reference({'hardware_service_median':125}),125)
        self.assertEqual(v.reference({'worker_service_median':80,'hardware_service_median':125}),80)
        self.assertEqual(v.reference({'history_generation_estimate_s':20,'prior_ttft_s':4}),24)


if __name__=='__main__':unittest.main()
