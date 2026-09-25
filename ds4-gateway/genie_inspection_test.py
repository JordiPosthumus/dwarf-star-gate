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
 def test_local_omlx_uses_same_tool_and_saved_event_without_ssh_or_selected_image_actions(self):
  target={'kind':'omlx-local','root':str(self.root),'url':'http://127.0.0.1:8013/v1'};self.register({'example':target})
  with patch.object(m,'inspect_omlx',return_value={'runtime':'omlx','scope':'Read only'}) as local,patch.object(m.subprocess,'run') as ssh:
   result=self.call('inspect_server',{'worker_id':'example'});self.assertEqual(result['runtime'],'omlx');local.assert_called_once_with(target,source_files=None,source_window=None);ssh.assert_not_called()
   self.assertEqual(self.events[-1][1]['event']['state'],'complete');self.assertEqual(self.events[-1][1]['event']['result'],result)
   self.assertIn('error',self.call('inspect_server',{'worker_id':'example','selected_default':True}));self.assertEqual(local.call_count,1)
 def test_enrolled_non_routable_rank_can_be_inspected_but_unknown_target_cannot(self):
  self.register({'example-rank1':{'ssh':['rank-host'],'container':'worker-engine'}})
  with patch.object(m.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout='{"runtime":"docker"}',stderr='')) as run:
   result=self.call('inspect_server',{'worker_id':'example-rank1'});self.assertEqual(result['runtime'],'docker');self.assertEqual(run.call_count,1)
   self.assertIn('error',self.call('inspect_server',{'worker_id':'unenrolled-rank'}));self.assertEqual(run.call_count,1)
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
 def test_source_files_reach_fixed_collector_and_existing_receipts(self):
  self.register({'example':{'ssh':['example-host'],'container':'example-engine'}})
  sources={'status':'read','files':[{'path':'vllm/example.py','status':'read','text':'value = 1','sha256':'c'*64}]}
  with patch.object(m.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout=json.dumps({'sources':sources}),stderr='')) as run:
   result=self.call('inspect_server',{'worker_id':'example','source_files':['vllm/example.py']})
   self.assertEqual(result['sources'],sources)
   self.assertEqual(json.loads(run.call_args.kwargs['input'].split('\n',1)[0])['source_files'],['vllm/example.py'])
   self.assertIn('c'*64,self.context['inspection_private_values'])
   self.assertEqual(self.events[-1][1]['event']['result'],result)
  for extra in [{'source_files':['vllm/../secret.py']},{'source_files':['vllm/example.py'],'selected_default':True}]:
   with patch.object(m.subprocess,'run') as run:
    self.assertIn('error',self.call('inspect_server',{'worker_id':'example',**extra}));run.assert_not_called()
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
 def test_selected_default_and_receipt_are_read_without_other_workers_or_secrets(self):
  (self.root/'defaults').mkdir();(self.root/'artifacts').mkdir();receipt=self.root/'artifacts/selection.json';receipt.write_text(json.dumps({'run_key':'selected-run','recorded_build':{'context_limit':262144},'api_key':'PRIVATE_SECRET'}))
  ref={'path':'artifacts/selection.json','sha256':m.hashlib.sha256(receipt.read_bytes()).hexdigest()}
  record={'schema':1,'workers':['example'],'selected_image':'sha256:'+'a'*64,'selection_receipt_reference':ref}
  (self.root/'defaults/shared.json').write_text(json.dumps(record));(self.root/'defaults/other.json').write_text(json.dumps({'schema':1,'workers':['other'],'private_note':'OTHER_WORKER'}));self.register()
  result=self.call('read_server_configuration',{'worker_id':'example'});selected=result['selected_defaults']['entries'];self.assertEqual(len(selected),1);self.assertEqual(selected[0]['selection_receipt']['status'],'verified');self.assertEqual(selected[0]['selection_receipt']['content']['run_key'],'selected-run');self.assertNotIn('PRIVATE_SECRET',json.dumps(result));self.assertNotIn('OTHER_WORKER',json.dumps(result))
  receipt.write_text('{}');result=self.call('read_server_configuration',{'worker_id':'example'});self.assertEqual(result['selected_defaults']['entries'][0]['selection_receipt']['status'],'unavailable');self.assertIn('records',result)
  receipt.unlink();receipt.symlink_to(self.root/'defaults/other.json');self.assertEqual(self.call('read_server_configuration',{'worker_id':'example'})['selected_defaults']['entries'][0]['selection_receipt']['status'],'unavailable')
 def test_restoration_receipt_uses_exact_record_reference_and_retains_evidence(self):
  (self.root/'approved').mkdir();(self.root/'artifacts').mkdir();file=self.root/'artifacts/restore.json';file.write_text(json.dumps({'state':'restored','checks':['cold-to-warm cache'],'api_key':'PRIVATE_SECRET'}))
  ref={'path':'artifacts/restore.json','sha256':m.hashlib.sha256(file.read_bytes()).hexdigest()}
  record={'schema':1,'worker_id':'example','kind':'approved','restoration':{'drill':{'receipt_reference':ref}}}
  (self.root/'approved/example.json').write_text(json.dumps(record));self.register()
  result=self.call('read_server_artifact',{'worker_id':'example','artifact':'restoration_drill','record_kind':'approved'})
  self.assertTrue(result['hash_matches_record']);self.assertEqual(result['content']['checks'],['cold-to-warm cache']);self.assertNotIn('PRIVATE_SECRET',json.dumps(result))
  event=self.events[-1][1]['event'];self.assertEqual(event['artifact'],'restoration_drill');self.assertEqual(event['record_kind'],'approved');self.assertEqual(event['result'],result)
  self.assertIn('do not independently prove',result['scope']);self.assertIn('restoration_drill',self.registry.tools['read_server_artifact']['schema']['parameters']['properties']['artifact']['enum'])
  file.write_text('{"state":"changed"}');self.assertIn('error',self.call('read_server_artifact',{'worker_id':'example','artifact':'restoration_drill','record_kind':'approved'}));self.assertEqual(file.read_text(),'{"state":"changed"}')
 def test_serving_flags_proof_is_read_from_its_own_hashed_reference(self):
  (self.root/'approved').mkdir();(self.root/'artifacts').mkdir();file=self.root/'artifacts/enrollment.json';file.write_text('{"state":"restored-in-drill","scope":"serving flags only"}')
  ref={'path':'artifacts/enrollment.json','sha256':m.hashlib.sha256(file.read_bytes()).hexdigest()}
  record={'schema':1,'worker_id':'example','kind':'approved','restoration':{'change_classes':{'serving_flags':{'drill_reference':ref}}}}
  (self.root/'approved/example.json').write_text(json.dumps(record));self.register()
  result=self.call('read_server_artifact',{'worker_id':'example','artifact':'serving_flags_restoration','record_kind':'approved'})
  self.assertTrue(result['hash_matches_record']);self.assertEqual(result['content']['scope'],'serving flags only')
  file.write_text('{}');self.assertIn('error',self.call('read_server_artifact',{'worker_id':'example','artifact':'serving_flags_restoration','record_kind':'approved'}))
 def test_restoration_status_or_unhashed_path_does_not_substitute_for_receipt(self):
  (self.root/'approved').mkdir();(self.root/'artifacts').mkdir();file=self.root/'artifacts/restore.json';file.write_text('{"state":"must-not-be-read"}')
  record={'schema':1,'worker_id':'example','kind':'approved','restoration':{'drill':{'status':'restored-in-drill','receipt':str(file)}}}
  record_file=self.root/'approved/example.json';record_file.write_text(json.dumps(record));self.register()
  self.assertIn('error',self.call('read_server_artifact',{'worker_id':'example','artifact':'restoration_drill','record_kind':'approved'}))
  record['restoration']['drill']['receipt_reference']={'path':str(file)};record_file.write_text(json.dumps(record));self.assertIn('error',self.call('read_server_artifact',{'worker_id':'example','artifact':'restoration_drill','record_kind':'approved'}))
 def test_selected_image_comes_only_from_unique_library_default(self):
  (self.root/'defaults').mkdir();record={'schema':1,'workers':['example'],'selected_image':'sha256:'+'a'*64};(self.root/'defaults/shared.json').write_text(json.dumps(record));self.register({'example':{'ssh':['example-host'],'container':'live-container'}})
  with patch.object(m.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout=json.dumps({'selected_image':record['selected_image'],'image_present':True,'retained_containers':[]}),stderr='')) as run:
   result=self.call('inspect_server',{'worker_id':'example','selected_default':True,'selected_image':'sha256:'+'b'*64});self.assertEqual(result['selected_image'],record['selected_image']);payload=json.loads(run.call_args.kwargs['input'].split('\n',1)[0]);self.assertEqual(payload,{'selected_image':record['selected_image']});self.assertTrue(self.events[-1][1]['event']['selected_default'])
  (self.root/'defaults/second.json').write_text(json.dumps(record))
  with patch.object(m.subprocess,'run') as run:self.assertIn('error',self.call('inspect_server',{'worker_id':'example','selected_default':True}));run.assert_not_called()
  (self.root/'defaults/second.json').unlink();record['selected_image']='--bad; command';(self.root/'defaults/shared.json').write_text(json.dumps(record))
  with patch.object(m.subprocess,'run') as run:self.assertIn('error',self.call('inspect_server',{'worker_id':'example','selected_default':True}));run.assert_not_called()
