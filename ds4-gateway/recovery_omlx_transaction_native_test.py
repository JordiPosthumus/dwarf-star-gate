"""Real disposable macOS HTTP processes and private permit socket; no LLM."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import signal
import socket
from socketserver import UnixStreamServer
from http.server import BaseHTTPRequestHandler
import subprocess
import sys
import tempfile
import threading
import time
import unittest

spec=importlib.util.spec_from_file_location('omlx_transaction',Path(__file__).with_name('recovery_omlx_transaction.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


@unittest.skipUnless(sys.platform=='darwin','macOS native process inspection')
class NativeOmlxTransactionTests(unittest.TestCase):
    def setUp(self):
        # Short socket path also works under macOS's 104-byte sun_path limit.
        tmp=tempfile.TemporaryDirectory(prefix='omlx-tx-',dir='/tmp');self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name);(self.root/'state').mkdir()
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1',0));self.port=reserve.getsockname()[1]
        (self.root/'port').write_text(str(self.port))
        (self.root/'credential').write_text('fixture-token');(self.root/'credential').chmod(0o600)
        for name in ('serve.sh','state/settings.json','state/model_settings.json'):(self.root/name).write_text('fixture')
        (self.root/'server.py').write_text('''import json,os,pathlib,signal
from http.server import BaseHTTPRequestHandler,HTTPServer
from socketserver import TCPServer
r=pathlib.Path(__file__).parent
def stopped(*args):
 with (r/'stops').open('a') as f:f.write('stop\\n');f.flush();os.fsync(f.fileno())
 os._exit(0)
signal.signal(signal.SIGTERM,stopped)
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.headers.get('Authorization')!='Bearer fixture-token':self.send_error(401);return
  self.send_response(200);self.end_headers()
  self.wfile.write(json.dumps({'status':'ok','active_requests':int((r/'busy').exists()),'waiting_requests':0,'models_loading':0}).encode())
 def log_message(self,*args):pass
class Server(HTTPServer):
 def server_bind(self):
  TCPServer.server_bind(self);self.server_name='localhost';self.server_port=self.server_address[1]
Server(('127.0.0.1',int((r/'port').read_text())),Handler).serve_forever()
''')
        bootstrap=self.root/'bootstrap.py'
        bootstrap.write_text('''import os,pathlib,subprocess,sys
r=pathlib.Path(__file__).parent
with (r/'launches').open('a') as f:f.write('launch\\n');f.flush();os.fsync(f.fileno())
with (r/'server.log').open('ab') as log:
 p=subprocess.Popen([sys.executable,str(r/'server.py')],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
(r/'server.pid').write_text(str(p.pid)+'\\n')
''')
        launcher=self.root/'start guarded.sh'
        launcher.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(bootstrap))+'\n');launcher.chmod(0o700)
        subprocess.run([str(launcher)],check=True,timeout=10)
        self.addCleanup(self.stop_fixture)
        self.wait_for(lambda:(self.root/'server.pid').exists() and m.omlx.mac.owns_listener(int((self.root/'server.pid').read_text()),self.port))
        pid=int((self.root/'server.pid').read_text());process=m.omlx.mac.process_info(pid)
        self.config={'root':str(self.root),'binary':process['executable'],'port':self.port,
                     'command_sha256':hashlib.sha256(process['command'].encode()).hexdigest(),
                     'api_key_file':str(self.root/'credential'),'start_stopped':False,
                     'launcher':str(launcher),'profile_files':[str(bootstrap),str(self.root/'server.py')]}
        self.filename=self.root/'omlx.json';m.omlx.mac.atomic_save(self.filename,self.config)
        self.before=m.omlx.inspect(self.config)
        self.request={'action':'transaction','action_id':'12345678-1234-1234-1234-123456789abc','canary':True,
                      **{k:self.before[k] for k in ('machine','profile','instance')},'gateway_socket':str(self.root/'control.sock')}
        self.journal=m.folder_for(self.filename)/(self.request['action_id']+'.json')
        self.allowed=True;self.permits=[];owner=self
        self.runners=[];self.addCleanup(self.reap_runners)
        class Permit(BaseHTTPRequestHandler):
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                exact={k:v for k,v in owner.request.items() if k!='gateway_socket'}
                allowed=owner.allowed and self.path=='/recovery-omlx-permit' and body==exact
                owner.permits.append(allowed)
                self.send_response(200);self.end_headers()
                self.wfile.write(json.dumps({'allowed':allowed,**{k:owner.request[k] for k in ('action_id','instance','profile')}}).encode())
            def log_message(self,*args):pass
        server=UnixStreamServer(self.request['gateway_socket'],Permit);os.chmod(self.request['gateway_socket'],0o600)
        self.server=server;self.thread=threading.Thread(target=server.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.close_permit_server)

    def close_permit_server(self):
        self.server.shutdown();self.server.server_close();self.thread.join(timeout=5)

    def stop_fixture(self):
        file=self.root/'server.pid'
        if file.exists():
            pid=int(file.read_text())
            if m.omlx.alive(pid):
                info=m.omlx.mac.process_info(pid)
                if str(self.root/'server.py') in info['command']:os.kill(pid,signal.SIGTERM)

    def wait_for(self,predicate,seconds=20):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            if predicate():return
            time.sleep(.1)
        log=self.journal.with_suffix('.log') if hasattr(self,'journal') else None
        self.fail('Disposable native transaction fixture did not reach its expected state: '+
                  json.dumps(self.row() if hasattr(self,'journal') else {})+' '+
                  (log.read_text()[-2048:] if log and log.exists() else ''))

    def reap_runners(self):
        for process in self.runners:process.wait(timeout=35)

    def spawn(self,*args,**kwargs):
        process=subprocess.Popen(*args,**kwargs);self.runners.append(process);return process

    def dispatch(self):return m.dispatch(self.filename,self.config,self.request,popen=self.spawn)

    def row(self):return m.private_read(self.journal) if self.journal.exists() else {}

    def save_request(self):
        m.omlx.mac.atomic_save(self.journal.with_suffix('.request'),{'request':self.request,'configuration':m.omlx.fingerprint(self.config)})

    def assert_one_restart(self):
        after=m.omlx.inspect(self.config)
        self.assertNotEqual(after['instance'],self.before['instance']);self.assertTrue(after['listener'])
        self.assertEqual(after['profile'],self.before['profile']);self.assertTrue(m.omlx.idle(self.config))
        self.assertEqual((self.root/'launches').read_text().splitlines(),['launch','launch'])
        self.assertEqual((self.root/'stops').read_text().splitlines(),['stop'])
        self.assertEqual(self.dispatch()['state'],'completed')
        self.assertEqual(m.omlx.inspect(self.config)['instance'],after['instance'])

    def test_detached_runner_outlives_dispatcher_and_restarts_exact_process_once(self):
        self.save_request()
        # The dispatching process exits immediately. The separate native runner
        # must finish using only its saved request and private permit socket.
        driver=self.root/'dispatch.py'
        driver.write_text('''import importlib.util,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('tx',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
f=Path(sys.argv[2]);c=m.omlx.mac.read_private_config(f);r=m.private_read(m.folder_for(f)/(sys.argv[3]+'.request'))['request']
assert m.dispatch(f,c,r)['state']=='running'
''')
        subprocess.run([sys.executable,'-I',str(driver),m.__file__,str(self.filename),self.request['action_id']],check=True,timeout=15)
        self.wait_for(lambda:self.row().get('state')=='completed')
        self.assert_one_restart();self.assertGreaterEqual(len(self.permits),5)

    def test_killed_runner_after_signal_resumes_observation_without_reissuing_stop(self):
        self.save_request();driver=self.root/'interrupt.py'
        driver.write_text('''import importlib.util,os,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('tx',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
f=Path(sys.argv[2]);c=m.omlx.mac.read_private_config(f);r=m.private_read(m.folder_for(f)/(sys.argv[3]+'.request'))['request']
def checkpoint(phase):
 if phase=='stop_issued':os._exit(77)
m.run_transaction(f,c,r,checkpoint=checkpoint)
''')
        result=subprocess.run([sys.executable,'-I',str(driver),m.__file__,str(self.filename),self.request['action_id']],timeout=15)
        self.assertEqual(result.returncode,77);self.assertEqual(self.row()['phase'],'stop_intent')
        self.assertEqual(self.dispatch()['state'],'running')
        self.wait_for(lambda:self.row().get('state')=='completed');self.assert_one_restart()

    def test_busy_native_process_waits_without_signal_then_same_action_resumes(self):
        (self.root/'busy').touch()
        first=self.dispatch();self.assertEqual(first['state'],'running')
        self.wait_for(lambda:self.row().get('reason')=='omlx_transaction_native_busy')
        self.assertFalse((self.root/'stops').exists());self.assertEqual(m.omlx.inspect(self.config)['instance'],self.before['instance'])
        # Wait for the real lease release, not an assumed process lifetime.
        def runner_finished():
            try:
                with m.lease(self.journal.parent/'runner.lock'):return True
            except ValueError:return False
        self.wait_for(runner_finished)
        (self.root/'busy').unlink();self.dispatch()
        self.wait_for(lambda:self.row().get('state')=='completed');self.assert_one_restart()


if __name__=='__main__':unittest.main()
