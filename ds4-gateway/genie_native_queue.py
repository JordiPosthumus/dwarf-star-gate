"""Durable checkpoints for pending native Hermes events, not an agent scheduler.

Stopping a turn must save its pending native events before removing them from
Hermes's queue. This module does not interrupt agents, admit new work, or replay
events. The control integration must reauthorize and dispatch through Hermes.
"""
from dataclasses import fields
from datetime import datetime
import hashlib
import json
import uuid
import weakref

from genie_native_sessions import canonical_uuid, private_directory, private_read, private_save


class NativeTurnIdentities:
    """Identity of the live native guard/generation, never a transcript row."""
    def __init__(self):
        self.process_id = str(uuid.uuid4())
        self.guards = weakref.WeakKeyDictionary()

    def current(self, runner, adapter, session_key):
        guard = adapter._active_sessions.get(session_key)
        state = runner._peek_session_state(session_key)
        generation = getattr(guard, '_hermes_run_generation', None)
        # A guard before admission, or an invalidated turn still unwinding, is
        # not an exact stoppable execution. Expose uncertainty instead of IDs
        # guessed from an old transcript or a durable active-turn marker.
        if guard is None or state is None or type(generation) is not int or generation != state.persistent.run_generation:
            return None
        if guard not in self.guards:
            self.guards[guard] = str(uuid.uuid4())
        return self.process_id + ':' + self.guards[guard] + ':' + str(generation)


def pack_event(event):
    """Keep every native field, including media, replies, and command trust bits."""
    from gateway.platforms.event import MessageEvent
    if type(event) is not MessageEvent or event.source is None:
        raise ValueError('A native message event with an origin is required')
    source = event.source
    if source.platform.value not in ('telegram', 'stargate_control') or source.delivered_via_upstream_relay:
        raise ValueError('This native queue checkpoint does not support that transport')
    values = {field.name: getattr(event, field.name) for field in fields(event) if field.init}
    values['source'] = {field.name: getattr(source, field.name) for field in fields(source) if field.init}
    values['source']['platform'] = source.platform.value
    values['message_type'] = event.message_type.value
    values['timestamp'] = event.timestamp.isoformat()
    raw = event.raw_message
    if raw is not None:
        from telegram import Message
        if type(raw) is not Message:
            raise ValueError('Native raw message cannot be checkpointed without losing its type')
        values['raw_message'] = {'telegram_message_json': raw.to_json()}
    # Refuse unrepresentable metadata BEFORE the caller removes any event.
    return json.loads(json.dumps(values, allow_nan=False))


def unpack_event(values, *, telegram_bot=None):
    from gateway.config import Platform
    from gateway.platforms.event import MessageEvent, MessageType
    from gateway.session import SessionSource
    if not isinstance(values, dict) or set(values) != {field.name for field in fields(MessageEvent) if field.init}:
        raise ValueError('Native event schema changed; preserve the checkpoint')
    source = values.get('source')
    if not isinstance(source, dict) or set(source) != {field.name for field in fields(SessionSource) if field.init}:
        raise ValueError('Native origin schema changed; preserve the checkpoint')
    if source['platform'] not in ('telegram', 'stargate_control') or source['delivered_via_upstream_relay']:
        raise ValueError('Unsupported checkpoint origin')
    copy = {**values, 'source': SessionSource(**{**source, 'platform': Platform(source['platform'])}),
            'message_type': MessageType(values['message_type']), 'timestamp': datetime.fromisoformat(values['timestamp'])}
    raw = values['raw_message']
    if raw is not None:
        from telegram import Message
        if not isinstance(raw, dict) or set(raw) != {'telegram_message_json'}:
            raise ValueError('Unsupported checkpoint raw message')
        copy['raw_message'] = Message.de_json(json.loads(raw['telegram_message_json']), telegram_bot)
    return MessageEvent(**copy)


