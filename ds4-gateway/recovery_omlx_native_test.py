"""Real macOS process/HTTP transport fixture; does not start oMLX or an LLM."""
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import shlex
import subprocess
import sys
import tempfile
import time
import unittest

spec=importlib.util.spec_from_file_location('omlx_adapter',Path(__file__).with_name('recovery-omlx.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


@unittest.skipUnless(sys.platform=='darwin','macOS native PID/listener fixture')
class NativeOmlxAdapterTests(unittest.TestCase):
    def test_native_busy_refusal_then_one_restart_and_original_launcher_settings(self):
        self.exercise_launcher(False)

    def test_native_enrolled_shell_launcher_without_start_py(self):
        self.exercise_launcher(True)

    def exercise_launcher(self, shell_launcher):
        with tempfile.TemporaryDirectory(prefix='sg-omlx-adapter-') as tmp:
            root=Path(tmp);(root/'state').mkdir()
            with socket.socket() as reserve:
                reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
            (root/'port').write_text(str(port));(root/'credential').write_text('fixture-token');(root/'credential').chmod(0o600)
            (root/'serve.sh').write_text('# Fixture only; start.py preserves this file.\n')
            for name in ('settings.json','model_settings.json'):(root/'state'/name).write_text('{"fixture":true}')
            (root/'server.py').write_text('''import faulthandler
faulthandler.dump_traceback_later(5)
import json,pathlib
from http.server import BaseHTTPRequestHandler,HTTPServer
from socketserver import TCPServer
r=pathlib.Path(__file__).parent
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.headers.get('Authorization')!='Bearer fixture-token':self.send_error(401);return
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'status':'ok','active_requests':int((r/'busy').exists()),'waiting_requests':0,'models_loading':0}).encode())
 def log_message(self,*args):pass
# HTTPServer resolves the loopback FQDN before listening. This fixture only
# needs the real HTTP handler and socket; CI DNS is not part of recovery.
class FixtureServer(HTTPServer):
 def server_bind(self):
  TCPServer.server_bind(self)
  self.server_name='localhost'
  self.server_port=self.server_address[1]
server=FixtureServer(('127.0.0.1',int((r/'port').read_text())),Handler)
faulthandler.cancel_dump_traceback_later()
server.serve_forever()
''')
            bootstrap=root/('bootstrap.py' if shell_launcher else 'start.py')
            bootstrap.write_text('''import pathlib,subprocess,sys
r=pathlib.Path(__file__).parent
with (r/'server.log').open('ab') as log:
 p=subprocess.Popen([sys.executable,str(r/'server.py')],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
(r/'server.pid').write_text(str(p.pid)+'\\n')
''')
            if shell_launcher:
                launcher=root/'start guarded.sh'
                launcher.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(bootstrap))+'\n')
                launcher.chmod(0o700)
            config=None
            def wait_ready(previous=None):
                deadline=time.monotonic()+15
                while time.monotonic()<deadline:
                    try:
                        pid=int((root/'server.pid').read_text())
                        if pid!=previous and m.mac.owns_listener(pid,port):return pid
                    except (OSError,ValueError):pass
                    time.sleep(.1)
                pid_file=root/'server.pid'
                pid=int(pid_file.read_text()) if pid_file.exists() else None
                listener=subprocess.run(['/usr/sbin/lsof','-nP','-a','-p',str(pid),f'-iTCP:{port}','-sTCP:LISTEN','-Fn'],capture_output=True,text=True) if pid else None
                process=subprocess.run(['/bin/ps','-p',str(pid),'-o','pid=,ppid=,stat=,command='],capture_output=True,text=True) if pid else None
                log=(root/'server.log').read_text() if (root/'server.log').exists() else '(no server log)'
                self.fail(f'Disposable fixture did not start: pid={pid}, alive={m.alive(pid) if pid else False}, '
                          f'process={None if process is None else process.stdout}, '
                          f'lsof={None if listener is None else (listener.returncode,listener.stdout,listener.stderr)}, server log={log[-8192:]}')
            try:
                subprocess.run([str(launcher)] if shell_launcher else [sys.executable,str(bootstrap)],check=True)
                pid=wait_ready();process=m.mac.process_info(pid)
                config={'root':str(root),'binary':process['executable'],'command_sha256':hashlib.sha256(process['command'].encode()).hexdigest(),'port':port,'api_key_file':str(root/'credential'),'start_stopped':True}
                if shell_launcher:
                    config.update(launcher=str(launcher),profile_files=[str(bootstrap),str(root/'server.py')])
                    self.assertFalse((root/'start.py').exists())
                file=root/'config.json';file.write_text(json.dumps(config));file.chmod(0o600)
                def invoke(request):
                    result=subprocess.run([sys.executable,'-I',m.__file__,str(file)],input=json.dumps(request),text=True,capture_output=True,timeout=40)
                    return result.returncode,json.loads(result.stdout) if result.stdout else {'error':result.stderr}
                code,before=invoke({'action':'inspect'});self.assertEqual(code,0);self.assertTrue(before['active']);self.assertTrue(before['listener'])
                request={'action':'restart','action_id':'12345678-1234-1234-1234-123456789abc','instance':before['instance'],'machine':before['machine'],'profile':before['profile'],'canary':True,'fault_after':0}
                (root/'busy').touch();self.assertNotEqual(invoke(request)[0],0);self.assertEqual(int((root/'server.pid').read_text()),pid)
                (root/'busy').unlink();code,receipt=invoke(request);self.assertEqual(code,0,receipt);self.assertEqual(receipt['state'],'issued')
                next_pid=wait_ready(pid);code,after=invoke({'action':'inspect'});self.assertEqual(code,0);self.assertEqual(after['profile'],before['profile']);self.assertNotEqual(after['instance'],before['instance'])
                self.assertEqual(invoke(request)[1],receipt);self.assertEqual(int((root/'server.pid').read_text()),next_pid)
            finally:
                # Only the process recorded inside this disposable test directory.
                if (root/'server.pid').exists():
                    pid=int((root/'server.pid').read_text())
                    if m.alive(pid):
                        info=m.mac.process_info(pid)
                        if str(root/'server.py') in info['command']:
                            import os,signal
                            os.kill(pid,signal.SIGTERM)


if __name__=='__main__':unittest.main()
