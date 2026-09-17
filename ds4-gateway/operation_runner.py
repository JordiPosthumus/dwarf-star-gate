"""Independent, single-attempt execution of an explicitly approved operation.

The trusted preparation adapter selects and hashes an executor; the Genie cannot
choose one. This module supervises that executor, not the chat. It does not grant
maintenance, restoration or readmission authority, or qualify a model itself.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
import time
import uuid

UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
DIGEST = re.compile(r'[a-f0-9]{64}')
TERMINAL = {'completed', 'restored', 'failed_unchanged', 'requires_reconciliation'}


def read_bytes(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 2 * 1024 * 1024:
            raise ValueError('Invalid operation file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise ValueError('Operation file grew beyond the supported size')
            return data
    finally:
        os.close(fd)


def read(file):
    try:
        return json.loads(read_bytes(file))
    except FileNotFoundError:
        return None


def save(folder, name, value, *, replace=False):
    data = (json.dumps(value, indent=2) + '\n').encode()
    if len(data) > 2 * 1024 * 1024:
        raise ValueError('Operation receipt is too large')
    target = folder / name
    temp = folder / (name + '.' + str(uuid.uuid4()) + '.tmp')
    try:
        with temp.open('xb') as stream:
            os.chmod(temp, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temp, target)
        else:
            os.link(temp, target)  # Exclusive, atomic publication.
        fd = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temp.unlink(missing_ok=True)


def folder_at(directory):
    folder = Path(directory).absolute()
    if not UUID.fullmatch(folder.name) or folder.is_symlink() or not folder.is_dir():
        raise ValueError('Use an existing operation directory')
    return folder


def lock_file(folder):
    fd = os.open(folder / 'runner.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError('Invalid runner lock')
    return fd


def approved_plan(folder):
    data = read_bytes(folder / 'plan.json')
    revision = hashlib.sha256(data).hexdigest()
    prepared, approval, intent = [read(folder / name) for name in ['prepared.json', 'approved.json', 'launch-intent.json']]
    if (not all(isinstance(row, dict) and row.get('plan_revision') == revision for row in [prepared, approval, intent])
            or approval.get('actor') != 'owner' or read(folder / 'declined.json') is not None
            or approval.get('record_revision') != prepared.get('record_revision')):
        raise ValueError('Exact saved owner approval and launch intent are required')
    plan = json.loads(data)
    proposal = read(folder / 'proposal.json')
    if not proposal or proposal.get('id') != folder.name or plan.get('worker_id') != proposal.get('worker_id'):
        raise ValueError('Operation identity does not match the proposal')
    # Preparation supplies the approved record and executor paths. Recheck bytes
    # in the independent process: approval may precede launch by an arbitrary wait.
    record = plan.get('record_file')
    if (not isinstance(record, str) or not Path(record).is_absolute()
            or hashlib.sha256(read_bytes(record)).hexdigest() != prepared.get('record_revision')
            or plan.get('record_revision') != prepared.get('record_revision')):
        raise ValueError('Approved configuration record changed')
    execution = plan.get('execution', {})
    if (set(execution) != {'path', 'sha256'} or not isinstance(execution.get('path'), str)
            or not Path(execution['path']).is_absolute() or not DIGEST.fullmatch(execution.get('sha256', ''))):
        raise ValueError('Prepared plan must bind a trusted executor')
    source = read_bytes(execution['path'])
    if hashlib.sha256(source).hexdigest() != execution['sha256']:
        raise ValueError('Prepared executor changed')
    return plan, revision, source


def observe(directory):
    folder = folder_at(directory)
    fd = lock_file(folder)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            alive = False
        except BlockingIOError:
            alive = True
        result = read(folder / 'runner-result.json')
        progress = read(folder / 'runner-progress.json')
        claim = read(folder / 'runner-started.json')
        # A PID alone is not liveness: the kernel-held lock belongs to this job.
        state = result['state'] if result else 'running' if alive else 'requires_reconciliation'
        original_result = None
        returning = read(folder / 'reconcile-started.json')
        returned = read(folder / 'reconcile-result.json') if returning else None
        if returning and state == 'requires_reconciliation':
            revision = hashlib.sha256(read_bytes(folder / 'plan.json')).hexdigest()
            if returning.get('plan_revision') == revision:
                if returned and returned.get('plan_revision') == revision and returned.get('state') in TERMINAL:
                    original_result, result = result, returned
                    state = returned['state']
                    progress = read(folder / 'reconcile-progress.json')
                elif returned is None and alive:
                    original_result, result = result, None
                    state, progress = 'running', read(folder / 'reconcile-progress.json')
        return {'id': folder.name, 'state': state, 'process_alive': alive,
                'runner': claim, 'progress': progress, 'result': result,
                **({'original_result': original_result} if original_result is not None else {}),
                **({'reconciliation': {'runner': read(folder / 'reconcile-started.json'),
                    'progress': read(folder / 'reconcile-progress.json'), 'result': read(folder / 'reconcile-result.json')}}
                    if read(folder / 'reconcile-started.json') is not None else {}),
                'scope': 'Process liveness is not model progress or successful qualification. A missing process or reply never resubmits the operation.'}
    finally:
        os.close(fd)


def reconciliation(directory, *, execute=False):
    """Use the frozen executor's return path only after its original run stopped."""
    folder = folder_at(directory)
    fd = lock_file(folder)
    try:
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ValueError('An operation still owns the runner lock') from None
        claim = read(folder / 'runner-started.json')
        if not claim: raise ValueError('The original runner identity is unavailable')
        if read(folder / 'runner-result.json') is None:
            # Cover the interval between an original claim and lock acquisition.
            # A saved PID is never signalled; uncertainty or PID reuse blocks.
            pid = claim.get('pid')
            if type(pid) is not int or pid <= 1: raise ValueError('Original process identity unavailable')
            try: os.kill(pid, 0)
            except ProcessLookupError: pass
            else: raise ValueError('The original process may still be active')
        plan, revision, source = approved_plan(folder)
        namespace = {'__name__': 'stargate_approved_executor', '__file__': plan['execution']['path']}
        exec(compile(source, plan['execution']['path'], 'exec'), namespace)
        if read(folder / 'reconcile-started.json') is not None:
            return {'state': 'already_attempted', 'result': read(folder / 'reconcile-result.json')}
        if not execute:
            review = namespace['inspect_reconciliation'](plan, folder, lambda *args: None)
            return {'state': 'ready', 'plan_revision': revision, 'review': review,
                'review_revision': hashlib.sha256(json.dumps(review, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
        approval, intent = read(folder / 'reconcile-approved.json'), read(folder / 'reconcile-launch-intent.json')
        if (not approval or approval.get('actor') != 'owner' or approval.get('plan_revision') != revision
                or not DIGEST.fullmatch(approval.get('review_revision', ''))
                or not intent or intent.get('plan_revision') != revision
                or intent.get('review_revision') != approval['review_revision']):
            raise ValueError('Exact owner approval and return intent are required')
        save(folder, 'reconcile-started.json', {'pid': os.getpid(), 'at': time.time(), 'plan_revision': revision})
        def progress(phase, detail):
            if not isinstance(phase, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', phase) or not isinstance(detail, str) or len(detail) > 1000:
                raise ValueError('Invalid return progress')
            save(folder, 'reconcile-progress.json', {'phase': phase, 'detail': detail,
                'changed_at': time.time(), 'heartbeat_at': time.time()}, replace=True)
        try:
            progress('returning', 'Checking the owner-approved return to service.')
            result = namespace['reconcile'](plan, folder, progress)
            if not isinstance(result, dict) or result.get('state') not in TERMINAL:
                raise ValueError('Return did not establish an explicit outcome')
            save(folder, 'reconcile-result.json', {**result, 'at': time.time(), 'plan_revision': revision})
        except BaseException:
            if read(folder / 'reconcile-result.json') is None:
                save(folder, 'reconcile-result.json', {'state': 'requires_reconciliation', 'at': time.time(),
                    'error': 'Return to service was not confirmed. Original evidence and remaining holds were preserved; no action was replayed.'})
        return {'state': 'attempted', 'result': read(folder / 'reconcile-result.json')}
    finally:
        os.close(fd)


def run(directory, *, heartbeat_seconds=10):
    folder = folder_at(directory)
    if read(folder / 'runner-started.json') is not None:
        return observe(directory)
    plan, revision, source = approved_plan(folder)
    try:
        save(folder, 'runner-started.json', {'id': folder.name, 'pid': os.getpid(),
             'at': time.time(), 'plan_revision': revision, 'executor_sha256': plan['execution']['sha256']})
    except FileExistsError:
        return observe(directory)
    fd = lock_file(folder)
    try:
        # The exclusive claim selects the only executor. Waiting for a brief
        # observer lock cannot accidentally discard the only launch attempt.
        fcntl.flock(fd, fcntl.LOCK_EX)
        mutex, stopped = threading.Lock(), threading.Event()
        current = {'phase': 'starting', 'detail': 'Starting the approved operation.', 'changed_at': time.time()}

        def progress(phase, detail):
            if not isinstance(phase, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', phase) or not isinstance(detail, str) or len(detail) > 1000:
                raise ValueError('Invalid operation progress')
            with mutex:
                current.update(phase=phase, detail=detail, changed_at=time.time())
                save(folder, 'runner-progress.json', {**current, 'heartbeat_at': time.time()}, replace=True)

        def heartbeat():
            while not stopped.wait(heartbeat_seconds):
                with mutex:
                    save(folder, 'runner-progress.json', {**current, 'heartbeat_at': time.time()}, replace=True)

        pulse = threading.Thread(target=heartbeat, daemon=True)
        try:
            progress('starting', 'Starting the approved operation.')
            pulse.start()
            # Compile the exact bytes checked above, rather than importing a path
            # that could have changed between its hash check and execution.
            namespace = {'__name__': 'stargate_approved_executor', '__file__': plan['execution']['path']}
            exec(compile(source, plan['execution']['path'], 'exec'), namespace)
            result = namespace['execute'](plan, folder, progress)
            if not isinstance(result, dict) or result.get('state') not in TERMINAL:
                raise ValueError('Executor did not return an explicit terminal outcome')
            # The enrolled executor owns the actual checks and evidence. This
            # supervisor never converts a process exit or healthy port to success.
            save(folder, 'runner-result.json', {**result, 'at': time.time(), 'plan_revision': revision})
        except BaseException:
            if read(folder / 'runner-result.json') is None:
                save(folder, 'runner-result.json', {'state': 'requires_reconciliation', 'at': time.time(),
                     'plan_revision': revision, 'error': 'The operation did not finish with a confirmed outcome. Existing evidence and holds were preserved; inspect them before another action.'})
        finally:
            stopped.set()
            if pulse.ident is not None:
                pulse.join()
        fcntl.flock(fd, fcntl.LOCK_UN)
        return observe(directory)
    finally:
        os.close(fd)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['run', 'observe', 'inspect-return', 'return'])
    parser.add_argument('directory')
    args = parser.parse_args()
    try:
        result = (run(args.directory) if args.action == 'run' else observe(args.directory) if args.action == 'observe'
            else reconciliation(args.directory, execute=args.action == 'return'))
        print(json.dumps(result))
    except Exception:
        # No raw executor, private file or transport exceptions in the UI log.
        print(json.dumps({'state': 'observation_unavailable' if args.action == 'observe' else 'launch_unconfirmed',
                          'error': 'Operation files could not be validated. No operation was replayed.'}))
        raise SystemExit(1)
