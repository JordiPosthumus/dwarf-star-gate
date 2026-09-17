"""SSH transport for the retained Docker executor; no remote installation.

Host and Docker socket come from trusted enrollment, never model-supplied shell
text. Requests are JSON on stdin. A failed transport is an uncertain result;
mutations are never retried here, and graceful stops have no kill timeout.
"""
import json
from pathlib import Path
import re
import shlex
import subprocess

from docker_profile import Docker, native_address


class RemoteObservationUnavailable(RuntimeError):
    """A read-only remote request was not confirmed; no mutation was attempted."""

BOOTSTRAP = '''import sys,json
p=json.load(sys.stdin)
scope={'__name__':'stargate_docker_transport'}
exec(compile(p['source'],'stargate_docker_transport','exec'),scope)
try:
 if p['operation']=='docker':
  if p['method'] not in ['GET','POST']: raise ValueError('Unsupported Docker request')
  result=scope['Docker'](p['socket']).request(p['method'],p['path'],p.get('body'),timeout=p['timeout'],missing=p['missing'])
 elif p['operation']=='idle': result=scope['native_idle'](p['url'])
 elif p['operation']=='http': result=scope['native_request'](p['url'],p['route'],p.get('body'))
 else: raise ValueError('Unsupported transport operation')
 print(json.dumps({'ok':True,'result':result}))
except Exception:
 print(json.dumps({'ok':False,'error':'Remote observation or operation could not be confirmed; no action was retried.'}))
 sys.exit(1)
'''


class SSHDocker(Docker):
    def __init__(self, host, filename='/var/run/docker.sock', *, run=subprocess.run, source=None):
        if not isinstance(host, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}', host):
            raise ValueError('Use the enrolled SSH host or alias')
        if not isinstance(filename, str) or not filename.startswith('/') or '\0' in filename:
            raise ValueError('Use the enrolled absolute Docker socket path')
        super().__init__(filename)
        self.host, self.run = host, run
        # An approved operation supplies its frozen transport implementation.
        # Ordinary read-only/preparation callers retain the installed source.
        self.source = source if source is not None else Path(__file__).with_name('docker_profile.py').read_text()
        if not isinstance(self.source, str) or not self.source.strip():
            raise ValueError('Use the trusted Docker transport source')

    def _call(self, payload, *, observation_timeout=None):
        request = {**payload, 'socket': self.filename, 'source': self.source}
        # Only this fixed bootstrap enters the remote shell. Model commands,
        # container names, HTTP bodies and paths are all in the JSON input.
        command = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--',
                   self.host, 'python3 -c ' + shlex.quote(BOOTSTRAP)]
        try:
            result = self.run(command, input=json.dumps(request), capture_output=True,
                              text=True, timeout=observation_timeout)
            value = json.loads(result.stdout)
            if result.returncode != 0 or value.get('ok') is not True:
                raise ValueError('Unconfirmed remote response')
            return value['result']
        except Exception:
            # SSH/Docker errors may contain private host, mount or command data.
            read_only = (payload['operation'] == 'idle'
                or payload['operation'] == 'docker' and payload['method'] == 'GET'
                or payload['operation'] == 'http' and payload.get('body') is None)
            error = RemoteObservationUnavailable if read_only else RuntimeError
            raise error('Remote observation or operation could not be confirmed; no action was retried.') from None

    def request(self, method, path, body=None, timeout=20, missing=False):
        if method not in ['GET', 'POST']:
            raise ValueError('Unsupported Docker request')
        return self._call({'operation': 'docker', 'method': method, 'path': path,
                          'body': body, 'timeout': timeout, 'missing': missing},
                         observation_timeout=(timeout + 15) if method == 'GET' and timeout is not None else None)

    def idle(self, url):
        native_address(url)
        return self._call({'operation': 'idle', 'url': url}, observation_timeout=25)

    def native_request(self, url, route, body=None):
        native_address(url)
        return self._call({'operation': 'http', 'url': url, 'route': route, 'body': body},
                          observation_timeout=25 if body is None else None)
