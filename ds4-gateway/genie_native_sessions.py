"""Route authorized DSG UI input into an existing native Hermes conversation.

This adapter has no agent loop, Telegram SDK calls or conversation database.
Hermes's plugin injector owns session routing, authorization and delivery.
"""
import asyncio
import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import threading
import uuid


def native_display_page(db, session_id, offset, limit, revision=None):
    """Project Hermes's canonical display lineage, never its compressed model context.

    get_resume_conversations reads one native snapshot and preserves archived
    display generations. It does not rewrite the transcript or run an agent.
    """
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError('Invalid native display page')
    if revision is not None and (not isinstance(revision, str) or len(revision) != 64):
        raise ValueError('Invalid native display revision')
    resolved = db.resolve_resume_session_id(session_id)
    _, display = db.get_resume_conversations(resolved)
    keys = ('role', 'content', 'tool_call_id', 'tool_calls', 'tool_name', 'timestamp', 'finish_reason', 'display_kind')
    rows = [{'id': row['_row_id'], **{key: row[key] for key in keys if key in row}} for row in display]
    digest = hashlib.sha256(json.dumps([resolved, rows], sort_keys=True).encode()).hexdigest()
    if revision is not None and revision != digest:
        raise ValueError('Native display changed during observation; read it again')
    return {'state': 'observed', 'session_id': resolved, 'revision': digest,
            'data': rows[offset:offset + limit],
            'pagination': {'offset': offset, 'limit': limit, 'returned': len(rows[offset:offset + limit]),
                           'total': len(rows), 'order': 'oldest'},
            'scope': 'Native Hermes display lineage, including compacted history; reasoning is excluded.'}


class NativeSessionRequests:
    def __init__(self, directory, allowed, inject):
        if not isinstance(allowed, list) or any(not isinstance(key, str) or not key for key in allowed):
            raise ValueError('Configure an explicit list of native session keys')
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.directory.lstat()
        if self.directory.is_symlink() or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise ValueError('Native UI receipts require a private owned directory')
        self.allowed = frozenset(allowed)
        self.inject = inject
        self.lock = threading.Lock()

    def _path(self, request_id):
        if not isinstance(request_id, str) or str(uuid.UUID(request_id)) != request_id:
            raise ValueError('Use a canonical request UUID')
        return self.directory / (request_id + '.json')

    def _read(self, file):
        if file.is_symlink():
            raise ValueError('Invalid native UI receipt')
        return json.loads(file.read_text()) if file.exists() else None

    def _save(self, file, value):
        temporary = file.with_name('.' + str(uuid.uuid4()))
        try:
            with temporary.open('x') as output:
                os.chmod(temporary, 0o600)
                output.write(json.dumps(value) + '\n')
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, file)
        finally:
            temporary.unlink(missing_ok=True)

    def dispatch(self, payload):
        action = payload.get('action')
        expected = {'action', 'request_id'} if action == 'status' else {'action', 'request_id', 'session_key', 'message'}
        if action not in {'send', 'status'} or set(payload) != expected:
            raise ValueError('Use one exact send or status request')
        file = self._path(payload['request_id'])
        with self.lock:
            prior = self._read(file)
            if action == 'status':
                return prior or {'request_id': payload['request_id'], 'state': 'unknown'}
            session = payload['session_key']
            message = payload['message']
            if not isinstance(session, str) or session not in self.allowed or not isinstance(message, str) or not message.strip():
                raise ValueError('Use an explicitly connected native session and nonempty message')
            fingerprint = hashlib.sha256(json.dumps([session, message]).encode()).hexdigest()
            if prior:
                if prior['fingerprint'] != fingerprint:
                    raise ValueError('Request identity belongs to different input')
                # Even a process dying between acceptance and recording cannot
                # replay a possibly executing fleet instruction.
                return prior
            record = {'request_id': payload['request_id'], 'session_key': session,
                      'fingerprint': fingerprint, 'message': message, 'state': 'dispatching',
                      'created_at': datetime.now(timezone.utc).isoformat(),
                      'scope': 'Dispatch receipt only. Verify the matching native transcript before claiming completion. Uncertain dispatch must not be replayed.'}
            self._save(file, record)
            try:
                accepted = self.inject('[DSG request ' + payload['request_id'] + ']\n\n' + message, session_key=session)
                record['state'] = 'accepted_unverified' if accepted else 'not_accepted'
            except Exception:
                record['state'] = 'unknown'
            self._save(file, record)
            return record


