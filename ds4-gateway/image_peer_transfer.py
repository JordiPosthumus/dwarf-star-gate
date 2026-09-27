"""Ephemeral authenticated image stream between two operator-enrolled SSH hosts.

The receiver's certificate/token come back over its existing trusted SSH channel.
No SSH credentials or persistent trust entries are installed on either machine.
"""
import base64
import json
import select
import shlex
import subprocess
import time

RECEIVER = r'''
import hashlib,hmac,http.server,json,os,pathlib,secrets,signal,ssl,subprocess,sys,tempfile,threading,time
p=json.loads(sys.argv[1]);token=secrets.token_urlsafe(48);loaded=False;child=None
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,status,value):
  data=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def authorized(self,suffix=''):
  return hmac.compare_digest(self.path,'/'+token+suffix)
 def do_GET(self):
  if not self.authorized('/probe'):self.reply(403,{'error':'unauthorized'});return
  self.reply(200,{'machine_sha256':hashlib.sha256(pathlib.Path('/etc/machine-id').read_bytes()).hexdigest()})
 def do_POST(self):
  global loaded,child
  if not self.authorized():self.reply(403,{'error':'unauthorized'});return
  if loaded or self.headers.get('Transfer-Encoding')!='chunked':self.reply(409,{'error':'unsupported or repeated stream'});return
  loaded=True;total=0
  with open(pathlib.Path(temp)/'docker-load.log','wb') as log:
   child=subprocess.Popen(['docker','load'],stdin=subprocess.PIPE,stdout=log,stderr=log)
   try:
    while True:
     line=self.rfile.readline(128)
     if not line.endswith(b'\r\n'):raise ValueError('Invalid chunk framing')
     size=int(line.strip(),16)
     if size<0 or size>16*1024*1024 or total+size>p['max_bytes']:raise ValueError('Image stream exceeded its bound')
     if size==0:
      if self.rfile.read(2)!=b'\r\n':raise ValueError('Invalid stream ending')
      break
     remaining=size
     while remaining:
      data=self.rfile.read(min(remaining,1024*1024))
      if not data:raise ValueError('Incomplete image stream')
      child.stdin.write(data);remaining-=len(data);total+=len(data)
     if self.rfile.read(2)!=b'\r\n':raise ValueError('Invalid chunk ending')
    child.stdin.close()
    if child.wait(timeout=600)!=0:raise RuntimeError('Docker image load failed')
    r=subprocess.run(['docker','image','inspect',p['image']],capture_output=True,text=True,timeout=30,check=True);image=json.loads(r.stdout)[0]
    if image['Id']!=p['image'] or image['Architecture']!='arm64':raise ValueError('Loaded image identity differs')
    self.reply(200,{'state':'loaded','image':image['Id'],'bytes':total})
   except Exception:
    if child.poll() is None:child.terminate();child.wait(timeout=30)
    log.flush();sys.stderr.write((pathlib.Path(temp)/'docker-load.log').read_text(errors='replace')[-16384:])
    self.reply(500,{'error':'Image stream failed; original serving state untouched','bytes':total})
   finally:
    threading.Thread(target=server.shutdown,daemon=True).start()
with tempfile.TemporaryDirectory(prefix='dsg-image-stream-') as temp:
 cert=pathlib.Path(temp)/'certificate.pem';key=pathlib.Path(temp)/'key.pem'
 subprocess.run(['openssl','req','-x509','-newkey','ed25519','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=dsg-image-stream'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=30)
 key.chmod(0o600)
 context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key)
 class Server(http.server.ThreadingHTTPServer):
  daemon_threads=True
  def get_request(self):
   connection,address=self.socket.accept();connection.settimeout(15)
   try:connection=context.wrap_socket(connection,server_side=True);connection.settimeout(600);return connection,address
   except Exception:connection.close();raise
 server=Server(('0.0.0.0',0),Handler)
 print(json.dumps({'port':server.server_port,'certificate':cert.read_text(),'token':token}),flush=True)
 def owner_gone():
  while os.read(sys.stdin.fileno(),4096):pass
  if child is not None and child.poll() is None:
   child.terminate()
  server.shutdown()
 threading.Thread(target=owner_gone,daemon=True).start()
 timer=threading.Timer(7300,server.shutdown);timer.daemon=True;timer.start()
 try:server.serve_forever(poll_interval=.2)
 finally:
  timer.cancel();server.server_close()
  if child is not None and child.poll() is None:child.terminate();child.wait(timeout=30)
'''

