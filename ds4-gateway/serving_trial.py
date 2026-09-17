"""One reviewed Hourglass run inside an existing serving-operation hold.

The serving operation owns restoration. This adapter only measures the qualified
candidate; it neither publishes a default nor releases the maintenance window.
"""
import copy
from pathlib import Path
import re
import time

from docker_profile import digest, signature
from hourglass_native import HourglassNative, gateway_target_matches
from hourglass_operation import NativeStartRejected, TERMINAL
from operation_runner import read, save


def prepare_trial(prepared, profile, model, docker, control, worker):
    review, payload = prepared['review'], prepared['payload']
    if (review['model_id'] != model or review['model'] != payload['model']
            or review['window_seconds'] != 3600 or review['question_count'] != len(payload['tasks'])
            or any(review[k] != payload[k] for k in ['models_revision', 'hardware_revision'])
            or not gateway_target_matches(control('/workers'), worker, review['endpoint'])):
        raise ValueError('Use the enrolled direct one-hour measurement for this worker and model')
    trial = {'hourglass': {'url': prepared['url'], 'controller_instance': prepared['controller'],
        **{k: review[k] for k in ['endpoint', 'metric', 'benchmark_version', 'scoring_policy']}},
        'native_request': copy.deepcopy(payload), 'model': model}
    # This GET-only check happens before any drain or container change. The
    # candidate gets its own observed identity after its native checks pass.
    native = HourglassNative(measurement_plan(trial, profile['native_url'], {
        **profile['before'], 'State': {'StartedAt': profile['started_at']}}), docker)
    native.verify_request(payload)
    return trial


def measurement_plan(trial, url, current):
    return {'hourglass': copy.deepcopy(trial['hourglass']),
        'native_request': copy.deepcopy(trial['native_request']),
        'native_target': {'container_id': current['Id'], 'signature_sha256': digest(signature(current)),
            'started_at': current['State']['StartedAt'], 'url': url, 'model': trial['model']}}


class TrialMeasurement:
    def __init__(self, plan, folder, docker, maintenance, progress, *, factory=HourglassNative, sleep=time.sleep):
        self.plan, self.folder = plan, Path(folder) / 'trial-measurement'
        self.docker, self.maintenance, self.progress = docker, maintenance, progress
        self.factory, self.sleep = factory, sleep

    def run(self, current):
        self.folder.mkdir(mode=0o700, exist_ok=True)
        if read(self.folder / 'start-intent.json') is not None:
            raise RuntimeError('Observe the existing trial measurement; never submit it again')
        plan = measurement_plan(self.plan['trial'], self.plan['profile']['native_url'], current)
        save(self.folder, 'plan.json', plan)
        native = self.factory(plan, self.docker)
        def owned():
            if not self.maintenance.owned(require_idle=False):
                raise RuntimeError('The trial no longer owns its serving window')
            if not gateway_target_matches(self.maintenance.control('/workers'), self.plan['worker_id'], plan['hourglass']['endpoint']):
                raise RuntimeError('The measured route changed; inspect the existing trial')
        owned()
        self.maintenance.wait_idle(native.idle)
        if not native.check_target():
            raise RuntimeError('The qualified candidate changed before its measurement')
        self.progress('trial_measurement', 'Starting the reviewed one-hour candidate measurement; the original will be restored afterward.')
        save(self.folder, 'start-intent.json', {'at': time.time(), 'request': plan['native_request']})
        try:
            receipt = native.submit(plan['native_request'])
        except NativeStartRejected:
            result = {'state': 'rejected_before_acceptance', 'job_id': None}
            save(self.folder, 'result.json', result)
            return result
        if not isinstance(receipt, dict) or not re.fullmatch(r'[a-f0-9]{32}', receipt.get('job_id', '')):
            raise RuntimeError('Measurement acceptance is uncertain; no start was retried')
        save(self.folder, 'acceptance.json', receipt)
        while True:
            owned()
            try:
                observation = native.observe(receipt['job_id'])
            except Exception:
                observation = {'state': 'unknown'}
            state = observation.get('state')
            save(self.folder, 'observation.json', {'at': time.time(), 'job_id': receipt['job_id'], 'state': state}, replace=True)
            if state in TERMINAL:
                break
            self.progress('trial_measurement', 'Observing the same Hourglass trial job: ' + (state if state in {'running', 'pending'} else 'status temporarily unavailable') + '.')
            self.sleep(15)
        self.maintenance.wait_idle(native.idle)
        owned()
        if not native.check_target():
            raise RuntimeError('Candidate identity changed during measurement')
        result = {'state': state, 'job_id': receipt['job_id'], 'at': time.time(),
            'candidate_signature_sha256': plan['native_target']['signature_sha256'],
            'scope': 'Native job outcome and exact candidate identity, not a score or adoption decision.'}
        save(self.folder, 'result.json', result)
        return result
