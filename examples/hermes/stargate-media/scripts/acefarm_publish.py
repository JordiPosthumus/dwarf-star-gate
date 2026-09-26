#!/usr/bin/env python3
"""Publish one retained DSG song through an installed AceFarm's canonical publisher."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import types
import urllib.parse
import media_client as client


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def same(actual, expected):
    if isinstance(actual, bool) or isinstance(expected, bool):
        return type(actual) is type(expected) and actual == expected
    return actual == expected


def file_hash(filename):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode), 'Audio must be a real regular file')
        sha = hashlib.sha256()
        while data := source.read(1024 * 1024):
            sha.update(data)
        after = os.fstat(source.fileno())
        require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'Audio changed while being checked')
        return sha.hexdigest(), before.st_size


def decode_flac(filename):
    probe = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels', '-of', 'json', str(filename)], capture_output=True, check=True, timeout=60).stdout)
    streams = probe.get('streams', [])
    require(len(streams) == 1 and streams[0].get('codec_type') == 'audio' and streams[0].get('codec_name') == 'flac', 'A real FLAC stream is required')
    duration = float(probe.get('format', {}).get('duration', 0))
    require(math.isfinite(duration) and duration > 0, 'Decoded FLAC duration is missing')
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(filename), '-map', '0', '-f', 'null', '-'], capture_output=True, check=True, timeout=300)
    return {**probe, 'full_decode': True}


def load_acefarm(filename):
    filename = Path(filename).expanduser().resolve(strict=True)
    raw = filename.read_bytes()
    module = types.ModuleType('_stargate_acefarm_publisher')
    module.__file__ = str(filename)
    sys.path.insert(0, str(filename.parent))
    bytecode = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        exec(compile(raw, str(filename), 'exec'), module.__dict__)
    finally:
        sys.dont_write_bytecode = bytecode
        sys.path.pop(0)
    require(all(callable(getattr(module, name, None)) for name in ('short_track_id', '_flat_output_paths', 'publish_success_result')), 'AceFarm canonical publishing API is unavailable')
    require('' not in module.MACHINES, 'Empty source identity must select local publication, never SSH')
    return module, {'path': str(filename), 'sha256': hashlib.sha256(raw).hexdigest()}


def verify_song(receipt, job, metadata):
    require(receipt['kind'] == 'music' and job.get('id') == receipt.get('id') and job.get('kind') == 'music', 'Saved music job identity required')
    require(job.get('state') == 'completed' and job.get('backend') == 'ace-step' and job.get('native_id'), 'A completed native ACE job is required')
    require(job.get('outputs', {}).get('state') == 'ready', 'Gateway audio is not retained yet')
    require(isinstance(metadata, dict), 'Supply the coordinator\'s canonical generation identity metadata')
    require(not set(metadata) & {'id', 'status', 'output', 'sidecar_path', 'source_audio_path', 'stargate', 'generation_params', 'generation_receipt'}, 'Use generation identity metadata, not an already published sidecar')
    for key in ('track', 'machine', 'caption', 'lyrics', 'model', 'lm_model'):
        require(isinstance(metadata.get(key), str) and metadata[key].strip(), 'Missing canonical metadata: ' + key)
    require(type(metadata.get('seed')) is int and metadata['seed'] >= 0, 'An explicit nonnegative seed is required')
    payload = receipt['payload']
    require(type(payload.get('batch_size')) is int and payload['batch_size'] == 1 and payload.get('use_random_seed') is False and payload.get('audio_format') == 'flac', 'Publish one explicit seeded FLAC per gateway job')
    require(same(payload.get('seed'), metadata['seed']), 'Requested seed differs from canonical metadata')
    for keys, field in [(('prompt', 'caption'), 'caption'), (('lyrics',), 'lyrics')]:
        values = [payload[k] for k in keys if k in payload]
        require(values and all(v == metadata[field] for v in values), 'Requested text differs from canonical metadata: ' + field)
    require(payload.get('model') == metadata['model'], 'Request the explicit AceFarm DIT model; do not rely on an engine default')
    pairs = [('thinking', 'thinking'), ('inference_steps', 'inference_steps'), ('guidance_scale', 'guidance_scale'), ('sampler_mode', 'sampler_mode'), ('dcw_enabled', 'dcw_enabled'), ('infer_method', 'infer_method'), ('audio_duration', 'duration')]
    for request_key, meta_key in pairs:
        require(meta_key in metadata and request_key in payload and same(payload[request_key], metadata[meta_key]), 'Requested recipe differs from canonical metadata: ' + meta_key)
    require(type(metadata['thinking']) is bool and type(metadata['dcw_enabled']) is bool, 'Thinking and DCW must be explicit booleans')
    require(type(metadata['duration']) in (int, float) and math.isfinite(metadata['duration']) and (metadata['duration'] == -1 or metadata['duration'] > 0), 'Duration must be positive or the automatic -1 sentinel')
    require(isinstance(job.get('result'), list) and len(job['result']) == 1 and len(job['outputs'].get('files', [])) == 1, 'Exactly one native and retained audio result is required')
    audio, output = job['result'][0], job['outputs']['files'][0]
    native = audio.get('generation_receipt', {})
    require(native.get('schema') == 1 and native.get('source') == 'acestep.inference.audio.params' and isinstance(native.get('parameters'), dict), 'Native per-audio generation parameters are missing; an ingress echo is insufficient')
    parameters = native['parameters']
    for key in ('seed', 'thinking', 'inference_steps', 'guidance_scale', 'sampler_mode', 'dcw_enabled', 'infer_method'):
        require(key in parameters and same(parameters[key], metadata[key]), 'Native generation differs: ' + key)
    require(parameters.get('audio_format') == 'flac', 'Native generation did not report FLAC')
    duration = parameters.get('duration')
    require(type(duration) in (int, float) and math.isfinite(duration) and (duration == -1 or duration > 0), 'Native duration is missing')
    if metadata['duration'] > 0:
        require(duration == metadata['duration'], 'Native explicit duration differs')
    for key in ('task_type', 'instrumental', 'use_cot_caption', 'enable_normalization', 'normalization_db'):
        if key in metadata:
            require(key in parameters and same(parameters[key], metadata[key]), 'Native generation differs: ' + key)
    models = native.get('reported_models', {})
    require(models.get('dit') == metadata['model'] and models.get('lm') == metadata['lm_model'], 'Native reported DIT/LM differ from AceFarm; model substitution is not accepted')
    require(output.get('content_type') == 'audio/flac' and Path(output.get('filename', '')).suffix.lower() == '.flac', 'Retained output is not a FLAC')
    parsed = urllib.parse.urlsplit(audio.get('file', ''))
    native_path = urllib.parse.parse_qs(parsed.query).get('path', [parsed.path])[0]
    require(Path(urllib.parse.unquote(native_path)).name == output['filename'], 'Native parameter receipt belongs to a different file')
    return native, output


def existing_json(filename):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        require(stat.S_ISREG(os.fstat(source.fileno()).st_mode), 'Existing publication metadata must be a regular file; preserved')
        return json.load(source)


def publish(receipt_file, metadata, acefarm_file, target_folder, *, decoder=decode_flac):
    receipt_file = Path(receipt_file).expanduser().absolute()
    receipt = client.read_receipt(receipt_file)
    job = client.status(receipt)
    native, output = verify_song(receipt, job, metadata)
    module, source = load_acefarm(acefarm_file)
    target = Path(target_folder).expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    publication = receipt_file.with_name(receipt_file.name + '.publication.json')
    identity = {'job_id': job['id'], 'native_id': job['native_id'], 'file_id': output['id'], 'sha256': output['sha256'], 'bytes': output['bytes'], 'metadata_sha256': digest(metadata), 'acefarm': source, 'target_folder': str(target)}
    with client.receipt_lock(publication):
        if publication.exists() or publication.is_symlink():
            require(existing_json(publication).get('identity') == identity, 'Publication inputs changed; original intent preserved')
        else:
            client.atomic(publication, {'schema': 1, 'identity': identity, 'state': 'collecting'})
        downloaded = client.download(receipt, receipt_file.parent / (receipt_file.name + '.audio'))['downloaded']
        require(len(downloaded) == 1 and downloaded[0]['sha256'] == output['sha256'], 'Downloaded file differs from the native receipt')
        audio = Path(downloaded[0]['path'])
        expected = (output['sha256'], output['bytes'])
        require(file_hash(audio) == expected, 'Downloaded FLAC integrity differs')
        decoded = decoder(audio)
        require(decoded.get('full_decode') is True, 'Full FLAC decode required')
        require(file_hash(audio) == expected, 'Audio changed during decode')
        track_id = module.short_track_id(metadata)
        require(isinstance(track_id, str) and len(track_id) == 8 and all(c in '0123456789abcdef' for c in track_id), 'AceFarm did not return its canonical eight-character ID')
        result = {**metadata, 'id': track_id, 'status': 'success', 'output': str(audio), 'generation_params': native['parameters'], 'generation_receipt': native,
                  'stargate': {**identity, 'worker': job.get('worker'), 'execution': job.get('execution'), 'requested_payload': receipt['payload'], 'decoded': decoded, 'scope': 'Native reported parameters/models and retained FLAC bytes verified; this is not model-weight or voice-identity attestation.'}}
        flat_audio, flat_sidecar = module._flat_output_paths(target, result, metadata['machine'], '.flac')
        require(flat_audio.parent == target and flat_sidecar.parent == target, 'AceFarm output escaped the target folder')
        with client.receipt_lock(target / '.stargate-publish'):
            index_file = target / 'track_index.json'
            require(not index_file.is_symlink(), 'Existing track index is a symlink; preserved')
            entries = existing_json(index_file) if index_file.exists() else []
            require(isinstance(entries, list) and all(isinstance(e, dict) for e in entries), 'Existing track index is invalid; preserved')
            previous_entry = None
            for entry in entries:
                if entry.get('id') == track_id:
                    require(previous_entry is None, 'Duplicate canonical IDs in existing index; preserved')
                    require(entry.get('audio_path') == str(flat_audio) and entry.get('sidecar_path') == str(flat_sidecar), 'Existing eight-character ID collision; preserved')
                    previous_entry = entry
            if flat_audio.exists() or flat_audio.is_symlink():
                require(file_hash(flat_audio) == expected, 'Existing canonical audio differs; preserved')
            if flat_sidecar.exists() or flat_sidecar.is_symlink():
                old = existing_json(flat_sidecar)
                require(all(k in old and same(old[k], v) for k, v in metadata.items()) and old.get('generation_receipt') == native and
                        all(old.get('stargate', {}).get(k) == v for k, v in identity.items()) and old.get('id') == track_id and
                        old.get('output') == str(flat_audio) and old.get('sidecar_path') == str(flat_sidecar),
                        'Existing canonical metadata differs; preserved')
            # Use AceFarm itself to construct canonical files/index in a private
            # stage, then publish exclusively without overwriting owner files.
            with tempfile.TemporaryDirectory(prefix='.stargate-stage-', dir=target) as staging:
                entry = module.publish_success_result(Path(staging), result, '', [])
                require(isinstance(entry, dict) and entry.get('id') == track_id, 'AceFarm canonical publication failed')
                staged_audio, staged_sidecar = Path(entry['audio_path']), Path(entry['sidecar_path'])
                require(file_hash(staged_audio) == expected, 'AceFarm copied different audio bytes')
                sidecar = existing_json(staged_sidecar)
                sidecar.update(output=str(flat_audio), sidecar_path=str(flat_sidecar))
                entry.update(audio_path=str(flat_audio), sidecar_path=str(flat_sidecar))
                if previous_entry is not None:
                    require(all(k in previous_entry and same(previous_entry[k], v) for k, v in entry.items()), 'Existing canonical index fields differ; preserved')
                    entry = previous_entry  # Retain ratings and other post-publication additions.
                client.atomic(staged_sidecar, sidecar)
                for src, dst in ((staged_audio, flat_audio), (staged_sidecar, flat_sidecar)):
                    os.chmod(src, 0o600)
                    with src.open('rb') as durable:
                        os.fsync(durable.fileno())
                    if not dst.exists():
                        os.link(src, dst)  # Exclusive create; retries adopt only verified files.
                if index_file.exists():
                    backup = receipt_file.parent / 'publication-backups' / (digest(entries) + '.json')
                    if not backup.exists(): client.atomic(backup, entries)
                client.atomic(index_file, entries if previous_entry is not None else entries + [entry])
        saved = {'schema': 1, 'identity': identity, 'state': 'published', 'entry': entry, 'restoration_phase': job.get('execution', {}).get('phase')}
        client.atomic(publication, saved)
        return saved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--metadata', required=True, help='Exact AceFarm generation identity metadata, including explicit model and LM names')
    parser.add_argument('--acefarm', required=True, help='Trusted installed AceFarm CLI source; imported for canonical publication only')
    parser.add_argument('--target-folder', required=True)
    args = parser.parse_args()
    result = publish(args.receipt, json.loads(Path(args.metadata).read_text()), args.acefarm, args.target_folder)
    print(json.dumps({'state': result['state'], 'entry': result['entry'], 'restoration_phase': result['restoration_phase']}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) else 'Publication could not be verified', 'scope': 'Saved job, original files and publication intent retained; no generation was resubmitted.'}))
        raise SystemExit(1)
