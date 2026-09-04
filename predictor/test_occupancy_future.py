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

    def test_changed_builder_profile_or_invalid_labels_fail_closed(self):
        for change in ('builder','profile','label','time'):
            previous=copy.deepcopy(self.future)
            if change=='builder':self.future['snapshot']['feature_builder_sha256']='changed'
            elif change=='profile':self.future['snapshot']['hashes']['worker-inventory.json']='changed'
            elif change=='label':self.future['rows'][0]['target_s']=float('nan')
            else:self.future['snapshot']['created_at']='2020-01-01T00:00:00Z'
            with self.assertRaises(ValueError):self.evaluate()
            self.future=previous
