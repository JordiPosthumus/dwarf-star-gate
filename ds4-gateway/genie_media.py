"""Genie chooses a queued media job and enrolled host; the runner handles return."""
import json
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request

TOOLSET = 'stargate_media'
NAMES = {'media_job_status', 'start_media_job', 'inspect_media_host'}


def register_media(config, emit):
    from tools.registry import registry
    url = urllib.parse.urlsplit(config['url'])
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path != '/api/genie/media-tools'
            or url.username or url.password or url.query or url.fragment):
        raise ValueError('Use the private media tool endpoint')

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def run(name, args):
        event = {'tool': name, 'request': args, 'at': datetime.now(timezone.utc).isoformat()}
        emit('media', event={**event, 'state': 'reading'})
        try:
            payload = {'action': 'status'} if name == 'media_job_status' else {'action': 'inspect' if name == 'inspect_media_host' else 'start', **args}
            request = urllib.request.Request(config['url'], data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json', 'X-SG-Media-Tool': config['token']})
            with opener.open(request, timeout=120 if name == 'inspect_media_host' else 30) as response:
                raw = response.read(524289)
                if len(raw) > 524288: raise ValueError('Media status too large')
                result = json.loads(raw)
            emit('media', event={**event, 'state': 'complete', 'finished_at': datetime.now(timezone.utc).isoformat(), 'result': result})
            return json.dumps(result)
        except Exception as error:
            message = ('Resource inspection was not confirmed. Existing services were not changed; read media_job_status for its last observation.' if name == 'inspect_media_host' else 'Media request was not confirmed. Read media_job_status for the same job; do not enqueue a replacement.')
            if isinstance(error, urllib.error.HTTPError):
                try: message = json.loads(error.read(4096)).get('error', message)
                except (ValueError, OSError): pass
                finally: error.close()
            emit('media', event={**event, 'state': 'failed', 'error': message})
            return json.dumps({'error': message, 'job_id': args.get('job_id')})

    schemas = [
        ('inspect_media_host', 'Read actual hardware, host memory and disk space on a registered worker through its enrolled inspection connection, alongside pinned media model sizes. Uses the Server inspection capability. No service stops, downloads or installation. Free memory includes the current LLM; matching hardware and enough model-file disk do not prove runtime fit or enough image/build/output space. Check before recommending media setup.', {'type': 'object', 'properties': {'worker_id': {'type': 'string'}}, 'required': ['worker_id'], 'additionalProperties': False}),
        ('media_job_status', 'Read media jobs, native/output state, host-return progress and enrolled media workers. Check before allocation and after a start. Start only queued unassigned jobs. Keep enough LLM capacity for current text demand, always at least one other serving LLM.', {'type': 'object', 'properties': {}, 'additionalProperties': False}),
        ('start_media_job', 'Assign one existing queued media job to an enrolled host. The enabled media capability permits this without another approval. The runner drains existing work, starts media, retains generated files and restores the original LLM. It runs independently of this chat. Do not claim completion from acceptance; inspect media_job_status. Cannot install engines or cancel active jobs.', {'type': 'object', 'properties': {k: {'type': 'string'} for k in ['job_id', 'worker_id']}, 'required': ['job_id', 'worker_id'], 'additionalProperties': False}),
    ]
    for name, description, parameters in schemas:
        registry.register(name=name, toolset=TOOLSET, schema={'name': name, 'description': description, 'parameters': parameters}, handler=lambda args, _name=name, **kw: run(_name, args), max_result_size_chars=524288)
    return NAMES
