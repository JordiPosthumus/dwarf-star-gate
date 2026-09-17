"""Prepare and observe Hourglass measurements through the existing dashboard."""
import json
import re
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request

TOOLSET = 'stargate_hourglass'
NAMES = {'prepare_hourglass_measurement', 'hourglass_measurement_status', 'compare_hourglass_reports'}


def register_hourglass(config, emit):
    from tools.registry import registry
    url = urllib.parse.urlsplit(config['url'])
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.path != '/api/genie/hourglass-tools' or url.username or url.password or url.query or url.fragment):
        raise ValueError('Use the private Hourglass preparation endpoint')

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def run(name, args):
        event = {'tool': name, 'at': datetime.now(timezone.utc).isoformat()}
        try:
            if name == 'prepare_hourglass_measurement':
                if set(args) != {'model'} or args['model'] not in config['models']:
                    raise ValueError('Invalid target')
                payload = {'action': 'prepare', 'model': args['model']}
            elif name == 'compare_hourglass_reports':
                if set(args) not in ({'baseline_revision', 'candidate_revision'}, {'baseline_revision', 'candidate_revision', 'operation_id'}) or not all(
                        isinstance(args.get(k), str) and re.fullmatch(r'[a-f0-9]{64}', args[k]) for k in ['baseline_revision', 'candidate_revision']):
                    raise ValueError('Choose saved report revisions')
                if 'operation_id' in args and (not isinstance(args['operation_id'], str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', args['operation_id'])):
                    raise ValueError('Choose a saved operation UUID')
                payload = {'action': 'compare', **args}
            else:
                if args:
                    raise ValueError('Status takes no arguments')
                payload = {'action': 'status'}
            emit('measurement', event={**event, 'state': 'reading', 'request': payload})
            request = urllib.request.Request(config['url'], data=json.dumps(payload).encode(),
                headers={'Content-Type': 'application/json', 'X-SG-Hourglass-Tool': config['token']})
            with opener.open(request, timeout=30) as response:
                raw = response.read(1048577)
                if len(raw) > 1048576:
                    raise ValueError('Measurement status too large')
                result = json.loads(raw)
            emit('measurement', event={**event, 'state': 'complete',
                'finished_at': datetime.now(timezone.utc).isoformat(), 'result': result})
            return json.dumps(result)
        except Exception as error:
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            emit('measurement', event={**event, 'state': 'failed',
                'finished_at': datetime.now(timezone.utc).isoformat()})
            return json.dumps({'error': 'Measurement preparation or observation could not be confirmed. '
                'Read hourglass_measurement_status or check Evidence → Measure with Hourglass. '
                'This tool cannot start or stop a benchmark; unavailable does not mean stopped.'})

    for name, description, parameters in [
        ('prepare_hourglass_measurement', 'Prepare a configured Hourglass measurement for owner review. '
            'Uses its saved native settings. Does not start, reserve or drain a server. '
            'Direct the owner to Evidence → Measure with Hourglass, then finish your reply.',
            {'type': 'object', 'properties': {'model': {'type': 'string', 'enum': config['models']}},
             'required': ['model'], 'additionalProperties': False}),
        ('hourglass_measurement_status', 'Read configured measurement targets, the pending review, and dated run observations. '
            'Refreshes known receipts without starting or retrying a benchmark. Do not poll in a loop.',
            {'type': 'object', 'properties': {}, 'additionalProperties': False}),
        ('compare_hourglass_reports', 'Compare two exact saved report revisions from measurement status. '
            'Checks recorded protocols and conditions, and returns a score difference only when the methodology matches. '
            'When evaluating a server change, first read server_change_status, then include its operation_id to link the reports. A restored measured trial uses its exact native job and candidate signature; ordinary adopted changes use before/after approved revisions. Never attribute a trial score to the restored original. '
            'Does not prove an upgrade caused a difference or start any work.',
            {'type': 'object', 'properties': {**{k: {'type': 'string', 'pattern': '^[a-f0-9]{64}$'}
                for k in ['baseline_revision', 'candidate_revision']}, 'operation_id': {'type': 'string', 'description': 'Optional UUID of the saved server-change operation being evaluated.'}},
             'required': ['baseline_revision', 'candidate_revision'], 'additionalProperties': False}),
    ]:
        registry.register(name=name, toolset=TOOLSET,
            schema={'name': name, 'description': description, 'parameters': parameters},
            handler=lambda args, _name=name, **kw: run(_name, args), max_result_size_chars=1048576)
    return NAMES
