"""Publication fault tests; optional installed AceFarm, synthetic audio only."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'examples/hermes/stargate-media/scripts'))
import acefarm_publish as publisher

# Portable fixture for CI; local acceptance runs this suite again with the
# installed canonical publisher selected by DSG_TEST_ACEFARM_SOURCE.
FIXTURE = '''
import hashlib, json, shutil
from pathlib import Path
MACHINES = {}
def short_track_id(meta):
    return hashlib.sha256(json.dumps(meta,sort_keys=True,ensure_ascii=False,separators=(',', ':')).encode()).hexdigest()[:8]
def _flat_output_paths(folder, meta, machine, suffix='.flac'):
    name = f"{meta['id']}_{meta['track']}_{machine}_seed_{meta['seed']:05d}"
    return folder/(name+suffix), folder/(name+'.json')
def publish_success_result(folder, result, source_machine, machine_names):
    assert source_machine == '' and machine_names == []
    audio, sidecar = _flat_output_paths(folder,result,result['machine'])
    shutil.copy2(result['output'],audio)
    sidecar.write_text(json.dumps(dict(result,output=str(audio),sidecar_path=str(sidecar))))
    entry = dict(id=result['id'],track=result['track'],seed=result['seed'],audio_path=str(audio),sidecar_path=str(sidecar))
    (folder/'track_index.json').write_text(json.dumps([entry]))
    return entry
'''


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sg-acefarm-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.acefarm = self.root/'acefarm'
        self.acefarm.write_text(FIXTURE)
        if os.environ.get('DSG_TEST_ACEFARM_SOURCE'):
            self.acefarm = Path(os.environ['DSG_TEST_ACEFARM_SOURCE'])
        self.audio = self.root/'song.flac'
        self.audio.write_bytes(b'fixture-audio-not-real-FLAC')
        self.metadata = dict(track='song',machine='stargate',caption='Test song',lyrics='Test lyrics',model='fixture-xl-sft',lm_model='fixture-4B',seed=11,thinking=False,inference_steps=80,guidance_scale=3.0,sampler_mode='heun',dcw_enabled=False,infer_method='ode',duration=-1)
        payload = dict(prompt=self.metadata['caption'],lyrics=self.metadata['lyrics'],model=self.metadata['model'],audio_duration=-1,batch_size=1,use_random_seed=False,audio_format='flac')
        for key in ('seed','thinking','inference_steps','guidance_scale','sampler_mode','dcw_enabled','infer_method'):
            payload[key] = self.metadata[key]
        self.receipt = dict(schema=1,gateway='http://127.0.0.1:30000',kind='music',id='10000000-0000-0000-0000-000000000000',payload=payload)
        parameters = {**{k:payload[k] for k in ('seed','thinking','inference_steps','guidance_scale','sampler_mode','dcw_enabled','infer_method','audio_format')}, 'duration':123.0}
        native = dict(schema=1,source='acestep.inference.audio.params',parameters=parameters,reported_models=dict(dit=self.metadata['model'],lm=self.metadata['lm_model']))
        self.job = dict(id=self.receipt['id'],kind='music',backend='ace-step',native_id='native-test',state='completed',execution=dict(phase='restoring_llm'),result=[dict(file='/v1/audio?path=%2Fout%2Fsong.flac',generation_receipt=native)],outputs=dict(state='ready',files=[dict(id='20000000-0000-0000-0000-000000000000',filename='song.flac',content_type='audio/flac')]))
        self.refresh_audio()
        self.receipt_file = self.root/'receipt.json'
        publisher.client.atomic(self.receipt_file,self.receipt)
        self.target = self.root/'listen_track1'
        self.publication = self.root/'receipt.json.publication.json'
        self.status = patch.object(publisher.client,'status',side_effect=lambda _:copy.deepcopy(self.job)).start()
        self.download = patch.object(publisher.client,'download',side_effect=lambda *_:dict(downloaded=[dict(path=str(self.audio),sha256=self.job['outputs']['files'][0]['sha256'])])).start()
        self.addCleanup(patch.stopall)

    def refresh_audio(self):
        self.job['outputs']['files'][0].update(sha256=hashlib.sha256(self.audio.read_bytes()).hexdigest(),bytes=self.audio.stat().st_size)

    def publish(self, **kwargs):
        return publisher.publish(self.receipt_file,self.metadata,self.acefarm,self.target,decoder=kwargs.get('decoder',lambda _:dict(full_decode=True)))

    def index(self):
        return json.loads((self.target/'track_index.json').read_text())

    def test_canonical_publication_preserves_metadata_and_restoration_is_separate(self):
        result = self.publish()
        module,_ = publisher.load_acefarm(self.acefarm)
        entry = result['entry']
        self.assertEqual(entry['id'],module.short_track_id(self.metadata))
        self.assertEqual(len(entry['id']),8)
        audio,sidecar = Path(entry['audio_path']),Path(entry['sidecar_path'])
        self.assertTrue(audio.name.startswith(entry['id']+'_'))
        self.assertFalse(audio.is_symlink())
        self.assertEqual(audio.read_bytes(),self.audio.read_bytes())
        saved = json.loads(sidecar.read_text())
        for key,value in self.metadata.items(): self.assertEqual(saved[key],value)
        self.assertEqual(saved['generation_params']['duration'],123.0)
        self.assertEqual(saved['duration'],-1)
        self.assertEqual(self.index(),[entry])
        self.assertEqual(result['restoration_phase'],'restoring_llm')
        for file in (audio,sidecar,self.publication): self.assertEqual(file.stat().st_mode & 0o777,0o600)

    def test_retry_preserves_reviews_and_unrelated_index_entries(self):
        entry = self.publish()['entry']
        sidecar = Path(entry['sidecar_path'])
        data = json.loads(sidecar.read_text()); data['rating']=5; sidecar.write_text(json.dumps(data))
        original = sidecar.read_bytes()
        entries = [{**entry,'rating':5},dict(id='other',owner_note='keep')]
        (self.target/'track_index.json').write_text(json.dumps(entries))
        self.job['execution']['phase']='returned'
        self.assertEqual(self.publish()['restoration_phase'],'returned')
        self.assertEqual(sidecar.read_bytes(),original)
        self.assertEqual(self.index(),entries)
        backups=list((self.root/'publication-backups').glob('*.json'))
        self.assertTrue(any(json.loads(p.read_text())==entries for p in backups))

    def test_crash_at_each_commit_boundary_recovers_same_files(self):
        real_atomic = publisher.client.atomic
        real_link = os.link
        for boundary in ('sidecar','index','receipt'):
            with self.subTest(boundary=boundary):
                self.target = self.root/('listen_'+boundary)
                self.receipt_file = self.root/(boundary+'.json')
                publisher.client.atomic(self.receipt_file,self.receipt)
                def atomic(filename,value):
                    if boundary=='index' and Path(filename)==self.target/'track_index.json': raise OSError('simulated crash')
                    if boundary=='receipt' and isinstance(value,dict) and value.get('state')=='published': raise OSError('simulated crash')
                    return real_atomic(filename,value)
                def link(src,dst):
                    if boundary=='sidecar' and str(dst).endswith('.json'): raise OSError('simulated crash')
                    return real_link(src,dst)
                with patch.object(publisher.client,'atomic',side_effect=atomic), patch.object(os,'link',side_effect=link):
                    with self.assertRaises(OSError): self.publish()
                result = self.publish()
                self.assertEqual(self.index(),[result['entry']])
                self.assertEqual(len(list(self.target.glob('*.flac'))),1)

    def test_native_recipe_model_and_file_mismatches_refuse_before_collection(self):
        baseline = copy.deepcopy(self.job)
        changes = [('sampler',lambda j:j['result'][0]['generation_receipt']['parameters'].update(sampler_mode='euler')),
                   ('cfg',lambda j:j['result'][0]['generation_receipt']['parameters'].update(guidance_scale=7)),
                   ('model',lambda j:j['result'][0]['generation_receipt']['reported_models'].update(dit='turbo')),
                   ('lm',lambda j:j['result'][0]['generation_receipt']['reported_models'].update(lm='other')),
                   ('echo',lambda j:j['result'][0]['generation_receipt'].update(source='ingress')),
                   ('file',lambda j:j['result'][0].update(file='/out/other.flac'))]
        for name,change in changes:
            with self.subTest(name=name):
                self.job=copy.deepcopy(baseline); change(self.job)
                with self.assertRaises(ValueError): self.publish()
        self.download.assert_not_called()
        self.assertFalse(self.publication.exists())

    def test_decoder_rejection_and_audio_changes_never_publish(self):
        with self.assertRaises(ValueError): self.publish(decoder=lambda _:dict(full_decode=False))
        self.assertFalse((self.target/'track_index.json').exists())
        def corrupt(file):
            file.write_bytes(b'changed'); return dict(full_decode=True)
        with self.assertRaises(ValueError): self.publish(decoder=corrupt)
        self.assertFalse(list(self.target.glob('*.flac')))

    def test_existing_owner_audio_and_invalid_index_are_preserved(self):
        entry=self.publish()['entry']; audio=Path(entry['audio_path'])
        audio.write_bytes(b'owner audio')
        with self.assertRaises(ValueError): self.publish()
        self.assertEqual(audio.read_bytes(),b'owner audio')
        audio.write_bytes(self.audio.read_bytes())
        index=self.target/'track_index.json'; index.write_text('{broken')
        with self.assertRaises(ValueError): self.publish()
        self.assertEqual(index.read_text(),'{broken')

    def test_symlink_audio_and_sidecar_refused(self):
        for field in ('audio_path','sidecar_path'):
            with self.subTest(field=field):
                entry=self.publish()['entry']; file=Path(entry[field]); original=file.read_bytes()
                owner=self.root/('owner-'+field); owner.write_bytes(original)
                file.unlink(); file.symlink_to(owner)
                with self.assertRaises((OSError,ValueError)): self.publish()
                self.assertEqual(owner.read_bytes(),original)
                file.unlink(); file.write_bytes(original)

    def test_changed_request_and_publisher_pin_preserve_intent(self):
        self.publish(); intent=self.publication.read_bytes()
        self.metadata['seed']=12
        with self.assertRaises(ValueError): self.publish()
        self.assertEqual(self.publication.read_bytes(),intent)
        self.metadata['seed']=11
        alternate=self.root/'alternate-acefarm'; alternate.write_bytes(self.acefarm.read_bytes()+b'\n# altered source\n')
        self.acefarm=alternate
        with self.assertRaises(ValueError): self.publish()
        self.assertEqual(self.publication.read_bytes(),intent)

    def test_index_collision_and_owner_changes_preserved(self):
        entry=self.publish()['entry']; index=self.target/'track_index.json'
        for changed in ([entry,entry],[dict(entry,audio_path='/owner/other.flac')],[dict(entry,seed=99)]):
            index.write_text(json.dumps(changed)); before=index.read_bytes()
            with self.assertRaises(ValueError): self.publish()
            self.assertEqual(index.read_bytes(),before)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FLAC tools unavailable')
    def test_real_flac_full_decode_and_invalid_codec_rejection(self):
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=0.25','-c:a','flac',str(self.audio)],check=True,capture_output=True)
        self.refresh_audio()
        entry=self.publish(decoder=publisher.decode_flac)['entry']
        saved=json.loads(Path(entry['sidecar_path']).read_text())
        self.assertTrue(saved['stargate']['decoded']['full_decode'])
        bad=self.root/'invalid.flac'; bad.write_bytes(b'not FLAC')
        with self.assertRaises((ValueError,subprocess.CalledProcessError)): publisher.decode_flac(bad)


if __name__=='__main__': unittest.main()
