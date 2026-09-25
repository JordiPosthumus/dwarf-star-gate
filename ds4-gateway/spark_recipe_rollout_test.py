import json
from pathlib import Path
import tempfile
import unittest

from spark_recipe_remote import Remote, baseline_cache_settings
from spark_recipe_rollout import Rollout, digest


class RolloutTransaction(unittest.TestCase):
    def fixture(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);root=Path(temporary.name)
        remote=Remote({'kind':'glm53-spark-pair-rollout','candidate_profile':'baseline-cache-400k','trial_root':str(root),'recipe_root':str(root/'original'),'trial_id':'fixture','qualified_image':'candidate-image'})
        original={'MAX_MODEL_LEN':'400000','MAX_NUM_SEQS':'2','MAX_NUM_BATCHED_TOKENS':'7168','GPU_MEM_UTIL':'0.85','GLM53_DENSE_FP8':'off','GLM53_KDA_BF16_LARGE_M':'0','GLM53_EXL3_MOE_FAST':'0','DFLASH_TOKENS':'7','DEFAULT_MAX_NEW_TOKENS':'65536'}
        mapped={'GLM53_APC_RETENTION_INTERVAL':'VLLM_PREFIX_CACHE_RETENTION_INTERVAL','GLM53_APC_RETENTION_INTERVAL_SWA':'VLLM_PREFIX_CACHE_RETENTION_INTERVAL_SWA'}
        candidate={mapped.get(k,k):v for k,v in baseline_cache_settings(original).items()}
        events=[];launched=[False]
        def inspect(rank=False):
            settings=candidate if launched[0] else original
            return {'Id':('candidate-' if launched[0] else 'original-')+('rank' if rank else 'head'),'Image':'candidate-image' if launched[0] else 'original-image','State':{'Running':True},'Config':{'Env':[k+'='+v for k,v in settings.items()]}}
        remote.inspect=inspect;remote.backup.mkdir();(remote.backup/'head.json').write_text(json.dumps(inspect()))
        (root/'prepared.json').write_text(json.dumps({'candidate_image':'candidate-image','rank_candidate_image':'candidate-image','original_container':'original-head','original_rank_container':'original-rank'}))
        remote.baseline_unchanged=lambda:None;remote.wait_idle=lambda **kw:events.append('idle')
        remote.isolate_candidate_staging=lambda prepared:events.append('staging')
        remote.suspend_original=lambda prepared:events.append('suspend')
        remote.launch=lambda *args:(events.append('launch'),launched.__setitem__(0,True))
        remote.request=lambda *args,**kw:json.dumps({'data':[{'id':'GLM-5.3-Flash-EXL3'}]}).encode()
        remote.chat=lambda *args,**kw:({'finish_reason':'stop'},{'content':'DEPLOYED_7319'})
        remote.checks=lambda *args:(_ for _ in ()).throw(AssertionError('Permanent rollout must not run benchmark checks'))
        remote.restore=lambda prepared:(events.append('restore') or {'state':'verified'})
        return remote,events,candidate

    def test_success_keeps_candidate_without_running_trial_or_restoring(self):
        remote,events,_=self.fixture();result=remote.deploy()
        self.assertEqual(result['state'],'deployed');self.assertTrue(result['preserved_serving_settings_verified']);self.assertNotIn('restore',events)
        with self.assertRaisesRegex(RuntimeError,'already submitted'):remote.deploy()

    def test_readiness_failure_restores_original_without_benchmark(self):
        remote,events,_=self.fixture();remote.chat=lambda *args,**kw:({'finish_reason':'stop'},{'content':'wrong'})
        result=remote.deploy();self.assertEqual(result['state'],'restored');self.assertIn('restore',events)

    def test_changed_serving_precision_refuses_candidate_and_restores(self):
        remote,events,candidate=self.fixture();candidate['GLM53_DENSE_FP8']='dense,kda'
        result=remote.deploy();self.assertEqual(result['state'],'restored');self.assertIn('preserved serving setting',result['error']);self.assertIn('restore',events)


