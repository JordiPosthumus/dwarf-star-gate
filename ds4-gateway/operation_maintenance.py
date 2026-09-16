"""Owned gateway maintenance for a trusted approved-operation executor.

This adapter does not approve a change or qualify a model. The serving executor
must verify its result before releasing the hold and requesting readmission.
"""
import json
from pathlib import Path
import re
import time
import uuid

from docker_profile import UnixHTTP
from operation_runner import read, save

CHANNEL = 'approved_operation'


class GatewayControl:
    def __init__(self, socket):
        if not isinstance(socket, str) or not Path(socket).is_absolute():
            raise ValueError('Use the enrolled gateway socket')
        self.socket = socket

    def __call__(self, route, body=None):
        if route not in ['/workers', '/maintenance-lock', '/release-maintenance-lock', '/maintenance-receipt', '/resume-workers']:
            raise ValueError('Unsupported operation control')
        connection = UnixHTTP(self.socket, 30)
        try:
            connection.request('GET' if route == '/workers' else 'POST', route,
                               None if body is None else json.dumps(body),
                               {'Content-Type': 'application/json', 'X-DSG-Control-Channel': CHANNEL})
            response = connection.getresponse()
            data = response.read(1048577)
            if len(data) > 1048576 or not 200 <= response.status < 300:
                raise RuntimeError('Gateway observation or operation was not confirmed')
            return json.loads(data)
        finally:
            connection.close()


