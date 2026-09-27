"""Start the pinned native gateway after registering configured plugin platforms.

Hermes's explicit --config path otherwise parses platform names before plugin
discovery and silently omits third-party platforms. No agent or transport loop
is implemented here: all arguments and execution belong to gateway.run.
"""
import runpy

from hermes_cli.plugins import discover_plugins


if __name__ == '__main__':
    discover_plugins()
    runpy.run_module('gateway.run', run_name='__main__')