class Publication(unittest.TestCase):
    def fixture(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);root=Path(temporary.name)
        launcher=root/'launcher.py';launcher.write_text('config = {"recipe": "/original", "other": "/untouched"}\n')
        config=root/'config.json';config.write_text(json.dumps({'unrelated':{'keep':True},'genie_chat':{'inspection':{'workers':{'glm53f-sparks12':{'recipe_root':'/original','ssh':['target']},'other':{'recipe_root':'/other'}}}}}))
        rollout=Rollout.__new__(Rollout);rollout.folder=root;rollout.remote='/prepared/operation';rollout.plan={'worker':'glm53f-sparks12','ssh':'target','recipe_root':'/original','launcher_file':str(launcher),'inspection_config_file':str(config),'launcher_sha256':digest(launcher.read_bytes())}
        return rollout,launcher,config

    def test_publication_changes_only_target_binding_and_has_exact_rollback(self):
        rollout,launcher,config=self.fixture();before=(launcher.read_bytes(),config.read_bytes());rollout.publication_prepare();rollout.publish()
        self.assertIn('"recipe": "/prepared/operation/candidate"',launcher.read_text())
        value=json.loads(config.read_text());self.assertTrue(value['unrelated']['keep']);self.assertEqual(value['genie_chat']['inspection']['workers']['other']['recipe_root'],'/other')
        rollout.unpublish();self.assertEqual((launcher.read_bytes(),config.read_bytes()),before)

    def test_owner_edits_block_publication_and_are_never_overwritten(self):
        rollout,launcher,config=self.fixture();rollout.publication_prepare();launcher.write_text('owner edit')
        with self.assertRaisesRegex(RuntimeError,'preserve owner edits'):rollout.publish()
        self.assertEqual(launcher.read_text(),'owner edit')


if __name__=='__main__':unittest.main()

