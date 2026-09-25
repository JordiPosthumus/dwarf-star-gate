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
    def test_native_standard_audit_preserves_services_and_distinguishes_absence_from_changed(self):
        llm, media = 'a'*64, 'b'*64
        expected = {'container':media, 'image':'sha256:'+'c'*64, 'kind':'comfyui', 'port':8188}
        payload = {'engine':'h3','expected':expected,'llm_container':'serving-llm'}
        for mode in ('present','absent','changed','unavailable','incomplete'):
            commands=[]
            def read(args, **kwargs):
                commands.append(args)
                if mode=='unavailable':raise OSError('SSH unavailable')
                if args[1]=='ps':return llm if mode=='absent' else ('not-an-id' if mode=='incomplete' else llm+'\n'+media)
                if args[-1]=='serving-llm':return json.dumps([{'Id':llm}])
                return json.dumps([{'Id':media,'Image':expected['image'] if mode=='present' else 'sha256:'+'d'*64,'State':{'Running':False},'HostConfig':{'PortBindings':{'8188/tcp':[{'HostPort':'8188'}]}}}])
            with self.subTest(mode=mode),patch.object(remote.subprocess,'check_output',side_effect=read):
                if mode in ('unavailable','incomplete'):
                    with self.assertRaises((OSError,ValueError)):remote.audit_media(payload)
                else:self.assertEqual(remote.audit_media(payload)['state'],mode)
            self.assertTrue(all(c[0]=='docker' and c[1] in ('ps','inspect') for c in commands))

    def test_missing_media_discovery_is_read_only_and_refuses_ambiguous_or_active_sources(self):
        current, old, candidate = 'a'*64, 'b'*64, 'c'*64
        request = {'engine':'h3', 'missing_container':old, 'llm_container':current}
        base = {'Id':candidate, 'Image':'sha256:'+'d'*64, 'State':{'Running':False},
                'Config':{'Cmd':['python','main.py'], 'WorkingDir':'/opt/ComfyUI'},
                'HostConfig':{'PortBindings':{'8188/tcp':[{'HostIp':'127.0.0.1','HostPort':'8188'}]}}}
        for mode in ('known','fresh','unknown','active','old-present','many','wrong-llm','ambiguous','host-network'):
            with self.subTest(mode=mode):
                commands=[]
                obj=json.loads(json.dumps(base))
                if mode=='unknown':obj['Config']['Cmd']=['unrecognized']
                if mode=='active':obj['State']['Running']=True
                if mode=='host-network':obj['HostConfig']['PortBindings']={}
                ids=[current]+([] if mode=='fresh' else [candidate])
                if mode=='old-present':ids.append(old)
                if mode=='many':ids=[format(i,'064x') for i in range(129)]
                def read(args, **kwargs):
                    commands.append(args)
                    if args[1]=='ps':return '\n'.join(ids)
                    if args[1:5]!=['inspect','--type','container','--']:self.fail(str(args))
                    if args[5:]==[current]:return json.dumps([{'Id':current,'State':{'Running':mode!='wrong-llm'}}])
                    items=[{'Id':current,'State':{'Running':True}},obj]
                    if mode=='ambiguous':items.append({**obj,'Id':'e'*64})
                    return json.dumps(items)
                with patch.object(remote.subprocess,'check_output',side_effect=read):
                    if mode in ('known','fresh'):
                        result=remote.discover_media(request)
                        self.assertEqual(result['selection'] is None,mode=='fresh')
                        if mode=='known':self.assertEqual(result['selection']['container'],candidate)
                    else:
                        with self.assertRaises(ValueError):remote.discover_media(request)
                self.assertTrue(all(c[0]=='docker' and c[1] in ('ps','inspect') for c in commands))

    def test_existing_media_is_read_only_pinned_and_requires_idle_for_qualification(self):
        expected = {'container': 'b'*64, 'image': 'sha256:'+'c'*64, 'kind': 'comfyui', 'port': 8188}
        media = {'Id': expected['container'], 'Image': expected['image'], 'State': {'Running': False},
                 'HostConfig': {'PortBindings': {'8188/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8188'}]}}}
        llm = {'Id': 'a'*64, 'State': {'Running': False}}
        request = {'engine': 'h3', 'expected': expected, 'llm_container': llm['Id'], 'require_idle': True}
        calls = []
        def observe(args, **kwargs):
            calls.append(args)
            if args[0] == 'nvidia-smi': return ''
            self.assertEqual(args[:2], ['docker', 'inspect'])
            return json.dumps([media if args[2] == media['Id'] else llm])
        with patch.object(remote.subprocess, 'check_output', side_effect=observe):
            result = remote.existing_media(request)
            self.assertEqual(result['engines']['h3']['container'], media['Id'])
            llm['State']['Running'] = True
            with self.assertRaisesRegex(ValueError, 'active'): remote.existing_media(request)
            self.assertEqual(remote.existing_media({**request, 'require_idle': False})['state'], 'prepared_stopped')
            media['Image'] = 'sha256:'+'d'*64
            with self.assertRaisesRegex(ValueError, 'identity'): remote.existing_media(request)
        self.assertTrue(all(args[0] == 'nvidia-smi' or args[:2] == ['docker', 'inspect'] for args in calls))
        with self.assertRaisesRegex(ValueError, 'Pin'): remote.existing_media({**request, 'expected': {**expected, 'command': 'arbitrary'}})

    def test_resume_keeps_partial_files_and_replays_observation_not_work(self):
        script = """import json,sys,time
from pathlib import Path
def preflight(): pass
def save(root, value):
 pending=root/'setup.json.tmp';pending.write_text(json.dumps(value));pending.replace(root/'setup.json')
if __name__ == '__main__':
 root=Path(sys.argv[1]);root.mkdir(exist_ok=True)
 partial=root/'retained-download';partial.write_text('downloaded bytes') if not partial.exists() else None
 if not (root.parent/'allow-resume').exists():
  save(root,{'state':'failed','error':'fixture download interrupted'});sys.exit(7)
 assert partial.read_text()=='downloaded bytes'
 while not (root.parent/'finish').exists():time.sleep(.02)
 save(root,{'state':'prepared_stopped','phase':'complete'})
"""
        def terminal(root):
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                result=remote.status(root)
                if not result['process_running']:return result
                time.sleep(.02)
            self.fail('Detached fixture did not finish')
        with tempfile.TemporaryDirectory() as tmp, patch.object(remote.Path,'home',return_value=Path(tmp)):
            root=Path(tmp)/'setup'
            remote.start(root,bundle(script));failed=terminal(root)
            self.assertEqual(failed['exit_code'],7)
            expected=failed['finished_at']
            original=(root/'launch.json').read_bytes()
            with self.assertRaisesRegex(ValueError,'exact confirmed'):
                remote.resume_preparation(root,'different-attempt')
            source=root/'source/examples/spark-build/setup-spark.py'
            source.write_text(script+'\n# changed\n')
            with self.assertRaisesRegex(ValueError,'sources changed'):
                remote.resume_preparation(root,expected)
            source.write_text(script)
            (root/'allow-resume').touch()
            try:
                result=remote.resume_preparation(root,expected)
                self.assertEqual(result['state'],'accepted')
                replay=remote.resume_preparation(root,expected)
                self.assertEqual(replay['state'],'running')
                self.assertEqual(replay['resume_of'],expected)
                self.assertEqual(next(root.glob('launch.before-resume-*.json')).read_bytes(),original)
                self.assertEqual((root/'engines/retained-download').read_text(),'downloaded bytes')
            finally:(root/'finish').touch()
            complete=terminal(root)
            self.assertEqual(complete['state'],'prepared_stopped')
            self.assertEqual(remote.resume_preparation(root,expected)['state'],'prepared_stopped')
            self.assertEqual(len(list(root.glob('launch.before-resume-*.json'))),1)

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
                # A retained media preparation survives replacement/removal of its old LLM.
                before = (root/'launch.json').read_bytes()
                replacement = 'f'*64
                containers[replacement] = {'Id':replacement,'State':{'Running':True}}
                del containers['qwen38-repaired']
                retained=remote.retained_media(root,{'require_idle':False,'llm_container':replacement,'engine':'h3'})
                self.assertEqual(retained['source_llm_container'],'qwen38-repaired')
                with self.assertRaisesRegex(ValueError,'Pin the current'):
                    remote.retained_media(root,{'require_idle':False,'llm_container':None,'engine':'h3'})
                self.assertEqual(retained['llm_container'],replacement)
                self.assertEqual((root/'launch.json').read_bytes(),before)
                with self.assertRaisesRegex(ValueError,'stopped state'):
                    remote.media_plan(root,current_llm=replacement,engine='h3')
                containers[replacement]['State']['Running']=False
                self.assertEqual(remote.media_plan(root,current_llm=replacement,engine='h3')['llm_container'],replacement)
                containers['qwen38-repaired']={'Id':'qwen38-repaired','State':{'Running':False}}
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
def save(root, value):
 pending=root/'setup.json.tmp';pending.write_text(json.dumps(value));pending.replace(root/'setup.json')
if __name__ == '__main__':
 root=Path(sys.argv[1]);root.mkdir()
 save(root,{'state':'running','phase':'fixture'})
 while not (root.parent/'finish').exists(): time.sleep(.02)
 save(root,{'state':'prepared_stopped','phase':'complete','arguments':sys.argv[2:]})
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
