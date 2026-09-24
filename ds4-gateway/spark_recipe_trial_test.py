import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from spark_recipe_remote import Remote

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
  self.remote.launch=lambda *args:(_ for _ in ()).throw(RuntimeError('candidate failed to load'))
  self.remote.restore=lambda prepared:(self.events.append('restore') or {'state':'verified'})
  self.remote.checks=lambda phase,limit:(self.events.append(phase) or [{'label':'arithmetic','passed':True},{'label':'tool_call_and_followup','passed':True}])
 def test_failed_candidate_launch_still_restores_original_and_checks_it(self):
  result=self.remote.run();self.assertEqual(result['state'],'complete');self.assertIn('failed to load',result['error'])
  self.assertLess(self.events.index('A'),self.events.index('suspend'));self.assertLess(self.events.index('restore'),self.events.index('A2'))
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
