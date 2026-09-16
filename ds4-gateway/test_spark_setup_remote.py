import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote', Path(__file__).with_name('spark_setup_remote.py'))
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


def bundle(script):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in [('examples/spark-build/setup-spark.py', script.encode()), ('ds4-gateway/spark_setup_remote.py', Path(remote.__file__).read_bytes())]:
            info = tarfile.TarInfo(name); info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    raw = buffer.getvalue()
    return {'bundle': base64.b64encode(raw).decode(), 'bundle_sha256': hashlib.sha256(raw).hexdigest()}


class RemoteSetupTests(unittest.TestCase):
    def test_media_plan_rejects_busy_gpu_without_inspecting_or_changing_containers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'engines').mkdir()
            (root / 'engines/setup.json').write_text(json.dumps({'state':'prepared_stopped'}))
            with patch.object(remote.subprocess, 'check_output', return_value='123\n') as command:
                with self.assertRaisesRegex(ValueError, 'GPU work is active'):
                    remote.media_plan(root)
                self.assertEqual(command.call_count, 1)
                self.assertEqual(command.call_args.args[0][0], 'nvidia-smi')

    def test_media_plan_checks_exact_stopped_containers_and_port_bindings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'engines').mkdir(); engines = {}; containers = {}; images = {}
            for key in ('qwen38-repaired', 'h3', 'ace-step'):
                data = root / key; data.mkdir(); port = 8002 if key == 'ace-step' else 8188
                engines[key] = {'container':key,'image':'image-'+key,'data':str(data),'models':str(root/'models'/key)}
                (data/'container.json').write_text(json.dumps({'container':key,'image':'image-'+key,'port':port}))
                model = '/models/ace-step' if key == 'ace-step' else '/opt/ComfyUI/models'
                containers[key] = {'Id':key,'Image':'image-'+key,'State':{'Running':False},'Config':{'Cmd':['serve'],'Entrypoint':None},'HostConfig':{'PortBindings':{str(port)+'/tcp':[{'HostIp':'127.0.0.1','HostPort':str(port)}]}},'Mounts':[{'Destination':model,'Source':engines[key]['models']},{'Destination':'/data','Source':str(data)}]}
                images['image-'+key] = {'Config':{'Cmd':['serve'],'Entrypoint':None}}
            (root/'engines/setup.json').write_text(json.dumps({'state':'prepared_stopped','engines':engines}))
            def command(args, **_):
                if args[0]=='nvidia-smi': return ''
                if args[:3]==['docker','image','inspect']: return json.dumps([images[args[3]]])
                self.assertEqual(args[:2],['docker','inspect']); return json.dumps([containers[args[2]]])
            with patch.object(remote.subprocess,'check_output',side_effect=command):
                self.assertEqual(set(remote.media_plan(root)['engines']), {'h3','ace-step'})
                containers['qwen38-repaired']['State']['Running']=True
                with self.assertRaisesRegex(ValueError,'stopped state'): remote.media_plan(root)
                self.assertEqual(set(remote.media_plan(root, require_idle=False)['engines']), {'h3','ace-step'})
                containers['h3']['State']['Running']=True
                with self.assertRaisesRegex(ValueError,'stopped state'): remote.media_plan(root, require_idle=False)
                containers['h3']['State']['Running']=False
                containers['qwen38-repaired']['State']['Running']=False
                containers['h3']['HostConfig']['PortBindings']['8188/tcp'][0]['HostIp']='0.0.0.0'
                with self.assertRaisesRegex(ValueError,'native port'): remote.media_plan(root)

    def test_preflight_failure_preserves_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'setup'
            with self.assertRaisesRegex(ValueError, 'busy GPU'):
                remote.start(root, bundle("def preflight(): raise ValueError('busy GPU')\n"))
            self.assertFalse(root.exists())

    def test_existing_unknown_directory_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); personal = root / 'personal'; personal.write_text('Keep')
            self.assertEqual(remote.start(root, {})['state'], 'needs_attention')
            self.assertEqual(personal.read_text(), 'Keep')
            self.assertEqual(list(root.iterdir()), [personal])

    def test_detached_preparation_is_observable_and_cannot_be_launched_twice(self):
        script = '''import json,sys,time
from pathlib import Path
def preflight(): pass
if __name__ == '__main__':
 root=Path(sys.argv[1]);root.mkdir()
 (root/'setup.json').write_text(json.dumps({'state':'running','phase':'fixture'}))
 while not (root.parent/'finish').exists(): time.sleep(.02)
 (root/'setup.json').write_text(json.dumps({'state':'prepared_stopped','phase':'complete'}))
'''
        with tempfile.TemporaryDirectory() as tmp, patch.object(remote.Path, 'home', return_value=Path(tmp)):
            root = Path(tmp) / 'setup'
            try:
                self.assertEqual(remote.start(root, bundle(script))['state'], 'accepted')
                self.assertEqual(remote.start(root, {})['state'], 'running')
                with self.assertRaisesRegex(ValueError, 'Another Spark preparation'):
                    remote.start(Path(tmp) / 'other', bundle(script))
                self.assertFalse((Path(tmp) / 'other').exists())
            finally:
                (root / 'finish').touch()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                state = remote.status(root)
                if state['state'] != 'running': break
                time.sleep(.02)
            self.assertEqual(state['state'], 'prepared_stopped', state)
            self.assertEqual(state['exit_code'], 0)
            self.assertEqual(remote.start(root, {})['state'], 'prepared_stopped')


if __name__ == '__main__':
    unittest.main()
