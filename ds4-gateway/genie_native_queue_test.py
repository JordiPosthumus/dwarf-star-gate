from datetime import datetime, timezone
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from genie_native_queue import NativeQueueCheckpoints, NativeTurnIdentities, checkpoint_pending, pack_event, unpack_event

NATIVE = importlib.util.find_spec('gateway') is not None and importlib.util.find_spec('telegram') is not None


@unittest.skipUnless(NATIVE, 'Installed native Hermes and messaging runtime required')
class NativeQueue(unittest.TestCase):
    def setUp(self):
        from gateway.config import Platform
        from gateway.platforms.event import MessageEvent, MessageType
        from gateway.session import SessionSource
        from gateway.session_state import SessionState
        from telegram import Chat, Message, User
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = NativeQueueCheckpoints(Path(self.temp.name) / 'checkpoints')
        self.hold_id = '12345678-1234-4234-8234-123456789abc'
        self.key = 'agent:main:telegram:dm:12345'
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.first = MessageEvent(text='First queued question with media', message_type=MessageType.DOCUMENT,
            source=SessionSource(platform=Platform.TELEGRAM, chat_id='12345', user_id='12345', message_id='41'),
            raw_message=Message(message_id=41, date=now, chat=Chat(id=12345, type='private'),
                                from_user=User(id=12345, first_name='Fixture', is_bot=False), text='First queued question with media'),
            media_urls=['/private/fixture/movie.mp4'], media_types=['video/mp4'], media_text_inlined=[False],
            reply_to_message_id='40', reply_to_text='Original question', reply_to_author_id='12345',
            platform_update_id=71, message_id='41', timestamp=now, metadata={'fixture': ['retain', 1]})
        self.second = MessageEvent(text='/start is data here', source=self.first.source, internal=True,
                                   allow_gateway_control=False, timestamp=now)
        self.state = SessionState()
        self.state.conversation.queued_events.append(self.second)
        self.adapter = SimpleNamespace(_pending_messages={self.key: self.first})
        self.runner = SimpleNamespace(_peek_session_state=lambda key: self.state)

    def checkpoint(self, **kwargs):
        return checkpoint_pending(store=self.store, hold_id=self.hold_id, session_key=self.key,
            turn_id='process-fixture:turn-1', adapter=self.adapter, runner=self.runner,
            current_turn=kwargs.get('current_turn', lambda: 'process-fixture:turn-1'))

    def assert_intact(self):
        self.assertIs(self.adapter._pending_messages[self.key], self.first)
        self.assertEqual(len(self.state.conversation.queued_events), 1)
        self.assertIs(self.state.conversation.queued_events[0], self.second)

    def test_native_events_keep_media_raw_telegram_replies_and_trust_bits_across_restart(self):
        saved = self.checkpoint()
        self.assertEqual(saved['state'], 'held')
        self.assertNotIn(self.key, self.adapter._pending_messages)
        self.assertEqual(len(self.state.conversation.queued_events), 0)
        restarted = NativeQueueCheckpoints(self.store.directory)
        self.assertEqual(restarted.read(self.hold_id), saved)
        events = [unpack_event(row) for row in saved['events']]
        self.assertEqual([pack_event(event) for event in events], [pack_event(self.first), pack_event(self.second)])
        self.assertFalse(events[1].allow_gateway_control)
        self.assertTrue(events[1].internal)
        self.assertEqual(events[0].raw_message.message_id, 41)
        self.assertEqual(events[0].media_urls, ['/private/fixture/movie.mp4'])
        self.assertEqual((self.store.directory / (self.hold_id + '.json')).stat().st_mode & 0o777, 0o600)

    def test_save_failure_and_unrepresentable_metadata_leave_both_native_slots_untouched(self):
        with patch('genie_native_queue.private_save', side_effect=OSError('Fixture disk full')):
            with self.assertRaises(OSError):
                self.checkpoint()
        self.assert_intact()
        self.second.metadata['unrepresentable'] = object()
        with self.assertRaises(TypeError):
            self.checkpoint()
        self.assert_intact()
        self.assertIsNone(self.store.read(self.hold_id))

    def test_old_stop_identity_never_detaches_a_newer_turn(self):
        with self.assertRaisesRegex(ValueError, 'turn changed'):
            self.checkpoint(current_turn=lambda: 'process-fixture:turn-2')
        self.assert_intact()
        self.assertIsNone(self.store.read(self.hold_id))
        observed = iter(['process-fixture:turn-1', 'process-fixture:turn-2'])
        with self.assertRaisesRegex(ValueError, 'queue changed'):
            self.checkpoint(current_turn=lambda: next(observed))
        self.assert_intact()
        self.assertIsNotNone(self.store.read(self.hold_id), 'Saved evidence is retained, never replayed')
        self.assertEqual(self.store.read(self.hold_id)['state'], 'prepared', 'A stale turn was not detached')

    def test_failed_detachment_receipt_restores_native_queue_and_keeps_uncertain_evidence(self):
        with patch.object(self.store, 'confirm_detached', side_effect=OSError('Fixture write failure')):
            with self.assertRaises(OSError):
                self.checkpoint()
        self.assert_intact()
        self.assertEqual(self.store.read(self.hold_id)['state'], 'prepared')

    def test_failure_after_terminal_replace_does_not_duplicate_held_events(self):
        original = self.store.confirm_detached
        def committed_then_failed(hold_id):
            original(hold_id)
            raise OSError('Fixture failure after atomic replace')
        with patch.object(self.store, 'confirm_detached', side_effect=committed_then_failed):
            with self.assertRaises(OSError):
                self.checkpoint()
        self.assertNotIn(self.key, self.adapter._pending_messages)
        self.assertEqual(len(self.state.conversation.queued_events), 0)
        self.assertEqual(self.store.read(self.hold_id)['state'], 'held')
        self.assertEqual(len(self.store.read(self.hold_id)['events']), 2)

    def test_reusing_checkpoint_for_different_input_does_not_remove_native_queue(self):
        self.store.save(hold_id=self.hold_id, session_key=self.key, turn_id='other-turn', events=[self.first])
        with self.assertRaisesRegex(ValueError, 'another native turn'):
            self.checkpoint()
        self.assert_intact()

    def test_oversized_queue_is_preserved_and_schema_drift_cannot_drop_fields(self):
        self.second.text = 'x' * 270000
        with self.assertRaisesRegex(ValueError, 'record limit'):
            self.checkpoint()
        self.assert_intact()
        row = pack_event(self.first)
        del row['reply_to_text']
        with self.assertRaisesRegex(ValueError, 'schema changed'):
            unpack_event(row)

    def test_native_turn_identity_survives_reads_but_not_guard_replacement_generation_or_restart(self):
        guard = asyncio.Event()
        guard._hermes_run_generation = 3
        self.adapter._active_sessions = {self.key: guard}
        self.state.persistent.run_generation = 3
        identities = NativeTurnIdentities()
        current = lambda: identities.current(self.runner, self.adapter, self.key)
        identity = current()
        self.assertIsInstance(identity, str)
        self.assertEqual(current(), identity)
        self.assertNotEqual(NativeTurnIdentities().current(self.runner, self.adapter, self.key), identity)
        self.state.persistent.run_generation = 4
        self.assertIsNone(current(), 'An invalidated old guard is not stoppable')
        replacement = asyncio.Event()
        self.adapter._active_sessions[self.key] = replacement
        self.assertIsNone(current(), 'Pre-admission guard is not a verified execution')
        replacement._hermes_run_generation = 4
        self.assertNotEqual(current(), identity)


if __name__ == '__main__':
    unittest.main()