SOURCE = r'''
import base64,http.client,json,ssl,subprocess,sys
p=json.loads(base64.b64decode(sys.argv[1]));context=ssl.create_default_context(cadata=p['certificate']);context.check_hostname=False
connection=http.client.HTTPSConnection(p['host'],p['port'],context=context,timeout=30 if p['mode']=='probe' else 7200,blocksize=1024*1024)
if p['mode']=='probe':
 connection.request('GET','/'+p['token']+'/probe');response=connection.getresponse();data=json.loads(response.read(4096))
 if response.status!=200 or data.get('machine_sha256')!=p['machine']:raise RuntimeError('Direct TLS peer identity was not verified')
 print(json.dumps({'state':'verified'}));connection.close();sys.exit(0)
sender=subprocess.Popen(['docker','save','--platform','linux/arm64',p['image']],stdout=subprocess.PIPE)
try:
 connection.request('POST','/'+p['token'],body=sender.stdout,headers={'Content-Type':'application/octet-stream'},encode_chunked=True)
 response=connection.getresponse();data=json.loads(response.read(4096));code=sender.wait(timeout=60)
 if code or response.status!=200 or data.get('state')!='loaded' or data.get('image')!=p['image']:raise RuntimeError('Direct TLS image transfer failed')
 print(json.dumps(data))
finally:
 connection.close()
 if sender.poll() is None:sender.terminate();sender.wait(timeout=30)
'''


def transfer(owner,peer):
    """False only before sending image bytes; a started transfer never falls back."""
    plan=owner.plan;receiver=None
    command=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',plan['ssh'],shlex.join(['python3','-u','-I','-c',RECEIVER,json.dumps({'image':plan['qualified_image'],'max_bytes':256*1024**3})])]
    with open(owner.folder/'image-copy.log','ab',buffering=0) as log:
        try:
            receiver=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log)
            if not select.select([receiver.stdout],[],[],45)[0]:return False
            line=receiver.stdout.readline(262144)
            try:connection=json.loads(line)
            except (ValueError,UnicodeError):return False
            if not isinstance(connection.get('port'),int) or not 1<=connection['port']<=65535 or not isinstance(connection.get('certificate'),str) or not isinstance(connection.get('token'),str):return False
            connection.update(host=peer['destination'].split('@',1)[1],machine=peer['machine_sha256'],image=plan['qualified_image'])
            def source(mode):
                payload=base64.b64encode(json.dumps({**connection,'mode':mode}).encode()).decode()
                return ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',plan['image_source_ssh'],shlex.join(['python3','-I','-c',SOURCE,payload])]
            try:
                probe=owner.run(source('probe'),stdout=subprocess.PIPE,stderr=log,timeout=45)
                if probe.returncode or json.loads(probe.stdout).get('state')!='verified':return False
            except (subprocess.TimeoutExpired,ValueError):return False
            owner.status('copying_qualified_image',transport='authenticated_peer_stream')
            try:result=owner.run(source('copy'),stdout=subprocess.PIPE,stderr=log,timeout=7300)
            except subprocess.TimeoutExpired:raise RuntimeError('Authenticated peer image transfer timed out; inspect this same operation') from None
            if result.returncode:raise RuntimeError('Authenticated peer image transfer failed; inspect this same operation')
            loaded=json.loads(result.stdout)
            if loaded.get('state')!='loaded' or loaded.get('image')!=plan['qualified_image']:raise RuntimeError('Peer image identity was not confirmed')
            from spark_recipe_trial import atomic
            atomic(owner.folder/'direct-copy-result.json',{**loaded,'transport':'authenticated_peer_stream','at':time.time()})
            return True
        finally:
            if receiver is not None:
                if receiver.stdin:
                    try:receiver.stdin.close()
                    except BrokenPipeError:pass
                try:receiver.wait(timeout=40)
                except subprocess.TimeoutExpired:receiver.terminate();receiver.wait(timeout=30)
