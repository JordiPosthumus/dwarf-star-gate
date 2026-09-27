import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from genie_native_sessions import NativeSessionRequests
from genie_native_pending import pending_native_inputs, combine_pending_inputs
from genie_native_queue import pack_event


@unittest.skipUnless(importlib.util.find_spec('gateway'), 'Installed native Hermes required')
class PendingInputs(unittest.TestCase):
    def setUp(self):
        from gateway.config import Platform
        from gateway.session import SessionSource
        from gateway.platforms.event import MessageEvent
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.key = 'agent:main:telegram:dm:12345'
        self.source = SessionSource(platform=Platform.TELEGRAM, chat_id='12345', user_id='12345')
        self.entry = SimpleNamespace(session_key=self.key, origin=self.source)
        self.event = lambda text, **kw: MessageEvent(text=text, source=self.source, **kw)
        self.head, self.tail, self.buffer = [self.event(text) for text in ['first', 'second', 'buffered']]
        self.state = SimpleNamespace(conversation=SimpleNamespace(queued_events=[self.tail]))
        self.runner = SimpleNamespace(_peek_session_state=lambda key: self.state,
                                      _is_user_authorized_for_source=lambda source: source.user_id == '12345')
        self.adapter = SimpleNamespace(_pending_messages={self.key: self.head},
                                       _text_debounce={self.key: SimpleNamespace(event=self.buffer)})
        self.injected = []
        self.requests = NativeSessionRequests(Path(self.temp.name) / 'requests', [self.key],
            lambda text, **kwargs: self.injected.append(text) or True)

    def observe(self, control=None):
        return pending_native_inputs(self.runner, self.adapter, self.entry, control, self.requests)

    def test_observations_preserve_native_order_and_never_detach_or_replay(self):
        rows = self.observe()
        self.assertEqual([row['text'] for row in rows], ['first', 'second', 'buffered'])
        self.assertEqual([row['state'] for row in rows], ['queued', 'queued', 'buffered'])
        self.assertIs(self.adapter._pending_messages[self.key], self.head)
        self.assertEqual(self.state.conversation.queued_events, [self.tail])
        self.assertIs(self.adapter._text_debounce[self.key].event, self.buffer)
        self.assertEqual(self.injected, [])

    def test_durable_receipts_remain_uncertain_until_history_and_queue_evidence_supersedes_them(self):
        payload={'action':'send','request_id':'12345678-1234-4234-8234-123456789abc','source_request_id':'source-request-12345',
                 'session_key':self.key,'message':'Original question','study_context':{'study_brief':'Full brief','previous_study':None}}
        self.requests.dispatch(payload)
        self.adapter._pending_messages[self.key]=self.event(self.injected[0])
        self.state.conversation.queued_events=[];self.adapter._text_debounce={}
        queued=self.observe();self.assertEqual(queued[0]['text'],'Original question')
        self.assertEqual(queued[0]['request_id'],payload['source_request_id'])
        restarted=NativeSessionRequests(self.requests.directory,[self.key],lambda *a,**kw:self.fail('No replay'))
        receipt=restarted.pending_receipts(self.key)
        self.assertEqual(receipt[0]['state'],'accepted_unverified')
        self.assertEqual(len(combine_pending_inputs(queued,receipt,set())),1)
        self.assertEqual(combine_pending_inputs(queued,receipt,{payload['request_id']}),[])
        with self.assertRaises(ValueError):restarted.pending_receipts('unbound')

    def test_held_and_uncertain_admission_keep_saved_text_without_double_display(self):
        packed=[pack_event(self.head),pack_event(self.tail)]
        self.adapter._text_debounce={};self.state.conversation.queued_events=[]
        control=SimpleNamespace(active={self.key:'hold'},holds={'hold':{'hold_id':'hold','state':'uncertain','admitted':0,'arrivals':[]}},
                                checkpoints=SimpleNamespace(read=lambda hold:{'events':packed}))
        rows=combine_pending_inputs(self.observe(control),[],set())
        self.assertEqual([row['text'] for row in rows],['first','second'])
        self.assertEqual([row['state'] for row in rows],['uncertain','uncertain'])
        control.holds['hold'].update(state='held',admitted=1)
        self.adapter._pending_messages={}
        self.assertEqual([row['text'] for row in self.observe(control)],['second'])
        self.assertEqual(self.injected,[])

    def test_wrong_origin_is_unavailable_instead_of_leaking_another_queue(self):
        from gateway.session import SessionSource
        self.tail.source=SessionSource(platform=self.source.platform,chat_id='other',user_id='12345')
        with self.assertRaises(ValueError):self.observe()


if __name__ == '__main__':
    unittest.main()
