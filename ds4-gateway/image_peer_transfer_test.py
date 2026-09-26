import base64,hashlib,json,os,pathlib,select,subprocess,sys,tempfile,unittest
from image_peer_transfer import RECEIVER,SOURCE

class NativeStream(unittest.TestCase):
 def test_certificate_pinned_authenticated_stream_and_machine_check(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);machine=root/'machine';machine.write_bytes(b'fixture-machine');payload=root/'payload';payload.write_bytes(bytes(range(256))*8192);loaded=root/'loaded';image='sha256:'+'a'*64
   binary=root/'docker';binary.write_text('#!'+sys.executable+'\n'+f'''import sys,json,pathlib
if sys.argv[1]=='save':sys.stdout.buffer.write(pathlib.Path({str(payload)!r}).read_bytes())
elif sys.argv[1]=='load':pathlib.Path({str(loaded)!r}).write_bytes(sys.stdin.buffer.read())
elif sys.argv[1:3]==['image','inspect']:print(json.dumps([{{'Id':{image!r},'Architecture':'arm64'}}]))
else:sys.exit(2)
''');binary.chmod(0o700);env={**os.environ,'PATH':str(root)+os.pathsep+os.environ['PATH']}
   code=RECEIVER.replace("'/etc/machine-id'",repr(str(machine)))
   server=subprocess.Popen([sys.executable,'-u','-I','-c',code,json.dumps({'image':image,'max_bytes':8*1024*1024})],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
   try:
    self.assertTrue(select.select([server.stdout],[],[],40)[0]);line=server.stdout.readline();self.assertTrue(line);connection=json.loads(line);connection.update(host='127.0.0.1',machine=hashlib.sha256(machine.read_bytes()).hexdigest(),image=image)
    def source(mode,**changes):return subprocess.run([sys.executable,'-I','-c',SOURCE,base64.b64encode(json.dumps({**connection,'mode':mode,**changes}).encode()).decode()],capture_output=True,env=env,timeout=45)
    self.assertNotEqual(source('probe',token='wrong').returncode,0);self.assertFalse(loaded.exists())
    self.assertNotEqual(source('probe',machine='b'*64).returncode,0);self.assertFalse(loaded.exists())
    self.assertNotEqual(source('probe',certificate='invalid certificate').returncode,0);self.assertFalse(loaded.exists())
    other=subprocess.Popen([sys.executable,'-u','-I','-c',code,json.dumps({'image':image,'max_bytes':8*1024*1024})],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
    try:
     self.assertTrue(select.select([other.stdout],[],[],40)[0]);other_connection=json.loads(other.stdout.readline())
     self.assertNotEqual(source('probe',certificate=other_connection['certificate']).returncode,0)
     other.stdin.close();self.assertEqual(other.wait(timeout=10),0,'Owner disconnect must close the temporary receiver')
    finally:
     if other.poll() is None:other.terminate();other.wait(timeout=10)
     other.stdout.close();other.stderr.close()
    probe=source('probe');self.assertEqual(probe.returncode,0,probe.stderr.decode())
    copied=source('copy');self.assertEqual(copied.returncode,0,copied.stderr.decode());receipt=json.loads(copied.stdout);self.assertEqual(receipt['image'],image);self.assertEqual(receipt['bytes'],payload.stat().st_size);self.assertEqual(loaded.read_bytes(),payload.read_bytes());self.assertEqual(server.wait(timeout=10),0)
   finally:
    if server.stdin:server.stdin.close()
    if server.poll() is None:server.terminate();server.wait(timeout=10)
    if server.stdout:server.stdout.close()
    if server.stderr:server.stderr.close()
