"""Publish an approved serving result into the existing private Git library.

Preparation supplies the candidate record for the owner to review with the plan.
This writer adds actual container/qualification evidence; it never guesses a new
package version or turns successful tests into additional recovery authority.
"""
import copy
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from docker_profile import digest, signature
from operation_runner import read, read_bytes, save


class ServingRecordPublisher:
    def __init__(self, library):
        self.library = Path(library).resolve()

    def git(self, *args):
        result = subprocess.run(['git', '-C', str(self.library), *args], capture_output=True)
        if result.returncode:
            raise RuntimeError('Configuration-library Git operation failed; inspect the retained operation evidence and repository before retrying')
        return result.stdout.decode().strip()

    def preflight(self, plan, folder):
        record_file = self.library / 'approved' / (plan['worker_id'] + '.json')
        raw = read_bytes(record_file)
        if hashlib.sha256(raw).hexdigest() != plan['record_revision']:
            raise ValueError('The approved record changed before publication')
        if self.git('status', '--porcelain', '--', str(record_file.relative_to(self.library))):
            raise ValueError('Commit or reconcile existing edits to this record before publication')
        candidate = plan.get('candidate_record')
        expected = {'previous_approved_revision': plan['record_revision'], 'retention': 'retained', 'drill': {'status': 'unproven'}}
        if (not isinstance(candidate, dict) or candidate.get('schema') != 1 or candidate.get('kind') != 'approved'
                or candidate.get('worker_id') != plan['worker_id'] or not isinstance(candidate.get('runtime'), dict)
                or candidate.get('configuration', {}).get('planned_recipe_sha256') != digest(plan['profile']['create'])
                or candidate.get('restoration') != expected):
            raise ValueError('Prepare the exact candidate record and retained restoration boundary before draining')
        self.approval(plan, Path(folder))

    @staticmethod
    def approval(plan, folder):
        approval = read(folder / 'approved.json')
        plan_bytes = read_bytes(folder / 'plan.json')
        if (not approval or approval.get('actor') != 'owner'
                or approval.get('plan_revision') != hashlib.sha256(plan_bytes).hexdigest()
                or approval.get('record_revision') != plan['record_revision'] or json.loads(plan_bytes) != plan):
            raise ValueError('Record publication requires the exact saved owner approval')

    def __call__(self, plan, folder, which, current):
        folder = Path(folder)
        worker = plan['worker_id']
        if not re.fullmatch(r'[a-zA-Z0-9][\w-]{0,63}', worker) or which not in ('candidate', 'previous'):
            raise ValueError('Invalid serving record identity')
        record_file = self.library / 'approved' / (worker + '.json')
        if (Path(plan['record_file']).is_symlink() or Path(plan['record_file']).resolve() != record_file
                or record_file.parent.is_symlink()):
            raise ValueError('Record must be in the enrolled configuration library')
        # Cooperating publishers serialize in the existing Git repository, even
        # when the library is a subdirectory of a larger personal repository.
        gitdir = Path(self.git('rev-parse', '--absolute-git-dir'))
        with (gitdir / 'stargate-record-publication.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return self.publish(plan, folder, which, current, record_file)

    def publish(self, plan, folder, which, current, record_file):
        old_bytes = read_bytes(record_file)
        if hashlib.sha256(old_bytes).hexdigest() != plan['record_revision']:
            raise ValueError('The approved record changed before publication')
        record_path = str(record_file.relative_to(self.library))
        if self.git('status', '--porcelain', '--', record_path):
            raise ValueError('Commit or reconcile existing edits to this record before publication')
        old = json.loads(old_bytes)
        proof_file = folder / ('qualified-' + which + '.json')
        proof = read(proof_file)
        result_file = folder / ('qualification-' + which) / 'result.json'
        result = read(result_file)
        if (not proof or proof.get('state') != 'passed' or not result or result.get('state') != 'passed'
                or proof.get('container_id') != current['Id'] or proof.get('started_at') != current['State']['StartedAt']
                or proof.get('signature_sha256') != digest(signature(current))
                or proof.get('result_sha256') != hashlib.sha256(read_bytes(result_file)).hexdigest()):
            raise ValueError('Publication requires the exact qualified serving identity and result')
        # Approval of the exact plan includes this complete candidate record.
        # Restoring the original uses its original record, not candidate prose.
        record = copy.deepcopy(plan.get('candidate_record') if which == 'candidate' else old)
        contract = result.get('contract', {})
        if (not isinstance(record, dict) or record.get('schema') != 1 or record.get('kind') != 'approved'
                or record.get('worker_id') != plan['worker_id'] or not isinstance(record.get('runtime'), dict)
                or record.get('model', {}).get('name') != contract.get('model')
                or record.get('settings', {}).get('context_length') != contract.get('context_length')):
            raise ValueError('The reviewed record does not describe the qualified model and context')
        if which == 'candidate':
            if record.get('configuration', {}).get('planned_recipe_sha256') != digest(plan['profile']['create']):
                raise ValueError('Candidate record must bind the complete reviewed Docker recipe')
            # A newly chosen image has no freshly inspected package metadata in
            # this adapter. Require honest unknowns rather than copying versions.
            if current['Image'] != plan['profile']['before']['Image']:
                if any(record['runtime'].get(key) is not None for key in ('version', 'build')) or record.get('configuration', {}).get('captured_container', {}).get('packages'):
                    raise ValueError('New-image package versions require fresh evidence; leave them unknown in this adapter')
            # The retained old record carries its proven restoration scope. The
            # new container has not itself been through a restoration drill.
            expected_restoration = {'previous_approved_revision': plan['record_revision'],
                'retention': 'retained', 'drill': {'status': 'unproven'}}
            if record.get('restoration') != expected_restoration:
                raise ValueError('A serving operation cannot expand restoration authority')
        self.approval(plan, folder)
        artifact = self.library / 'artifacts' / ('serving-' + folder.name)
        if artifact.parent.is_symlink() or artifact.exists():
            raise ValueError('Publication artifacts already exist or require reconciliation; do not repeat publication')
        artifact.mkdir(mode=0o700)
        # Retain exact old bytes, independent of formatting or later Git history.
        self.copy_file(record_file, artifact / 'previous-approved.json')
        for name in ('plan.json', 'approved.json', 'qualified-' + which + '.json'):
            self.copy_file(folder / name, artifact / name)
        source = folder / ('qualification-' + which)
        destination = artifact / source.name
        destination.mkdir(mode=0o700)
        for item in sorted(source.iterdir()):
            self.copy_file(item, destination / item.name)
        # Verify copied raw responses against the qualification's recorded
        # hashes before giving these files a durable library reference.
        if read_bytes(destination / 'result.json') != read_bytes(result_file):
            raise ValueError('Qualification result changed while copying evidence')
        for case in result['cases']:
            name = case['case']
            if not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9-]*', name):
                raise ValueError('Invalid qualification case identity')
            if self.file_digest(destination / (name + '.response.bin')) != case['response_sha256']:
                raise ValueError('Raw qualification response no longer matches its receipt')
            intent = read(destination / (name + '.intent.json'))
            request = intent.get('request')
            if request and (request['file'] != name + '.request.json'
                    or self.file_digest(destination / request['file']) != request['sha256']):
                raise ValueError('Qualification request no longer matches its receipt')
        save(artifact, 'container.json', current)
        at = datetime.now(timezone.utc).isoformat()
        reference = str(artifact.relative_to(self.library))
        record['recorded_at'] = record['evidence_updated_at'] = at
        record.setdefault('configuration', {})['qualified_container_reference'] = {
            'path': reference + '/container.json', 'sha256': hashlib.sha256(read_bytes(artifact / 'container.json')).hexdigest(),
            'container_id': current['Id'], 'started_at': current['State']['StartedAt'], 'image_id': current['Image'],
            'scope': 'Actual Docker recipe and startup identity at qualification; package versions require separate inspection.'}
        record.setdefault('evidence', []).append({'path': reference + '/' + source.name + '/result.json',
            'sha256': hashlib.sha256(read_bytes(result_file)).hexdigest(), 'captured_at': at,
            'scope': 'Recorded native checks for this startup; not a benchmark or fresh-machine installation.'})
        record['serving_operation'] = {'id': folder.name, 'outcome': which,
            'previous_approved_revision': plan['record_revision'], 'approval_reference': reference + '/approved.json'}
        if which == 'candidate':
            record['approval'] = {'at': at, 'reference': reference + '/approved.json',
                'scope': 'Exact owner-approved serving plan; no new automatic recovery authority.'}
        save(artifact, 'published-record.json', record)
        paths = [record_path, reference]
        # No blanket add/reset/stash: unrelated personal files and staged changes
        # remain in the owner's index. Hooks run through ordinary git commit.
        if read_bytes(record_file) != old_bytes or self.git('status', '--porcelain', '--', record_path):
            raise ValueError('Configuration record changed during evidence collection')
        save(record_file.parent, record_file.name, record, replace=True)
        self.git('add', '--', *paths)
        self.git('commit', '--only', '-m', 'Record verified serving operation ' + folder.name, '--', *paths)
        commit = self.git('rev-parse', 'HEAD')
        prefix = self.git('rev-parse', '--show-prefix')
        relative = prefix + record_path
        committed = subprocess.run(['git', '-C', str(self.library), 'show', commit + ':' + relative], capture_output=True, check=True).stdout
        expected = read_bytes(artifact / 'published-record.json')
        if committed != expected or read_bytes(record_file) != expected:
            raise RuntimeError('Committed record does not match the qualified publication')
        receipt = {'state': 'recorded', 'commit': commit, 'record_revision': hashlib.sha256(expected).hexdigest(),
            'previous_record_revision': plan['record_revision'], 'artifact': reference,
            'scope': 'Local private Git commit; no push and no recovery-policy change.'}
        save(folder, 'record-publication.json', receipt)
        return receipt

    @staticmethod
    def file_digest(path):
        with path.open('rb') as stream:
            return hashlib.file_digest(stream, 'sha256').hexdigest()

    @staticmethod
    def copy_file(source, destination):
        # Qualification includes full-context request artifacts larger than the
        # receipt limit. Stream regular files without following symlinks.
        import stat
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError('Qualification evidence must be a regular file')
            with os.fdopen(fd, 'rb', closefd=False) as incoming, destination.open('xb') as outgoing:
                os.chmod(destination, 0o600)
                shutil.copyfileobj(incoming, outgoing)
                outgoing.flush()
                os.fsync(outgoing.fileno())
        finally:
            os.close(fd)