class EvidenceNavigation(unittest.TestCase):
 register=Inspection.register
 call=Inspection.call
 def setUp(self):
  Inspection.setUp(self)
  (self.root/'approved').mkdir();(self.root/'artifacts').mkdir()
  self.child=self.root/'artifacts/tool.json';self.child.write_text(json.dumps({'choices':[{'message':{'tool_calls':[{'function':{'name':'report_value','arguments':'{"value":7319}'}}]}}],'api_key':'PRIVATE_SECRET'}))
  self.child_ref={'path':'artifacts/tool.json','sha256':m.hashlib.sha256(self.child.read_bytes()).hexdigest()}
  self.parent=self.root/'artifacts/proof.json';self.parent.write_text(json.dumps({'validation_reference':self.child_ref,'nested/list~':[self.child_ref]}))
  self.parent_ref={'path':'artifacts/proof.json','sha256':m.hashlib.sha256(self.parent.read_bytes()).hexdigest()}
  self.record={'schema':1,'worker_id':'example','kind':'approved','evidence':[self.parent_ref],'restoration':{'change_classes':{'serving_flags':{'drill_reference':self.parent_ref}}}}
  self.record_file=self.root/'approved/example.json';self.record_file.write_text(json.dumps(self.record));self.register()
 def read_chain(self,chain,**extra):return self.call('read_server_artifact',{'worker_id':'example','record_kind':'approved','reference_chain':chain,**extra})
 def test_named_artifact_follows_nested_reference_and_records_the_complete_provenance(self):
  result=self.read_chain(['/validation_reference'],artifact='serving_flags_restoration')
  self.assertEqual(result['sha256'],self.child_ref['sha256']);self.assertEqual(len(result['verified_references']),2)
  self.assertEqual(result['content']['choices'][0]['message']['tool_calls'][0]['function']['name'],'report_value')
  self.assertNotIn('PRIVATE_SECRET',json.dumps(result));self.assertEqual(self.events[-1][1]['event']['result'],result)
 def test_record_array_and_escaped_pointer_keys_need_no_new_artifact_enum(self):
  result=self.read_chain(['/evidence/0','/nested~1list~0/0'])
  self.assertTrue(result['hash_matches_record']);self.assertEqual(result['sha256'],self.child_ref['sha256'])
  self.assertIsNone(result['artifact']);self.assertEqual(result['verified_references'][0]['pointer'],'/evidence/0')
 def test_changed_parent_is_rejected_before_child_is_opened(self):
  self.parent.write_text('{}')
  with patch.object(m,'read_json',wraps=m.read_json) as reads:
   self.assertIn('error',self.read_chain(['/evidence/0','/validation_reference']))
   self.assertNotIn(self.child,[call.args[0] for call in reads.call_args_list])
  self.assertEqual(self.parent.read_text(),'{}')
 def test_changed_child_is_rejected_without_rewriting_either_document(self):
  self.child.write_text('{"changed":true}')
  self.assertIn('error',self.read_chain(['/evidence/0','/validation_reference']))
  self.assertEqual(self.child.read_text(),'{"changed":true}')
 def test_unknown_unhashed_malformed_and_excessive_chains_fail(self):
  for chain in [[],['/evidence/-1'],['/evidence/00'],['/evidence/0','/missing'],['/evidence'],['/evidence/0','/nested~2list'],['/evidence/0']*9,'/evidence/0',[None]]:
   with self.subTest(chain=chain):self.assertIn('error',self.read_chain(chain))
  self.record['evidence'][0].pop('sha256');self.record_file.write_text(json.dumps(self.record))
  self.assertIn('error',self.read_chain(['/evidence/0']))
 def test_nested_symlink_and_library_escape_are_rejected(self):
  self.child.unlink();self.child.symlink_to(self.parent)
  self.assertIn('error',self.read_chain(['/evidence/0','/validation_reference']))
  for path in ['../outside.json','artifacts/../../outside.json','/tmp/outside.json']:
   self.record['evidence']=[{'path':path,'sha256':'a'*64}];self.record_file.write_text(json.dumps(self.record))
   self.assertIn('error',self.read_chain(['/evidence/0']))

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
class SelectedCollector(unittest.TestCase):
 def collect(self,mode='present'):
  import io,contextlib
  image_id='sha256:'+'a'*64;ids=['b'*64,'c'*64];calls=[]
  image={'Id':image_id,'Created':'image-created','RepoTags':['example:selected'],'Config':{'Env':['API_KEY=PRIVATE_SECRET','VISIBLE=yes']}}
  def inspected(argv,**kwargs):
   calls.append(argv);self.assertEqual(argv,['docker','image','inspect','--',image_id])
   if mode=='absent':return types.SimpleNamespace(returncode=1,stdout='[]',stderr='Error response from daemon: No such image: '+image_id)
   if mode=='failed':return types.SimpleNamespace(returncode=1,stdout='',stderr='Permission denied')
   return types.SimpleNamespace(returncode=0,stdout=json.dumps([image]),stderr='')
  def read(argv,**kwargs):
   calls.append(argv)
   if argv[1]=='ps':return '\n'.join(ids)
   self.assertEqual(argv[:5],('docker','inspect','--type','container','--'))
   base={'Name':'retained','Created':'container-created','State':{'Running':False,'StartedAt':'historical'},'Config':{'Cmd':['--api-key','PRIVATE_ARG','--max-model-len','262144']},'HostConfig':{'IpcMode':'host','ShmSize':17179869184},'Mounts':[{'Destination':'/models','RW':False}]}
   return json.dumps([{**base,'Id':ids[0],'Image':image_id},{**base,'Id':ids[1],'Image':'sha256:'+'d'*64}])
  output=io.StringIO()
  with patch('subprocess.run',side_effect=inspected),patch('subprocess.check_output',side_effect=read),patch('sys.stdin',io.StringIO(json.dumps({'selected_image':image_id}))),contextlib.redirect_stdout(output):
   try:exec(compile(m.COLLECTOR,'selected-collector','exec'),{})
   except SystemExit as e:self.assertEqual(e.code,0)
  return json.loads(output.getvalue()),calls
 def test_exact_image_and_retained_recipe_without_descendant_or_mutation(self):
  result,calls=self.collect();self.assertTrue(result['image_present']);self.assertTrue(result['retained_containers_checked']);self.assertEqual(len(result['retained_containers']),1);self.assertFalse(result['retained_containers'][0]['running']);self.assertEqual(result['retained_containers'][0]['host_config']['ShmSize'],17179869184);self.assertNotIn('PRIVATE_',json.dumps(result));self.assertTrue(all(c[1] in ['image','ps','inspect'] for c in calls))
 def test_absent_is_distinct_from_daemon_failure(self):
  result,calls=self.collect('absent');self.assertFalse(result['image_present']);self.assertFalse(result['retained_containers_checked']);self.assertIn('were not queried',result['scope']);self.assertEqual(len(calls),1)
  with self.assertRaisesRegex(ValueError,'unavailable'):self.collect('failed')
