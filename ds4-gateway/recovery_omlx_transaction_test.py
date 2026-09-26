"""Interruption/ownership tests for the staged native oMLX transaction."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec=importlib.util.spec_from_file_location('omlx_transaction',Path(__file__).with_name('recovery_omlx_transaction.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class Interruption(BaseException):pass


class OmlxTransactionTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name);(self.root/'state').mkdir()
        for name in ('serve.sh','state/settings.json','state/model_settings.json','start.py','server.pid'):
            (self.root/name).write_text('123\n' if name=='server.pid' else 'fixture: '+name)
        self.config={'root':str(self.root),'binary':'/fixture/python','port':39001,
                     'command_sha256':'a'*64,'api_key_file':str(self.root/'credential'),'start_stopped':False}
        self.filename=self.root/'omlx.json'
        self.request={'action':'transaction','action_id':'12345678-1234-1234-1234-123456789abc',
                      'instance':'b'*32,'machine':'c'*64,'profile':'d'*64,'canary':True,'gateway_socket':str(self.root/'control.sock')}
        self.initial={'active':True,'listener':True,'fault':None,'pid':123,'stopped':False,
                      'instance':'b'*32,'machine':'c'*64,'profile':'d'*64}
        self.current=copy.deepcopy(self.initial);self.stops=[];self.starts=[];self.clock=0
        self.owns=Mock(return_value=True);self.idle=Mock(return_value=True)
        self.journal=m.folder_for(self.filename)/(self.request['action_id']+'.json')

    def stop(self,pid):
        self.stops.append(pid)
        self.current={**self.initial,'active':False,'listener':False,'stopped':True,'pid':0,'instance':'','stopped_epoch':'e'*64}

    def start(self,*args):
        self.starts.append(args)
        self.current={**self.initial,'pid':456,'instance':'f'*32}
        return 455

    def sleep(self,delay):self.clock+=delay

    def run_action(self,**overrides):
        args={'inspect':lambda c:copy.deepcopy(self.current),'idle':self.idle,'owns':self.owns,
              'stop':self.stop,'start':self.start,'now':lambda:self.clock,'sleep':self.sleep,'budget':.4}
        args.update(overrides)
        return m.run_transaction(self.filename,self.config,self.request,**args)

    def crash_at(self,phase):
        def crash(current):
            if current==phase:raise Interruption()
        return crash

    def test_one_restart_retains_bytes_and_private_backup(self):
        before={str(p):p.read_bytes() for p in m.backup_files(self.config)}
        result=self.run_action();self.assertEqual(result['state'],'completed')
        self.assertEqual(result['new_instance'],'f'*32)
        self.assertEqual(self.stops,[123]);self.assertEqual(len(self.starts),1)
        self.assertEqual(self.starts[0],(self.config,self.journal,self.request['action_id']))
        self.assertEqual(before,{str(p):p.read_bytes() for p in m.backup_files(self.config)})
        self.assertEqual(self.run_action(),result);self.assertEqual(len(self.starts),1)
        backup=Path(m.private_read(self.journal)['backup'])
        self.assertEqual(backup.stat().st_mode&0o777,0o700)
        self.assertTrue(all(p.stat().st_mode&0o777==0o600 for p in backup.iterdir()))
        self.assertEqual(self.journal.stat().st_mode&0o777,0o600)

    def test_controller_loss_after_signal_resumes_same_action_without_second_signal(self):
        with self.assertRaises(Interruption):self.run_action(checkpoint=self.crash_at('stop_issued'))
        self.assertEqual(m.private_read(self.journal)['phase'],'stop_intent')
        self.assertEqual(self.run_action()['state'],'completed')
        self.assertEqual(self.stops,[123]);self.assertEqual(len(self.starts),1)

    def test_controller_loss_at_observed_stopped_resumes_one_launch(self):
        with self.assertRaises(Interruption):self.run_action(checkpoint=self.crash_at('stopped'))
        self.assertEqual(self.run_action()['state'],'completed')
        self.assertEqual(self.stops,[123]);self.assertEqual(len(self.starts),1)

    def test_loss_after_launch_before_receipt_observes_without_second_launch(self):
        with self.assertRaises(Interruption):self.run_action(checkpoint=self.crash_at('launch_issued'))
        self.assertEqual(m.private_read(self.journal)['phase'],'launch_intent')
        self.assertEqual(self.run_action()['state'],'completed')
        self.assertEqual(self.stops,[123]);self.assertEqual(len(self.starts),1)

    def test_loss_after_stop_intent_before_signal_never_reissues_ambiguous_signal(self):
        with self.assertRaises(Interruption):self.run_action(checkpoint=self.crash_at('stop_intent'))
        for _ in range(2):
            result=self.run_action();self.assertEqual(result['reason'],'omlx_transaction_stop_observation_pending')
        self.assertEqual(self.stops,[]);self.assertEqual(self.starts,[])

    def test_loss_after_launch_intent_before_command_never_replays_ambiguous_launch(self):
        with self.assertRaises(Interruption):self.run_action(checkpoint=self.crash_at('launch_intent'))
        for _ in range(2):self.assertEqual(self.run_action()['reason'],'omlx_transaction_launch_observation_pending')
        self.assertEqual(self.stops,[123]);self.assertEqual(self.starts,[])

    def test_ownership_revoked_while_stopped_waits_and_resumes_only_when_returned(self):
        with self.assertRaises(Interruption):self.run_action(checkpoint=self.crash_at('stopped'))
        self.owns.return_value=False
        self.assertEqual(self.run_action()['state'],'waiting_for_ownership');self.assertEqual(self.starts,[])
        self.owns.return_value=True;self.assertEqual(self.run_action()['state'],'completed')
        self.assertEqual(self.stops,[123]);self.assertEqual(len(self.starts),1)

    def test_busy_or_missing_ownership_before_intent_never_mutates(self):
        self.idle.return_value=False
        self.assertEqual(self.run_action()['reason'],'omlx_transaction_native_busy')
        self.idle.return_value=True;self.owns.return_value=False
        self.assertEqual(self.run_action()['state'],'waiting_for_ownership')
        self.assertEqual(self.stops,[]);self.assertEqual(self.starts,[])
        self.owns.return_value=True;self.assertEqual(self.run_action()['state'],'completed')

    def test_new_listener_does_not_complete_while_native_model_is_loading_or_busy(self):
        self.idle.side_effect=lambda config:not self.starts
        result=self.run_action();self.assertEqual(result['phase'],'launch_observed');self.assertEqual(result['state'],'pending')
        self.idle.side_effect=None;self.idle.return_value=True
        self.assertEqual(self.run_action()['state'],'completed')
        self.assertEqual(self.stops,[123]);self.assertEqual(len(self.starts),1)

    def test_final_stop_guard_detects_pid_reuse_and_cannot_be_reenabled(self):
        def change(phase):
            if phase=='stop_intent':self.current['pid']=456
        self.assertEqual(self.run_action(checkpoint=change)['state'],'uncertain')
        self.current=copy.deepcopy(self.initial)
        self.assertEqual(self.run_action()['state'],'uncertain')
        self.assertEqual(self.stops,[]);self.assertEqual(self.starts,[])

    def test_revocation_after_intent_never_signals(self):
        def revoke(phase):
            if phase=='stop_intent':self.owns.return_value=False
        self.assertEqual(self.run_action(checkpoint=revoke)['state'],'uncertain')
        self.assertEqual(self.stops,[])

    def test_final_start_guard_refuses_new_port_owner(self):
        def change(phase):
            if phase=='launch_intent':self.current['listener']=True
        self.assertEqual(self.run_action(checkpoint=change)['state'],'uncertain')
        self.assertEqual(self.stops,[123]);self.assertEqual(self.starts,[])

    def test_changed_profile_or_stopped_epoch_never_launches(self):
        with self.assertRaises(Interruption):self.run_action(checkpoint=self.crash_at('stopped'))
        stopped=copy.deepcopy(self.current)
        for field in ('profile','stopped_epoch'):
            self.current={**stopped,field:'9'*64}
            with self.assertRaises(ValueError):self.run_action()
        self.assertEqual(self.starts,[])

    def test_external_replacement_after_stop_is_sticky_uncertain(self):
        with self.assertRaises(Interruption):self.run_action(checkpoint=self.crash_at('stop_issued'))
        self.current={**self.initial,'pid':456,'instance':'f'*32}
        self.assertEqual(self.run_action()['reason'],'omlx_transaction_external_replacement')
        self.assertEqual(self.run_action()['state'],'uncertain');self.assertEqual(self.starts,[])

    def test_backup_failure_prevents_signal(self):
        (self.root/'serve.sh').unlink()
        with self.assertRaises(ValueError):self.run_action()
        self.assertEqual(self.stops,[]);self.assertEqual(self.starts,[])

    def test_corrupted_backup_or_journal_prevents_continuation(self):
        with self.assertRaises(Interruption):self.run_action(checkpoint=self.crash_at('stopped'))
        row=m.private_read(self.journal);backup=Path(row['backup'])/'0'
        data=backup.read_bytes();backup.write_text('corrupt')
        with self.assertRaisesRegex(ValueError,'backup_unverified'):self.run_action()
        backup.write_bytes(data)
        m.omlx.mac.atomic_save(self.journal,{**row,'stopped_epoch':None})
        with self.assertRaisesRegex(ValueError,'journal_unverified'):self.run_action()
        self.assertEqual(self.starts,[])

    def test_backup_symlinks_are_refused(self):
        with self.assertRaises(Interruption):self.run_action(checkpoint=self.crash_at('stopped'))
        backup=Path(m.private_read(self.journal)['backup'])/'0';backup.unlink();backup.symlink_to(self.root/'serve.sh')
        with self.assertRaises(OSError):self.run_action()
        self.assertEqual(self.starts,[])

    def test_live_runner_lease_refuses_second_runner(self):
        with m.lease(self.journal.parent/'runner.lock'):
            with self.assertRaisesRegex(ValueError,'runner_active'):self.run_action()
        self.assertEqual(self.stops,[])

    def test_legacy_adapter_lock_or_attempt_prevents_new_signal(self):
        with m.lease(self.filename.with_suffix('.actions.json.lock')):
            with self.assertRaisesRegex(ValueError,'runner_active'):self.run_action()
        m.omlx.mac.atomic_save(self.filename.with_suffix('.actions.json'),{'old-action':{'identity':self.request['instance'],'state':'intent'}})
        with self.assertRaisesRegex(ValueError,'instance_already_attempted'):self.run_action()
        self.assertEqual(self.stops,[]);self.assertEqual(self.starts,[])

    def test_parent_path_alias_uses_same_durable_journal(self):
        alias=self.root/'alias';alias.symlink_to(self.root,target_is_directory=True)
        self.assertEqual(m.folder_for(alias/'omlx.json'),m.folder_for(self.filename))

    def test_corrupted_terminal_backup_is_not_returned_as_valid_by_dispatch(self):
        self.run_action()
        m.omlx.mac.atomic_save(self.journal.with_suffix('.request'),{'request':self.request,'configuration':m.omlx.fingerprint(self.config)})
        (Path(m.private_read(self.journal)['backup'])/'0').write_text('corrupt')
        spawn=Mock()
        with self.assertRaisesRegex(ValueError,'backup_unverified'):m.dispatch(self.filename,self.config,self.request,owns=self.owns,popen=spawn)
        spawn.assert_not_called()

    def test_dispatch_uses_fixed_detached_command_and_refuses_changed_request(self):
        spawn=Mock();spawn.return_value.pid=678
        self.assertEqual(m.dispatch(self.filename,self.config,self.request,owns=self.owns,popen=spawn)['state'],'running')
        command=spawn.call_args.args[0]
        self.assertEqual(command[1:],[ '-I',str(Path(m.__file__).resolve()),str(self.filename.resolve()),self.request['action_id']])
        self.assertTrue(spawn.call_args.kwargs['start_new_session']);self.assertNotIn('shell',spawn.call_args.kwargs)
        changed={**self.request,'profile':'f'*64}
        with self.assertRaisesRegex(ValueError,'action_conflict'):m.dispatch(self.filename,self.config,changed,owns=self.owns,popen=spawn)
        with m.lease(self.journal.parent/'runner.lock'):
            self.assertEqual(m.dispatch(self.filename,self.config,self.request,owns=self.owns,popen=spawn)['state'],'running')
        self.assertEqual(spawn.call_count,1)

    def test_dispatch_refuses_other_action_or_reusing_original_instance(self):
        spawn=Mock();spawn.return_value.pid=678
        m.dispatch(self.filename,self.config,self.request,owns=self.owns,popen=spawn)
        other={**self.request,'action_id':'22345678-1234-1234-1234-123456789abc'}
        with self.assertRaisesRegex(ValueError,'instance_already_attempted'):m.dispatch(self.filename,self.config,other,owns=self.owns,popen=spawn)
        other['instance']='f'*32
        with self.assertRaisesRegex(ValueError,'other_action_unresolved'):m.dispatch(self.filename,self.config,other,owns=self.owns,popen=spawn)
        self.assertEqual(spawn.call_count,1)

    def test_dispatch_denied_ownership_creates_no_request(self):
        spawn=Mock();self.owns.return_value=False
        with self.assertRaisesRegex(ValueError,'ownership_unavailable'):m.dispatch(self.filename,self.config,self.request,owns=self.owns,popen=spawn)
        spawn.assert_not_called();self.assertEqual(list(self.journal.parent.glob('*.request')),[])

    def test_private_journals_and_socket_request_shape(self):
        for delta in ({'canary':False},{'action':'start'},{'action_id':'../bad'}, {'gateway_socket':'relative'}, {'command':'arbitrary'}):
            with self.subTest(delta=delta),self.assertRaises(ValueError):m.validate_request({**self.request,**delta})
        self.assertFalse(m.permitted(self.request))
        self.filename.write_text('{}');self.filename.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'file_unverified'):m.private_read(self.filename)


if __name__=='__main__':unittest.main()
