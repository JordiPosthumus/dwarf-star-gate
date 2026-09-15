"""Frozen measurement entry for the existing exact-approval operation runner."""
from pathlib import Path

from docker_profile_remote import SSHDocker
from hourglass_native import HourglassNative, gateway_target_matches
from hourglass_operation import HourglassOperation, TERMINAL
from operation_maintenance import GatewayControl, Maintenance
from operation_runner import read, save
from docker_profile import digest


def components(plan, folder, progress):
    sources = globals().get('_BUNDLED_SOURCES')
    if not sources or 'docker_profile' not in sources:
        raise ValueError('Use the frozen approved measurement executor')
    target = plan['target']
    if set(target) != {'ssh', 'docker_socket', 'gateway_socket'}:
        raise ValueError('Use the enrolled measurement connections')
    folder = Path(folder)
    if plan.get('id') != folder.name:
        raise ValueError('The measurement does not identify this operation')
    docker = SSHDocker(target['ssh'], target['docker_socket'], source=sources['docker_profile'])
    control = GatewayControl(target['gateway_socket'])
    maintenance = Maintenance(folder, folder.name, plan['worker_id'],
        control=control, progress=progress, purpose='hourglass')
    native = HourglassNative(plan, docker)
    check_native = native.check_target
    native.check_target = lambda: (gateway_target_matches(control('/workers'),
        plan['worker_id'], plan['hourglass']['endpoint']) and check_native())
    return maintenance, native


def execute(plan, folder, progress):
    maintenance, native = components(plan, folder, progress)
    result = HourglassOperation(plan, folder, maintenance=maintenance, native=native, progress=progress).run()
    # Completed describes this lifecycle. The native outcome remains explicit,
    # including rejection/error; neither completion nor readmission is a score.
    return {'state': 'completed' if result['readmission']['state'] == 'readmitted' else 'requires_reconciliation',
        'measurement': result, 'scope': 'Measurement lifecycle only. Read the native outcome and its separately collected aggregate report.'}


def inspect_reconciliation(plan, folder, progress):
    """Observe a finished saved job; this does not acquire/release a hold."""
    folder = Path(folder)
    if any(read(folder / name) is not None for name in ['readmission-intent.json',
            'gateway/release.intent.json', 'gateway/resume.intent.json']):
        raise ValueError('Readmission already began; inspect its existing receipts instead of repeating it')
    receipt = read(folder / 'native-acceptance.json')
    if not receipt:
        raise ValueError('Native acceptance is unknown; it cannot be treated as a finished measurement')
    maintenance, native = components(plan, folder, progress)
    if not native.check_target() or not maintenance.owned(require_idle=True) or not native.idle():
        raise ValueError('The unchanged worker and its exclusive idle maintenance hold are not verified')
    observed = native.observe(receipt['job_id'])
    if observed['state'] not in TERMINAL:
        raise ValueError('The saved native job is not confirmed finished')
    acquired = read(folder / 'gateway/acquire.result.json')
    return {'worker_id': plan['worker_id'], 'job_id': receipt['job_id'], 'native_state': observed['state'],
        'native_target': plan['native_target'], 'lock_id': acquired['result']['lock_id'],
        'scope': 'Release only this finished measurement hold and return the unchanged server if operator decisions still permit it. No benchmark is started or cancelled.'}


def reconcile(plan, folder, progress):
    folder = Path(folder)
    approval = read(folder / 'reconcile-approved.json')
    review = inspect_reconciliation(plan, folder, progress)
    if not approval or approval.get('actor') != 'owner' or approval.get('review_revision') != digest(review):
        raise ValueError('Approve the exact observed return-to-service review')
    maintenance, native = components(plan, folder, progress)
    progress('waiting_idle', 'Rechecking the finished measurement before returning the server.')
    maintenance.wait_idle(native.idle)
    if digest(inspect_reconciliation(plan, folder, progress)) != approval['review_revision']:
        raise ValueError('The reviewed return-to-service conditions changed')
    save(folder, 'readmission-intent.json', {'job_id': review['job_id'], 'native_state': review['native_state'],
        'source': 'explicit_owner_reconciliation'})
    maintenance.release()
    readmission = maintenance.resume_if_unchanged()
    result = {'job_id': review['job_id'], 'native_state': review['native_state'], 'readmission': readmission,
        'scope': 'Owner-approved completion of a finished measurement; the original runner evidence is preserved.'}
    save(folder, 'measurement-result.json', result)
    return {'state': 'completed', 'measurement': result}
