"""Stage the owner's Genie identity and complete guidance in a native profile.

This writes identity files only. It never configures credentials, starts Hermes,
changes the source profile or overwrites an occupied destination.
"""
import hashlib
import json
import os
from pathlib import Path
import stat

from genie_native_sessions import private_directory, private_read, private_save
from genie_operating_policy import native_operating_instructions


def digest(data):
    return hashlib.sha256(data).hexdigest()


def instruction_budget(files):
    # Hermes counts formatted provenance headings as well as file contents.
    # Reserve room for those wrappers; startup also checks the actual rendering.
    return ((max(len(data.decode('utf-8')) for data in files.values()) + 4096 + 4095) // 4096) * 4096


def validate_native_identity(home, config):
    home = private_directory(home)
    receipt = private_read(home / 'dsg-identity.json')
    if not isinstance(receipt, dict) or receipt.get('schema') != 1:
        raise ValueError('Prepare and verify the dedicated native Genie identity before launch')
    for name in ('SOUL.md', 'AGENTS.md'):
        file = home / name
        info = file.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid()
                or digest(file.read_bytes()) != receipt.get('native_sha256', {}).get(name)):
            raise ValueError('Native identity changed or is not private; nothing replaced')
    required = instruction_budget({name: (home / name).read_bytes() for name in ('SOUL.md', 'AGENTS.md')})
    limit = config.get('context_file_max_chars')
    if type(limit) is not int or limit < required or required != receipt.get('required_context_file_max_chars'):
        raise ValueError('Set context_file_max_chars to at least the identity receipt requirement; otherwise Hermes can truncate operating instructions')
    return receipt


def prepare_native_identity(source_home, destination):
    source = Path(source_home)
    destination = Path(destination)
    if source.resolve() == destination.resolve():
        raise ValueError('The native profile must be separate from the current identity')
    originals = {}
    for name in ('SOUL.md', 'AGENTS.md'):
        file = source / name
        if file.is_symlink() or not file.is_file():
            raise ValueError('Both original identity files must be regular files')
        data = file.read_bytes()
        if not data.decode('utf-8').strip():
            raise ValueError('Both original identity files must be nonempty UTF-8')
        originals[name] = data
    files = {'SOUL.md': originals['SOUL.md'],
             'AGENTS.md': (native_operating_instructions(originals['AGENTS.md'].decode('utf-8')) + '\n').encode()}
    receipt = {'schema': 1, 'source_sha256': {name: digest(data) for name, data in originals.items()},
               'native_sha256': {name: digest(data) for name, data in files.items()},
               'required_context_file_max_chars': instruction_budget(files)}
    home = private_directory(destination)
    record = home / 'dsg-identity.json'
    saved = private_read(record)
    if saved is not None:
        if saved != receipt or any((home / name).is_symlink() or not (home / name).is_file()
                                  or digest((home / name).read_bytes()) != receipt['native_sha256'][name]
                                  for name in files):
            raise ValueError('Native identity differs from its source or receipt; nothing replaced')
        return receipt
    if any(home.iterdir()):
        raise ValueError('Native profile destination is occupied; nothing replaced')
    for name, data in files.items():
        file = home / name
        with file.open('xb') as output:
            file.chmod(0o600)
            output.write(data)
    private_save(record, receipt)
    return receipt


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-home', required=True)
    parser.add_argument('--home', required=True)
    args = parser.parse_args()
    print(json.dumps(prepare_native_identity(args.source_home, args.home)))
