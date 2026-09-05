import copy
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import recipe_sweep as sweep


class RecipeSweepTests(unittest.TestCase):
    def trials(self):
        trials=[]
        for i,recipe in enumerate(sweep.RECIPES):
            model={'id':'old','encoding':{},'base_margin':i,'trees':[],'transform':'raw','factor':1,'holdout_passed':i==0}
            report={'status':'holdout_passed' if i==0 else 'holdout_failed','cutoff':100,'training_requests':40,'holdout_requests':10,'folds':3,
                    'selected':{'mae_s':3-i},'holdout':{'mae_s':i*1000},'holdout_passed':i==0}
            trials.append({'schema':2,'feature_schema':'dsg-occupancy-v2','snapshot':{'created_at':'old'},'dependencies':{},'routing_enabled':False,
                           'training_recipe':{'id':recipe,'policy_sha256':sweep.RECIPE_HASH},
                           'models':{kind:copy.deepcopy(model) for kind in sweep.KINDS},'reports':{kind:copy.deepcopy(report) for kind in sweep.KINDS}})
        return trials

    def test_cv_winner_can_fail_holdout_and_gate_is_never_overridden(self):
        trials=self.trials();original=copy.deepcopy(trials)
        result=sweep.select_trials(trials,'new')
        for kind in sweep.KINDS:
            self.assertEqual(result['reports'][kind]['selected_recipe'],sweep.RECIPES[-1])
            self.assertFalse(result['reports'][kind]['holdout_passed']);self.assertFalse(result['models'][kind]['holdout_passed'])
            self.assertEqual(result['models'][kind]['base_margin'],2)
            self.assertNotEqual(result['models'][kind]['id'],'old')
        self.assertFalse(result['routing_enabled']);self.assertEqual(trials,original)
        again=sweep.select_trials(trials,'other-release')
        self.assertNotEqual(result['models']['remaining']['id'],again['models']['remaining']['id'])

    def test_per_kind_selection_stable_ties_and_missing_evidence(self):
        trials=self.trials()
        for trial in trials:trial['reports']['admission']['selected']['mae_s']=1
        trials[1]['reports']['updated']['selected']['mae_s']=0
        for trial in trials:
            del trial['models']['remaining'];trial['reports']['remaining']={'status':'insufficient_evidence'}
        result=sweep.select_trials(trials,'new')
        self.assertEqual(result['reports']['admission']['selected_recipe'],sweep.RECIPES[0])
        self.assertEqual(result['reports']['updated']['selected_recipe'],sweep.RECIPES[1])
        self.assertNotIn('remaining',result['models']);self.assertNotIn('selected_recipe',result['reports']['remaining'])

    def test_changed_contract_recipe_partition_and_bad_cv_are_rejected(self):
        for field,value in [('snapshot',{}),('dependencies',{'changed':True}),('routing_enabled',True),('feature_schema','production')]:
            trials=self.trials();trials[1][field]=value
            with self.assertRaises(ValueError):sweep.select_trials(trials,'new')
        for mutation in ('policy','partition','nan'):
            trials=self.trials()
            if mutation=='policy':trials[1]['training_recipe']['policy_sha256']='changed'
            if mutation=='partition':trials[1]['reports']['remaining']['cutoff']=101
            if mutation=='nan':trials[1]['reports']['remaining']['selected']['mae_s']=float('nan')
            with self.assertRaises(ValueError):sweep.select_trials(trials,'new')

    def test_existing_output_is_refused_before_training(self):
        with tempfile.TemporaryDirectory() as root,patch.object(sweep,'train') as train:
            with self.assertRaises(FileExistsError):sweep.sweep('input',root)
            train.assert_not_called()

    def test_sweep_runs_only_reviewed_recipes_and_writes_private_exclusive_artifacts(self):
        with tempfile.TemporaryDirectory() as root,patch.object(sweep,'train',side_effect=self.trials()) as train:
            output=Path(root)/'experiment';result=sweep.sweep('input',output)
            self.assertEqual([call.args[1] for call in train.call_args_list],list(sweep.RECIPES))
            self.assertTrue(all(call.kwargs=={'occupancy':True} for call in train.call_args_list))
            self.assertFalse(result['routing_enabled']);self.assertEqual(output.stat().st_mode&0o777,0o700)
            self.assertEqual(len(list(output.iterdir())),5)
            for file in output.iterdir():self.assertEqual(file.stat().st_mode&0o777,0o600)
            target=output/'report.json';before=target.read_bytes()
            with self.assertRaises(FileExistsError):sweep.write_private(target,{'replace':True})
            self.assertEqual(target.read_bytes(),before)

    def test_expanded_recipe_budget_is_refused_before_training(self):
        with tempfile.TemporaryDirectory() as root,patch.object(sweep,'train') as train,patch.object(sweep,'RECIPE_POLICY',{'recipes':[]}):
            with self.assertRaisesRegex(ValueError,'budget'):sweep.sweep('input',str(Path(root)/'experiment'))
            train.assert_not_called()


if __name__=='__main__':unittest.main()
