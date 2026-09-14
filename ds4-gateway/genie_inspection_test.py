import importlib.util,json,pathlib,sys,tempfile,types,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('inspection',pathlib.Path(__file__).with_name('genie_inspection.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Registry:
 def __init__(self):self.tools={}
 def register(self,**kw):self.tools[kw['name']]=kw
class Inspection(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name);self.registry=Registry();self.events=[];self.context={'servers':[{'id':'example'}]}
  self.patch=patch.dict(sys.modules,{'tools.registry':types.SimpleNamespace(registry=self.registry)});self.patch.start();self.addCleanup(self.patch.stop)
 def register(self,workers=None):m.register_inspection({'records_directory':str(self.root),'workers':workers or {}},self.context,lambda k,**v:self.events.append((k,v)))
 def call(self,name,args):return json.loads(self.registry.tools[name]['handler'](args))
 def test_records_missing_distinct_from_unknown_and_no_secret_contents(self):
  (self.root/'observed').mkdir();(self.root/'observed/example.json').write_text(json.dumps({'schema':1,'worker_id':'example','kind':'observed','configuration':{'api_key':'PRIVATE_SECRET','context':262144},'runtime':{'build':'a'*64}}));self.register()
  result=self.call('read_server_configuration',{'worker_id':'example'});self.assertNotIn('PRIVATE_SECRET',json.dumps(result));self.assertEqual(result['records']['observed']['configuration']['context'],262144);self.assertIsNone(result['records']['approved']);self.assertIn('a'*64,self.context['inspection_private_values'])
  self.assertIn('error',self.call('read_server_configuration',{'worker_id':'../../outside'}))
 def test_symlink_record_rejected(self):
  (self.root/'observed').mkdir();(self.root/'sensitive.json').write_text('{"key":"NEVER_READ"}');(self.root/'observed/example.json').symlink_to(self.root/'sensitive.json');self.register();self.assertIn('error',self.call('read_server_configuration',{'worker_id':'example'}))
 def test_fixed_collector_fallback_and_evidence(self):
  self.register({'example':{'ssh':['example-a','example-b'],'container':'example-engine','launcher':'/srv/launch.sh'}})
  replies=[types.SimpleNamespace(returncode=255,stdout='',stderr='private network detail'),types.SimpleNamespace(returncode=0,stdout=json.dumps({'container':{'running':True},'launcher':{'sha256':'b'*64}}),stderr='')]
  with patch.object(m.subprocess,'run',side_effect=replies) as run:
   result=self.call('inspect_server',{'worker_id':'example'});self.assertTrue(result['container']['running']);self.assertEqual(run.call_count,2)
   args,kw=run.call_args;self.assertEqual(args[0][0],'ssh');self.assertNotIn('shell',kw);self.assertIn('docker',kw['input']);self.assertNotIn('restart',kw['input'].split("print(json.dumps")[0]);self.assertIn('b'*64,self.context['inspection_private_values'])
  self.assertEqual(self.events[-1][1]['event']['result'],result)
 def test_missing_target_and_collector_failure_never_fabricate_inspection(self):
  self.register({'example':{'ssh':['example-a','example-b'],'container':'example-engine'}})
  with patch.object(m.subprocess,'run',return_value=types.SimpleNamespace(returncode=1,stdout='',stderr='PRIVATE_FAILURE')) as run:
   result=self.call('inspect_server',{'worker_id':'example'});self.assertIn('error',result);self.assertNotIn('PRIVATE_FAILURE',json.dumps(result));self.assertEqual(run.call_count,1)
 def test_injection_target_cannot_launch_a_command(self):
  self.register({'example':{'ssh':['example-host'],'container':'--privileged; touch /tmp/bad'}})
  with patch.object(m.subprocess,'run') as run:self.assertIn('error',self.call('inspect_server',{'worker_id':'example'}));run.assert_not_called()
if __name__=='__main__':unittest.main()
