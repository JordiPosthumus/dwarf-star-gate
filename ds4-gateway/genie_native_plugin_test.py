import importlib.util,json,pathlib,tempfile,threading,unittest
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
spec=importlib.util.spec_from_file_location('native_plugin',pathlib.Path(__file__).with_name('genie_native_plugin.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class NativePlugin(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.home=pathlib.Path(self.temp.name)
  self.token='first-private-fixture-token';self.enabled=True;self.calls=[]
  outer=self
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
    if self.path=='/api/genie/native-tools':
     if self.headers.get('X-SG-Native-Tool')!=outer.token:self.send_error(403);return
     payload={'schema':1,'context':{'servers':[],'genie_capabilities':{'fleet_power':outer.enabled}},'tools':{'power':{'url':outer.origin+'/api/genie/power-tools','token':outer.token}},'enabled_sections':['power'] if outer.enabled else []}
    elif self.path=='/api/genie/power-tools':
     if self.headers.get('X-SG-Power-Tool')!=outer.token:self.send_error(403);return
     outer.calls.append(body);payload={'action_id':body.get('action_id'),'receipt':{'state':'complete','ok':False,'verified':{'state':'timeout'}}}
    else:self.send_error(404);return
    self.send_response(200);self.end_headers();self.wfile.write(json.dumps(payload).encode())
  self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=self.server.serve_forever,daemon=True).start();self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
  self.origin='http://127.0.0.1:'+str(self.server.server_port);self.file=self.home/'bridge.json';self.write_descriptor()
  class Context:
   def __init__(self):self.tools={};self.prompts={};self.hooks={};self.state=SimpleNamespace(data_dir=outer.home)
   def get_config(self,key,default=None):return {'module_directory':str(pathlib.Path(__file__).parent),'bridge_descriptor':str(outer.file)}.get(key,default)
   def register_tool(self,**entry):self.tools[entry['name']]=entry
   def register_system_prompt_section(self,id,content,**kwargs):self.prompts[id]=content
   def register_hook(self,name,callback):self.hooks[name]=callback
  self.ctx=Context()
 def write_descriptor(self):
  self.file.write_text(json.dumps({'url':self.origin+'/api/genie/native-tools','token':self.token}));self.file.chmod(0o600)
 def test_native_plugin_uses_existing_tools_and_refreshes_tokens_after_restart(self):
  m.register(self.ctx);self.assertIn('fleet_power_status',self.ctx.tools);self.assertIn('stargate_status',self.ctx.tools)
  self.token='rotated-private-fixture-token';self.write_descriptor()
  result=json.loads(self.ctx.tools['fleet_power_status']['handler']({'action_id':'12345678-1234-4234-8234-123456789012'}))
  self.assertEqual(result['receipt']['verified']['state'],'timeout');self.assertEqual(self.calls,[{'action':'status','action_id':'12345678-1234-4234-8234-123456789012'}])
  self.assertNotIn(self.token,json.dumps(result));self.assertEqual(len(self.ctx.prompts),1)
 def test_capability_change_does_not_execute_stale_registered_handler(self):
  m.register(self.ctx);self.enabled=False
  result=json.loads(self.ctx.tools['fleet_power_status']['handler']({}));self.assertIn('unavailable',result['error']);self.assertEqual(self.calls,[])
  context=json.loads(self.ctx.tools['stargate_status']['handler']({}));self.assertFalse(context['genie_capabilities']['fleet_power'])
 def test_missing_bridge_returns_uncertainty_and_never_replays(self):
  m.register(self.ctx);self.file.unlink()
  result=json.loads(self.ctx.tools['fleet_power']['handler']({'worker':'fixture','power_action':'start','action_id':'12345678-1234-4234-8234-123456789012'}));self.assertIn('could not be confirmed',result['error']);self.assertEqual(self.calls,[])
 def test_descriptor_rejects_shared_file_and_nonlocal_endpoint(self):
  self.file.chmod(0o644)
  with self.assertRaises(ValueError):m.read_descriptor(self.file)
  self.write_descriptor();self.file.write_text(json.dumps({'url':'https://example.invalid/api/genie/native-tools','token':self.token}))
  with self.assertRaises(ValueError):m.read_descriptor(self.file)

if __name__=='__main__':unittest.main()
