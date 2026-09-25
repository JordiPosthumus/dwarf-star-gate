import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from spark_recipe_remote import Remote, isolated_rank_launcher, baseline_cache_settings

class TrialTransaction(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.remote=Remote({'trial_root':str(self.root),'recipe_root':str(self.root/'original'),'trial_id':'fixture','baseline_image':'original-image'})
  self.events=[];self.prepared={'original_container':'original-head','original_rank_container':'original-rank','candidate_image':'candidate-image','rank_candidate_image':'candidate-image'}
  (self.root/'prepared.json').write_text(json.dumps(self.prepared))
  self.remote.baseline_unchanged=lambda:self.events.append('baseline_checked');self.remote.wait_idle=lambda **kw:self.events.append('idle')
  self.remote.inspect=lambda rank=False:{'Id':'original-rank' if rank else 'original-head'}
  self.remote.backup.mkdir();(self.remote.backup/'worker-inner.sh').write_bytes(b'original');self.remote.rank=lambda *args,**kw:b'original'
  self.remote.suspend_original=lambda prepared:self.events.append('suspend')
  self.remote.isolate_candidate_staging=lambda prepared:self.events.append('isolate_staging')
  self.remote.launch=lambda *args:(_ for _ in ()).throw(RuntimeError('candidate failed to load'))
  self.remote.restore=lambda prepared:(self.events.append('restore') or {'state':'verified'})
  self.remote.checks=lambda phase,limit:(self.events.append(phase) or [{'label':label,'passed':True} for label in ['arithmetic','tool_call_and_followup','cold-A','cold-B','append-A','append-B','edit-90-percent','branch-90-percent']]+[{'label':'context-boundary','accepted':True},{'label':'concurrency-two','two_active_requests_observed':True}])
 def test_cache_variant_rejects_changed_precision_before_candidate_measurement(self):
  original={'MAX_MODEL_LEN':'400000','MAX_NUM_SEQS':'2','MAX_NUM_BATCHED_TOKENS':'7168','GPU_MEM_UTIL':'0.85','GLM53_DENSE_FP8':'off','GLM53_KDA_BF16_LARGE_M':'0','GLM53_EXL3_MOE_FAST':'0','DFLASH_TOKENS':'7'}
  (self.remote.backup/'head.json').write_text(json.dumps({'Config':{'Env':[key+'='+value for key,value in original.items()]}}))
  self.remote.plan['candidate_profile']='baseline-cache-400k'
  state={'candidate':False};self.remote.launch=lambda *args:state.update(candidate=True)
  def inspect(rank=False):
   if not state['candidate']:return {'Id':'original-rank' if rank else 'original-head'}
   settings={**original,'GLM53_DENSE_FP8':'dense,kda'}
   return {'Id':'candidate-rank' if rank else 'candidate-head','Image':'candidate-image','Config':{'Env':[key+'='+value for key,value in settings.items()]}}
  self.remote.inspect=inspect
  result=self.remote.run();self.assertIn('preserved serving setting',result['error']);self.assertIn('restore',self.events);self.assertNotIn('B',self.events)
 def test_failed_candidate_launch_still_restores_original_and_checks_it(self):
  result=self.remote.run();self.assertEqual(result['state'],'complete');self.assertIn('failed to load',result['error'])
  self.assertLess(self.events.index('A'),self.events.index('suspend'));self.assertLess(self.events.index('restore'),self.events.index('A2'))
 def test_failed_restored_context_or_concurrency_cannot_claim_verified_restoration(self):
  for label,key in [('context-boundary','accepted'),('concurrency-two','two_active_requests_observed')]:
   with self.subTest(label=label):
    intent=self.root/'run-intent.json'
    if intent.exists():intent.unlink()
    original=self.remote.checks
    def checks(phase,limit):
     rows=original(phase,limit)
     if phase=='A2':
      for row in rows:
       if row['label']==label:row[key]=False
     return rows
    self.remote.checks=checks
    result=self.remote.run();self.assertEqual(result['state'],'restoration_required');self.assertEqual(result['restoration']['state'],'unverified')
    self.remote.checks=original
 def test_restoration_failure_never_claims_completion(self):
  self.remote.restore=lambda prepared:(_ for _ in ()).throw(RuntimeError('owner changed the recipe'))
  result=self.remote.run();self.assertEqual(result['state'],'restoration_required');self.assertNotIn('A2',self.events)
 def test_uncertain_run_is_never_submitted_twice(self):
  (self.root/'run-intent.json').write_text('{}')
  with self.assertRaisesRegex(RuntimeError,'already started'):self.remote.run()
  self.assertNotIn('suspend',self.events)
 def test_changed_original_identity_prevents_any_stop(self):
  self.remote.inspect=lambda rank=False:{'Id':'another-container'}
  with self.assertRaisesRegex(RuntimeError,'identity changed'):self.remote.run()
  self.assertNotIn('suspend',self.events)
 def test_suspend_keeps_exact_original_containers_instead_of_removing_them(self):
  del self.remote.suspend_original
  commands=[];self.remote.command=lambda args,**kw:commands.append(args);self.remote.rank=lambda args,**kw:commands.append(args)
  self.remote.suspend_original(self.prepared)
  self.assertEqual(commands[0],['docker','stop','--time','60','original-head']);self.assertEqual(commands[2],['docker','stop','--time','60','original-rank'])
  self.assertTrue(all(command[1] in ['stop','rename'] for command in commands))

class Restoration(unittest.TestCase):
 def test_candidate_staging_rewrites_every_host_copy_and_bind_but_no_container_paths(self):
  original=''.join("scp input rank:/tmp/patch_fixture.py\n-v '/tmp/patch_fixture.py:/opt/glm53/patch_fixture.py:ro'\n" for _ in range(12))
  value,count=isolated_rank_launcher(original,'/fixture/trial/rank-launch')
  self.assertEqual(count,24);self.assertNotIn('/tmp/',value)
  self.assertEqual(value.count('/opt/glm53/patch_fixture.py:ro'),12)
  with self.assertRaisesRegex(ValueError,'Unexpected'):isolated_rank_launcher(original+'rm /tmp/unrecognized\n','/fixture/trial')
 def test_exact_containers_are_restored_and_candidate_containers_retained(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);recipe=root/'original';recipe.mkdir();(recipe/'.env').write_text('unchanged')
   remote=Remote({'trial_root':str(root),'recipe_root':str(recipe),'trial_id':'test','baseline_image':'old'});remote.backup.mkdir();(remote.backup/'worker-inner.sh').write_bytes(b'original worker launcher')
   store={}
   for rank in [False,True]:
    name='glm53-exl3-worker' if rank else 'glm53-exl3-head';identity='old-rank' if rank else 'old-head'
    row={'Id':identity,'Image':'old','Name':'/'+name+'-original-test','State':{'Running':False},'Config':{'Env':['MAX_MODEL_LEN=400000']},'Mounts':[]};store[identity]=row
    (remote.backup/('rank.json' if rank else 'head.json')).write_text(json.dumps(row))
    candidate='new-rank' if rank else 'new-head';store[candidate]={'Id':candidate,'Image':'new','Name':'/'+name,'State':{'Running':True}}
   commands=[]
   def inspect(rank=False):
    name='/glm53-exl3-worker' if rank else '/glm53-exl3-head'
    return next(row for row in store.values() if row['Name']==name)
   def command(args,**kw):
    commands.append(args)
    if args[:2]==['docker','inspect']:return json.dumps([store[args[2]]]).encode()
    if args[:2]==['docker','stop']:store[args[-1]]['State']['Running']=False
    if args[:2]==['docker','rename']:store[args[2]]['Name']='/'+args[3]
    if args[:2]==['docker','start']:store[args[2]]['State']['Running']=True
    if args[0]=='cat':return b'original worker launcher'
    if args[0]=='python3':self.assertEqual(kw['input'],b'original worker launcher')
    return b''
   remote.command=remote.rank=command;remote.inspect=inspect;remote.baseline_unchanged=lambda:None;remote.wait_idle=lambda **kw:None
   with patch('spark_recipe_remote.socket.create_connection',side_effect=ConnectionRefusedError(61,'refused')):result=remote.restore({'candidate_image':'new','rank_candidate_image':'new'})
   self.assertEqual(result['state'],'verified');self.assertEqual(result['head_container'],'old-head');self.assertEqual(result['rank_container'],'old-rank')
   self.assertEqual(len(store),4);self.assertTrue(store['old-head']['State']['Running']);self.assertFalse(store['new-head']['State']['Running'])
   self.assertFalse(any(command[:2]==['docker','rm'] for command in commands))

if __name__=='__main__':unittest.main()

class CacheProfile(unittest.TestCase):
 def test_preserves_capacity_precision_and_existing_scheduler_knobs(self):
  original={'MAX_MODEL_LEN':'400000','MAX_NUM_SEQS':'2','MAX_NUM_BATCHED_TOKENS':'7168','GPU_MEM_UTIL':'0.85','GLM53_DENSE_FP8':'off','GLM53_KDA_BF16_LARGE_M':'0','GLM53_EXL3_MOE_FAST':'0','DFLASH_TOKENS':'7','GLM53_SPINWAIT_MS':'stock','DEFAULT_MAX_NEW_TOKENS':'65536','GLM53_APC_NO_STORE':'1','GLM53_MIXED_PREFILL_CHUNK':'fair','LOAD_FORMAT':'','EXL3_FAT_BATCHED':'0'}
  result=baseline_cache_settings(original)
  for key,value in original.items():self.assertEqual(result[key],value)
  self.assertEqual(set(result)-set(original),{'GLM53_DRAFT_KV_COMPACT','GLM53_APC_RETENTION_INTERVAL','GLM53_APC_RETENTION_INTERVAL_SWA'})
  self.assertEqual(result['GLM53_APC_RETENTION_INTERVAL'],'14336')
  with self.assertRaisesRegex(ValueError,'pinned'):baseline_cache_settings({**original,'MAX_MODEL_LEN':'262144'})

class CacheHistoryLabels(unittest.TestCase):
 def test_failed_first_cold_request_cannot_relabel_second_history(self):
  with tempfile.TemporaryDirectory() as directory:
   remote=Remote({'trial_root':directory,'recipe_root':directory,'trial_id':'fixture'})
   remote.prompt=lambda count,nonce:([{'role':'user','content':nonce}],count)
   remote.metrics=lambda:{}
   def chat(messages,**kwargs):
    content=messages[0]['content']
    if content.endswith('-A'):raise RuntimeError('first history failed')
    return {'finish_reason':'stop','usage':{'prompt_tokens':399935},'cached_tokens':131000},{'role':'assistant','content':'7319'}
   remote.chat=chat
   rows=remote.checks('A',400000);labels=[row['label'] for row in rows]
   self.assertIn('append-B',labels);self.assertNotIn('append-A',labels);self.assertNotIn('edit-90-percent',labels)
