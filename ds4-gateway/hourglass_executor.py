"""Frozen measurement entry for the existing exact-approval operation runner."""
from pathlib import Path

from docker_profile_remote import SSHDocker
from hourglass_native import HourglassNative, gateway_target_matches
from hourglass_operation import HourglassOperation
from operation_maintenance import GatewayControl, Maintenance


def execute(plan, folder, progress):
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
    result = HourglassOperation(plan, folder, maintenance=maintenance, native=native, progress=progress).run()
    # Completed describes this lifecycle. The native outcome remains explicit,
    # including rejection/error; neither completion nor readmission is a score.
    return {'state': 'completed' if result['readmission']['state'] == 'readmitted' else 'requires_reconciliation',
        'measurement': result, 'scope': 'Measurement lifecycle only. Read the native outcome and its separately collected aggregate report.'}
