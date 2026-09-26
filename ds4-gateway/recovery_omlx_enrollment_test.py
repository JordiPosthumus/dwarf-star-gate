import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('omlx_enrollment',Path(__file__).with_name('recovery-omlx-enrollment.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class OmlxEnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.destination=self.root/'enrollment'
        self.expected={'worker_id':'local','route':{'id':'local','url':'http://127.0.0.1:8013/v1'},
                       'target':{'kind':'omlx-local','root':str(self.root),'url':'http://127.0.0.1:8013/v1','api_key_file':str(self.root/'key')},
                       'launcher':str(self.root/'start.sh'),'profile_files':[],
                       'model':'fixture','context_length':400000,'concurrency':1}
        self.config={'root':str(self.root),'binary':'/fixture/python','port':8013,'command_sha256':'a'*64,
                     'api_key_file':str(self.root/'key'),'launcher':self.expected['launcher'],'profile_files':[],'start_stopped':False}
        self.inspection={'machine':'a'*64,'profile':'b'*64,'instance':'c'*32,'active':True,'listener':True,'stopped':False,'fault':None}
        self.metadata={'model':'fixture','context_length':400000,'configured_concurrency':1}

    def run_capture(self,**kwargs):
        return m.materialize(self.destination,self.expected,capture=lambda _:copy.deepcopy(self.config),
                             inspect=kwargs.get('inspect',lambda _:copy.deepcopy(self.inspection)),
                             read_metadata=kwargs.get('metadata',lambda _:copy.deepcopy(self.metadata)))

    def test_capture_pins_stable_native_identity_and_is_idempotent_without_actions(self):
        with patch.object(m.omlx.os,'kill') as kill,patch.object(m.omlx,'start') as start:
            first=self.run_capture();second=self.run_capture()
            self.assertEqual(first,second);kill.assert_not_called();start.assert_not_called()
        self.assertEqual(first['context_length'],400000);self.assertEqual(first['concurrency'],1)
        self.assertEqual(m.read_json(self.destination/'omlx.json'),self.config)
        evidence=m.read_json(self.destination/'evidence.json')
        self.assertEqual(evidence['stable_observations'],3)
        self.assertEqual(first['evidence_sha256'],m.omlx.fingerprint(evidence))
        for name in ['omlx.json','evidence.json','capture.lock']:
            self.assertEqual((self.destination/name).stat().st_mode&0o777,0o600)

    def test_mid_capture_identity_metadata_or_listener_change_never_installs(self):
        for change in ['instance','profile','listener','stopped','metadata']:
            with self.subTest(change=change):
                self.destination=self.root/change
                count=[0]
                def inspect(_):
                    count[0]+=1;value=copy.deepcopy(self.inspection)
                    if count[0]>1 and change!='metadata':value[change]=False if change=='listener' else True if change=='stopped' else 'd'*32
                    return value
                reads=[0]
                def metadata(_):
                    reads[0]+=1;return {**self.metadata,**({'context_length':8192} if reads[0]>1 and change=='metadata' else {})}
                with self.assertRaisesRegex(ValueError,'no_longer_current'):self.run_capture(inspect=inspect,metadata=metadata)
                self.assertFalse((self.destination/'omlx.json').exists())

    def test_resumed_capture_cannot_replace_pinned_configuration_or_process(self):
        self.run_capture();original=(self.destination/'evidence.json').read_bytes()
        self.config['command_sha256']='d'*64
        with self.assertRaisesRegex(ValueError,'existing_enrollment_changed'):self.run_capture()
        self.config['command_sha256']='a'*64;self.inspection['instance']='d'*32
        with self.assertRaisesRegex(ValueError,'existing_capture_changed'):self.run_capture()
        self.assertEqual((self.destination/'evidence.json').read_bytes(),original)

    def test_readonly_partial_capture_can_finish_after_metadata_write(self):
        self.run_capture();(self.destination/'omlx.json').unlink()
        old=(self.destination/'evidence.json').read_bytes();self.run_capture()
        self.assertEqual((self.destination/'evidence.json').read_bytes(),old)
        self.assertTrue((self.destination/'omlx.json').exists())

    def test_unsafe_paths_and_changed_private_inputs_refuse_before_capture(self):
        for change in [{'route':{'id':'local','url':'http://127.0.0.1:9999/v1'}},
                       {'launcher':'relative'}, {'profile_files':['/a','/a']}, {'concurrency':True}, {'extra':'arbitrary'}]:
            with self.subTest(change=change),self.assertRaises(ValueError):m.validate_expected({**self.expected,**change})
        for url in ['https://127.0.0.1:8013/v1','http://example.invalid:8013/v1','http://user@127.0.0.1:8013/v1','http://127.0.0.1:8013/v1?x=1']:
            changed=copy.deepcopy(self.expected);changed['route']['url']=changed['target']['url']=url
            with self.assertRaises(ValueError):m.validate_expected(changed)

    def test_existing_public_or_symlinked_output_is_not_trusted(self):
        self.run_capture();wrapper=self.destination/'omlx.json';wrapper.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'file_unverified'):self.run_capture()
        wrapper.unlink();wrapper.symlink_to(self.destination/'evidence.json')
        with self.assertRaisesRegex(ValueError,'file_unverified'):self.run_capture()


if __name__=='__main__':unittest.main()
