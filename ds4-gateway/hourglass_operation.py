"""Owned measurement sequence for a trusted independent runner.

Not an approval API or a production entry point. The enrolled native adapter must
bind the reviewed target, enforce its native revisions, and report direct work.
Existing dashboard owner-started measurements remain unchanged until integrated.
"""
from pathlib import Path
import re
import time

from operation_runner import read, save

TERMINAL = {'completed', 'stopped', 'error', 'cancelled'}


class NativeStartRejected(Exception):
    """Trusted adapter proved rejection before native acceptance; never a timeout."""


class HourglassOperation:
    def __init__(self, plan, directory, *, maintenance, native, progress=lambda *args: None, sleep=time.sleep):
        self.plan, self.folder = plan, Path(directory)
        self.maintenance, self.native = maintenance, native
        self.progress, self.sleep = progress, sleep
        if (plan.get('id') != maintenance.operation_id or plan.get('worker_id') != maintenance.worker_id
                or maintenance.purpose != 'hourglass' or not isinstance(plan.get('native_request'), dict)):
            raise ValueError('Measurement must match its approved worker and native request')
        self.folder.mkdir(parents=True, exist_ok=True)

    def run(self):
        recorded = read(self.folder / 'measurement-plan.json')
        if recorded is None:
            save(self.folder, 'measurement-plan.json', self.plan)
        elif recorded != self.plan:
            raise RuntimeError('The recorded measurement plan changed')
        result = read(self.folder / 'measurement-result.json')
        if result is not None:
            return result
        # A process lost during readmission requires inspection; do not replay
        # an uncertain release/resume merely because its result is absent.
        if read(self.folder / 'readmission-intent.json') is not None:
            raise RuntimeError('Measurement readmission requires reconciliation')
        receipt = read(self.folder / 'native-acceptance.json')
        rejected = read(self.folder / 'native-rejection.json')
        if receipt is None and rejected is None and read(self.folder / 'native-start-intent.json') is not None:
            raise RuntimeError('Native start acceptance is uncertain; no start will be retried')
        if self.native.check_target() is not True:
            raise RuntimeError('The reviewed native target is not verified')
        self.maintenance.acquire()
        if receipt is None and rejected is None:
            self.progress('waiting_idle', 'Waiting for existing work before the measurement.')
            self.maintenance.wait_idle(self.native.idle)
            if self.native.check_target() is not True:
                raise RuntimeError('The reviewed native target changed before measurement')
            save(self.folder, 'native-start-intent.json', {'at': time.time(), 'request': self.plan['native_request']})
            try:
                receipt = self.native.submit(self.plan['native_request'])
            except NativeStartRejected:
                rejected = {'at': time.time(), 'state': 'rejected_before_acceptance'}
                save(self.folder, 'native-rejection.json', rejected)
            if rejected is None:
                if not isinstance(receipt, dict) or not re.fullmatch(r'[a-f0-9]{32}', receipt.get('job_id', '')):
                    raise RuntimeError('Native start returned no valid receipt; do not retry')
                save(self.folder, 'native-acceptance.json', receipt)
        job, state = (receipt['job_id'], None) if receipt else (None, 'rejected')
        while job:
            # Preserve a newer manual decision, even if native work continues.
            if self.maintenance.owned(require_idle=False) is not True:
                raise RuntimeError('Measurement maintenance ownership is unavailable')
            try:
                observation = self.native.observe(job)
            except Exception:
                self.progress('observation_unavailable', 'The saved Hourglass job may still be running; checking the same receipt.')
                self.sleep(15)
                continue
            state = observation.get('state') if isinstance(observation, dict) else None
            if state not in TERMINAL | {'pending', 'running'}:
                self.progress('observation_unavailable', 'No terminal state is established for the saved Hourglass job.')
                self.sleep(15)
                continue
            save(self.folder, 'native-observation.json', {'job_id': job, 'observed_at': time.time(),
                'state': state}, replace=True)
            if state in TERMINAL:
                break
            self.progress('measuring', 'Hourglass reports the saved measurement ' + state + '.')
            self.sleep(15)
        # A terminal controller receipt does not prove its last native request
        # has finished. Keep the worker isolated until both observations agree.
        self.maintenance.wait_idle(self.native.idle)
        if self.native.check_target() is not True:
            raise RuntimeError('Native target changed; readmission requires inspection')
        save(self.folder, 'readmission-intent.json', {'at': time.time(), 'job_id': job, 'native_state': state})
        self.maintenance.release()
        readmission = self.maintenance.resume_if_unchanged()
        result = {'job_id': job, 'native_state': state, 'readmission': readmission,
            'scope': 'Native job termination and gateway readmission only; aggregate score collection is separate.'}
        save(self.folder, 'measurement-result.json', result)
        return result
