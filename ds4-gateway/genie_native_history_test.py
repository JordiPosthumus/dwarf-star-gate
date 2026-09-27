"""Exercise the installed native Hermes display store in a disposable database."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from genie_native_sessions import native_display_page


@unittest.skipUnless(importlib.util.find_spec('hermes_state'), 'Requires the installed native Hermes runtime')
class NativeHistory(unittest.TestCase):
    def setUp(self):
        from hermes_state import SessionDB
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = SessionDB(Path(self.temp.name) / 'fixture.db')
        self.addCleanup(self.db.close)
        self.db.create_session('parent', 'telegram')
        self.db.append_message('parent', 'user', 'Inspect the original service.')
        self.db.append_message('parent', 'assistant', '', tool_calls=[
            {'id': 'call-fixture', 'type': 'function', 'function': {'name': 'inspect_fleet_service', 'arguments': '{"worker":"fixture"}'}}])
        self.db.append_message('parent', 'tool', '{"state":"running"}', tool_call_id='call-fixture', tool_name='inspect_fleet_service')
        self.db.append_message('parent', 'assistant', 'Inspection started.', finish_reason='stop', reasoning_content='private fixture reasoning')

    def test_compaction_preserves_original_display_and_tool_receipts_without_rewriting(self):
        self.db.archive_and_compact('parent', [{'role': 'user', 'content': 'Compressed fixture summary', '_compressed_summary': True}])
        before = self.db.get_messages('parent', include_inactive=True)
        self.assertFalse(any(row.get('tool_call_id') == 'call-fixture' for row in self.db.get_messages('parent')))
        page = native_display_page(self.db, 'parent', 0, 500)
        self.assertTrue(any(row.get('tool_call_id') == 'call-fixture' for row in page['data']))
        self.assertTrue(any(row.get('content') == 'Inspect the original service.' for row in page['data']))
        self.assertNotIn('private fixture reasoning', json.dumps(page))
        self.assertEqual(self.db.get_messages('parent', include_inactive=True), before)

    def test_native_continuation_keeps_ancestors_and_excludes_unrelated_branch(self):
        self.db.create_session('child', 'telegram', parent_session_id='parent')
        self.db.append_message('child', 'user', 'Continue the recovery.')
        self.db.create_session('branch', 'telegram', parent_session_id='parent', model_config={'_branched_from': 'parent'})
        self.db.append_message('branch', 'user', 'Unrelated explicit branch.')
        page = native_display_page(self.db, 'parent', 0, 500)
        self.assertEqual(page['session_id'], 'child')
        self.assertIn('Inspect the original service.', json.dumps(page))
        self.assertIn('Continue the recovery.', json.dumps(page))
        self.assertNotIn('Unrelated explicit branch.', json.dumps(page))

    def test_revision_prevents_joining_pages_across_a_concurrent_append(self):
        first = native_display_page(self.db, 'parent', 0, 2)
        second = native_display_page(self.db, 'parent', 2, 2, first['revision'])
        self.assertEqual(second['data'][0]['tool_call_id'], 'call-fixture')
        self.db.append_message('parent', 'user', 'New owner input.')
        with self.assertRaisesRegex(ValueError, 'changed during observation'):
            native_display_page(self.db, 'parent', 2, 2, first['revision'])

    def test_invalid_pages_are_rejected(self):
        for offset, limit in [(-1, 2), (True, 2), (0, False), (0, 501)]:
            with self.subTest(offset=offset, limit=limit), self.assertRaises(ValueError):
                native_display_page(self.db, 'parent', offset, limit)

    def test_operation_receipt_follows_its_exact_archived_native_row_and_changes_revision(self):
        first = native_display_page(self.db, 'parent', 0, 500)
        row = next(row for row in first['data'] if row.get('tool_calls'))
        record = {'native_call': {'row_id': row['id']}, 'events': [{'action_id': 'retained-action', 'state': 'reading'}]}
        observed = native_display_page(self.db, 'parent', 0, 500, operation_records=[record])
        self.assertNotEqual(first['revision'], observed['revision'])
        self.db.archive_and_compact('parent', [{'role': 'user', 'content': 'Compressed summary', '_compressed_summary': True}])
        archived = native_display_page(self.db, 'parent', 0, 500, operation_records=[record])
        decorated = [row for row in archived['data'] if row.get('dsg_operations')]
        self.assertEqual(len(decorated), 1)
        self.assertEqual(decorated[0]['dsg_operations'], [record])

    def test_full_revision_includes_request_metadata_even_when_message_count_is_unchanged(self):
        first = native_display_page(self.db, 'parent', 0, 1, request_metadata=lambda content: {'research': False})
        second = native_display_page(self.db, 'parent', 0, 1, request_metadata=lambda content: {'research': True})
        self.assertEqual(first['pagination']['total'], second['pagination']['total'])
        self.assertNotEqual(first['revision'], second['revision'])


if __name__ == '__main__':
    unittest.main()
