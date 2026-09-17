"""Inspect mounted H3 input files without starting a container or reading image bytes."""
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys


def collect(request, inspect=None):
    if inspect is None:
        inspect = lambda identifier: json.loads(subprocess.check_output(
            ['docker', 'inspect', '--type', 'container', '--', identifier], timeout=8))[0]
    container = inspect(request['container'])
    if container.get('Id') != request['container'] or container.get('Image') != request['image']:
        raise ValueError('Enrolled media container identity changed')
    cfg = container.get('Config', {})
    # The shipped wrapper starts from /opt/ComfyUI and appends these arguments.
    # Other launchers remain unverified rather than guessing their input roots.
    known = '/usr/local/bin/h3-entrypoint' in (cfg.get('Entrypoint') or []) and cfg.get('WorkingDir') == '/opt/ComfyUI'
    env = dict(v.split('=', 1) for v in cfg.get('Env', []) if '=' in v)
    args = env.get('COMFYUI_EXTRA_ARGS', '').split()
    if any(a == '--base-directory' or a.startswith('--base-directory=') for a in args): known = False
    roots = {'input': '/opt/ComfyUI/input', 'output': '/opt/ComfyUI/output', 'temp': '/opt/ComfyUI/temp'}
    for kind in roots:
        flag = '--' + kind + '-directory'
        for i, arg in enumerate(args):
            if arg == flag:
                if i + 1 >= len(args): known = False
                else: roots[kind] = args[i + 1]
            elif arg.startswith(flag + '='): roots[kind] = arg.split('=', 1)[1]
        if not roots[kind].startswith('/'): roots[kind] = '/opt/ComfyUI/' + roots[kind]
    rows = []
    for item in request['files']:
        row = {**item, 'state': 'unknown'}
        name, kind = item['name'], 'input'
        for suffix in roots:
            if name.endswith(' [' + suffix + ']'):
                name, kind = name[:-(len(suffix) + 3)], suffix
                break
        parts = PurePosixPath(name)
        if known and name and not parts.is_absolute() and '..' not in parts.parts and '\x00' not in name:
            target = PurePosixPath(roots[kind]) / parts
            mounts = sorted(container.get('Mounts', []), key=lambda m: len(m.get('Destination', '')), reverse=True)
            for mount in mounts:
                destination = PurePosixPath(mount.get('Destination', '/unavailable'))
                if not target.is_relative_to(destination): continue
                if mount.get('Type') != 'bind': break  # A nested volume hides a parent bind.
                root = Path(mount['Source']).resolve()
                host = root.joinpath(*target.relative_to(destination).parts)
                # Do not mistake a container symlink for a host-side path.
                if any(p.is_symlink() for p in [host, *list(host.parents)[:len(host.relative_to(root).parts)]]): break
                try:
                    stat = host.stat()
                    row.update(state='present' if host.is_file() else 'not_a_file', bytes=stat.st_size)
                except FileNotFoundError: row['state'] = 'missing'
                except OSError: pass
                row['container_path'] = str(target)
                break
        rows.append(row)
    return {'files': rows, 'scope': 'Mounted paths for the enrolled H3 wrapper; custom launchers, unmounted files, symlinks and unsafe relative paths remain unknown. Presence does not prove decodability. No file bytes were read and no services changed.'}


if __name__ == '__main__':
    print(json.dumps(collect(json.loads(sys.stdin.readline()))))
