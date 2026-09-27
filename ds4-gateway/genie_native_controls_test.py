import asyncio
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from genie_native_controls import NativeControls
from genie_native_queue import pack_event


@unittest.skipUnless(importlib.util.find_spec('gateway'), 'Installed native Hermes required')
class NativeControlTests(unittest.TestCase):
    def setUp(self):
        from gateway.config import Platform
        from gateway.session import SessionSource
        from gateway.platforms.event import MessageEvent
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runner = SimpleNamespace(_is_user_authorized_for_source=lambda s: s.user_id == '12345')
        self.control = NativeControls(self.runner, Path(self.temp.name) / 'holds')
        self.source = SessionSource(platform=Platform.TELEGRAM, chat_id='12345', user_id='12345')
        self.event = MessageEvent(text='Retain this question', source=self.source, message_id='41', platform_update_id=42)
        self.key = 'agent:main:telegram:dm:12345'
        self.hold = '11111111-1111-4111-8111-111111111111'
        self.entry = SimpleNamespace(session_key=self.key, session_id='native-fixture', origin=self.source, active_turn_token=None)
        self.record = {'schema': 1, 'hold_id': self.hold, 'session_key': self.key, 'session_id': self.entry.session_id,
                       'turn_id': 'old-turn', 'state': 'held', 'arrivals': [], 'admitted': 0,
                       'platform': 'telegram', 'chat_id': '12345', 'user_id': '12345'}
        self.control.save(self.record)
        self.control.active[self.key] = self.hold
        self.control.checkpoints.save(hold_id=self.hold, session_key=self.key, turn_id='old-turn', events=[self.event])
        self.control.checkpoints.confirm_detached(self.hold)

    def test_new_arrivals_are_private_durable_authorized_and_not_duplicated(self):
        self.assertTrue(self.control.gate(None, self.event, self.key))
        self.assertTrue(self.event._gateway_accepted)
        self.control.gate(None, self.event, self.key)
        self.assertEqual(len(self.control.holds[self.hold]['arrivals']), 1)
        restarted = NativeControls(self.runner, self.control.directory)
        self.assertEqual(restarted.holds[self.hold]['arrivals'][0]['event'], pack_event(self.event))
        self.event.source.user_id = 'untrusted'
        self.assertTrue(restarted.gate(None, self.event, self.key))
        self.assertFalse(self.event._gateway_accepted)
        self.assertEqual(len(restarted.holds[self.hold]['arrivals']), 1)
        self.assertFalse(restarted.gate(None, self.event, 'unrelated-session'))

    def test_save_failure_never_falls_through_to_native_admission(self):
        with patch('genie_native_controls.private_save', side_effect=OSError('fixture disk full')):
            with self.assertRaises(OSError):
                self.control.gate(None, self.event, self.key)
        self.assertFalse(getattr(self.event, '_gateway_accepted', False))
        self.assertEqual(self.control.holds[self.hold]['arrivals'], [])
        self.assertEqual(self.control.active[self.key], self.hold)

    def test_restart_preserves_uncertain_admission_and_refuses_replay(self):
        self.control.change(self.hold, state='resuming', admitting_index=0)
        restarted = NativeControls(self.runner, self.control.directory)
        self.assertEqual(restarted.observe(self.key)['state'], 'uncertain')
        adapter = SimpleNamespace(_active_sessions={}, handle_message=lambda e: self.fail('Uncertain input must not be replayed'))
        with self.assertRaisesRegex(ValueError, 'uncertain'):
            asyncio.run(restarted.resume(self.entry, adapter, hold_id=self.hold))

    def test_exception_after_native_admission_keeps_uncertainty_not_a_retryable_queue(self):
        admitted = []
        async def handle(event):
            admitted.append(event.text)
            event._gateway_accepted = True
            raise OSError('Native acknowledgement failed after acceptance')
        adapter = SimpleNamespace(_active_sessions={}, handle_message=handle, _event_session_key=lambda event: self.key)
        with self.assertRaises(OSError):
            asyncio.run(self.control.resume(self.entry, adapter, hold_id=self.hold))
        self.assertEqual(admitted, [self.event.text])
        self.assertEqual(self.control.observe(self.key)['state'], 'uncertain')
        with self.assertRaisesRegex(ValueError, 'uncertain'):
            asyncio.run(self.control.resume(self.entry, adapter, hold_id=self.hold))
        self.assertEqual(len(admitted), 1)

    def test_continue_uses_native_admission_and_a_duplicate_hold_cannot_replay(self):
        admitted = []
        async def handle(event):
            self.assertIs(self.control.replaying, event)
            self.assertFalse(self.control.gate(None, event, self.key))
            admitted.append(pack_event(event))
            event._gateway_accepted = True
        adapter = SimpleNamespace(_active_sessions={}, handle_message=handle, _event_session_key=lambda event: self.key)
        result = asyncio.run(self.control.resume(self.entry, adapter, hold_id=self.hold))
        self.assertEqual(result['state'], 'released')
        self.assertEqual(admitted, [pack_event(self.event)])
        self.assertEqual(asyncio.run(self.control.resume(self.entry, adapter, hold_id=self.hold)), result)
        self.assertEqual(len(admitted), 1)
        self.assertIsNone(self.control.observe(self.key))

    def test_native_debounce_acknowledges_both_initial_and_merged_input(self):
        from gateway.platforms.base import BasePlatformAdapter
        from gateway.platforms.event import MessageEvent
        async def exercise():
            store = {}
            timers = []
            async def flush(key, delay):
                await asyncio.sleep(delay)
            adapter = SimpleNamespace(_text_debounce_store=lambda: store,
                _can_merge_text_debounce_events=lambda a, b: True,
                _text_debounce_delay=lambda key: 60, _flush_text_debounce=flush)
            second = MessageEvent(text='The second Telegram burst', source=self.source, message_id='42')
            try:
                await BasePlatformAdapter._queue_text_debounce(adapter, self.key, self.event)
                timers.append(store[self.key].task)
                self.assertTrue(self.event._gateway_accepted)
                await BasePlatformAdapter._queue_text_debounce(adapter, self.key, second)
                timers.append(store[self.key].task)
                self.assertTrue(second._gateway_accepted)
                self.assertIn(second.text, store[self.key].event.text)
                self.assertEqual(len(store), 1, 'Native burst merging is preserved')
            finally:
                for timer in timers:
                    timer.cancel()
                await asyncio.gather(*timers, return_exceptions=True)
        asyncio.run(exercise())

    def test_changed_native_session_or_owner_cannot_receive_held_input(self):
        adapter = SimpleNamespace(_active_sessions={})
        self.entry.session_id = 'new-session'
        with self.assertRaisesRegex(ValueError, 'session changed'):
            asyncio.run(self.control.resume(self.entry, adapter, hold_id=self.hold))
        self.entry.session_id = 'native-fixture'
        self.entry.origin.user_id = 'changed-owner'
        with self.assertRaisesRegex(ValueError, 'authorization'):
            asyncio.run(self.control.resume(self.entry, adapter, hold_id=self.hold))

if __name__ == '__main__':
    unittest.main()
