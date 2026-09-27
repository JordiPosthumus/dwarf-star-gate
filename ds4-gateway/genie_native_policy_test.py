import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from genie_native_policy import NativeRequestPolicy, DISABLED, UNAVAILABLE
from genie_native_sessions import NativeSessionRequests


class NativePolicy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name) / 'requests'
        self.inject = Mock(return_value=True)
        self.requests = NativeSessionRequests(self.folder, ['owner-session', 'other-session'], self.inject)
        self.policy = NativeRequestPolicy(self.folder)

    def submit(self, research, suffix='abc'):
        payload = {'action': 'send', 'request_id': '12345678-1234-4234-8234-123456789' + suffix,
                   'session_key': 'owner-session', 'message': 'Inspect public documentation.', 'research': research}
        self.requests.dispatch(payload)
        return self.inject.call_args.args[0]

    def bind(self, message, turn='turn-one', session='native-owner', key='owner-session'):
        return self.policy.bind(session_id=session, turn_id=turn, session_key=key, user_message=message)

    def test_queued_options_survive_restart_and_remain_scoped_to_exact_turn(self):
        off = self.submit(False)
        on = self.submit(True, 'abd')
        self.policy = NativeRequestPolicy(self.folder)
        self.assertEqual(self.bind(off)['context'], DISABLED)
        self.assertEqual(self.policy.reason('native-owner', 'turn-one'), DISABLED)
        self.assertEqual(self.policy.reason('native-owner', 'another-turn'), UNAVAILABLE)
        self.bind('Ordinary Telegram input', session='native-other', key='other-session')
        self.assertIsNone(self.policy.reason('native-other', 'turn-one'))
        self.assertEqual(self.policy.reason('native-owner', 'turn-one'), DISABLED)
        self.bind(on, turn='turn-two')
        self.assertIsNone(self.policy.reason('native-owner', 'turn-two'))
        self.assertEqual(self.policy.reason('native-owner', 'turn-one'), UNAVAILABLE)

    def test_missing_changed_or_wrong_session_receipt_never_authorizes_research(self):
        message = self.submit(True)
        for value,key in [(message+' altered','owner-session'),(message,'other-session'),
                          ('[DSG request invalid]\n\nInspect','owner-session'),(None,'owner-session')]:
            with self.subTest(value=value,key=key):
                self.assertEqual(self.bind(value,key=key)['context'], UNAVAILABLE)
                self.assertEqual(self.policy.reason('native-owner','turn-one'), UNAVAILABLE)
        for file in self.folder.glob('*.json'):
            file.unlink()
        self.assertEqual(self.bind(message)['context'], UNAVAILABLE)

    def test_research_option_cannot_change_under_the_same_dispatch_identity(self):
        self.submit(False)
        payload = {'action': 'send', 'request_id': '12345678-1234-4234-8234-123456789abc',
                   'session_key': 'owner-session', 'message': 'Inspect public documentation.', 'research': True}
        with self.assertRaisesRegex(ValueError, 'different input'):
            self.requests.dispatch(payload)
        for value in (1, 'false', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.requests.dispatch({**payload,'research':value})
        self.assertEqual(self.inject.call_count, 1)

    def test_web_hook_blocks_only_web_and_never_uses_another_turn(self):
        self.bind(self.submit(False))
        for name in ('web_search','web_extract','stargate_web_search','stargate_web_extract'):
            self.assertEqual(self.policy.pre_tool(tool_name=name,session_id='native-owner',turn_id='turn-one'),
                             {'action':'block','message':DISABLED})
        self.assertIsNone(self.policy.pre_tool(tool_name='inspect_server',session_id='native-owner',turn_id='turn-one'))
        self.assertEqual(self.policy.pre_tool(tool_name='web_search',session_id='unknown',turn_id='turn-one')['message'],UNAVAILABLE)

    @unittest.skipUnless(importlib.util.find_spec('hermes_state'), 'Requires installed native Hermes')
    def test_registered_handler_uses_native_contextvars_even_if_hook_is_skipped(self):
        from tools.approval_context import set_current_observability_context, reset_current_observability_context
        self.bind(self.submit(False))
        tokens=set_current_observability_context(session_id='native-owner',turn_id='turn-one')
        try:
            self.assertEqual(self.policy.handler_reason('native-owner'),DISABLED)
            self.assertEqual(self.policy.handler_reason('different-session'),UNAVAILABLE)
        finally:
            reset_current_observability_context(tokens)
        self.assertEqual(self.policy.handler_reason('native-owner'),UNAVAILABLE)

    @unittest.skipUnless(importlib.util.find_spec('hermes_state'), 'Requires installed native Hermes')
    def test_full_study_context_binds_to_exact_turn_and_cannot_bleed_into_other_tools(self):
        from tools.approval_context import set_current_observability_context, reset_current_observability_context
        payload={'action':'send','request_id':'12345678-1234-4234-8234-123456789abc',
                 'session_key':'owner-session','message':'Research this setup.','research':True,
                 'study_context':{'study_brief':'Inspect actual source.',
                                  'previous_study':{'latest_completed_answer':{'text':'Evidence '*40000+'END'},'conversation_id':'private-study-id'}}}
        self.requests.dispatch(payload)
        self.assertEqual(self.bind(self.inject.call_args.args[0])['context'],'')
        tokens=set_current_observability_context(session_id='native-owner',turn_id='turn-one')
        try:
            copied=self.policy.handler_study_context('native-owner')
            self.assertEqual(copied,payload['study_context'])
            copied['previous_study']['conversation_id']='changed'
            self.assertEqual(self.policy.handler_study_context('native-owner')['previous_study']['conversation_id'],'private-study-id')
            self.assertIsNone(self.policy.handler_study_context('another-session'))
        finally:
            reset_current_observability_context(tokens)
        self.assertIsNone(self.policy.handler_study_context('native-owner'))
