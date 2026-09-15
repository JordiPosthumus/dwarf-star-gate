"""Freeze the known serving executor modules into one approved source artifact.

This is a preparation helper, not a model tool. The ordinary runner already
checks and compiles the exact entry-point bytes; embedding dependencies makes
that same approval cover the full local implementation without an installer,
import-path changes, or a dependency service. Python's standard library remains
the installed runtime, explicitly outside this source snapshot.
"""
import hashlib
import os
from pathlib import Path
import uuid

from operation_runner import read_bytes, save

MODULES = ('operation_runner', 'docker_profile', 'docker_profile_remote',
    'operation_maintenance', 'serving_qualification', 'serving_records',
    'serving_operation', 'serving_executor')

LOADER = '''
def execute(plan, folder, progress):
    import sys, types
    previous = {name: sys.modules.get(name) for name in _SOURCES}
    try:
        for name, source in _SOURCES.items():
            module = types.ModuleType(name)
            module.__file__ = __file__ + ':' + name + '.py'
            module._BUNDLED_SOURCES = _SOURCES
            sys.modules[name] = module
            exec(compile(source, module.__file__, 'exec'), module.__dict__)
        return sys.modules['serving_executor'].execute(plan, folder, progress)
    finally:
        for name, module in previous.items():
            if module is None: sys.modules.pop(name, None)
            else: sys.modules[name] = module
'''


def build_executor(folder, *, source_directory=None):
    folder = Path(folder).resolve()
    directory = Path(source_directory) if source_directory is not None else Path(__file__).parent
    sources = {name: read_bytes(directory / (name + '.py')).decode('utf-8') for name in MODULES}
    for name, source in sources.items():
        compile(source, name + '.py', 'exec')
    data = ('# Frozen Star Gate serving executor. The approved hash covers every embedded module.\n'
        + '_SOURCES = ' + repr(sources) + '\n' + LOADER).encode('utf-8')
    if len(data) > 2 * 1024 * 1024:
        raise ValueError('Executor exceeds the existing approved-source receipt limit')
    target = folder / 'executor.py'
    temporary = folder / ('executor.' + str(uuid.uuid4()) + '.tmp')
    try:
        with temporary.open('xb') as stream:
            os.chmod(temporary, 0o600)
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.link(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    manifest = {'schema': 1, 'modules': {name: hashlib.sha256(source.encode('utf-8')).hexdigest()
        for name, source in sources.items()}, 'scope': 'Frozen local executor sources; Python standard library and enrolled host software are not vendored.'}
    save(folder, 'executor-sources.json', manifest)
    return {'path': str(target), 'sha256': hashlib.sha256(data).hexdigest()}
