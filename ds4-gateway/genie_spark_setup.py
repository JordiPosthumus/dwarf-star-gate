"""Genie prepares explicitly enrolled new Sparks using the bundled recipes."""
import json
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request

TOOLSET = 'stargate_spark_setup'
NAMES = {'spark_setup_status', 'prepare_spark'}


def register_spark_setup(config, emit):
    from tools.registry import registry
    url = urllib.parse.urlsplit(config['url'])
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path != '/api/genie/spark-setup-tools'
            or url.username or url.password or url.query or url.fragment):
        raise ValueError('Use the private Spark setup tool endpoint')

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def run(name, args):
        event = {'tool': name, 'request': args, 'at': datetime.now(timezone.utc).isoformat()}
        emit('spark_setup', event={**event, 'state': 'reading'})
        try:
            payload = {'action': 'status'} if name == 'spark_setup_status' else {'action': 'start', **args}
            request = urllib.request.Request(config['url'], data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json', 'X-SG-Spark-Setup-Tool': config['token']})
            with opener.open(request, timeout=30) as response:
                raw = response.read(524289)
                if len(raw) > 524288: raise ValueError('Setup status too large')
                result = json.loads(raw)
            emit('spark_setup', event={**event, 'state': 'complete', 'finished_at': datetime.now(timezone.utc).isoformat(), 'result': result})
            return json.dumps(result)
        except Exception as error:
            message = 'Setup request was not confirmed. Read spark_setup_status for the same target; do not start a replacement.'
            if isinstance(error, urllib.error.HTTPError):
                try: message = json.loads(error.read(4096)).get('error', message)
                except (ValueError, OSError): pass
                finally: error.close()
            emit('spark_setup', event={**event, 'state': 'failed', 'error': message})
            return json.dumps({'error': message, 'target_id': args.get('target_id')})

    schemas = [
        ('spark_setup_status', 'Read preparation progress for enrolled new Sparks. Distinguishes accepted, running, prepared stopped engines and failures. Prepared engines are not qualified or serving.', {'type': 'object', 'properties': {}, 'additionalProperties': False}),
        ('prepare_spark', 'Prepare the pinned LLM, H3 and ACE engines on an explicitly enrolled idle new Spark. The enabled setup switch grants standing permission. Builds and downloads continue independently of this chat. Never stops existing services. Read status first and once after acceptance; do not poll indefinitely. Qualification and gateway registration are still separate steps.', {'type': 'object', 'properties': {'target_id': {'type': 'string'}}, 'required': ['target_id'], 'additionalProperties': False}),
    ]
    for name, description, parameters in schemas:
        registry.register(name=name, toolset=TOOLSET, schema={'name': name, 'description': description, 'parameters': parameters}, handler=lambda args, _name=name, **kw: run(_name, args), max_result_size_chars=524288)
    return NAMES
