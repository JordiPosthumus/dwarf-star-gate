"""Read host resources without importing ML packages or changing services."""
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from datetime import datetime, timezone


def command(*args):
    return subprocess.check_output(args, text=True, timeout=8).strip()


def collect(target):
    result = {'observed_at': datetime.now(timezone.utc).isoformat(),
              'system': platform.system(), 'architecture': platform.machine(),
              'memory_total_bytes': None, 'memory_available_bytes': None,
              'gpu_names': [], 'docker_architecture': None, 'disks': [], 'errors': []}
    paths = [('home', Path.home())]
    try:
        if result['system'] == 'Linux':
            memory = {line.split(':')[0]: int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemTotal:', 'MemAvailable:'))}
            result.update(memory_total_bytes=memory.get('MemTotal'), memory_available_bytes=memory.get('MemAvailable'))
        elif result['system'] == 'Darwin':
            result['memory_total_bytes'] = int(command('sysctl', '-n', 'hw.memsize'))
    except (OSError, ValueError, subprocess.SubprocessError):
        result['errors'].append('Host memory unavailable')
    if result['system'] == 'Linux':
        try:
            result['gpu_names'] = command('nvidia-smi', '--query-gpu=name', '--format=csv,noheader').splitlines()
        except (OSError, subprocess.SubprocessError):
            result['errors'].append('NVIDIA hardware unavailable')
        try:
            info = json.loads(command('docker', 'info', '--format', '{{json .}}'))
            result['docker_architecture'] = info.get('Architecture')
            if info.get('DockerRootDir'):
                paths.append(('docker', Path(info['DockerRootDir'])))
            if target.get('container'):
                container = json.loads(command('docker', 'inspect', '--type', 'container', '--', target['container']))[0]
                for mount in container.get('Mounts', []):
                    if mount.get('Type') == 'bind' and mount.get('Source'):
                        paths.append(('existing container mount: ' + mount.get('Destination', 'unknown'), Path(mount['Source'])))
        except (OSError, ValueError, subprocess.SubprocessError):
            result['errors'].append('Docker storage inspection unavailable')
    disks = {}
    for label, location in paths:
        try:
            disk = shutil.disk_usage(location)
            device = os.stat(location).st_dev
            if device in disks:
                disks[device]['locations'].append(label)
            else:
                row = {'locations': [label], 'total_bytes': disk.total, 'free_bytes': disk.free}
                disks[device] = row
                result['disks'].append(row)
        except OSError:
            result['disks'].append({'locations': [label], 'error': 'Disk space unavailable to the enrolled account'})
    result['scope'] = 'Read-only host observations. Free memory includes current workloads. Disk rows describe these existing filesystems, not an unchosen installation destination. No fit guarantee, generation, download, container execution or service change.'
    return result


if __name__ == '__main__':
    print(json.dumps(collect(json.loads(sys.stdin.readline()))))
