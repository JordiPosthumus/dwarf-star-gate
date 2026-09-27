"""Exact-turn controls around Hermes's native cancellation and admission paths.

No agent loop or Telegram transport is implemented here. The durable hold keeps
questions out of Hermes's destructive /stop path; Continue uses native admission.
A crash during admission retains uncertainty and never automatically replays it.
"""
import os
from pathlib import Path

from genie_native_queue import NativeQueueCheckpoints, NativeTurnIdentities, checkpoint_pending, pack_event, unpack_event
from genie_native_sessions import canonical_uuid, private_directory, private_read, private_save


def controls_enabled():
    return os.environ.get('DSG_NATIVE_SESSION_CONTROLS') == '1'


class NativeControls:
    def __init__(self, runner, directory):
        self.runner = runner
        self.directory = private_directory(directory)
        self.checkpoints = NativeQueueCheckpoints(self.directory / 'checkpoints')
        self.identities = NativeTurnIdentities()
        self.holds = {}
        self.active = {}
        self.replaying = None
        for file in self.directory.glob('*.json'):
            record = private_read(file, max_bytes=None)
            if (not isinstance(record, dict) or record.get('schema') != 1 or file.stem != record.get('hold_id') or
                record.get('state') not in ('preparing', 'stopping', 'held', 'resuming', 'released', 'uncertain') or
                not isinstance(record.get('arrivals'), list) or not isinstance(record.get('session_key'), str)):
                raise ValueError('Invalid native hold journal; preserve it for reconciliation')
            canonical_uuid(record['hold_id'])
            # The old process may have died before recording an admission or
            # stop result. A journal alone is not proof that a request did not run.
            if record['state'] in ('preparing', 'stopping', 'resuming'):
                record = {**record, 'state': 'uncertain'}
                self.save(record)
            self.holds[record['hold_id']] = record
            if record['state'] != 'released':
                if record['session_key'] in self.active:
                    raise ValueError('Conflicting native holds; no input may be admitted')
                self.active[record['session_key']] = record['hold_id']

    def save(self, record):
        private_save(self.directory / (record['hold_id'] + '.json'), record)
        self.holds[record['hold_id']] = record
        return record

    def change(self, hold_id, **changes):
        return self.save({**self.holds[hold_id], **changes})

    def authorized(self, source, record):
        return (source is not None and source.platform.value == record['platform'] and
                source.chat_id == record['chat_id'] and source.user_id == record['user_id'] and
                self.runner._is_user_authorized_for_source(source))

    def gate(self, adapter, event, session_key):
        hold_id = self.active.get(session_key)
        if not hold_id or event is self.replaying:
            return False
        record = self.holds[hold_id]
        if not self.authorized(event.source, record):
            # Do not allow an unauthorized sender to occupy an owner's held queue.
            event._gateway_accepted = False
            return True
        packed = pack_event(event)
        identity = [event.source.platform.value, event.source.chat_id, event.source.user_id,
                    event.message_id, event.platform_update_id]
        identifiable = bool(event.message_id or event.platform_update_id is not None)
        for existing in record['arrivals']:
            if identifiable and existing['identity'] == identity:
                if existing['event'] != packed:
                    raise ValueError('Held native message identity changed; input was not replaced')
                event._gateway_accepted = True
                return True
        # Save before acknowledging acceptance. Failure propagates, never falls
        # through to native admission or silently releases the held conversation.
        self.change(hold_id, arrivals=[*record['arrivals'], {'identity': identity, 'event': packed}])
        event._gateway_accepted = True
        return True

    def observe(self, session_key):
        hold_id = self.active.get(session_key)
        if not hold_id:
            return None
        record = self.holds[hold_id]
        checkpoint = self.checkpoints.read(hold_id)
        count = (len(checkpoint['events']) + int(checkpoint.get('buffered_text') is not None)) if checkpoint else 0
        return {'hold_id': hold_id, 'turn_id': record['turn_id'], 'state': record['state'],
                'queued': count + len(record['arrivals']) - record.get('admitted', 0),
                'scope': 'Native chat hold only. Existing fleet operations may continue independently.'}

    async def stop(self, entry, adapter, *, turn_id, hold_id):
        from gateway.platforms.event import MessageEvent
        canonical_uuid(hold_id)
        key = entry.session_key
        prior = self.holds.get(hold_id)
        if prior:
            if prior['session_key'] != key or prior['turn_id'] != turn_id:
                raise ValueError('Hold identity belongs to another native turn')
            return self.observe(key) or {'hold_id': hold_id, 'state': prior['state']}
        if key in self.active:
            raise ValueError('The conversation already has a held queue')
        if self.identities.current(self.runner, adapter, key) != turn_id:
            raise ValueError('The native turn changed; no newer reply was stopped')
        origin = entry.origin
        record = {'schema': 1, 'hold_id': hold_id, 'session_key': key, 'session_id': entry.session_id,
                  'turn_id': turn_id, 'state': 'preparing', 'arrivals': [], 'admitted': 0,
                  'platform': origin.platform.value, 'chat_id': origin.chat_id, 'user_id': origin.user_id}
        if not self.authorized(origin, record):
            raise ValueError('Native owner authorization is required')
        task = adapter._session_tasks.get(key)
        if task is None or task.done():
            raise ValueError('A live native processing task is required')
        self.save(record)
        self.active[key] = hold_id
        try:
            checkpoint_pending(store=self.checkpoints, hold_id=hold_id, session_key=key, turn_id=turn_id,
                adapter=adapter, runner=self.runner,
                current_turn=lambda: self.identities.current(self.runner, adapter, key))
            self.change(hold_id, state='stopping')
            # Same fixed native command path used by Telegram. Pending/FIFO and
            # buffered text have already been checkpointed; new arrivals are held.
            event = MessageEvent(text='/stop', source=origin, internal=True, allow_gateway_control=True)
            await adapter._dispatch_active_session_command(event, key, 'stop')
            if not task.done() or key in adapter._active_sessions:
                self.change(hold_id, state='uncertain')
            else:
                self.change(hold_id, state='held')
        except BaseException:
            self.change(hold_id, state='uncertain')
            raise
        return self.observe(key)

    async def resume(self, entry, adapter, *, hold_id):
        canonical_uuid(hold_id)
        record = self.holds.get(hold_id)
        key = entry.session_key
        if not record or record['session_key'] != key:
            raise ValueError('Use the existing hold identity for this conversation')
        if record['state'] == 'released':
            return {'hold_id': hold_id, 'state': 'released', 'admitted': record['admitted']}
        if record['state'] != 'held' or entry.session_id != record['session_id']:
            raise ValueError('Held admission is uncertain or session changed; do not replay it')
        if not self.authorized(entry.origin, record):
            raise ValueError('Native owner authorization is required')
        if key in adapter._active_sessions or entry.active_turn_token:
            raise ValueError('Wait for the native turn to become idle before continuing')
        checkpoint = self.checkpoints.read(hold_id)
        if not checkpoint or checkpoint['state'] != 'held':
            raise ValueError('Detached native queue evidence is unavailable')
        original = [*checkpoint['events']]
        if checkpoint.get('buffered_text') is not None:
            original.append(checkpoint['buffered_text'])
        self.change(hold_id, state='resuming')
        try:
            while True:
                current = self.holds[hold_id]
                pending = [*original, *(item['event'] for item in current['arrivals'])]
                index = current['admitted']
                if index == len(pending):
                    self.change(hold_id, state='released')
                    self.active.pop(key, None)
                    return {'hold_id': hold_id, 'state': 'released', 'admitted': index}
                event = unpack_event(pending[index], telegram_bot=getattr(getattr(adapter, '_app', None), 'bot', None))
                if not self.authorized(event.source, record):
                    raise ValueError('A held message no longer has native owner authorization')
                if adapter._event_session_key(event) != key:
                    raise ValueError('A held message no longer resolves to this native session')
                # If the process exits after this write, startup holds uncertainty;
                # it never assumes this event was not accepted and sends it again.
                self.change(hold_id, admitting_index=index)
                self.replaying = event
                try:
                    if key in adapter._active_sessions:
                        # These are already separate accepted questions (or an
                        # already-coalesced native burst). Restore them through
                        # Hermes's FIFO, not its new-input debounce path, which
                        # can merge a late Telegram item into an older UI head.
                        self.runner._enqueue_fifo(key, event, adapter)
                    else:
                        await adapter.handle_message(event)
                finally:
                    self.replaying = None
                if not getattr(event, '_gateway_accepted', False):
                    raise ValueError('Native admission was not confirmed; preserve this hold')
                self.change(hold_id, admitted=index + 1, admitting_index=None)
        except BaseException:
            self.change(hold_id, state='uncertain')
            raise


def get_native_controls(runner):
    if not controls_enabled() or runner is None:
        raise ValueError('Native session controls are not enabled for this profile')
    control = getattr(runner, '_dsg_native_controls', None)
    if control is None:
        control = NativeControls(runner, Path(os.environ['HERMES_HOME']) / 'dsg-native-holds')
        runner._dsg_native_controls = control
    return control


def gate_native_message(adapter, event, session_key):
    return get_native_controls(adapter.gateway_runner).gate(adapter, event, session_key)
