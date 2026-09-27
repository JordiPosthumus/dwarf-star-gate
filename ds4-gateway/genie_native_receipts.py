"""Durable domain-operation receipts; Hermes remains the conversation store.

The existing handlers emit the actual operation handle before sending. Retain
that event before crossing the boundary, under exact native tool-call identity.
An interrupted invocation is never replayed by this journal.
"""
from datetime import datetime, timezone
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import stat
import threading

from genie_native_sessions import private_directory, private_read, private_save


def native_scope(session_id):
    from tools.approval_context import (_approval_session_key, _approval_session_id,
                                       _approval_turn_id, _approval_tool_call_id)
    values = {'session_key': _approval_session_key.get(), 'session_id': _approval_session_id.get(),
              'turn_id': _approval_turn_id.get(), 'tool_call_id': _approval_tool_call_id.get()}
    if values['session_id'] != session_id or any(not isinstance(v, str) or not v for v in values.values()):
        raise ValueError('Exact native tool identity is unavailable')
    return values


def receipt_identity(scope):
    if (not isinstance(scope, dict) or set(scope) != {'session_key', 'session_id', 'turn_id', 'tool_call_id'}
            or any(not isinstance(v, str) or not v for v in scope.values())):
        raise ValueError('Use exact native session, turn and tool identities')
    return hashlib.sha256(json.dumps(scope, sort_keys=True).encode()).hexdigest()


def native_call_anchor(scope, name, arguments):
    """Pinned Hermes flushes the assistant tool-call row before running handlers."""
    from hermes_state import SessionDB
    db = SessionDB(read_only=True)
    try:
        _, display = db.get_resume_conversations(scope['session_id'])
        for row in reversed(display):
            if row.get('role') != 'assistant':
                continue
            for call in row.get('tool_calls') or []:
                if call.get('id') != scope['tool_call_id']:
                    continue
                function = call.get('function') or {}
                actual_name = function.get('name')
                actual_args = function.get('arguments')
                if isinstance(actual_args, str):
                    actual_args = json.loads(actual_args)
                if actual_name == 'tool_call' and isinstance(actual_args, dict):
                    actual_name, actual_args = actual_args.get('name'), actual_args.get('arguments')
                    if isinstance(actual_args, str):
                        actual_args = json.loads(actual_args)
                if actual_name != name or actual_args != arguments or type(row.get('_row_id')) is not int:
                    raise ValueError('Native persisted tool call does not match dispatch')
                return {'row_id': row['_row_id'], 'tool_call_id': scope['tool_call_id'], 'tool': name}
        raise ValueError('Native persisted tool call is unavailable')
    finally:
        db.close()


class NativeOperationReceipts:
    def __init__(self, directory):
        self.directory = private_directory(directory)
        self.lock = threading.RLock()

    @contextmanager
    def guard(self):
        with self.lock:
            fd = os.open(self.directory / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise ValueError('Native receipt lock must be private and owned')
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                os.close(fd)

    def read(self, receipt_id):
        if not isinstance(receipt_id, str) or len(receipt_id) != 64 or any(c not in '0123456789abcdef' for c in receipt_id):
            raise ValueError('Invalid native operation receipt identity')
        row = private_read(self.directory / (receipt_id + '.json'), max_bytes=None)
        if row is not None and (row.get('schema') != 1 or row.get('receipt_id') != receipt_id
                or receipt_identity(row.get('scope')) != receipt_id
                or row.get('state') not in ('invoking', 'returned') or not isinstance(row.get('events'), list)
                or row.get('input_sha256') != hashlib.sha256(json.dumps([row.get('tool'), row.get('arguments')], sort_keys=True).encode()).hexdigest()
                or (row.get('state') == 'returned' and not isinstance(row.get('result'), str))):
            raise ValueError('Native operation receipt is inconsistent; preserve it for reconciliation')
        return row

    def save(self, row):
        private_save(self.directory / (row['receipt_id'] + '.json'), row)

    @staticmethod
    def unconfirmed(row):
        return json.dumps({'error': 'Native tool dispatch could not be confirmed. Inspect this saved receipt and its original operation IDs; do not repeat the mutation.',
                           'native_receipt_id': row['receipt_id'],
                           'operation_events': row['events'], 'dispatch_state': 'unconfirmed'})

    def execute(self, scope, name, arguments, invoke, *, anchor=None):
        identity = receipt_identity(scope)
        # Serialize journal decisions, never the independent native tool calls.
        with self.guard():
            prior = self.read(identity)
            if prior is not None:
                if prior['tool'] != name or prior['arguments'] != arguments:
                    raise ValueError('Native tool-call identity belongs to different input')
                return prior['result'] if prior['state'] == 'returned' else self.unconfirmed(prior)
            row = {'schema': 1, 'receipt_id': identity, 'scope': scope, 'tool': name,
                   'arguments': arguments, 'state': 'invoking', 'events': [],
                   'input_sha256': hashlib.sha256(json.dumps([name, arguments], sort_keys=True).encode()).hexdigest(),
                   'started_at': datetime.now(timezone.utc).isoformat(), 'native_call': anchor}
            self.save(row)

        def emit(kind, **payload):
            event = payload.get('event')
            if not isinstance(kind, str) or not isinstance(event, dict) or event.get('tool') != name:
                raise ValueError('Domain operation event does not match its native call')
            with self.guard():
                current = self.read(identity)
                if current is None or current['state'] != 'invoking':
                    raise ValueError('Native operation receipt is no longer open')
                self.save({**current, 'events': [*current['events'], {'kind': kind, **event}]})

        try:
            result = invoke(emit)
            if not isinstance(result, str):
                raise ValueError('Native domain handler returned an unsupported result')
            value = json.loads(result)
            if not isinstance(value, dict) or 'native_receipt_id' in value:
                raise ValueError('Native domain result cannot carry its receipt identity')
            result = json.dumps({**value, 'native_receipt_id': identity})
            with self.guard():
                current = self.read(identity)
                self.save({**current, 'state': 'returned', 'result': result,
                           'finished_at': datetime.now(timezone.utc).isoformat()})
            return result
        except Exception:
            # The original pre-dispatch event remains the authority. Do not
            # create a new action handle after an uncertain write or response.
            with self.guard():
                current = self.read(identity)
            return self.unconfirmed(current or row)

    def for_session(self, session_key, receipt_id=None):
        if not isinstance(session_key, str) or not session_key:
            raise ValueError('An exact native conversation is required')
        with self.guard():
            ids = [receipt_id] if receipt_id else [file.stem for file in self.directory.glob('*.json')]
            rows = [self.read(identity) for identity in ids]
            return sorted([row for row in rows if row is not None and row['scope']['session_key'] == session_key],
                          key=lambda row: (row['started_at'], row['receipt_id']))
