import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest

import residual_life as residual


def row(identifier,kind='admission',duration=10,elapsed=0,decision=100,finish=200,node='a',run='r'):
    return {'run_id':run,'request_id':identifier,'node':node,'group':'session','kind':kind,
            'decision_time':decision,'finish_time':finish,'target_s':duration,
            'target_contract':'observed_terminal_occupancy','terminal_class':'normal','features':{'elapsed_s':elapsed}}


class ResidualLifeTests(unittest.TestCase):
    def test_conditions_on_strict_survival_not_subtraction_of_unconditional_mean(self):
        estimator=residual.ResidualLife({'a':[10,20,100]})
        self.assertAlmostEqual(estimator.predict('a',0)['mean_s'],130/3)
        self.assertEqual(estimator.predict('a',20),{'status':'observed','support':1,'mean_s':80,'p10_s':80,'median_s':80,'p90_s':80})
        self.assertEqual(estimator.predict('a',100)['status'],'no_survivors')
        self.assertEqual(estimator.predict('other',0)['status'],'unknown_worker')
        for age in (None,True,-1,float('nan'),float('inf')):self.assertEqual(estimator.predict('a',age)['status'],'unknown_age')

    def test_training_deduplicates_admissions_not_runs_and_purges_late_labels(self):
        a=row('a',duration=20);b=row('a',duration=30,run='other')
        rows=[a,copy.deepcopy(a),b,row('progress','remaining',duration=900),row('late',duration=500,finish=1000),row('cut',finish=500)]
        self.assertEqual(residual.fit_history(rows,500),{'a':[20,30]})
        with self.assertRaisesRegex(ValueError,'Contradictory'):residual.fit_history([a,{**a,'target_s':999}],500)
        with self.assertRaisesRegex(ValueError,'Unsupported'):residual.fit_history([{**a,'terminal_class':'cancelled'}],500)
        with self.assertRaisesRegex(ValueError,'Invalid'):residual.fit_history([{**a,'target_s':float('nan')}],500)

    def test_duration_pools_reject_bad_order_nonfinite_and_overflow(self):
        for pool in ([2,1],[True],[float('nan')],[-1],[1e308,1e308]):
            with self.assertRaises(ValueError):residual.ResidualLife({'a':pool})

    def test_matched_comparison_reports_abstention_and_uncalibrated_degenerate_quantiles(self):
        tr=[row('old','remaining')];model={'encoding':{'names':[],'categorical':[],'vocabulary':{}},'base_margin':10,'trees':[],'transform':'raw','factor':1}
        rows=[row('one','remaining',duration=30,elapsed=20),row('one','remaining',elapsed=200),row('other','remaining',node='unseen')]
        result=residual.compare(rows,tr,model,residual.ResidualLife({'a':[50]}))
        self.assertEqual((result['points'],result['requests'],result['covered_points'],result['requests_with_covered_points']),(3,2,1,1))
        self.assertEqual(result['matched_metrics']['conditional_mean']['mae_s'],0)
        self.assertEqual(result['matched_metrics']['frozen_xgb']['mae_s'],20)
        self.assertEqual(result['empirical_interval'],{'nominal_mass':.8,'calibrated':False,'observed_coverage':1.,'mean_width_s':0.})
        empty=residual.compare(rows,tr,model,residual.ResidualLife({}))
        self.assertIsNone(empty['matched_metrics']);self.assertIsNone(empty['empirical_interval'])

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        snapshot={'created_at':'2020-01-01T00:00:00Z','feature_builder_sha256':'builder','hashes':{'worker-inventory.json':'profiles'}}
        self.training={'schema':'dsg-occupancy-v1','feature_schema':'dsg-latency-v4','snapshot':snapshot,
                       'rows':[row('old',duration=50),row('old','remaining',duration=50),row('held','remaining',duration=25,elapsed=25,decision=600,finish=700)]}
        model={'encoding':{'names':[],'categorical':[],'vocabulary':{}},'base_margin':10,'trees':[],'transform':'raw','factor':1}
        self.candidate={'schema':2,'feature_schema':'dsg-occupancy-v1','routing_enabled':False,'created_at':'2020-01-02T00:00:00Z',
                        'snapshot':snapshot,'models':{'remaining':model},'reports':{'remaining':{'cutoff':500}}}
        self.write('training',self.training);self.write('candidate',self.candidate)

    def write(self,name,data):
        (self.root/name).write_text(json.dumps(data))

    def freeze(self):
        return residual.freeze(self.root/'candidate',self.root/'training',self.root/'artifact')

    def evaluate(self,prepared=None):
        return residual.evaluate(self.root/'candidate',self.root/'training',self.root/'artifact',self.root/prepared if prepared else None)

    def test_frozen_artifact_is_exclusive_private_bound_to_policy_and_training(self):
        result=self.freeze();self.assertEqual(result['training_jobs'],1)
        self.assertEqual((self.root/'artifact').stat().st_mode&0o777,0o600)
        with self.assertRaises(FileExistsError):self.freeze()
        original=json.loads((self.root/'artifact').read_text())
        for change in ({'source_sha256':'changed'},{'pools':{'a':[900]}},{'routing_enabled':True},{'candidate_sha256':'changed'}):
            self.write('artifact',{**original,**change})
            with self.assertRaises(ValueError):self.evaluate()

    def test_holdout_is_exploratory_and_future_admission_must_follow_experiment_freeze(self):
        freeze=self.freeze();result=self.evaluate()
        self.assertEqual(result['mode'],'exploratory_existing_holdout');self.assertEqual(result['all']['covered_points'],1)
        self.assertEqual(result['all']['matched_metrics']['conditional_mean']['mae_s'],0)
        cut=residual.timestamp(freeze['frozen_at'])
        future=copy.deepcopy(self.training)
        future['snapshot']['created_at']=dt.datetime.fromtimestamp((cut+10000)/1000,dt.timezone.utc).isoformat()
        future['rows']=[row('new','remaining',duration=30,elapsed=20,decision=cut+1,finish=cut+5000),
                        row('old','remaining',decision=cut+2,finish=cut+5000),
                        row('lingering',decision=cut-10,finish=cut+5000),row('lingering','remaining',decision=cut+3,finish=cut+5000)]
        self.write('future',future);result=self.evaluate('future')
        self.assertEqual(result['mode'],'frozen_future');self.assertEqual(result['all']['points'],1)
        self.assertFalse(result['routing_enabled']);self.assertEqual(result['authority'],'none')
        self.assertEqual(result['all']['matched_metrics']['conditional_mean']['mae_s'],0)
        future['snapshot']['hashes']['worker-inventory.json']='different';self.write('future',future)
        with self.assertRaisesRegex(ValueError,'contract'):self.evaluate('future')


if __name__=='__main__':unittest.main()
