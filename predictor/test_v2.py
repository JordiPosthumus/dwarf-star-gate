"""Synthetic tests only. No private fleet data or model weights committed."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
import numpy as np
import fit_v2 as v

ROOT=Path(__file__).resolve().parent.parent


class PredictorV2Tests(unittest.TestCase):
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
            first=v.train(prepared);second=v.train(prepared)
        report=first['reports']['admission']
        self.assertGreaterEqual(report['folds'],2)
        self.assertIn(report['selected']['rounds'],v.ROUNDS)
        self.assertEqual({c['rounds'] for c in report['ablations']},set(v.ROUNDS))
        self.assertFalse(first['routing_enabled'])
        self.assertNotEqual(first['models']['admission']['id'],second['models']['admission']['id'])

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
