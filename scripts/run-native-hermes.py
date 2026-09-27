"""Start the pinned native gateway after registering configured plugin platforms.

Hermes's explicit --config path otherwise parses platform names before plugin
discovery and silently omits third-party platforms. No agent or transport loop
is implemented here: all arguments and execution belong to gateway.run.
"""
import runpy
import os
from pathlib import Path
import sys

import yaml

from hermes_cli.plugins import discover_plugins


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ds4-gateway'))
    from genie_native_identity import validate_native_identity
    home = Path(os.environ['HERMES_HOME'])
    config_path = home / 'config.yaml'
    for index, arg in enumerate(sys.argv[1:], 1):
        if arg == '--config':
            config_path = Path(sys.argv[index + 1])
        elif arg.startswith('--config='):
            config_path = Path(arg.split('=', 1)[1])
    validate_native_identity(home, yaml.safe_load(config_path.read_text()))
    from agent.prompt_builder import build_context_files_prompt
    rendered = build_context_files_prompt(cwd=str(home), home_override=home)
    if any((home / name).read_text().strip() not in rendered for name in ('SOUL.md', 'AGENTS.md')):
        raise ValueError('Native Genie identity is shadowed or truncated; no gateway was started')
    if os.environ.get('DSG_NATIVE_SESSION_CONTROLS') == '1':
        import inspect
        from gateway.platforms.base import BasePlatformAdapter
        if 'gate_native_message(self, event, session_key)' not in inspect.getsource(BasePlatformAdapter.handle_message):
            raise ValueError('Native Stop/Continue requires the verified admission policy; no gateway was started')
    discover_plugins()
    runpy.run_module('gateway.run', run_name='__main__')
