"""Genie chooses a queued media job and enrolled host; the runner handles return."""
import json
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request

TOOLSET = 'stargate_media'
NAMES = {'media_job_status', 'start_media_job', 'inspect_media_host', 'inspect_media_inputs', 'setup_media_host'}


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
            payload = {'action': 'status'} if name == 'media_job_status' else {'action': 'inputs' if name == 'inspect_media_inputs' else 'inspect' if name == 'inspect_media_host' else 'setup' if name == 'setup_media_host' else 'start', **args}
            request = urllib.request.Request(config['url'], data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json', 'X-SG-Media-Tool': config['token']})
            with opener.open(request, timeout=120 if name in ('inspect_media_host', 'inspect_media_inputs') else 30) as response:
                raw = response.read(524289)
                if len(raw) > 524288: raise ValueError('Media status too large')
                result = json.loads(raw)
            emit('media', event={**event, 'state': 'complete', 'finished_at': datetime.now(timezone.utc).isoformat(), 'result': result})
            return json.dumps(result)
        except Exception as error:
            message = ('Resource inspection was not confirmed. Existing services were not changed; read media_job_status for its last observation.' if name in ('inspect_media_host', 'inspect_media_inputs') else 'Media request was not confirmed. Read media_job_status for the same job; do not enqueue a replacement.')
            if isinstance(error, urllib.error.HTTPError):
                try: message = json.loads(error.read(4096)).get('error', message)
                except (ValueError, OSError): pass
                finally: error.close()
            emit('media', event={**event, 'state': 'failed', 'error': message})
            return json.dumps({'error': message, 'job_id': args.get('job_id')})

    schemas = [
        ('inspect_media_inputs', 'Check a saved video job’s stock LoadImage/LoadAudio files on an enrolled worker before placement. Uses the Server inspection switch. Reports mounted file presence without starting the media engine or draining its LLM. Read input_requirements in media_job_status; check workers for engine-local files and prefer one where they are present. Unknown is not missing. Uploaded references are portable. File presence does not prove decoding or reference fidelity.', {'type': 'object', 'properties': {'job_id': {'type': 'string'}, 'worker_id': {'type': 'string'}}, 'required': ['job_id', 'worker_id'], 'additionalProperties': False}),
        ('setup_media_host', 'Prepare and qualify ACE-Step or H3 on an existing registered Spark whose placement choice allows that engine. Read media_job_status and inspect_media_host first. The Media capability must be on. Drains work, preserves another serving LLM, installs only the selected media recipe in a separate directory, tests native generation and restores/verifies the original LLM before saving enrollment. Observe the saved setup operation; acceptance is not completion. Repeating the same worker/engine observes its existing operation or finishes pending enrollment; never claims a replacement installation.', {'type': 'object', 'properties': {'worker_id': {'type': 'string'}, 'engine': {'type': 'string', 'enum': ['ace-step', 'h3']}}, 'required': ['worker_id', 'engine'], 'additionalProperties': False}),
        ('inspect_media_host', 'Read actual hardware, host memory and disk space on a registered worker through its enrolled inspection connection, alongside pinned media model sizes. Uses the Server inspection capability. No service stops, downloads or installation. Free memory includes the current LLM; matching hardware and enough model-file disk do not prove runtime fit or enough image/build/output space. Check before recommending media setup.', {'type': 'object', 'properties': {'worker_id': {'type': 'string'}}, 'required': ['worker_id'], 'additionalProperties': False}),
        ('media_job_status', 'Read media jobs, native/output state, host-return progress and enrolled media workers. Check before allocation and after a start. Start only queued unassigned jobs. Keep enough LLM capacity for current text demand, always at least one other serving LLM.', {'type': 'object', 'properties': {}, 'additionalProperties': False}),
        ('start_media_job', 'Assign an existing queued media job to an enrolled host. When status reports batch_jobs_supported, optionally include up to seven following_job_ids: already queued, unassigned jobs using the same engine and priority. Choose a small batch appropriate for current LLM demand. The runner drains once, runs each job sequentially, retains separate results and restores/verifies the original LLM once. A higher-priority arrival can end a batch between jobs; unstarted jobs stay queued after return. The enabled media capability permits this without another approval. Execution is independent of this chat. Do not claim completion from acceptance; inspect media_job_status. Cannot install engines or cancel active jobs.', {'type': 'object', 'properties': {**{k: {'type': 'string'} for k in ['job_id', 'worker_id']}, 'following_job_ids': {'type': 'array', 'items': {'type': 'string'}, 'maxItems': 7, 'uniqueItems': True}}, 'required': ['job_id', 'worker_id'], 'additionalProperties': False}),
    ]
    for name, description, parameters in schemas:
        registry.register(name=name, toolset=TOOLSET, schema={'name': name, 'description': description, 'parameters': parameters}, handler=lambda args, _name=name, **kw: run(_name, args), max_result_size_chars=524288)
    return NAMES
