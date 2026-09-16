"""Genie prepares explicitly enrolled new Sparks using the bundled recipes."""
import json
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request

TOOLSET = 'stargate_spark_setup'
NAMES = {'qualify_spark_media', 'setup_spark', 'spark_setup_status', 'prepare_spark', 'qualify_spark_llm', 'register_spark_llm'}


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
            payload = {'action': 'status'} if name == 'spark_setup_status' else {'action': 'qualify_media' if name == 'qualify_spark_media' else 'setup' if name == 'setup_spark' else 'register' if name == 'register_spark_llm' else 'qualify' if name == 'qualify_spark_llm' else 'start', **args}
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
        ('qualify_spark_media', 'Test the prepared stopped H3 and ACE-Step engines on a new idle Spark before its LLM is started. Generates real sample video/audio and music, retains and fully decodes the files, and stops only those prepared engines. Detached from chat. After acceptance, read spark_setup_status once before ending. Only a saved setup_spark request creates later automatic chat wakeups. Existing serving LLMs are untouched. The setup switch grants permission; read status and inspect the same retained operation on uncertainty. Does not enroll media or recovery.', {'type': 'object', 'properties': {'target_id': {'type': 'string'}}, 'required': ['target_id'], 'additionalProperties': False}),
        ('setup_spark', 'Request complete LLM onboarding for an enrolled new Spark: prepare the standard engines, test stopped media candidates where connected, then qualify and register the LLM. A saved request wakes Genie after each long stage, across dashboard restarts. The enabled setup switch grants permission; turning it off pauses new stages while accepted work continues. Registration connects the qualified dedicated recovery helper and any separately qualified, unchanged media engines. Existing recovery and media capability switches keep their settings. Use prepare_spark instead for preparation only.', {'type': 'object', 'properties': {'target_id': {'type': 'string'}}, 'required': ['target_id'], 'additionalProperties': False}),
        ('register_spark_llm', 'Admit the qualified new LLM to the gateway. Rechecks its actual running instance, model/context and saved native proof; records observed configuration, adds a paused worker through existing gateway controls, then resumes it if operator state is unchanged. The setup switch grants permission as part of requested new-Spark setup. Does not modify an existing worker. New restart-qualified proofs enroll the dedicated recovery helper; separately qualified unchanged media engines enroll their switching bindings. Earlier LLM-only proofs remain LLM-only. Report the actual returned state and services fields; capability switches are unchanged.', {'type': 'object', 'properties': {'target_id': {'type': 'string'}}, 'required': ['target_id'], 'additionalProperties': False}),
        ('qualify_spark_llm', 'Start and qualify the prepared LLM on an idle enrolled new Spark. Installs a dedicated bundled recovery helper, tests one same-container restart, then checks exact serving settings and native text/tools/vision/context/cache/EOS behavior. This proves that restart but does not enroll automatic recovery. Runs independently of this chat and leaves a passing LLM running for later registration. Does not stop existing workloads or register a server. Read setup status first; once a qualification exists, inspect it instead of rerunning.', {'type': 'object', 'properties': {'target_id': {'type': 'string'}}, 'required': ['target_id'], 'additionalProperties': False}),
        ('spark_setup_status', 'Read preparation progress for enrolled new Sparks. Distinguishes accepted, running, prepared stopped engines and failures. Prepared engines are not qualified or serving.', {'type': 'object', 'properties': {}, 'additionalProperties': False}),
        ('prepare_spark', 'Prepare the pinned LLM, H3 and ACE engines on an explicitly enrolled idle new Spark. The enabled setup switch grants standing permission. Builds and downloads continue independently of this chat. Never stops existing services. Read status first and once after acceptance; do not poll indefinitely. Qualification and gateway registration are still separate steps.', {'type': 'object', 'properties': {'target_id': {'type': 'string'}}, 'required': ['target_id'], 'additionalProperties': False}),
    ]
    for name, description, parameters in schemas:
        registry.register(name=name, toolset=TOOLSET, schema={'name': name, 'description': description, 'parameters': parameters}, handler=lambda args, _name=name, **kw: run(_name, args), max_result_size_chars=524288)
    return NAMES
