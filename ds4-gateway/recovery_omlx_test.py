import hashlib
import importlib.util
import json
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery_omlx', Path(__file__).with_name('recovery-omlx.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class OmlxRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name);self.journal = self.root/'actions.json'
        self.config = {'root':str(self.root),'binary':'/fixture/python','port':39001,
                       'command_sha256':'a'*64,'api_key_file':str(self.root/'credential'),'start_stopped':True}
        self.current = {'version':1,'active':True,'listener':True,'stopped':False,'pid':123,
                        'instance':'b'*32,'machine':'c'*64,'profile':'d'*64,'service_profile':'d'*64,'fault':None}
        self.restart = {'action':'restart','action_id':'12345678-1234-1234-1234-123456789abc',
                        'instance':'b'*32,'machine':'c'*64,'profile':'d'*64,'canary':True,'fault_after':0}

    def test_exact_idle_canary_terminates_once_and_uses_original_launcher(self):
        with patch.object(m,'inspect',return_value=self.current),patch.object(m,'idle',return_value=True),patch.object(m,'alive',return_value=False),patch.object(m,'profile',return_value='d'*64),patch.object(m,'port_occupied',return_value=False),patch.object(m.os,'kill') as kill,patch.object(m,'start',return_value=456) as start:
            result=m.handle(self.config,self.restart,self.journal)
            self.assertEqual(result['state'],'issued');self.assertEqual(result['launcher_pid'],456)
            self.assertEqual(m.handle(self.config,self.restart,self.journal),result)
            kill.assert_called_once_with(123,signal.SIGTERM);start.assert_called_once_with(self.config,self.journal,self.restart['action_id'])
            self.assertEqual(self.journal.stat().st_mode & 0o777,0o600)
            with self.assertRaisesRegex(ValueError,'instance_already_attempted'):
                m.handle(self.config,{**self.restart,'action_id':'22345678-1234-1234-1234-123456789abc'},self.journal)

    def test_running_jobs_changed_identity_or_noncanary_never_stop_any_process(self):
        for current,idle,request in [({**self.current,'instance':'e'*32},True,self.restart),
                                     (self.current,False,self.restart),
                                     (self.current,True,{**self.restart,'canary':False})]:
            with self.subTest(request=request,current=current,idle=idle),patch.object(m,'inspect',return_value=current),patch.object(m,'idle',return_value=idle),patch.object(m.os,'kill') as kill,patch.object(m,'start') as start:
                with self.assertRaises(ValueError):m.handle(self.config,request,self.journal)
                kill.assert_not_called();start.assert_not_called();self.assertFalse(self.journal.exists())

    def test_changed_identity_after_durable_intent_is_not_signalled_or_replayed(self):
        with patch.object(m,'inspect',side_effect=[self.current,self.current,{**self.current,'pid':456}]),patch.object(m,'idle',return_value=True),patch.object(m.os,'kill') as kill:
            with self.assertRaisesRegex(ValueError,'service_identity_changed'):m.handle(self.config,self.restart,self.journal)
            self.assertEqual(m.handle(self.config,self.restart,self.journal)['state'],'intent');kill.assert_not_called()

    def test_stopped_start_needs_explicit_permission_exact_epoch_and_empty_port(self):
        stopped={**self.current,'active':False,'stopped':True,'listener':False,'pid':0,'instance':'','stopped_epoch':'e'*64}
        request={'action':'start','action_id':self.restart['action_id'],'machine':'c'*64,'service_profile':'d'*64,'stopped_epoch':'e'*64}
        with patch.object(m,'inspect',return_value=stopped),patch.object(m,'profile',return_value='d'*64),patch.object(m,'port_occupied',return_value=False),patch.object(m,'start',side_effect=TimeoutError) as start:
            with self.assertRaisesRegex(ValueError,'not_enrolled'):m.handle({**self.config,'start_stopped':False},request,self.journal)
            with self.assertRaisesRegex(ValueError,'identity_changed'):m.handle(self.config,{**request,'stopped_epoch':'f'*64},self.journal)
            with self.assertRaises(TimeoutError):m.handle(self.config,request,self.journal)
            self.assertEqual(m.handle(self.config,request,self.journal)['state'],'intent');start.assert_called_once()

    def test_inspection_rejects_reused_pid_and_preserves_source_settings(self):
        (self.root/'server.pid').write_text('123\n')
        command='/fixture/python /fixture/omlx serve';config={**self.config,'command_sha256':hashlib.sha256(command.encode()).hexdigest()}
        with patch.object(m,'profile',return_value='d'*64),patch.object(m.mac,'machine_identity',return_value='c'*64),patch.object(m,'alive',return_value=True),patch.object(m.mac,'process_info',return_value={'executable':'/fixture/python','command':command,'started_at':100}),patch.object(m.mac,'owns_listener',return_value=True):
            value=m.inspect(config);self.assertTrue(value['active']);self.assertTrue(value['listener']);self.assertEqual(len(value['instance']),32)
            with patch.object(m.mac,'process_info',return_value={'executable':'/fixture/python','command':'unrelated','started_at':200}):
                with self.assertRaisesRegex(ValueError,'identity_changed'):m.inspect(config)
        with patch.object(m,'profile',return_value='d'*64),patch.object(m.mac,'machine_identity',return_value='c'*64),patch.object(m,'alive',return_value=False),patch.object(m,'port_occupied',return_value=True):
            value=m.inspect(config);self.assertTrue(value['stopped']);self.assertTrue(value['listener']);self.assertEqual(len(value['stopped_epoch']),64)


if __name__ == '__main__':unittest.main()
