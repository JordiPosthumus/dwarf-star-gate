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
        # These records contain events already admitted into Hermes's queue,
        # including media/reply metadata. The small UI metadata limit must not
        # reduce the native queue's capacity. Private ownership/type checks and
        # the complete-content fingerprint still apply.
        record = private_read(self.directory / (hold_id + '.json'), max_bytes=None)
        if record is not None:
            expected = {'schema', 'hold_id', 'session_key', 'turn_id', 'fingerprint', 'state', 'events'}
            if isinstance(record, dict) and record.get('schema') == 2:
                expected.add('buffered_text')
            if not isinstance(record, dict) or set(record) != expected or record.get('hold_id') != hold_id or record.get('schema') not in (1, 2) or record.get('state') not in ('prepared', 'held') or not isinstance(record.get('events'), list):
                raise ValueError('Invalid native queue checkpoint')
            contents = [record['session_key'], record['turn_id'], record['events']]
            if record['schema'] == 2:
                contents.append(record['buffered_text'])
            fingerprint = hashlib.sha256(json.dumps(contents, sort_keys=True).encode()).hexdigest()
            if record['fingerprint'] != fingerprint:
                raise ValueError('Native queue checkpoint contents changed')
        return record

    def save(self, *, hold_id, session_key, turn_id, events, buffered_text=None):
        canonical_uuid(hold_id)
        if not isinstance(session_key, str) or not session_key or not isinstance(turn_id, str) or not turn_id:
            raise ValueError('An exact native session and turn identity are required')
        packed = [pack_event(event) for event in events]
        buffered = pack_event(buffered_text) if buffered_text is not None else None
        fingerprint = hashlib.sha256(json.dumps([session_key, turn_id, packed, buffered], sort_keys=True).encode()).hexdigest()
        prior = self.read(hold_id)
        if prior is not None:
            if prior.get('fingerprint') != fingerprint:
                raise ValueError('Queue checkpoint identity belongs to another native turn or input')
            return prior
        record = {'schema': 2, 'hold_id': hold_id, 'session_key': session_key, 'turn_id': turn_id,
                  'fingerprint': fingerprint, 'state': 'prepared', 'events': packed, 'buffered_text': buffered}
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
    debounce_store = getattr(adapter, '_text_debounce', {})
    if not isinstance(debounce_store, dict):
        raise ValueError('Native buffered-text evidence is unavailable')
    debounce = debounce_store.get(session_key)
    head = adapter._pending_messages.get(session_key)
    tail = list(overflow)
    events = ([head] if head is not None else []) + tail
    record = store.save(hold_id=hold_id, session_key=session_key, turn_id=turn_id, events=events,
                        buffered_text=debounce.event if debounce is not None else None)
    if current_turn() != turn_id or adapter._pending_messages.get(session_key) is not head or (
        len(overflow) != len(tail) or any(a is not b for a, b in zip(overflow, tail))
    ) or debounce_store.get(session_key) is not debounce:
        raise ValueError('Native queue changed during checkpoint; leave it intact')
    adapter._pending_messages.pop(session_key, None)
    overflow.clear()
    debounce_store.pop(session_key, None)
    try:
        held = store.confirm_detached(hold_id)
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
            if debounce is not None:
                # No await occurred: the original timer has not run or been
                # cancelled and still owns exactly this native buffer.
                debounce_store[session_key] = debounce
        elif debounce is not None:
            debounce.cancel_timer()
        raise
    if debounce is not None:
        debounce.cancel_timer()
    return held