def register_native_sessions(ctx):
    from gateway.config import Platform
    from gateway.platforms.base import BasePlatformAdapter, SendResult

    class NativeUIAdapter(BasePlatformAdapter):
        def __init__(self, config):
            super().__init__(config, Platform('stargate_control'))
            self.requests = NativeSessionRequests(ctx.state.data_dir / 'ui-requests',
                                                  config.extra.get('allowed_session_keys', []), ctx.inject_message)

        async def connect(self, *, is_reconnect=False):
            if not isinstance(self.config.token, str) or len(self.config.token) < 16:
                return False
            self._mark_connected()
            return True

        async def disconnect(self):
            self._running = False

        async def verify_http_event_request(self, authorization):
            expected = 'Bearer ' + (self.config.token or '')
            return (bool(self._running and self.config.token) and hmac.compare_digest(
                str(authorization).encode(), expected.encode()), 'native_ui_authorization')

        async def dispatch_http_event(self, payload):
            try:
                if payload.get('action') == 'session':
                    return await self.observe_session(payload)
                if payload.get('action') == 'transcript':
                    return await self.read_transcript(payload)
                return self.requests.dispatch(payload)
            except ValueError as error:
                return {'state': 'rejected', 'error': str(error)}

        async def read_transcript(self, payload):
            expected = {'action', 'session_key', 'session_id', 'offset', 'limit', 'revision'}
            key = payload.get('session_key')
            if set(payload) != expected or not isinstance(key, str) or key not in self.requests.allowed:
                raise ValueError('Use an explicitly connected native session')
            before = await self.observe_session({'action': 'session', 'session_key': key})
            if before.get('state') != 'observed' or payload.get('session_id') != before['session_id']:
                raise ValueError('Native session changed during observation; read it again')
            # Resolve the existing native store by session key so background UI
            # reads use the same profile as the Telegram conversation.
            db = await self.gateway_runner.async_session_store._db_for_key(key)
            if db is None:
                return {'state': 'unavailable', 'session_key': key}
            page = await asyncio.to_thread(native_display_page, db, before['session_id'],
                                          payload['offset'], payload['limit'], payload['revision'])
            after = await self.observe_session({'action': 'session', 'session_key': key})
            if after.get('state') != 'observed' or after['session_id'] != before['session_id']:
                raise ValueError('Native session changed during observation; read it again')
            return {**page, 'session_key': key}

        async def observe_session(self, payload):
            key = payload.get('session_key')
            if set(payload) != {'action', 'session_key'} or not isinstance(key, str) or key not in self.requests.allowed:
                raise ValueError('Use an explicitly connected native session')
            runner = self.gateway_runner
            if runner is None:
                return {'state': 'unavailable', 'session_key': key}
            entry = await runner.async_session_store.lookup_by_session_key(key)
            if entry is None or entry.origin is None:
                return {'state': 'missing', 'session_key': key}
            # Read the pinned native adapter's scheduler; never create a session,
            # mutate the routing index or infer idle from a persisted transcript.
            adapter = runner._adapter_for_source(entry.origin)
            active = getattr(adapter, '_active_sessions', None)
            pending = getattr(adapter, '_pending_messages', None)
            if not isinstance(active, dict) or not isinstance(pending, dict):
                return {'state': 'unavailable', 'session_key': key}
            return {'state': 'observed', 'session_key': key, 'session_id': entry.session_id,
                    'busy': key in active or bool(entry.active_turn_token), 'queued': int(key in pending),
                    'suspended': bool(entry.suspended), 'resume_pending': bool(entry.resume_pending),
                    'platform': entry.origin.platform.value, 'user_id': entry.origin.user_id,
                    'observed_at': datetime.now(timezone.utc).isoformat()}

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            return SendResult(success=False, error='Replies belong to the existing native session adapter')

        async def get_chat_info(self, chat_id):
            return {'name': 'DSG native session control', 'type': 'dm'}

    ctx.register_platform(name='stargate_control', label='DSG session control',
                          adapter_factory=NativeUIAdapter, check_fn=lambda: True,
                          validate_config=lambda config: bool(config.token), allow_update_command=False)
