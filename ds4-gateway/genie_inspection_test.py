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
 def test_failed_artifact_receipt_identifies_requested_reference_without_untrusted_fields(self):
  self.register()
  self.call('read_server_artifact',{'worker_id':'example','artifact':'recreation_capture','record_kind':'observed'})
  for _,data in self.events:
   event=data['event'];self.assertEqual(event['artifact'],'recreation_capture');self.assertEqual(event['record_kind'],'observed')
  self.assertEqual(self.events[-1][1]['event']['state'],'failed')
  self.events.clear()
  self.call('read_server_artifact',{'worker_id':'example','artifact':'PRIVATE_INPUT','record_kind':'PRIVATE_KIND'})
  self.assertNotIn('PRIVATE_',json.dumps(self.events));self.assertEqual(self.events[-1][1]['event']['state'],'failed')
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
 def test_artifact_hash_and_boundaries(self):
  (self.root/'proposed').mkdir();(self.root/'artifacts').mkdir();file=self.root/'artifacts/manifest.json'
  file.write_text(json.dumps({'model_revision':'public-revision','api_key':'PRIVATE_SECRET','environment':['API_KEY=PRIVATE_ENV','VISIBLE=ok']}));digest=m.hashlib.sha256(file.read_bytes()).hexdigest()
  record={'schema':1,'worker_id':'example','kind':'proposed','configuration':{'baseline_reconciliation':{'path':str(file),'sha256':digest}}};record_file=self.root/'proposed/example.json';record_file.write_text(json.dumps(record));self.register()
  result=self.call('read_server_artifact',{'worker_id':'example','artifact':'baseline_reconciliation'});self.assertTrue(result['hash_matches_record']);self.assertEqual(result['content']['model_revision'],'public-revision');self.assertNotIn('PRIVATE_',json.dumps(result));self.assertIn('VISIBLE=ok',json.dumps(result))
  file.write_text('{"model_revision":"changed"}');self.assertIn('error',self.call('read_server_artifact',{'worker_id':'example','artifact':'baseline_reconciliation'}));self.assertEqual(file.read_text(),'{"model_revision":"changed"}')
  external=self.root/'outside.json';external.write_text('{}');record['configuration']['baseline_reconciliation']={'path':str(external),'sha256':m.hashlib.sha256(external.read_bytes()).hexdigest()};record_file.write_text(json.dumps(record));self.assertIn('error',self.call('read_server_artifact',{'worker_id':'example','artifact':'baseline_reconciliation'}))
  file.unlink();file.symlink_to(external);record['configuration']['baseline_reconciliation']['path']=str(file);record_file.write_text(json.dumps(record));self.assertIn('error',self.call('read_server_artifact',{'worker_id':'example','artifact':'baseline_reconciliation'}))
class Collector(unittest.TestCase):
 def collect(self, mode='ok'):
  import io,contextlib,copy
  c={'Id':'exact-container-id','Image':'image-id','State':{'Running':True,'StartedAt':'before'},'Config':{'Cmd':[],'Env':[]},'Mounts':[],'HostConfig':{}}
  calls=[]
  def run(argv,**kwargs):
   calls.append(argv)
   if argv[:3]==('docker','image','inspect'):return json.dumps([{'Id':'image-id','Created':'dated','RepoDigests':['example.invalid/image@sha256:'+'a'*64]}])
   if argv[:2]==('docker','exec'):
    self.assertEqual(argv[2:6],('exact-container-id','python3','-B','-c'))
    self.assertIn('importlib.metadata',argv[6]);self.assertNotIn('import torch',argv[6])
    if mode=='failed':raise subprocess.TimeoutExpired(argv,20)
    return json.dumps({'vllm':{'status':'installed','version':'0.29.0'},'torch':{'status':'installed','version':'2.13.0+cu130'},'transformers':{'status':'not_found'}})
   value=copy.deepcopy(c)
   if len(calls)>3 and mode=='changed':value['State']['StartedAt']='after'
   return json.dumps([value])
  import subprocess
  output=io.StringIO()
  with patch('subprocess.check_output',side_effect=run),patch('sys.stdin',io.StringIO(json.dumps({'container':'mutable-name'}))),contextlib.redirect_stdout(output):exec(compile(m.COLLECTOR,'collector','exec'),{})
  return json.loads(output.getvalue()),calls
 def test_queries_exact_container_packages_separate_from_image_labels(self):
  result,calls=self.collect();self.assertEqual(result['packages']['status'],'queried');self.assertEqual(result['packages']['values']['transformers']['status'],'not_found');self.assertEqual(result['packages']['values']['vllm']['version'],'0.29.0');self.assertEqual(len(result['image']['repo_digests']),1);self.assertEqual(calls[-1][-1],'exact-container-id')
 def test_package_failure_preserves_other_metadata_without_raw_errors(self):
  result,calls=self.collect('failed');self.assertEqual(result['packages'],{'status':'unavailable','reason':'package_query_failed'});self.assertEqual(result['container']['id'],'exact-container-id');self.assertNotIn('TimeoutExpired',json.dumps(result));self.assertEqual(len(calls),3)
 def test_restart_during_query_is_not_current_package_evidence(self):
  result,calls=self.collect('changed');self.assertEqual(result['packages'],{'status':'unavailable','reason':'container_changed_during_query'});self.assertNotIn('values',result['packages'])
if __name__=='__main__':unittest.main()
