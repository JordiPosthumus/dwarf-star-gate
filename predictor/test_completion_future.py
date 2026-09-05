import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest

import occupancy_future as audit


class CompletionFutureTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        snapshot={'created_at':'2020-01-01T00:00:00Z','feature_builder_sha256':'builder','hashes':{'worker-inventory.json':'inventory'}}
        self.training={'schema':'dsg-latency-v4','snapshot':snapshot,
                       'rows':[self.row('old',100,200,kind) for kind in ('admission','updated','remaining')]}
        model={'encoding':{'names':['x'],'categorical':[],'vocabulary':{}},'base_margin':10,'trees':[],'transform':'raw','factor':1}
        self.candidate={'schema':2,'feature_schema':'dsg-latency-v4','routing_enabled':False,
                        'created_at':'2020-01-02T00:00:00Z','snapshot':copy.deepcopy(snapshot),
                        'models':{k:copy.deepcopy(model) for k in ('admission','updated','remaining')},
                        'reports':{k:{'cutoff':500} for k in ('admission','updated','remaining')}}
        self.write('training',self.training);self.write('candidate',self.candidate)
        self.receipt=audit.freeze(self.root/'candidate',self.root/'training',self.root/'receipt',completion=True)
        self.cut=audit.timestamp(self.receipt['frozen_at'])
        self.future=copy.deepcopy(self.training)
        self.future['snapshot']['created_at']=dt.datetime.fromtimestamp((self.cut+10000)/1000,dt.timezone.utc).isoformat()
        self.future['rows']=[self.row('new',self.cut+1,self.cut+1000,k) for k in ('admission','updated','remaining')]
        self.future['rows'].append({**self.row('new',self.cut+1,self.cut+1000,'updated'),'stage':'embedded'})

    def row(self,identifier,decision,finish,kind='admission'):
        return {'run_id':'r','request_id':identifier,'group':'private-session','node':'a','kind':kind,
                'stage':'upload' if kind=='updated' else kind,'decision_time':decision,'finish_time':finish,
                'target_s':10,'features':{'x':1,'elapsed_s':30}}

    def write(self,name,value):
        (self.root/name).write_text(json.dumps(value))

    def evaluate(self):
        self.write('future',self.future)
        return audit.evaluate(self.root/'candidate',self.root/'training',self.root/'receipt',self.root/'future',completion=True)

    def test_explicit_completion_mode_is_separate_from_occupancy(self):
        for schema in ('dsg-latency-v2','dsg-latency-v3','dsg-latency-v4'):
            candidate=copy.deepcopy(self.candidate);training=copy.deepcopy(self.training)
            candidate['feature_schema']=training['schema']=schema
            audit.contracts(candidate,training,completion=True)
            with self.assertRaises(ValueError):audit.contracts(candidate,training)
        candidate=copy.deepcopy(self.candidate);training=copy.deepcopy(self.training)
        candidate['feature_schema']=training['schema']='dsg-occupancy-v1';training['feature_schema']='dsg-latency-v4'
        audit.contracts(candidate,training)
        with self.assertRaises(ValueError):audit.contracts(candidate,training,completion=True)
        with self.assertRaises(ValueError):audit.freeze(self.root/'candidate',self.root/'training',self.root/'wrong-mode')
        self.assertFalse((self.root/'wrong-mode').exists())

    def test_future_only_completion_preserves_pairs_and_never_promotes(self):
        self.future['rows'] += [self.row('boundary',self.cut,self.cut+1000),self.row('old',self.cut+1,self.cut+1000),
                               self.row('earlier',self.cut-1,self.cut+1000),self.row('earlier',self.cut+1,self.cut+1000,'remaining'),
                               self.row('unfinished',self.cut+1,self.cut+20000)]
        before=copy.deepcopy((self.training,self.candidate,self.future))
        result=self.evaluate()
        self.assertEqual(result['mode'],'offline_frozen_completion_future')
        self.assertEqual(result['authority'],'none');self.assertFalse(result['routing_enabled'])
        for report in result['reports'].values():
            self.assertEqual(report['metrics']['requests'],1);self.assertEqual(report['metrics']['mae_s'],0)
            self.assertNotIn('terminal_classes',report)
        self.assertEqual(result['reports']['updated']['paired_stages']['paired_requests'],1)
        selection=result['reports']['admission']['cohort_selection']
        self.assertEqual(selection['source_points'],5)
        self.assertEqual(selection['selected_points'],1)
        self.assertEqual(selection['excluded_points'],{'in_training_snapshot':1,
                         'first_checkpoint_at_or_before_freeze':2,'finishes_after_snapshot':1})
        self.assertEqual(selection['source_requests'],5)
        self.assertEqual(selection['fully_excluded_requests'],4)
        self.assertEqual(result['reports']['remaining']['cohort_selection']['excluded_points']['first_checkpoint_at_or_before_freeze'],1)
        self.assertEqual((self.training,self.candidate,self.future),before)
        for private in ('request_id','private-session','unfinished'):
            self.assertNotIn(private,json.dumps(result))

    def test_completion_rejects_mixed_targets_invalid_labels_and_changed_contracts(self):
        for key,value in [('terminal_class','output_limited'),('target_contract','observed_terminal_occupancy'),
                          ('target_s',True),('target_s',float('nan')),('target_s',-1),('finish_time',0)]:
            original=copy.deepcopy(self.future)
            self.future['rows'][0][key]=value
            with self.assertRaisesRegex(ValueError,'label'):self.evaluate()
            self.future=original
        for changed in ('builder','inventory','schema','features'):
            original=copy.deepcopy(self.future)
            if changed=='builder':self.future['snapshot']['feature_builder_sha256']='other'
            if changed=='inventory':self.future['snapshot']['hashes']['worker-inventory.json']='other'
            if changed=='schema':self.future['schema']='dsg-latency-v3'
            if changed=='features':self.future['feature_schema']='dsg-latency-v4'
            with self.assertRaisesRegex(ValueError,'feature builder'):self.evaluate()
            self.future=original

    def test_completion_freeze_is_exclusive_and_receipt_and_artifacts_are_bound(self):
        self.assertEqual((self.root/'receipt').stat().st_mode&0o777,0o600)
        with self.assertRaises(FileExistsError):audit.freeze(self.root/'candidate',self.root/'training',self.root/'receipt',completion=True)
        receipt=copy.deepcopy(self.receipt);receipt['purpose']='offline_occupancy_future_audit';self.write('receipt',receipt)
        with self.assertRaisesRegex(ValueError,'identity'):self.evaluate()
        self.write('receipt',self.receipt)
        self.candidate['models']['admission']['base_margin']=20;self.write('candidate',self.candidate)
        with self.assertRaisesRegex(ValueError,'identity'):self.evaluate()

    def test_completion_no_later_labels_has_no_accuracy_claim(self):
        self.future['rows']=copy.deepcopy(self.training['rows'])
        result=self.evaluate()
        for report in result['reports'].values():
            self.assertEqual(report['status'],'no_future_labels');self.assertNotIn('metrics',report)
            self.assertEqual(report['cohort_selection']['selected_points'],0)
            self.assertEqual(report['cohort_selection']['fully_excluded_requests'],1)
            self.assertEqual(report['cohort_selection']['excluded_points']['in_training_snapshot'],1)
        self.assertEqual(result['reports']['updated']['paired_stages']['paired_requests'],0)

    def test_completion_stage_pairs_still_require_matching_request_target(self):
        self.future['rows'][-1]['target_s']=20
        report=self.evaluate()['reports']['updated']['paired_stages']
        self.assertEqual(report['paired_requests'],0)
        self.assertEqual(report['excluded_requests']['different_target'],1)


if __name__=='__main__':unittest.main()
