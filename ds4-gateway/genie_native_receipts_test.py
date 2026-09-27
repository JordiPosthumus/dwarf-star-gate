import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from genie_native_receipts import NativeOperationReceipts, receipt_identity


class NativeReceipts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'operations'
        self.receipts = NativeOperationReceipts(self.directory)
        self.scope = {'session_key': 'native-conversation', 'session_id': 'native-session',
                      'turn_id': 'native-turn', 'tool_call_id': 'call-1'}
        self.tool = 'prepare_pair_recovery'
        self.args = {'worker_id': 'fixture'}
        self.event = {'tool': self.tool, 'state': 'reading', 'action_id': 'original-action', 'request': self.args}

    def test_actual_action_handle_is_durable_before_dispatch_and_same_call_never_replays(self):
        calls = []
        def invoke(emit):
            emit('recovery', event=self.event)
            saved = NativeOperationReceipts(self.directory).read(receipt_identity(self.scope))
            self.assertEqual(saved['events'][0]['action_id'], 'original-action')
            calls.append('sent')
            return json.dumps({'action_id': 'original-action', 'state': 'running'})
        result = self.receipts.execute(self.scope, self.tool, self.args, invoke)
        restored = NativeOperationReceipts(self.directory)
        self.assertEqual(restored.execute(self.scope, self.tool, self.args, lambda _: self.fail('No replay')), result)
        self.assertEqual(calls, ['sent'])
        self.assertEqual(json.loads(result)['state'], 'running')
        self.assertEqual(restored.read(receipt_identity(self.scope))['state'], 'returned')

    def test_crash_after_dispatch_keeps_original_identity_across_restart(self):
        def invoke(emit):
            emit('recovery', event=self.event)
            raise SystemExit('Simulated process exit after possible dispatch')
        with self.assertRaises(SystemExit):
            self.receipts.execute(self.scope, self.tool, self.args, invoke)
        restarted = NativeOperationReceipts(self.directory)
        result = json.loads(restarted.execute(self.scope, self.tool, self.args, lambda _: self.fail('No replay')))
        self.assertEqual(result['dispatch_state'], 'unconfirmed')
        self.assertEqual(result['operation_events'][0]['action_id'], 'original-action')
        self.assertEqual(restarted.for_session('other'), [])
        self.assertEqual(len(restarted.for_session(self.scope['session_key'])), 1)

    def test_failure_to_save_pre_dispatch_event_prevents_the_external_call(self):
        actual = self.receipts.save
        def save(row):
            if row['events']:
                raise OSError('Disk unavailable')
            actual(row)
        self.receipts.save = save
        calls = []
        def invoke(emit):
            emit('recovery', event=self.event)
            calls.append('must not send')
        result = json.loads(self.receipts.execute(self.scope, self.tool, self.args, invoke))
        self.assertEqual(calls, [])
        self.assertEqual(result['dispatch_state'], 'unconfirmed')

    def test_lost_final_write_keeps_dispatch_receipt_without_reissuing(self):
        actual = self.receipts.save
        def save(row):
            if row['state'] == 'returned':
                raise OSError('Lost final write')
            actual(row)
        self.receipts.save = save
        def invoke(emit):
            emit('recovery', event=self.event)
            return '{"state":"running"}'
        result = json.loads(self.receipts.execute(self.scope, self.tool, self.args, invoke))
        self.assertEqual(result['operation_events'][0]['action_id'], 'original-action')
        self.assertEqual(json.loads(NativeOperationReceipts(self.directory).execute(self.scope, self.tool, self.args,
            lambda _: self.fail('No replay')))['dispatch_state'], 'unconfirmed')

    def test_concurrent_independent_tools_remain_parallel_and_duplicate_is_unconfirmed(self):
        entered = threading.Event();release = threading.Event();results = []
        def slow(emit):
            emit('recovery', event=self.event);entered.set();release.wait(5)
            return '{"state":"running"}'
        thread = threading.Thread(target=lambda: results.append(self.receipts.execute(self.scope,self.tool,self.args,slow)))
        thread.start();self.addCleanup(lambda: (release.set(),thread.join()))
        self.assertTrue(entered.wait(5))
        duplicate = json.loads(NativeOperationReceipts(self.directory).execute(self.scope,self.tool,self.args,lambda _: self.fail('No duplicate')))
        self.assertEqual(duplicate['dispatch_state'],'unconfirmed')
        other = self.receipts.execute({**self.scope,'tool_call_id':'call-2'},self.tool,self.args,lambda _: '{"state":"running"}')
        self.assertEqual(json.loads(other)['state'],'running');release.set();thread.join(5)
        self.assertEqual(len(results),1)

    def test_identity_mismatch_and_invalid_scope_never_dispatch(self):
        self.receipts.execute(self.scope,self.tool,self.args,lambda _: '{"state":"running"}')
        with self.assertRaises(ValueError):
            self.receipts.execute(self.scope,self.tool,{'worker_id':'other'},lambda _: self.fail('Mismatch'))
        with self.assertRaises(ValueError):receipt_identity({**self.scope,'session_key':''})
        with self.assertRaises(ValueError):self.receipts.for_session('')


if __name__ == '__main__':
    unittest.main()
