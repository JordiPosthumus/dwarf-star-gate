"""Trusted entry point joining the approved serving components.

Preparation supplies enrolled connections, verified model contracts, the exact
Docker plan and the complete record for owner review. None is read from chat or
mutable installation settings during execution. This file is frozen with all
required local modules by serving_bundle.py before the plan is approved.
"""
from pathlib import Path

from docker_profile import RetainedProfile
from docker_profile_remote import SSHDocker
from operation_maintenance import GatewayControl, Maintenance
from serving_operation import ServingOperation
from serving_qualification import NativeQualification
from serving_records import ServingRecordPublisher
from serving_trial import TrialMeasurement


def execute(plan, folder, progress):
    sources = globals().get('_BUNDLED_SOURCES')
    if not sources or 'docker_profile' not in sources:
        raise ValueError('Execute the frozen approved bundle, not an installed mutable entry point')
    target = plan.get('target', {})
    if set(target) != {'ssh', 'docker_socket', 'gateway_socket'}:
        raise ValueError('Use the enrolled SSH, Docker and gateway connections')
    contracts = plan.get('qualification', {})
    if set(contracts) != {'candidate', 'previous'}:
        raise ValueError('Both serving versions need their approved qualification contracts')
    folder = Path(folder)
    docker = SSHDocker(target['ssh'], target['docker_socket'], source=sources['docker_profile'])
    control = GatewayControl(target['gateway_socket'])
    maintenance = Maintenance(folder, folder.name, plan['worker_id'], control=control, progress=progress,
        purpose='trial' if plan.get('trial') is not None else 'serving')
    driver = RetainedProfile(folder / 'containers', docker=docker,
        lease_check=maintenance.owned, idle=docker.idle)
    qualifiers = {which: NativeQualification(docker.native_request, plan['profile']['native_url'], contract,
        progress=progress) for which, contract in contracts.items()}
    publisher = ServingRecordPublisher(Path(plan['record_file']).parent.parent)
    measurement = TrialMeasurement(plan, folder, docker, maintenance, progress).run if plan.get('trial') is not None else None
    return ServingOperation(plan, folder, driver=driver, maintenance=maintenance,
        candidate_qualifier=qualifiers['candidate'], previous_qualifier=qualifiers['previous'],
        publish=publisher, progress=progress, measurement=measurement).run()