class ModelConfiguration(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name)
  self.file=self.root/'config.json'
  self.file.write_text(json.dumps({'architectures':['ActualModelForCausalLM'],'model_type':'actual_model','text_config':{'model_type':'actual_text','head_dim':128,'num_hidden_layers':48,'token':'PRIVATE_TOKEN'},'quantization_config':{'quant_method':'modelopt','bits':4},'auto_map':{'AutoConfig':'must_not_import.Config'},'_name_or_path':'PRIVATE_REPO','api_key':'PRIVATE_KEY'}))
  (self.root/'must_not_import.py').write_text('raise RuntimeError("Model code must not run")')
 def query(self,cmd=None,entry=None):
  import subprocess
  return subprocess.run([sys.executable,'-I','-B','-c',m.MODEL_CONFIG_QUERY,json.dumps({'Cmd':cmd or [str(self.root)],'Entrypoint':entry or ['vllm','serve']})],capture_output=True,text=True)
 def test_reads_real_json_without_loading_model_code_or_private_fields(self):
  r=self.query();self.assertEqual(r.returncode,0,r.stderr);data=json.loads(r.stdout)
  self.assertEqual(data['sha256'],m.hashlib.sha256(self.file.read_bytes()).hexdigest());self.assertEqual(data['values']['architectures'],['ActualModelForCausalLM']);self.assertEqual(data['values']['text_config'],{'model_type':'actual_text','head_dim':128,'num_hidden_layers':48});self.assertNotIn('PRIVATE_',r.stdout);self.assertNotIn('auto_map',r.stdout)
 def test_uses_explicit_config_override_and_supported_launch_forms(self):
  other=self.root/'override';other.mkdir();(other/'config.json').write_text('{"model_type":"override"}')
  r=self.query([str(self.root),'--hf-config-path',str(other)]);self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(json.loads(r.stdout)['values']['model_type'],'override');self.assertTrue(json.loads(r.stdout)['hf_config_path_override'])
  for cmd,entry in [(['serve',str(self.root)],['vllm']),(['--model='+str(self.root)],['vllm','serve'])]:
   r=self.query(cmd,entry);self.assertEqual(r.returncode,0,r.stderr)
 def test_does_not_resolve_remote_or_ambiguous_model_locations(self):
  for cmd,entry in [(['public/model'],None),([str(self.root),'--model',str(self.root)],None),([str(self.root),'--hf-config-path',str(self.root),'--hf-config-path',str(self.root)],None),([str(self.root)],['sh','-c'])]:
   with self.subTest(cmd=cmd,entry=entry):self.assertNotEqual(self.query(cmd,entry).returncode,0)
 def test_preserves_bad_files_and_rejects_symlink(self):
  self.file.write_text('invalid-json');self.assertNotEqual(self.query().returncode,0);self.assertEqual(self.file.read_text(),'invalid-json')
  self.file.unlink();self.file.symlink_to(self.root/'must_not_import.py');self.assertNotEqual(self.query().returncode,0);self.assertTrue(self.file.is_symlink())
 def collect(self,changed=False,failed=False,runtime_failed=False,logs='selection',cache_failed=False):
  import io,contextlib,copy,subprocess
  c={'Id':'exact-container-id','Image':'image-id','State':{'Running':True,'StartedAt':'2026-01-01T00:00:00Z'},'Config':{'Cmd':[str(self.root)],'Entrypoint':['vllm','serve'],'Env':[]},'Mounts':[],'HostConfig':{}}
  model_read=False;calls=[]
  def run(argv,**kwargs):
   nonlocal model_read
   calls.append(argv)
   if argv[:3]==('docker','image','inspect'):return json.dumps([{'Id':'image-id','Created':'dated'}])
   if argv[:2]==('docker','exec'):
    self.assertEqual(argv[2:6],('exact-container-id','python3','-B','-c'))
    if argv[6]==m.CACHE_QUERY:
     self.assertEqual(json.loads(argv[7]),[str(self.root)])
     if cache_failed:raise subprocess.TimeoutExpired(argv,20)
     return json.dumps({'state':'observed','kv_cache_size_tokens':500123})
    if argv[6]==m.RUNTIME_QUERY:
     if runtime_failed:raise subprocess.TimeoutExpired(argv,20)
     return json.dumps({'gpus':{'status':'observed','devices':[{'name':'Example GPU','compute_capability':'12.1','driver_version':'580.1'}]},'flashinfer':{'status':'installed','version':'0.6.18'}})
    if argv[6]==m.MODEL_CONFIG_QUERY:
     model_read=True
     if failed:raise subprocess.TimeoutExpired(argv,20)
     r=self.query();self.assertEqual(r.returncode,0);return r.stdout
    return json.dumps({k:{'status':'not_found'} for k in ['vllm','torch','transformers']})
   value=copy.deepcopy(c)
   if changed and model_read:value['State']['StartedAt']='after'
   return json.dumps([value])
  output=io.StringIO()
  original_run=subprocess.run
  def logged(argv,**kw):
   if argv[0]!='docker':return original_run(argv,**kw)
   self.assertEqual(argv,['docker','logs','--timestamps','--since','2026-01-01T00:00:00Z','--until','2026-01-01T00:30:00+00:00','--tail','10000','exact-container-id'])
   if logs=='failed':raise subprocess.TimeoutExpired(argv,20)
   text='PRIVATE_PROMPT PRIVATE_TOKEN\n'
   if logs=='selection':text+='2026-01-01T00:00:00Z INFO [qwen_gdn_linear_attn.py:190] Using Triton/FLA GDN prefill kernel (requested=auto, head_k_dim=128)\n'
   return types.SimpleNamespace(returncode=0,stdout='',stderr=text)
  with patch('subprocess.check_output',side_effect=run),patch('subprocess.run',side_effect=logged),patch('sys.stdin',io.StringIO(json.dumps({'container':'enrolled-name'}))),contextlib.redirect_stdout(output):exec(compile(m.COLLECTOR,'collector','exec'),{})
  return json.loads(output.getvalue()),calls
 def test_collector_observes_exact_container_and_keeps_other_metadata_on_failure(self):
  result,calls=self.collect();self.assertEqual(result['model_config']['values']['architectures'],['ActualModelForCausalLM']);self.assertTrue(all(c[1] in ['image','inspect','exec'] for c in calls));self.assertNotIn('PRIVATE_',json.dumps(result))
  for options in [{'changed':True},{'failed':True}]:
   result,_=self.collect(**options);self.assertEqual(result['model_config'],{'status':'unavailable','reason':'model_config_read_failed'});self.assertEqual(result['container']['id'],'exact-container-id');self.assertEqual(result['packages']['status'],'queried')
 def test_runtime_returns_structured_current_start_selection_without_raw_logs(self):
  result,_=self.collect();runtime=result['engine_runtime'];self.assertEqual(runtime['device_and_package']['gpus']['devices'][0]['compute_capability'],'12.1');self.assertEqual(runtime['gdn_prefill_log']['selections'],[{'backend':'Triton/FLA','requested':'auto','head_k_dim':128}]);self.assertEqual(runtime['gdn_prefill_log']['container_started_at'],'2026-01-01T00:00:00Z');self.assertNotIn('PRIVATE_',json.dumps(result))
 def test_missing_logs_or_device_do_not_invent_a_backend_or_hide_model_config(self):
  result,_=self.collect(runtime_failed=True,logs='empty');self.assertEqual(result['engine_runtime']['device_and_package']['status'],'unavailable');self.assertEqual(result['engine_runtime']['gdn_prefill_log']['status'],'not_found_in_tail');self.assertEqual(result['engine_runtime']['gdn_prefill_log']['selections'],[]);self.assertEqual(result['model_config']['status'],'read')
  result,_=self.collect(logs='failed');self.assertEqual(result['engine_runtime']['gdn_prefill_log']['status'],'unavailable');self.assertEqual(result['model_config']['status'],'read')
  result,_=self.collect(changed=True);self.assertEqual(result['engine_runtime']['status'],'unavailable')
 def test_cache_read_is_bound_to_start_and_failure_does_not_hide_other_inspection(self):
  result,_=self.collect();cache=result['engine_runtime']['cache_capacity']
  self.assertEqual(cache['kv_cache_size_tokens'],500123);self.assertEqual(cache['container_started_at'],'2026-01-01T00:00:00Z')
  result,_=self.collect(cache_failed=True);self.assertEqual(result['engine_runtime']['cache_capacity']['state'],'unavailable');self.assertEqual(result['model_config']['status'],'read')

