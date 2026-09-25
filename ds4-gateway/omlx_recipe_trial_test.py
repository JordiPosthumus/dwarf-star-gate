import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from omlx_recipe_trial import Executor, candidate_bytes, summarize_mtp

MODEL='GLM-5.3-Flash-oQ8e-mtp'
ORIGINAL=(json.dumps({'version':1,'models':{MODEL:{'mtp_enabled':True,'mtp_num_draft_tokens':3,
    'max_context_window':400000,'max_tokens':262144,'enable_thinking':True,
    'thinking_budget_enabled':False}}},indent=2)+'\n').encode()


class Maintenance:
    def __init__(self,*args,**kwargs):self.released=False;self.resumed=False;self.waits=0
    def acquire(self):pass
    def wait_idle(self,native_idle):
        self.waits+=1
        if not native_idle():raise RuntimeError('not idle')
    def release(self):self.released=True
    def resume_if_unchanged(self):self.resumed=True;return {'state':'readmitted'}


class TrialTests(unittest.TestCase):
    def fixture(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        root=Path(temp.name);(root/'backup/state').mkdir(parents=True)
        (root/'backup/state/model_settings.json').write_bytes(ORIGINAL)
        executor=Executor.__new__(Executor)
        executor.folder=root;executor.root=root;executor.file=root/'model_settings.json'
        executor.file.write_bytes(ORIGINAL);executor.model=MODEL;executor.id='trial';executor.control=None
        executor.plan={'worker':'glm53f-m3'};executor.key='fixture-key';executor.status=lambda *a,**k:None
        def unchanged(expected):
            if executor.file.read_bytes()!=expected:raise RuntimeError('preserve owner edits')
        executor.unchanged=unchanged;executor.live=lambda depth:{'depth':depth};executor.native_idle=lambda:True
        executor.request=lambda *a,**k:{'active_requests':0,'waiting_requests':0,'models_loading':0}
        executor.reload=lambda depth:{'depth':depth};executor.checks=lambda phase:{'state':'passed','phase':phase}
        maintenance=Maintenance();mock=patch('omlx_recipe_trial.Maintenance',return_value=maintenance);mock.start();self.addCleanup(mock.stop)
        return executor,maintenance

    def test_reload_uses_installed_admin_status_contract_then_checks_live_settings(self):
        e,m=self.fixture();calls=[]
        e.request=lambda route,body:(calls.append((route,body)) or {'status':'ok','message':'Re-discovered models'})
        e.live=lambda depth:(calls.append(('live',depth)) or {'depth':depth,'loaded':True})
        self.assertEqual(Executor.reload(e,5),{'depth':5,'loaded':True})
        self.assertEqual(calls,[('/admin/api/reload',{}),('live',5)])
        e.request=lambda *args:{'success':True}
        with self.assertRaisesRegex(RuntimeError,'not confirmed'):Executor.reload(e,5)
        e.request=lambda *args:{'status':'ok'}
        e.live=lambda depth:(_ for _ in ()).throw(RuntimeError('settings differ'))
        with self.assertRaisesRegex(RuntimeError,'settings differ'):Executor.reload(e,5)

    def test_only_one_integer_changes_and_all_other_bytes_remain(self):
        candidate=candidate_bytes(ORIGINAL,MODEL,5)
        self.assertEqual(candidate,ORIGINAL.replace(b'"mtp_num_draft_tokens": 3',b'"mtp_num_draft_tokens": 5'))
        with self.assertRaises(ValueError):candidate_bytes(ORIGINAL,MODEL,7)
        with self.assertRaises(ValueError):candidate_bytes(candidate,MODEL,5)

    def test_candidate_reload_failure_restores_original_and_verifies_before_release(self):
        e,m=self.fixture();events=[]
        def reload(depth):
            events.append(('reload',depth))
            if depth==5:raise RuntimeError('candidate failed')
            return {'depth':depth}
        e.reload=reload;e.checks=lambda phase:events.append(('checks',phase)) or {'state':'passed'}
        result=e.measure()
        self.assertEqual(e.file.read_bytes(),ORIGINAL)
        self.assertEqual(events,[('checks','A'),('reload',5),('reload',3),('checks','A2')])
        self.assertTrue(m.released and m.resumed)
        self.assertEqual(result['result']['error'],'candidate failed')
        self.assertEqual(result['restoration']['state'],'verified')

    def test_candidate_generation_exception_still_restores_original(self):
        e,m=self.fixture()
        def checks(phase):
            if phase=='B':raise RuntimeError('native stream failed')
            return {'state':'passed'}
        e.checks=checks;result=e.measure()
        self.assertEqual(e.file.read_bytes(),ORIGINAL);self.assertTrue(m.released)
        self.assertEqual(result['result']['error'],'native stream failed')

    def test_external_settings_change_is_preserved_and_hold_retained(self):
        e,m=self.fixture()
        def checks(phase):
            if phase=='B':e.file.write_bytes(b'owner changed this')
            return {'state':'passed'}
        e.checks=checks
        with self.assertRaisesRegex(RuntimeError,'preserve owner edits'):e.measure()
        self.assertEqual(e.file.read_bytes(),b'owner changed this')
        self.assertFalse(m.released or m.resumed)

    def test_failed_restoration_check_does_not_readmit(self):
        e,m=self.fixture();e.checks=lambda phase:{'state':'failed' if phase=='A2' else 'passed'}
        with self.assertRaisesRegex(RuntimeError,'hold retained'):e.measure()
        self.assertEqual(e.file.read_bytes(),ORIGINAL);self.assertFalse(m.released or m.resumed)

    def test_native_work_during_restoration_prevents_reload(self):
        e,m=self.fixture();e.request=lambda *a,**k:{'active_requests':1,'waiting_requests':0,'models_loading':0}
        with self.assertRaisesRegex(RuntimeError,'Native work'):e.measure()
        self.assertFalse(m.released or m.resumed)


if __name__=='__main__':unittest.main()

class MtpEvidence(unittest.TestCase):
    def test_adaptive_depth_evidence_ignores_zero_depth_cycles_and_unrelated_log_text(self):
        value=summarize_mtp('private prompt\nMTP[4] finish=stop tokens=100 depth[d1=4/5,d2=2/3,d5=0/1] d0=12\nMTP[5] finish=stop depth[d1=2/3,d3=1/2]\n')
        self.assertEqual(value['highest_attempted_depth'],5)
        self.assertEqual(value['requests_with_depth_logs'],2)
        self.assertEqual(value['depths']['1'],{'accepted':6,'attempted':8})
        self.assertNotIn('private prompt',str(value));self.assertNotIn('0',value['depths'])
        self.assertIsNone(summarize_mtp('No finish records')['highest_attempted_depth'])
