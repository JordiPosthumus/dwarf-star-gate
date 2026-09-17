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
    def test_media_location_is_derived_from_enrolled_ssh_account_and_creates_nothing(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(remote.Path,'home',return_value=Path(tmp)):
            identity='12345678-1234-1234-1234-123456789abc'
            self.assertEqual(remote.media_location(identity)['directory'],str(Path(tmp)/'.local/share/star-gate/media-setup'/identity))
            self.assertEqual(list(Path(tmp).iterdir()),[])
            with self.assertRaises(ValueError):remote.media_location('../other')

    def test_media_preflight_refusal_confirms_no_launch_and_preserves_files(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(remote.subprocess,'check_output',return_value=json.dumps([{'Id':'a'*64,'State':{'Running':False}}])):
            root=Path(tmp)/'setup'
            result=remote.start(root,{**bundle("def preflight(): raise ValueError('unsupported platform')\n"),'operation':'prepare_media','selected_engines':['ace-step'],'llm_container':'a'*64})
            self.assertEqual(result['state'],'refused');self.assertFalse(result['process_running']);self.assertFalse(root.exists())

    def test_download_progress_counts_partial_bytes_once_without_claiming_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = root/'source/examples/spark-build/h3/models.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({'files':[{'path':name,'bytes':size} for name,size in [('done',4),('partial',10),('missing',6)]]}))
            models = root/'engines/h3/models';models.mkdir(parents=True)
            (models/'done').write_bytes(b'done')
            (models/'done.stargate-download').write_bytes(b'done')
            partial = models/'partial.stargate-download';partial.write_bytes(b'abc')
            phase = {'engine':'h3','phase':'verify_or_download_models'}
            first = remote.model_progress(root,phase)
            self.assertEqual((first['bytes_present'],first['bytes_required']),(7,20))
            self.assertIn('partial downloads',first['scope'])
            self.assertIn('verification',first['scope'])
            self.assertIsNotNone(first['last_file_activity_at'])
            partial.write_bytes(b'abcdefghij');partial.rename(models/'partial')
            self.assertEqual(remote.model_progress(root,phase)['bytes_present'],14)
            self.assertEqual((models/'done.stargate-download').read_bytes(),b'done','Observation must preserve files')
            manifest.unlink()
            self.assertEqual(remote.model_progress(root,phase)['state'],'unavailable')
            self.assertIsNone(remote.model_progress(root,{'engine':'h3','phase':'build_image'}))

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
                # Media-only preparation retains an existing LLM rather than
                # requiring another Qwen container in this setup directory.
                setup_file=root/'engines/setup.json'
                setup_file.write_text(json.dumps({'state':'prepared_stopped','engines':{'h3':engines['h3']}}))
                (root/'launch.json').write_text(json.dumps({'operation':'prepare_media','selected_engines':['h3'],'llm_container':'qwen38-repaired'}))
                selected=remote.media_plan(root)
                self.assertEqual(set(selected['engines']),{'h3'})
                self.assertEqual(selected['llm_container'],'qwen38-repaired')
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
        self.exercise_detached()

    def test_selected_media_preparation_uses_original_llm_and_exact_cli_selection(self):
        self.exercise_detached(media=True)

    def test_media_preparation_requires_stopped_original_before_creating_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'setup'
            payload={'operation':'prepare_media','selected_engines':['ace-step'],'llm_container':'a'*64}
            with patch.object(remote.subprocess,'check_output',return_value=json.dumps([{'Id':'a'*64,'State':{'Running':True}}])):
                with self.assertRaisesRegex(ValueError,'Drain and stop'):remote.start(root,payload)
            self.assertFalse(root.exists())
            for selected in [[],['qwen38-repaired'],['h3','h3']]:
                with self.assertRaisesRegex(ValueError,'exact media engines'):remote.start(root,{**payload,'selected_engines':selected})
                self.assertFalse(root.exists())

    def exercise_detached(self, media=False):
        script = '''import json,sys,time
from pathlib import Path
def preflight(): pass
if __name__ == '__main__':
 root=Path(sys.argv[1]);root.mkdir()
 (root/'setup.json').write_text(json.dumps({'state':'running','phase':'fixture'}))
 while not (root.parent/'finish').exists(): time.sleep(.02)
 (root/'setup.json').write_text(json.dumps({'state':'prepared_stopped','phase':'complete','arguments':sys.argv[2:]}))
'''
        with tempfile.TemporaryDirectory() as tmp, patch.object(remote.Path, 'home', return_value=Path(tmp)), patch.object(remote.subprocess,'check_output',return_value=json.dumps([{'Id':'a'*64,'State':{'Running':False}}])):
            root = Path(tmp) / 'setup'
            try:
                payload=bundle(script)
                if media:payload.update(operation='prepare_media',selected_engines=['ace-step'],llm_container='a'*64)
                self.assertEqual(remote.start(root, payload)['state'], 'accepted')
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
            self.assertEqual(state['progress']['arguments'],['--engine','ace-step'] if media else [])
            if media:
                launch=json.loads((root/'launch.json').read_text())
                self.assertEqual(launch['llm_container'],'a'*64)
                self.assertEqual(launch['selected_engines'],['ace-step'])
            self.assertEqual(remote.start(root, {})['state'], 'prepared_stopped')


if __name__ == '__main__':
    unittest.main()
