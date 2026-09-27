#!/usr/bin/env python3
"""Capture and enroll an existing local oMLX process. Native access is read-only."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import urllib.parse
import urllib.request

spec = importlib.util.spec_from_file_location('omlx', Path(__file__).with_name('recovery-omlx.py'))
omlx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(omlx)


def require(value, reason):
    if not value:
        raise ValueError(reason)


def private_directory(folder):
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = folder.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            'omlx_enrollment_directory_unverified')


def read_json(filename):
    require(omlx.mac.owned_private_regular(filename), 'omlx_enrollment_file_unverified')
    require(filename.stat().st_size <= 65536, 'omlx_enrollment_file_unverified')
    return json.loads(filename.read_text())


def validate_expected(expected):
    require(isinstance(expected, dict) and set(expected) == {'worker_id', 'route', 'target', 'launcher', 'profile_files', 'model', 'context_length', 'concurrency'}, 'omlx_enrollment_request_invalid')
    target = expected['target']
    require(isinstance(target, dict) and set(target) == {'kind', 'root', 'url', 'api_key_file'}
            and target['kind'] == 'omlx-local', 'omlx_inspection_binding_unverified')
    url = urllib.parse.urlsplit(target['url'])
    require(url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port
            and not (url.username or url.password or url.query or url.fragment)
            and expected['route'].get('url') == target['url']
            and expected['route'].get('id') == expected['worker_id'], 'omlx_endpoint_binding_unverified')
    require(isinstance(expected['model'], str) and expected['model']
            and all(type(expected[k]) is int and expected[k] > 0 for k in ('context_length', 'concurrency')), 'omlx_capacity_unverified')
    require(Path(target['root']).is_absolute() and not Path(target['root']).is_symlink(), 'omlx_root_unverified')
    # Validate launcher configuration before inspecting or writing any native binding.
    omlx.validate_config({'root': target['root'], 'binary': '/placeholder', 'port': url.port,
                          'command_sha256': '0'*64, 'api_key_file': target['api_key_file'], 'start_stopped': False,
                          'launcher': expected['launcher'], 'profile_files': expected['profile_files']})


def candidate(expected):
    target = expected['target']
    raw = (Path(target['root'])/'server.pid').read_text().strip()
    require(raw.isascii() and raw.isdigit() and 2 <= int(raw) <= 2147483647, 'omlx_recorded_pid_unverified')
    process = omlx.mac.process_info(int(raw))
    return {'root': target['root'], 'binary': process['executable'],
            'port': urllib.parse.urlsplit(target['url']).port,
            'command_sha256': hashlib.sha256(process['command'].encode()).hexdigest(),
            'api_key_file': target['api_key_file'], 'start_stopped': False,
            'launcher': expected['launcher'], 'profile_files': expected['profile_files']}


def metadata(expected):
    target = expected['target']
    key = Path(target['api_key_file'])
    require(omlx.mac.owned_private_regular(key) and key.stat().st_size <= 8192, 'omlx_credential_unavailable')
    token = key.read_text().strip()
    require(token and not any(ord(c) <= 32 or ord(c) == 127 for c in token), 'omlx_credential_unavailable')
    request = urllib.request.Request(target['url'].rstrip('/')+'/models', headers={'Authorization': 'Bearer '+token})
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), omlx.NoRedirect()).open(request, timeout=10) as response:
        raw = response.read(262145)
        require(len(raw) <= 262144, 'omlx_metadata_limit')
        models = json.loads(raw)
    model = next((m for m in models.get('data', []) if m.get('id') == expected['model']), {})
    settings = json.loads((Path(target['root'])/'state/settings.json').read_text())
    result = {'model': model.get('id'), 'context_length': model.get('max_model_len'),
              'configured_concurrency': settings.get('scheduler', {}).get('max_concurrent_requests')}
    require(result == {'model': expected['model'], 'context_length': expected['context_length'],
                       'configured_concurrency': expected['concurrency']}, 'omlx_capacity_or_model_changed')
    return result


def materialize(destination, expected, capture=candidate, inspect=omlx.inspect, read_metadata=metadata):
    validate_expected(expected)
    private_directory(destination)
    lockfile = destination/'capture.lock'
    fd = os.open(lockfile, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'r+') as lock:
        require(omlx.mac.owned_private_regular(lockfile), 'omlx_enrollment_file_unverified')
        fcntl.flock(lock, fcntl.LOCK_EX)
        config = capture(expected)
        omlx.validate_config(config)
        before = inspect(config)
        first = read_metadata(expected)
        after = inspect(config)
        second = read_metadata(expected)
        final = inspect(config)
        require(before == after == final and first == second and final['active'] and final['listener']
                and not final['stopped'] and final['fault'] is None, 'omlx_capture_no_longer_current')
        wrapper = destination/'omlx.json'
        evidence_file = destination/'evidence.json'
        if wrapper.exists():
            require(read_json(wrapper) == config, 'omlx_existing_enrollment_changed')
        if evidence_file.exists():
            prior = read_json(evidence_file)
            require(prior['expected'] == expected and prior['configuration'] == config
                    and prior['inspection'] == final and prior['metadata'] == second,
                    'omlx_existing_capture_changed')
            evidence = prior
        else:
            evidence = {'schema': 1, 'expected': expected, 'configuration': config, 'inspection': final,
                        'metadata': second, 'stable_observations': 3,
                        'scope': 'Native process/listener and model context metadata; concurrency is pinned settings-file metadata, not a boundary exercise. No signal, launch or generation.'}
            omlx.mac.atomic_save(evidence_file, evidence)
        if not wrapper.exists():
            omlx.mac.atomic_save(wrapper, config)
        return {'machine': final['machine'], 'profile': final['profile'], 'instance': final['instance'],
                'evidence_sha256': omlx.fingerprint(evidence), 'config_sha256': hashlib.sha256(wrapper.read_bytes()).hexdigest(),
                'context_length': expected['context_length'], 'concurrency': expected['concurrency']}


def main():
    try:
        require(sys.platform == 'darwin' and len(sys.argv) == 2, 'omlx_enrollment_platform_unavailable')
        raw = sys.stdin.buffer.read(65537)
        require(len(raw) <= 65536, 'omlx_enrollment_input_limit')
        print(json.dumps(materialize(Path(sys.argv[1]), json.loads(raw))))
        return 0
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) and str(error).startswith('omlx_') else 'omlx_enrollment_unverified'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
