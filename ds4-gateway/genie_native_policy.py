"""Bind saved UI research choices to exact native turns, without an agent loop."""
from pathlib import Path
import re
import threading

from genie_native_sessions import canonical_uuid, private_read, request_fingerprint

WEB_TOOLS = frozenset({'web_search', 'web_extract', 'stargate_web_search', 'stargate_web_extract'})
UNAVAILABLE = 'Research authorization for this exact native turn could not be verified. No web request was issued.'
DISABLED = 'Web research is disabled for this request. No web request was issued.'


class NativeRequestPolicy:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.turns = {}
        self.lock = threading.Lock()

    def bind(self, *, session_id, turn_id, session_key, user_message):
        # A new turn starts unknown. A failed hook must never inherit another
        # request's authorization, including the previous turn in this session.
        key = (session_id, turn_id)
        if not all(isinstance(v, str) and v for v in key) or not session_key:
            return {'context': UNAVAILABLE}
        with self.lock:
            self.turns[session_id] = (turn_id, None)
        try:
            research = True  # Ordinary authorized Telegram input retains the global capability policy.
            if not isinstance(user_message, str):
                raise ValueError('Native input is not a text request')
            marker = re.match(r'^\[DSG request ([a-f0-9-]{36})\]\n\n', user_message)
            if user_message.startswith('[DSG request ') and marker is None:
                raise ValueError('Invalid native dispatch marker')
            if marker:
                canonical_uuid(marker[1])
                record = private_read(self.directory / (marker[1] + '.json'))
                if (record is None or record.get('request_id') != marker[1]
                        or record.get('session_key') != session_key
                        or record.get('message') != user_message[marker.end():]
                        or record.get('fingerprint') != request_fingerprint(record)):
                    raise ValueError('Native input does not match its saved dispatch')
                research = record.get('research', True)
            with self.lock:
                self.turns[session_id] = (turn_id, research)
            return {'context': '' if research else DISABLED}
        except Exception:
            return {'context': UNAVAILABLE}

    def reason(self, session_id, turn_id):
        with self.lock:
            current = self.turns.get(session_id)
        if current is None or not turn_id or current[0] != turn_id or current[1] is None:
            return UNAVAILABLE
        return None if current[1] else DISABLED

    def pre_llm(self, *, session_id='', turn_id='', user_message=None, **_kwargs):
        from tools.approval_context import get_current_session_key
        return self.bind(session_id=session_id, turn_id=turn_id,
                         session_key=get_current_session_key(''), user_message=user_message)

    def pre_tool(self, *, tool_name='', session_id='', turn_id='', **_kwargs):
        if tool_name in WEB_TOOLS:
            reason = self.reason(session_id, turn_id)
            if reason:
                return {'action': 'block', 'message': reason}

    def handler_reason(self, session_id):
        # The pinned upstream registry binds these ContextVars around every
        # handler, including parallel dispatch. No process-global session fallback.
        from tools.approval_context import _approval_session_id, _approval_turn_id
        if not session_id or _approval_session_id.get() != session_id:
            return UNAVAILABLE
        return self.reason(session_id, _approval_turn_id.get())
