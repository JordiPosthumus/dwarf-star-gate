"""Media uses the existing owned drain and conditional readmission controls."""
import json
import hashlib
from pathlib import Path
import sys
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from operation_maintenance import Maintenance, GatewayControl
from serving_qualification import native_load
from docker_profile import UnixHTTP


def qualification_permit(plan, raw):
    qualification = plan.get('ace_qualification')
    if qualification is None:
        return
    body = {'operation_id': qualification['candidate_operation_id'], 'job_id': plan['operation_id'],
            'plan_file_sha256': hashlib.sha256(raw).hexdigest()}
    connection = UnixHTTP(plan['control_socket'], 30)
    try:
        connection.request('POST', '/media-qualification-permit', json.dumps(body), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = response.read(1048577)
        if response.status != 200 or len(data) > 1048576 or json.loads(data).get('allowed') is not True:
            raise RuntimeError('Candidate qualification permission unavailable; no new test work')
    finally:
        connection.close()


def main(folder, action):
    folder = Path(folder)
    raw = (folder / 'plan.json').read_bytes()
    plan = json.loads(raw)
    # Deny new borrowing, native LLM-stop/media-start and generation if policy
    # changed. Cleanup's owned/finish path remains available to return the LLM.
    if action in ('prepare', 'transition'):
        qualification_permit(plan, raw)
    control = GatewayControl(plan['control_socket'])
    window = Maintenance(folder, plan['operation_id'], plan['worker_id'], control=control, purpose='media')

    def floor():
        workers = control('/workers')['workers']
        others = [w for w in workers if w['id'] != plan['worker_id'] and (not plan.get('llm_pair') or w['id'] in plan.get('separate_workers', [])) and w.get('is_healthy')
                  and not any(w.get(k) for k in ['drained', 'quarantine', 'recovering', 'holds', 'maintenance_locks'])]
        if not others:
            raise RuntimeError('At least one other healthy LLM must remain serving')
        return {'other_llms': [w['id'] for w in others]}

    def idle():
        url = plan['recovery']['url'].removesuffix('/').removesuffix('/v1') + '/metrics'
        with urllib.request.urlopen(url, timeout=10) as response:
            load = native_load(response.read(1048576))
        return load['num_requests_running'] == load['num_requests_waiting'] == 0

    if action == 'prepare':
        floor(); window.acquire(); window.wait_idle(idle)
        return {'idle': True, **floor()}
    if action == 'transition':
        return {'owned': window.owned(), **floor()}
    if action == 'owned':
        return {'owned': window.owned()}
    if action == 'finish':
        if plan.get('llm_pair'):window.wait_idle(idle)
        window.release()
        return window.resume_if_unchanged()
    raise ValueError('Unknown media maintenance action')


if __name__ == '__main__':
    print(json.dumps(main(*sys.argv[1:])))
