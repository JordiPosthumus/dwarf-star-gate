"""Route authorized DSG UI input into an existing native Hermes conversation.

This adapter has no agent loop, Telegram SDK calls or conversation database.
Hermes's plugin injector owns session routing, authorization and delivery.
"""
import asyncio
import hashlib
import hmac
import json
import os
import stat
from datetime import datetime, timezone
from pathlib import Path
import threading
import uuid


def private_read(file, *, max_bytes=262144):
    try:
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid() or (max_bytes is not None and info.st_size > max_bytes):
            raise ValueError('Invalid private native UI record')
        return json.load(source)


def private_save(file, value):
    temporary = file.with_name('.' + str(uuid.uuid4()))
    try:
        with temporary.open('x') as output:
            os.chmod(temporary, 0o600)
            output.write(json.dumps(value) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, file)
        directory_fd = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def private_directory(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError('Native UI records require a private owned directory')
    return directory


def canonical_uuid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('Use a canonical request UUID')
    return value


class NativeConversationCatalog:
    """Private UI identity/title metadata only. Hermes stores every conversation."""
    def __init__(self, directory, owner):
        self.directory = private_directory(directory)
        self.owner = owner
        self.records = {}
        for file in self.directory.glob('*.json'):
            row = private_read(file)
            self.validate(row)
            if file.name != row['id'] + '.json':
                raise ValueError('Invalid native conversation identity')
            self.records[row['id']] = row

    def validate(self, row):
        if not isinstance(row, dict) or set(row) != {'id', 'title', 'purpose', 'owner', 'session_key', 'created_at'}:
            raise ValueError('Invalid native conversation metadata')
        canonical_uuid(row['id'])
        if not isinstance(self.owner, str) or not self.owner or row['owner'] != self.owner:
            raise ValueError('Native dashboard owner is not configured or changed')
        if row['session_key'] != 'agent:main:stargate_control:dm:' + row['id']:
            raise ValueError('Invalid native conversation binding')
        if not isinstance(row['title'], str) or not row['title'].strip() or len(row['title']) > 100 or row['purpose'] not in (None, 'setup_research'):
            raise ValueError('Invalid conversation title or purpose')
        if not isinstance(row['created_at'], str):
            raise ValueError('Invalid conversation timestamp')

    def prepare(self, identity, title, purpose):
        row = {'id': identity, 'title': title, 'purpose': purpose, 'owner': self.owner,
               'session_key': 'agent:main:stargate_control:dm:' + str(identity),
               'created_at': datetime.now(timezone.utc).isoformat()}
        self.validate(row)
        prior = self.records.get(identity)
        if prior:
            if any(prior[key] != row[key] for key in ('title', 'purpose', 'owner', 'session_key')):
                raise ValueError('Conversation identity belongs to different metadata')
            return prior
        # Save binding intent before native session creation. Reusing this UUID
        # resumes lookup of that identity; it never creates a second conversation.
        private_save(self.directory / (identity + '.json'), row)
        self.records[identity] = row
        return row


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
    for row, original in zip(rows, display):
        if original.get('display_kind') == 'dsg_legacy':
            legacy = (original.get('display_metadata') or {}).get('dsg_legacy')
            if not isinstance(legacy, dict) or legacy.get('schema') != 1:
                raise ValueError('Migrated conversation evidence is unavailable')
            row['dsg_legacy'] = legacy
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
        self.directory = private_directory(directory)
        self.allowed = frozenset(allowed)
        self.inject = inject
        self.lock = threading.Lock()

    def _path(self, request_id):
        canonical_uuid(request_id)
        return self.directory / (request_id + '.json')

    def _read(self, file):
        return private_read(file)

    def _save(self, file, value):
        private_save(file, value)

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
    from gateway.session import SessionSource

    class NativeUIAdapter(BasePlatformAdapter):
        def __init__(self, config):
            super().__init__(config, Platform('stargate_control'))
            from genie_native_queue import NativeTurnIdentities
            self.turn_identities = NativeTurnIdentities()
            self.requests = NativeSessionRequests(ctx.state.data_dir / 'ui-requests',
                                                  config.extra.get('allowed_session_keys', []), ctx.inject_message)
            self.conversations = NativeConversationCatalog(ctx.state.data_dir / 'ui-conversations',
                                                           config.extra.get('dashboard_owner_id'))
            self.requests.allowed |= frozenset(row['session_key'] for row in self.conversations.records.values())

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
                if payload.get('action') == 'create':
                    return await self.create_conversation(payload)
                if payload == {'action': 'conversations'}:
                    return {'state': 'observed', 'conversations': list(self.conversations.records.values())}
                if payload.get('action') == 'session':
                    return await self.observe_session(payload)
                if payload.get('action') == 'transcript':
                    return await self.read_transcript(payload)
                if payload.get('action') in ('stop', 'continue'):
                    return await self.control_session(payload)
                return self.requests.dispatch(payload)
            except ValueError as error:
                return {'state': 'rejected', 'error': str(error)}

        async def control_session(self, payload):
            from genie_native_controls import get_native_controls
            key = payload.get('session_key')
            expected = {'action', 'session_key', 'hold_id'} | ({'turn_id'} if payload.get('action') == 'stop' else set())
            if set(payload) != expected or key not in self.requests.allowed:
                raise ValueError('Use an explicitly connected native session and exact control identity')
            runner = self.gateway_runner
            control = get_native_controls(runner)
            entry = await runner.async_session_store.lookup_by_session_key(key)
            if entry is None or entry.origin is None:
                raise ValueError('Native session is unavailable')
            adapter = runner._adapter_for_source(entry.origin)
            if payload['action'] == 'stop':
                return await control.stop(entry, adapter, turn_id=payload['turn_id'], hold_id=payload['hold_id'])
            return await control.resume(entry, adapter, hold_id=payload['hold_id'])

        async def create_conversation(self, payload):
            if set(payload) != {'action', 'id', 'title', 'purpose'}:
                raise ValueError('Use one exact conversation creation request')
            canonical_uuid(payload['id'])
            owner = self.conversations.owner
            source = SessionSource(platform=self.platform, chat_id=payload['id'], chat_name=payload['title'],
                                   user_id=owner, chat_type='dm')
            runner = self.gateway_runner
            if not owner or runner is None or not runner._is_user_authorized(source, allow_adapter_delegation=False):
                raise ValueError('The native dashboard owner must be explicitly authorized')
            row = self.conversations.prepare(payload['id'], payload['title'], payload['purpose'])
            entry = await runner.async_session_store.lookup_by_session_key(row['session_key'])
            if entry is None:
                entry = await runner.async_session_store.get_or_create_session(source, touch_activity=False)
            if entry.session_key != row['session_key'] or entry.origin is None or entry.origin.user_id != owner:
                raise ValueError('Native conversation identity could not be verified')
            self.requests.allowed |= {entry.session_key}
            return {'state': 'created', **row, 'session_id': entry.session_id}

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
            from genie_native_controls import controls_enabled, get_native_controls
            control = get_native_controls(runner) if controls_enabled() else None
            return {'state': 'observed', 'session_key': key, 'session_id': entry.session_id,
                    'busy': key in active or bool(entry.active_turn_token),
                    'hold': control.observe(key) if control else None,
                    'turn_id': (control.identities if control else self.turn_identities).current(runner, adapter, key),
                    'queued': runner._queue_depth(key, adapter=adapter),
                    'suspended': bool(entry.suspended), 'resume_pending': bool(entry.resume_pending),
                    'platform': entry.origin.platform.value, 'user_id': entry.origin.user_id,
                    'observed_at': datetime.now(timezone.utc).isoformat()}

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            if chat_id not in self.conversations.records:
                return SendResult(success=False, error='Unbound dashboard conversation')
            # Hermes already persisted the native reply. The dashboard observes
            # that transcript; this transport acknowledges no external delivery.
            return SendResult(success=True, message_id=str(uuid.uuid4()))

        async def get_chat_info(self, chat_id):
            return {'name': 'DSG native session control', 'type': 'dm'}

    ctx.register_platform(name='stargate_control', label='DSG session control',
                          adapter_factory=NativeUIAdapter, check_fn=lambda: True,
                          validate_config=lambda config: bool(config.token), allow_update_command=False,
                          allowed_users_env='DSG_DASHBOARD_ALLOWED_USERS')
