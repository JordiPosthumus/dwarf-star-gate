"""Load the installed DSG domain plugin; Telegram remains native Hermes code."""
import importlib.util
from pathlib import Path

def register(ctx):
    directory = Path(ctx.get_config('module_directory', ''))
    if not directory.is_absolute():
        raise ValueError('Use an absolute installed DSG module directory')
    source = directory / 'genie_native_plugin.py'
    spec = importlib.util.spec_from_file_location('stargate_native_plugin', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.register(ctx)