class Maintenance:
    def __init__(self, directory, operation_id, worker_id, *, control, progress=lambda *args: None, sleep=time.sleep, purpose='serving'):
        if purpose not in ('serving', 'hourglass', 'media'):
            raise ValueError('Unknown maintenance purpose')
        self.purpose = purpose
        if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', operation_id) or not re.fullmatch(r'[a-zA-Z0-9][\w-]{0,63}', worker_id):
            raise ValueError('Use the approved operation and enrolled worker identities')
        self.folder = Path(directory) / 'gateway'
        self.folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.folder.is_symlink():
            raise ValueError('Maintenance receipts must not be a symlink')
        self.operation_id, self.worker_id = operation_id, worker_id
        self.control, self.progress, self.sleep = control, progress, sleep

    def snapshot(self):
        data = self.control('/workers')
        if data.get('conditional_resume_version') != 1:
            raise RuntimeError('Gateway must support conditional readmission before this workflow starts')
        if self.purpose == 'media' and data.get('media_maintenance_version') != 1:
            raise RuntimeError('Gateway must support the media LLM minimum before this workflow starts')
        matches = [w for w in data.get('workers', []) if w.get('id') == self.worker_id]
        recovery = [w for w in data.get('recovery', {}).get('workers', []) if w.get('worker_id') == self.worker_id]
        if len(matches) != 1 or len(recovery) != 1:
            raise RuntimeError('Current worker and recovery ownership are not established')
        worker = matches[0]
        if (not all(type(worker.get(k)) is int and worker[k] >= 0 for k in ['load', 'queued'])
                or not all(type(worker.get(k)) is bool for k in ['drained', 'operator_paused'])
                or not all(isinstance(worker.get(k), list) for k in ['holds', 'maintenance_locks'])
                or 'last_operator_action' not in worker):
            raise RuntimeError('Incomplete current maintenance observation')
        return {'worker': worker, 'recovery': recovery[0]}

    @staticmethod
    def action(snapshot):
        return (snapshot['worker'].get('last_operator_action') or {}).get('id')

    def _receipt(self, name, body, route, action):
        intent = read(self.folder / (name + '.intent.json'))
        if intent is not None and intent['body'] != body:
            raise RuntimeError('Existing maintenance intent belongs to another action')
        result = read(self.folder / (name + '.result.json'))
        if result is None:
            if intent is None:
                save(self.folder, name + '.intent.json', {'at': time.time(), 'body': body})
                result = self.control(route, body)  # One submission only.
            else:
                result = self.control('/maintenance-receipt', {'request_id': body['request_id']})
            if (result.get('request_id') != body['request_id'] or result.get('action') != action
                    or result.get('control_channel') != CHANNEL or result.get('result', {}).get('worker_id') != self.worker_id
                    or (action == 'release' and result['result'].get('lock_id') != body['lock_id'])):
                raise RuntimeError('Maintenance acknowledgement does not identify this operation')
            save(self.folder, name + '.result.json', result)
        return result

    def acquire(self):
        baseline = read(self.folder / 'before.json')
        if baseline is None:
            baseline = self.snapshot()
            if baseline['worker']['holds'] or baseline['worker']['maintenance_locks'] or baseline['recovery']['state'] == 'recovering':
                raise RuntimeError('Another maintenance or recovery operation owns this worker')
            save(self.folder, 'before.json', baseline)
        body = {'worker_id': self.worker_id, 'request_id': self.operation_id,
                'name': 'Approved Genie operation', 'reason': 'Hold this worker for the exact approved serving change.', 'review_after_hours': None}
        if self.purpose == 'hourglass':
            body.update(name='Approved Hourglass measurement', reason='Keep new gateway work off this worker during the approved measurement.')
        elif self.purpose == 'media':
            body.update(name='Genie media job', reason='Serve queued media while keeping another LLM available.', minimum_other_llms=1)
        result = self._receipt('acquire', body, '/maintenance-lock', 'lock')
        self.owned(require_idle=False)
        return result

    def owned(self, operation_id=None, *, require_idle=True):
        if operation_id is not None and operation_id != self.operation_id:
            return False
        acquired = read(self.folder / 'acquire.result.json')
        baseline = read(self.folder / 'before.json')
        if not acquired or not baseline:
            return False
        current = self.snapshot()
        worker, lock_id = current['worker'], acquired['result']['lock_id']
        locks = worker['maintenance_locks']
        if (not worker['drained'] or worker['holds'] or len(locks) != 1
                or locks[0].get('id') != lock_id or locks[0].get('control_channel') != CHANNEL
                or self.action(current) != self.action(baseline) or worker['operator_paused'] != baseline['worker']['operator_paused']
                or current['recovery']['state'] == 'recovering'):
            raise RuntimeError('Maintenance ownership or operator decision changed; no further serving change is allowed')
        return not require_idle or worker['load'] == worker['queued'] == 0

    def wait_idle(self, native_idle):
        while True:
            if self.owned() and native_idle() is True:
                self.sleep(3)
                if self.owned() and native_idle() is True:
                    self.progress('idle_verified', 'Gateway and direct server work have finished.')
                    return
            self.progress('waiting_idle', 'Waiting for existing gateway and direct server work to finish.')
            self.sleep(2)

    def release(self):
        acquired = read(self.folder / 'acquire.result.json')
        if not acquired:
            raise RuntimeError('No owned maintenance receipt to release')
        if read(self.folder / 'release.before.json') is None:
            save(self.folder, 'release.before.json', self.snapshot())
        body = {'lock_id': acquired['result']['lock_id'],
                'request_id': str(uuid.uuid5(uuid.UUID(self.operation_id), 'release-maintenance')),
                'reason': 'The approved operation has finished its serving checks; release only its own hold.'}
        if self.purpose == 'hourglass':
            body['reason'] = 'The measurement ended and direct work finished; release only its own hold.'
        elif self.purpose == 'media':
            body['reason'] = 'Media work ended and the original LLM passed serving checks; release only its own hold.'
        return self._receipt('release', body, '/release-maintenance-lock', 'release')

    def resume_if_unchanged(self):
        if not read(self.folder / 'release.result.json'):
            raise RuntimeError('Release the owned hold before requesting readmission')
        result = read(self.folder / 'resume.result.json')
        if result is not None:
            return result
        if read(self.folder / 'resume.intent.json') is not None:
            raise RuntimeError('Readmission response is uncertain; observe existing state without submitting it again')
        baseline, current = read(self.folder / 'before.json'), self.snapshot()
        before_release = read(self.folder / 'release.before.json')
        worker = current['worker']
        reason = ('preexisting_operator_pause' if baseline['worker']['operator_paused'] else
                  'pause_before_release' if before_release['worker']['operator_paused'] else
                  'operator_decision_changed' if self.action(baseline) != self.action(current) else
                  'other_maintenance_present' if worker['holds'] or worker['maintenance_locks'] or current['recovery']['state'] == 'recovering' else None)
        if reason:
            result = {'state': 'left_to_operator', 'reason': reason, 'observed_drained': worker['drained']}
        else:
            body = {'workers': [self.worker_id], 'expected_operator_actions': {self.worker_id: self.action(baseline)},
                    'expected_maintenance_actions': {self.worker_id: read(self.folder / 'release.result.json')['request_id']}}
            save(self.folder, 'resume.intent.json', {'at': time.time(), 'body': body})
            self.control('/resume-workers', body)
            after = self.snapshot()
            if after['worker']['drained'] or after['worker']['holds'] or after['worker']['maintenance_locks']:
                raise RuntimeError('Current readmission could not be confirmed')
            result = {'state': 'readmitted', 'operator_action': after['worker']['last_operator_action']}
        result['observed_at'] = time.time()
        save(self.folder, 'resume.result.json', result)
        return result
