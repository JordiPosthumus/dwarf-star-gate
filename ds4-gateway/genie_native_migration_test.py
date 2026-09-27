import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from genie_native_migration import stage_legacy_history, read_snapshot
from genie_native_sessions import native_display_page, private_save


@unittest.skipUnless(importlib.util.find_spec('hermes_state'), 'Requires installed native Hermes')
class HistoryMigration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'legacy'
        self.source.mkdir(mode=0o700)
        self.target = self.root / 'staging'
        self.identity = '11111111-1111-4111-8111-111111111111'
        self.file = self.source / (self.identity + '.json')
        self.row = {'version': 1, 'id': self.identity, 'title': 'Existing owner conversation', 'messages': [
            {'id': 'old-user', 'role': 'user', 'text': 'Recover my enrolled pair.', 'at': 1700000000123, 'state': 'complete', 'request_id': 'retained-request'},
            {'id': 'old-assistant', 'role': 'assistant', 'text': 'Recovery was not verified.', 'at': 1700000001456, 'state': 'failed',
             'error': 'Observation interrupted.', 'recovery': {'events': [{'tool': 'recover_server', 'state': 'complete', 'result': {'id': 'original-action', 'state': 'failed', 'logs': 'retain all bytes\n' * 30000}}]},
             'dispatch': {'schema': 1, 'available': True, 'calls': []}},
            {'id': 'old-second', 'role': 'assistant', 'text': 'Interrupted reply.', 'at': 1700000002999, 'state': 'interrupted'}]}
        private_save(self.file, self.row)
        self.bindings = [{'id': self.identity, 'platform': 'telegram', 'chat_id': '12345', 'user_id': '12345'}]

    def stage(self):
        return stage_legacy_history(self.source, self.target, self.bindings)

    def test_native_database_and_display_keep_exact_text_timestamps_states_and_all_receipts(self):
        from hermes_state import SessionDB
        before = self.file.read_bytes()
        receipt = self.stage()
        self.assertEqual(receipt['state'], 'staged')
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual((self.target / 'legacy-source' / self.file.name).read_bytes(), before)
        db = SessionDB(self.target / 'state.db')
        self.addCleanup(db.close)
        native_id = receipt['conversations'][0]['session_id']
        session = db.get_session(native_id)
        self.assertEqual(session['session_key'], 'agent:main:telegram:dm:12345')
        self.assertEqual(json.loads(session['origin_json'])['user_id'], '12345')
        page = native_display_page(db, native_id, 0, 500)
        self.assertEqual([row['dsg_legacy']['message'] for row in page['data']], self.row['messages'])
        self.assertEqual([row['timestamp'] for row in page['data']], [m['at']/1000 for m in self.row['messages']])
        self.assertTrue(all(not row.get('tool_calls') and not row.get('finish_reason') for row in page['data']))
        # A native follow-up extends the imported canonical history normally.
        db.append_message(native_id, 'user', 'Continue from the preserved record.')
        self.assertEqual(native_display_page(db, native_id, 0, 500)['pagination']['total'], 4)
        with self.assertRaisesRegex(ValueError, 'occupied'):
            self.stage()
        self.assertEqual(len(db.get_messages(native_id)), 4, 'No duplicate import or overwritten new history')

    def test_dashboard_origin_can_be_staged_offline_before_native_plugin_discovery(self):
        from hermes_state import SessionDB
        self.bindings[0].update(platform='stargate_control', chat_id=self.identity)
        receipt = self.stage()
        db = SessionDB(self.target / 'state.db')
        self.addCleanup(db.close)
        row = db.get_session(receipt['conversations'][0]['session_id'])
        self.assertEqual(row['session_key'], 'agent:main:stargate_control:dm:' + self.identity)
        self.assertEqual(json.loads(row['origin_json'])['platform'], 'stargate_control')
        self.assertEqual(row['user_id'], '12345')

    def test_active_and_held_source_work_is_not_migrated_or_lost(self):
        for key, value in [('state', 'working'), ('state', 'queued'), ('pending_dispatch', True)]:
            with self.subTest(key=key, value=value):
                original = dict(self.row['messages'][1])
                self.row['messages'][1][key] = value
                private_save(self.file, self.row)
                with self.assertRaisesRegex(ValueError, 'active or held'):
                    self.stage()
                self.assertFalse(self.target.exists())
                self.row['messages'][1] = original
        self.row['queue_paused'] = 'old-assistant'
        private_save(self.file, self.row)
        with self.assertRaisesRegex(ValueError, 'active or held'):
            self.stage()

    def test_source_drift_keeps_partial_bundle_but_never_publishes_a_valid_manifest(self):
        original = read_snapshot
        count = 0
        def changing(source):
            nonlocal count
            count += 1
            if count == 2:
                self.row['title'] = 'Owner changed this while staging'
                private_save(self.file, self.row)
            return original(source)
        with patch('genie_native_migration.read_snapshot', side_effect=changing):
            with self.assertRaisesRegex(ValueError, 'changed during migration'):
                self.stage()
        self.assertFalse((self.target / 'migration.json').exists())
        self.assertTrue((self.target / 'legacy-source' / self.file.name).exists())
        self.assertIn('Owner changed', self.file.read_text())

    def test_bindings_cannot_merge_conversations_or_skip_existing_ones(self):
        second = '22222222-2222-4222-8222-222222222222'
        private_save(self.source / (second + '.json'), {**self.row, 'id': second})
        with self.assertRaisesRegex(ValueError, 'every legacy'):
            self.stage()
        self.bindings.append({**self.bindings[0], 'id': second})
        with self.assertRaisesRegex(ValueError, 'same native session'):
            self.stage()
        self.assertFalse(self.target.exists())

    def test_source_symlink_is_rejected_and_progress_bytes_preserved(self):
        data = self.file.read_bytes()
        other = self.source / 'preserved.json'
        self.file.rename(other)
        self.file.symlink_to(other)
        with self.assertRaises(OSError):
            self.stage()
        self.file.unlink()
        self.file.write_bytes(data)
        self.file.chmod(0o600)
        progress = self.source / (self.identity + '.progress.json')
        private_save(progress, {'version': 1, 'partial': 'Original saved partial reply'})
        self.stage()
        self.assertEqual((self.target / 'legacy-source' / progress.name).read_bytes(), progress.read_bytes())

if __name__ == '__main__':
    unittest.main()
