"""Stage legacy DSG history in a new native Hermes database without activating it.

Only quiescent source snapshots are accepted. Original files and all message
fields remain in the private bundle; tool receipts are historical metadata, not
invented native tool calls. Never point a running gateway at this destination.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re

from genie_native_sessions import canonical_uuid, private_directory, private_read, private_save

UUID_FILE = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_snapshot(source):
    files = {}
    conversations = {}
    for path in sorted(source.iterdir()):
        if not UUID_FILE.fullmatch(path.name):
            continue
        # No file-size cap: migration must not truncate an established history.
        row = private_read(path, max_bytes=None)
        raw = path.read_bytes()
        if json.loads(raw) != row:
            raise ValueError('Source changed while reading; take a new idle snapshot')
        if not isinstance(row, dict) or row.get('version') != 1 or path.name != str(row.get('id')) + '.json' or not isinstance(row.get('messages'), list):
            raise ValueError('Unrecognized legacy conversation; nothing imported')
        canonical_uuid(row['id'])
        if row.get('queue_paused') or any(m.get('state') in ('working', 'queued') or m.get('pending_dispatch') for m in row['messages'] if isinstance(m, dict)):
            raise ValueError('Legacy conversation has active or held work; wait for reconciliation')
        ids = set()
        for message in row['messages']:
            if (not isinstance(message, dict) or message.get('role') not in ('user', 'assistant') or
                not isinstance(message.get('text'), str) or message.get('state') not in ('complete', 'failed', 'interrupted') or
                not isinstance(message.get('id'), str) or message['id'] in ids or
                type(message.get('at')) not in (int, float) or not math.isfinite(message['at'])):
                raise ValueError('Unrecognized legacy message; preserve the source for review')
            ids.add(message['id'])
        files[path.name] = raw
        progress = path.with_name(path.stem + '.progress.json')
        if progress.exists() or progress.is_symlink():
            private_read(progress, max_bytes=None)
            files[progress.name] = progress.read_bytes()
        conversations[row['id']] = row
    if not conversations:
        raise ValueError('No legacy conversations found')
    return files, conversations


def stage_legacy_history(source, destination, bindings):
    """bindings explicitly map EVERY source conversation to its native origin.

    Writes a new, empty bundle only. A partial or existing destination is never
    overwritten or reimported. A manifest is published only after native readback
    and a second byte-for-byte check of the source snapshot.
    """
    from hermes_state import SessionDB

    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve() or source.resolve() in destination.resolve().parents:
        raise ValueError('Use a separate staging destination outside the source directory')
    files, conversations = read_snapshot(source)
    if not isinstance(bindings, list) or len(bindings) != len(conversations):
        raise ValueError('Bind every legacy conversation explicitly')
    resolved = {}
    session_keys = set()
    for binding in bindings:
        if not isinstance(binding, dict) or set(binding) != {'id', 'platform', 'chat_id', 'user_id'}:
            raise ValueError('Use exact native owner/origin bindings')
        identity = binding['id']
        if identity not in conversations or identity in resolved or binding['platform'] not in ('telegram', 'stargate_control'):
            raise ValueError('Duplicate, missing or unsupported legacy binding')
        if any(not isinstance(binding[k], str) or not binding[k] for k in ('chat_id', 'user_id')):
            raise ValueError('A verified native owner and chat identity are required')
        if binding['platform'] == 'stargate_control' and binding['chat_id'] != identity:
            raise ValueError('Dashboard conversation identity must be preserved')
        # This is persisted origin metadata, not a running adapter. In an
        # offline importer the custom platform has not been registered yet;
        # native plugin discovery resolves it when the gateway starts.
        origin = {'platform': binding['platform'], 'chat_id': binding['chat_id'],
                  'user_id': binding['user_id'], 'chat_type': 'dm',
                  'chat_name': conversations[identity].get('title'), 'user_name': None,
                  'thread_id': None, 'chat_topic': None}
        key = 'agent:main:' + binding['platform'] + ':dm:' + binding['chat_id']
        if key in session_keys:
            raise ValueError('Two legacy conversations cannot replace the same native session')
        session_keys.add(key)
        resolved[identity] = (origin, key)
    home = private_directory(destination)
    if any(home.iterdir()):
        raise ValueError('History staging destination is occupied; nothing replaced')
    archive = private_directory(home / 'legacy-source')
    for name, raw in files.items():
        with (archive / name).open('xb') as output:
            os.chmod(output.name, 0o600)
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
    db_path = home / 'state.db'
    db = SessionDB(db_path)
    os.chmod(db_path, 0o600)
    migrated = []
    try:
        for identity, conversation in conversations.items():
            origin, key = resolved[identity]
            native_id = 'dsg-migrated-' + identity
            source_hash = sha(files[identity + '.json'])
            db.create_session(native_id, origin['platform'], user_id=origin['user_id'],
                              session_key=key, chat_id=origin['chat_id'], chat_type='dm',
                              origin_json=json.dumps(origin), display_name=conversation.get('title'))
            expected = []
            for message in conversation['messages']:
                metadata = {'schema': 1, 'conversation_id': identity, 'source_sha256': source_hash, 'message': message}
                # Complete text is preserved. Historical failed/interrupted
                # messages do not become completed native replies or tool calls.
                db.append_message(native_id, message['role'], message['text'], timestamp=message['at'] / 1000,
                                  display_kind='dsg_legacy', display_metadata={'dsg_legacy': metadata})
                expected.append(metadata)
            rows = db.get_messages(native_id, include_inactive=True)
            if len(rows) != len(expected) or any(row.get('content') != item['message']['text'] or row.get('display_metadata', {}).get('dsg_legacy') != item for row, item in zip(rows, expected)):
                raise ValueError('Native history readback differs; do not activate this bundle')
            migrated.append({'id': identity, 'session_id': native_id, 'session_key': key,
                             'messages': len(rows), 'source_sha256': source_hash})
    finally:
        db.close()
    after, _ = read_snapshot(source)
    if after != files:
        raise ValueError('Legacy history changed during migration; do not activate this bundle')
    manifest = {'schema': 1, 'state': 'staged', 'conversations': migrated,
                'source_sha256': {name: sha(raw) for name, raw in files.items()},
                'database_sha256': sha(db_path.read_bytes()),
                'scope': 'Inactive native history bundle. No credentials, poller, queued work or live service migrated.'}
    private_save(home / 'migration.json', manifest)
    return manifest