class CacheMetricsQuery(unittest.TestCase):
 def setUp(self):
  import http.server,threading
  self.requests=[];self.mode='normal'
  owner=self
  class Handler(http.server.BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_GET(self):
    owner.requests.append(self.path)
    if owner.mode=='redirect':
     self.send_response(302);self.send_header('Location','/must-not-fetch');self.end_headers();return
    if owner.mode=='denied':self.send_response(401);self.end_headers();return
    raw=b'vllm:cache_config_info{engine="0",kv_cache_size_tokens="500123",num_gpu_blocks="340",secret="PRIVATE_VALUE"} 1.0\n'
    if owner.mode=='duplicate':raw+=raw
    if owner.mode=='large':raw=b'x'*4194305
    self.send_response(200);self.end_headers();self.wfile.write(raw)
  self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
  thread=threading.Thread(target=self.server.serve_forever,daemon=True);thread.start()
  self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
 def query(self,flags=None):
  import subprocess,os
  flags=flags if flags is not None else ['model','--port',str(self.server.server_port)]
  result=subprocess.run([sys.executable,'-B','-c',m.CACHE_QUERY,json.dumps(flags)],capture_output=True,text=True,check=True,env={**os.environ,'HTTP_PROXY':'http://127.0.0.1:1','NO_PROXY':''})
  return json.loads(result.stdout)
 def test_reads_explicit_tokens_without_private_labels_or_proxy(self):
  result=self.query();self.assertEqual(result['kv_cache_size_tokens'],500123);self.assertEqual(self.requests,['/metrics']);self.assertNotIn('PRIVATE_VALUE',json.dumps(result));self.assertIn('observed_at',result)
 def test_redirect_auth_failure_and_ambiguous_metrics_stay_unavailable(self):
  for mode in ['redirect','denied','duplicate','large']:
   self.mode=mode;self.requests.clear();self.assertEqual(self.query()['state'],'unavailable');self.assertEqual(self.requests,['/metrics'])
 def test_ambiguous_or_invalid_port_never_fetches(self):
  for flags in [['--port','5','--port=6'],['--port','65536'],['--port','http://example'],['--port']]:self.assertEqual(self.query(flags)['state'],'unavailable')
  self.assertEqual(self.requests,[])
if __name__=='__main__':unittest.main()

class RecipeInspection(unittest.TestCase):
 def test_enrolled_recipe_is_read_without_execution_and_secrets_are_redacted(self):
  import io,contextlib,hashlib
  with tempfile.TemporaryDirectory() as temporary:
   root=pathlib.Path(temporary);marker=root/'must-not-exist'
   env='MAX_MODEL_LEN=400000\nAPI_KEY=PRIVATE_TEST_VALUE\nSIDE_EFFECT=$(touch '+str(marker)+')\n'
   (root/'.env').write_text(env);(root/'start.sh').write_text('# launcher\n'+'# unchanged\n'*1000)
   container={'Id':'immutable-id','Image':'image-id','State':{'Running':False,'StartedAt':'dated'},'Config':{'Entrypoint':['bash'],'Cmd':['start.sh'],'Env':['MAX_MODEL_LEN=400000']},'HostConfig':{},'Mounts':[]}
   def run(argv,**kwargs):
    argv=tuple(argv)
    if argv[:3]==('docker','image','inspect'):return json.dumps([{'Id':'image-id','Created':'dated','Config':{'Labels':{'glm53.recipe.stamp':'fixture-stamp'}}}])
    if argv[:2]==('docker','inspect'):return json.dumps([container])
    if argv[0]=='git':return 'a'*40+'\n' if argv[-1]=='HEAD' else ''
    raise AssertionError(argv)
   def collect():
    output=io.StringIO()
    with patch('subprocess.check_output',side_effect=run),patch('subprocess.run',return_value=__import__('types').SimpleNamespace(returncode=0,stdout='native fixture failure\n',stderr='API_KEY=PRIVATE_LOG_VALUE\n')),patch('sys.stdin',io.StringIO(json.dumps({'container':'fixture','recipe_root':str(root)}))),contextlib.redirect_stdout(output):exec(compile(m.COLLECTOR,'collector','exec'),{})
    return json.loads(output.getvalue())
   result=collect();recipe=result['recipe']
   self.assertEqual(result['recent_runtime_log']['container'],'immutable-id');self.assertIn('native fixture failure',result['recent_runtime_log']['tail']);self.assertNotIn('PRIVATE_LOG_VALUE',json.dumps(result))
   self.assertEqual(recipe['revision'],'a'*40);self.assertFalse(recipe['tracked_changes'])
   self.assertEqual(result['recipe_stamp'],'fixture-stamp')
   self.assertEqual(recipe['files']['.env']['sha256'],hashlib.sha256(env.encode()).hexdigest())
   self.assertIn('MAX_MODEL_LEN=400000',recipe['files']['.env']['text']);self.assertNotIn('PRIVATE_TEST_VALUE',json.dumps(result))
   self.assertFalse(marker.exists());self.assertTrue(recipe['files']['start.sh']['truncated']);self.assertEqual(len(recipe['files']['start.sh']['text']),6000)
   (root/'.env').unlink();(root/'.env').symlink_to(root/'start.sh')
   self.assertEqual(collect()['recipe']['files']['.env'],{'state':'unavailable'})

class TrialProgress(unittest.TestCase):
 def test_only_current_candidate_fixed_receipts_are_read_and_sensitive_samples_omitted(self):
  with tempfile.TemporaryDirectory() as temp:
   home=pathlib.Path(temp).resolve();trial='12345678-abcd-1234-abcd-123456789012';root=home/'.local/share/dsg-recipe-trials'/trial
   (root/'A').mkdir(parents=True);(root/'candidate').mkdir()
   (root/'A/results.json').write_text(json.dumps([{'label':'cold-A','sample':{'answer':'PRIVATE_ANSWER','metrics_before':{'private':'PRIVATE_METRIC'},'ttft_s':1.5},'passed':True}]))
   (root/'candidate-start.log').write_text('Starting compiler\nAPI_KEY=PRIVATE_KEY\nReady\n')
   mounts=[{'Source':str(root/'candidate/overlay/file.py')}]
   result=m.inspect_trial_progress(str(home/'recipe'),mounts)
   self.assertEqual(result['trial_id'],trial);self.assertEqual(result['phases']['A'][0]['sample']['ttft_s'],1.5);self.assertNotIn('PRIVATE_',json.dumps(result));self.assertIn('Ready',result['candidate_start_tail'])
   self.assertIsNone(m.inspect_trial_progress(str(home/'recipe'),[{'Source':str(home/'arbitrary')}]));self.assertIsNone(m.inspect_trial_progress(None,mounts))
   (root/'prepared.json').write_text(json.dumps({'original_container':'original-id'}));(root/'run-intent.json').write_text('{"started_at":2}')
   self.assertEqual(m.inspect_trial_progress(str(home/'recipe'),[],'original-id')['trial_id'],trial)
   self.assertIsNone(m.inspect_trial_progress(str(home/'recipe'),[],'different-id'))
   old=root.with_name('12345678-abcd-1234-abcd-123456789013');old.mkdir()
   (old/'prepared.json').write_text(json.dumps({'original_container':'original-id'}));(old/'run-intent.json').write_text('{"started_at":1}')
   self.assertEqual(m.inspect_trial_progress(str(home/'recipe'),[],'original-id')['trial_id'],trial)
   (root/'A/results.json').unlink();(root/'A/results.json').symlink_to(root/'candidate-start.log')
   self.assertEqual(m.inspect_trial_progress(str(home/'recipe'),mounts)['phases']['A']['state'],'unavailable')
 def test_ambiguous_candidate_or_traversal_never_selects_a_trial(self):
  base='/srv/example/.local/share/dsg-recipe-trials/'
  self.assertIsNone(m.inspect_trial_progress('/srv/example/recipe',[{'Source':base+'12345678-abcd-1234-abcd-123456789012/candidate/a'},{'Source':base+'12345678-abcd-1234-abcd-123456789013/candidate/b'}]))
  self.assertIsNone(m.inspect_trial_progress('/srv/example/recipe',[{'Source':base+'../candidate/private'}]))
