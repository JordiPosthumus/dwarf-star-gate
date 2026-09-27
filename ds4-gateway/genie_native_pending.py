"""Read native queued/held inputs without detaching, admitting or replaying them."""
import hashlib
import json
import re

from genie_native_queue import unpack_event


def pending_native_inputs(runner, adapter, entry, control, requests):
    key = entry.session_key
    state = runner._peek_session_state(key)
    pending = getattr(adapter, '_pending_messages', None)
    debounce = getattr(adapter, '_text_debounce', {})
    if not isinstance(pending, dict) or not isinstance(debounce, dict):
        raise ValueError('Native pending input is unavailable')
    events = []
    head = pending.get(key)
    if head is not None:
        events.append((head, 'queued'))
    if state is not None:
        events.extend((event, 'queued') for event in state.conversation.queued_events)
    buffered = debounce.get(key)
    if buffered is not None:
        events.append((buffered.event, 'buffered'))
    if control and key in control.active:
        record = control.holds[control.active[key]]
        checkpoint = control.checkpoints.read(record['hold_id'])
        if checkpoint is None:
            raise ValueError('Native held input is unavailable')
        original = list(checkpoint['events'])
        if checkpoint.get('buffered_text') is not None:
            original.append(checkpoint['buffered_text'])
        saved = original + [item['event'] for item in record['arrivals']]
        admitted = record.get('admitted', 0)
        if type(admitted) is not int or not 0 <= admitted <= len(saved):
            raise ValueError('Native held admission evidence is inconsistent')
        condition = 'held' if record['state'] == 'held' else 'uncertain'
        events.extend((unpack_event(event), condition) for event in saved[admitted:])
    result = []
    for event, condition in events:
        source = event.source
        if (source is None or source.platform != entry.origin.platform or source.chat_id != entry.origin.chat_id
                or source.user_id != entry.origin.user_id or not runner._is_user_authorized_for_source(source)):
            raise ValueError('Native pending origin does not match the authorized conversation')
        content = event.text or ''
        metadata = requests.transcript_metadata(key, content)
        marker = re.match(r'^\[DSG request ([a-f0-9-]{36})\]\n\n', content)
        text = metadata.get('visible_message', content[marker.end():]) if metadata and marker else content
        identity = [key, event.message_id, event.platform_update_id, event.timestamp.isoformat(), content]
        result.append({'id': hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest(),
                       'text': text, 'state': condition, 'created_at': event.timestamp.isoformat(),
                       'media_count': len(event.media_urls or []),
                       **({'native_request_id': metadata['request_id'],
                           'request_id': metadata['source_request_id']} if metadata else {})})
    return result


def combine_pending_inputs(queued, receipts, seen):
    """Canonical history supersedes dispatch receipts; queue proof supersedes acceptance."""
    unique = {}
    for row in queued:
        prior = unique.get(row['id'])
        if prior is None or row['state'] == 'uncertain':
            unique[row['id']] = row
    queued = list(unique.values())
    queued_ids = {row.get('native_request_id') for row in queued}
    return [row for row in queued if row.get('native_request_id') not in seen] + [
        row for row in receipts if row['native_request_id'] not in seen and row['native_request_id'] not in queued_ids]