class ImageTransport(unittest.TestCase):
    def fixture(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        r=Rollout.__new__(Rollout);r.folder=Path(temporary.name);r.plan={'ssh':'target','image_source_ssh':'source','qualified_image':'sha256:'+'c'*64};r.status=lambda *a,**k:None
        return r
    def test_existing_exact_arm_image_is_reused_and_wrong_identity_is_rejected(self):
        r=self.fixture();r.ssh=lambda *a,**k:json.dumps({'present':True,'image':r.plan['qualified_image'],'architecture':'arm64'}).encode();self.assertTrue(r.target_has_image())
        r.ssh=lambda *a,**k:json.dumps({'present':True,'image':'different','architecture':'arm64'}).encode()
        with self.assertRaisesRegex(RuntimeError,'differs'):r.target_has_image()
    def test_direct_copy_requires_matching_peer_before_sending_any_image(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        import shlex
        r=self.fixture();peer={'destination':'fixture@example.invalid','port':22,'machine_sha256':'a'*64};calls=[]
        def run(argv,**kw):
            calls.append(argv)
            if len(calls)==1:return SimpleNamespace(returncode=0,stdout=b'b'*64)
            raise AssertionError('Image must not be sent to a mismatched machine')
        r.run=run
        with patch('spark_recipe_rollout.peer_parameters',return_value=peer):self.assertFalse(r.direct_image())
        self.assertEqual(len(calls),1)
        calls.clear()
        def matching(argv,**kw):
            calls.append(argv)
            if len(calls)==1:return SimpleNamespace(returncode=0,stdout=b'a'*64)
            command=shlex.split(argv[-1]);compile(command[3],'direct-copy','exec')
            return SimpleNamespace(returncode=0)
        r.run=matching
        with patch('spark_recipe_rollout.peer_parameters',return_value=peer):self.assertTrue(r.direct_image())
        self.assertEqual(len(calls),2);self.assertTrue((r.folder/'direct-copy-peer.json').exists())
    def test_resume_checks_all_retained_source_bytes_and_refuses_advanced_preparation(self):
        import tarfile,subprocess,shlex
        r=self.fixture();r.remote=str(r.folder/'remote');candidate=Path(r.remote)/'candidate';candidate.mkdir(parents=True)
        file=candidate/'start.sh';file.write_text('original');archive=r.folder/'source.tar'
        with tarfile.open(archive,'w') as out:out.add(file,arcname='start.sh')
        r.plan['source_archive']=str(archive);r.ssh=lambda command,**kw:subprocess.check_output(shlex.split(command),stderr=subprocess.STDOUT)
        r.verify_retained_source();file.write_text('owner edit')
        with self.assertRaises(subprocess.CalledProcessError):r.verify_retained_source()
        self.assertEqual(file.read_text(),'owner edit');file.write_text('original');(Path(r.remote)/'baseline').mkdir()
        with self.assertRaises(subprocess.CalledProcessError):r.verify_retained_source()

    def test_unavailable_peer_ssh_uses_authenticated_stream_without_changing_credentials(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        r=self.fixture();peer={'destination':'fixture@example.invalid','port':22,'machine_sha256':'a'*64};r.run=lambda *a,**kw:SimpleNamespace(returncode=255,stdout=b'')
        with patch('spark_recipe_rollout.peer_parameters',return_value=peer),patch('spark_recipe_rollout.peer_stream',return_value=True) as stream:
            self.assertTrue(r.direct_image());stream.assert_called_once_with(r,peer)


class PairPublication(unittest.TestCase):
 def test_recipe_update_preserves_media_membership_and_rolls_back_exactly(self):
  helper=Publication();r,launcher,config=helper.fixture();self.addCleanup(helper.doCleanups)
  value=json.loads(config.read_text());value['media_jobs']={'automatic_dispatch':False,'pairs':{'glm53f-sparks12':{'members':[{'ssh':'target','recipe_root':'/original'},{'ssh':'rank'}],'engine_members':{'video':0,'music':1}}}}
  config.write_text(json.dumps(value));before=config.read_bytes();r.publication_prepare();r.publish()
  new=json.loads(config.read_text());pair=new['media_jobs']['pairs']['glm53f-sparks12']
  self.assertEqual(pair['members'][0]['recipe_root'],'/prepared/operation/candidate');self.assertEqual(pair['members'][1],{'ssh':'rank'})
  self.assertEqual(pair['engine_members'],{'video':0,'music':1});self.assertFalse(new['media_jobs']['automatic_dispatch'])
  r.unpublish();self.assertEqual(config.read_bytes(),before)
 def test_unexpected_media_binding_refuses_publication(self):
  helper=Publication();r,launcher,config=helper.fixture();self.addCleanup(helper.doCleanups)
  value=json.loads(config.read_text());value['media_jobs']={'pairs':{'glm53f-sparks12':{'members':[{'ssh':'target','recipe_root':'/owner-change'}]}}};config.write_text(json.dumps(value));before=config.read_bytes()
  with self.assertRaisesRegex(RuntimeError,'media recipe binding'):r.publication_prepare()
  self.assertEqual(config.read_bytes(),before)

class CandidateQualification(unittest.TestCase):
 def test_cache_and_restoration_proof_are_required_for_candidate_only_acceptance(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);r=Rollout.__new__(Rollout);result=root/'result.json';prepared=root/'prepared.json'
   prepared.write_text(json.dumps({'candidate_image':'image','source_revision':'revision'}))
   rows=[{'label':x,'passed':True} for x in ['arithmetic','tool_call_and_followup','cold-A','cold-B','append-A','append-B','edit-90-percent','branch-90-percent']]+[{'label':'context-boundary','accepted':True},{'label':'concurrency-two','two_active_requests_observed':True}]
   for row in rows:
    if row['label'].startswith('cold-'):row['cold_cache_proved']=True
    if row['label'].startswith('append-'):row['substantial_reuse_proved']=True
   value={'state':'complete','qualification_mode':'candidate-only','restoration':{'state':'verified','readiness':{'finish_reason':'stop','answer':'RESTORED_7319'}},'preserved_serving_settings_verified':True,'phases':{'B':rows}}
   def save():
    result.write_text(json.dumps(value));r.plan={'qualified_result_file':str(result),'qualified_result_sha256':digest(result.read_bytes()),'qualified_prepare_file':str(prepared),'qualified_prepare_sha256':digest(prepared.read_bytes()),'qualified_image':'image','source_revision':'revision'}
   save();r.qualification()
   rows[4]['substantial_reuse_proved']=False;save()
   with self.assertRaisesRegex(RuntimeError,'native cache'):r.qualification()
   rows[4]['substantial_reuse_proved']=True;value['error']='candidate failed';save()
   with self.assertRaisesRegex(RuntimeError,'lacks'):r.qualification()