class NativeQueueCheckpoints:
    def __init__(self, directory):
        self.directory = private_directory(directory)

    def read(self, hold_id):
        canonical_uuid(hold_id)
        record = private_read(self.directory / (hold_id + '.json'))
        if record is not None:
            if not isinstance(record, dict) or set(record) != {'schema', 'hold_id', 'session_key', 'turn_id', 'fingerprint', 'state', 'events'} or record.get('hold_id') != hold_id or record.get('schema') != 1 or record.get('state') not in ('prepared', 'held') or not isinstance(record.get('events'), list):
                raise ValueError('Invalid native queue checkpoint')
            fingerprint = hashlib.sha256(json.dumps([record['session_key'], record['turn_id'], record['events']], sort_keys=True).encode()).hexdigest()
            if record['fingerprint'] != fingerprint:
                raise ValueError('Native queue checkpoint contents changed')
        return record

    def save(self, *, hold_id, session_key, turn_id, events):
        canonical_uuid(hold_id)
        if not isinstance(session_key, str) or not session_key or not isinstance(turn_id, str) or not turn_id:
            raise ValueError('An exact native session and turn identity are required')
        packed = [pack_event(event) for event in events]
        fingerprint = hashlib.sha256(json.dumps([session_key, turn_id, packed], sort_keys=True).encode()).hexdigest()
        prior = self.read(hold_id)
        if prior is not None:
            if prior.get('fingerprint') != fingerprint:
                raise ValueError('Queue checkpoint identity belongs to another native turn or input')
            return prior
        record = {'schema': 1, 'hold_id': hold_id, 'session_key': session_key, 'turn_id': turn_id,
                  'fingerprint': fingerprint, 'state': 'prepared', 'events': packed}
        if len((json.dumps(record) + '\n').encode()) > 262144:
            raise ValueError('Queue checkpoint exceeds the private record limit; leave the native queue intact')
        private_save(self.directory / (hold_id + '.json'), record)
        return record

    def confirm_detached(self, hold_id):
        record = self.read(hold_id)
        if record is None:
            raise ValueError('Native queue checkpoint is missing')
        held = {**record, 'state': 'held'}
        private_save(self.directory / (hold_id + '.json'), held)
        return held


def checkpoint_pending(*, store, hold_id, session_key, turn_id, adapter, runner, current_turn):
    """Synchronous save-before-detach boundary, called on the gateway event loop.

    current_turn must observe the live native execution identity, not a saved
    conversation record. No await occurs between identity checks and detachment.
    This does not stop the active turn or prevent future arrivals: a control must
    install its hold gate before using this boundary.
    """
    if current_turn() != turn_id:
        raise ValueError('The native turn changed; do not stop a newer reply')
    state = runner._peek_session_state(session_key)
    if state is None or not isinstance(adapter._pending_messages, dict):
        raise ValueError('Native queue evidence is unavailable')
    overflow = state.conversation.queued_events
    head = adapter._pending_messages.get(session_key)
    tail = list(overflow)
    events = ([head] if head is not None else []) + tail
    record = store.save(hold_id=hold_id, session_key=session_key, turn_id=turn_id, events=events)
    if current_turn() != turn_id or adapter._pending_messages.get(session_key) is not head or (
        len(overflow) != len(tail) or any(a is not b for a, b in zip(overflow, tail))
    ):
        raise ValueError('Native queue changed during checkpoint; leave it intact')
    adapter._pending_messages.pop(session_key, None)
    overflow.clear()
    try:
        return store.confirm_detached(hold_id)
    except BaseException:
        # A failed fsync may occur AFTER atomic replacement. Restore native
        # ownership only when the record is observably still prepared. A held
        # or unreadable record may have committed: keep its hold gate and
        # reconcile, never create a second native copy of its questions.
        try:
            observed = store.read(hold_id)
        except Exception:
            observed = None
        if observed is not None and observed['state'] == 'prepared':
            if head is not None:
                adapter._pending_messages[session_key] = head
            overflow.extend(tail)
        raise
