#!/usr/bin/env python3
"""Materialize a captured pair binding; native access is inspection only."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from recovery_pair import enrollment_identity, fingerprint, observe_pair, require
from recovery_pair_native import PairReader, private_read, private_save


def private_directory(root, create=True):
    if create:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            'pair_enrollment_directory_unverified')


def materialize(capture, destination, expected, reader_factory=PairReader):
    private_directory(capture, create=False)
    request = private_read(capture / 'request.json')
    receipt = private_read(capture / 'receipt.json')
    evidence = private_read(capture / 'evidence.json')
    require(request['action_id'] == capture.name and request['worker_id'] == expected['worker_id']
            and request['binding'] == expected['binding'] and request['route'] == expected['route'], 'pair_capture_binding_changed')
    require(receipt['state'] == 'prepared' and receipt['action_id'] == request['action_id']
            and receipt['worker_id'] == request['worker_id'] and receipt['request_hash'] == fingerprint(request)
            and receipt['evidence_sha256'] == fingerprint(evidence), 'pair_capture_receipt_unverified')
    enrollment = evidence['enrollment']
    require(evidence['route'] == expected['route'] and evidence['identity'] == enrollment_identity(enrollment), 'pair_capture_identity_unverified')
    require({k: enrollment[k] for k in ('worker_id', 'model', 'port', 'context_length', 'concurrency')}
            == {k: expected['binding'][k] for k in ('worker_id', 'model', 'port', 'context_length', 'concurrency')}, 'pair_capture_binding_changed')
    for member, target in zip(enrollment['members'], expected['binding']['members']):
        require(member['ssh'] == target['ssh'] and member['recipe_root'] == target['recipe_root'], 'pair_capture_binding_changed')
    initial = observe_pair(enrollment, evidence['before'])
    final = observe_pair(enrollment, evidence['after'])
    require(initial['epoch'] == final['epoch'] == evidence['epoch'] and final['active'] and final['listener']
            and final['fault'] is None, 'pair_capture_identity_unverified')
    # Refuse legacy machine-ID-only observations, including cloned OS identities.
    for row in evidence['after']:
        identity = row.get('machine_identity', {})
        require(identity.get('scheme') == 'linux-machine-id-and-gpu-uuid-v1' and identity.get('gpu_uuids')
                and fingerprint(identity) == row['machine'], 'pair_hardware_identity_unverified')
    native_binding = {k: enrollment[k] for k in ('worker_id', 'model', 'port', 'context_length', 'concurrency')}
    native_binding['members'] = [{k: m[k] for k in ('ssh', 'container', 'recipe_root')} for m in enrollment['members']]
    reader = reader_factory(expected['binding'])
    current = observe_pair(enrollment, reader.observe())
    reader.enrollment = native_binding
    again = observe_pair(enrollment, reader.observe())
    require(current['epoch'] == again['epoch'] == evidence['epoch'] and again['active'] and again['listener']
            and again['fault'] is None, 'pair_capture_no_longer_current')
    private_directory(destination)
    private_directory(destination / 'journal')
    wrapper = {'schema': 1, 'enrollment': enrollment, 'journal_directory': str(destination / 'journal'),
               'gateway_socket': expected['gateway_socket']}
    filename = destination / 'pair.json'
    if filename.exists():
        require(private_read(filename) == wrapper, 'pair_existing_enrollment_changed')
    else:
        private_save(filename, wrapper)
    return {**evidence['identity'], 'evidence_sha256': receipt['evidence_sha256'], 'epoch': again['epoch'],
            'pair_config_sha256': hashlib.sha256(filename.read_bytes()).hexdigest(),
            'context_length': enrollment['context_length'], 'concurrency': enrollment['concurrency']}


def main():
    try:
        require(len(sys.argv) == 3, 'pair_enrollment_invocation_invalid')
        expected = json.loads(sys.stdin.read(65537))
        result = materialize(Path(sys.argv[1]), Path(sys.argv[2]), expected)
        print(json.dumps(result))
        return 0
    except Exception as error:
        # Native output and full Docker definitions remain private.
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) and str(error).startswith('pair_') else 'pair_enrollment_unverified'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
