"""Native Hourglass protocol and read-only serving identity for a reviewed run."""
import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from docker_profile import digest, native_address, signature
from hourglass_operation import NativeStartRejected


def gateway_target_matches(snapshot, worker, endpoint):
    workers = [row for row in snapshot.get('workers', []) if row.get('id') == worker]
    return (snapshot.get('conditional_resume_version') == 1 and len(workers) == 1
        and workers[0].get('url') == endpoint)


class HourglassNative:
    def __init__(self, plan, docker, *, opener=None):
        self.plan, self.docker = plan, docker
        self.console, self.target = plan['hourglass'], plan['native_target']
        url = urllib.parse.urlsplit(self.console['url'])
        if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
                or url.path not in ('', '/') or url.username or url.password or url.query or url.fragment):
            raise ValueError('Use the enrolled local Hourglass console')
        self.origin = f'http://127.0.0.1:{url.port}'
        native_address(self.target['url'])
        for key in ['container_id', 'signature_sha256']:
            if not re.fullmatch(r'[a-f0-9]{64}', self.target.get(key, '')):
                raise ValueError('Bind the reviewed container and configuration identity')

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, route, body=None):
        if route not in ['/api/health', '/api/state', '/api/run'] or (body is not None) != (route == '/api/run'):
            raise ValueError('Unsupported Hourglass request')
        request = urllib.request.Request(self.origin + route,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', 'Origin': self.origin})
        try:
            with self.opener.open(request, timeout=15) as response:
                raw = response.read(64 * 1024 * 1024 + 1)
                if len(raw) > 64 * 1024 * 1024:
                    raise ValueError('Native response is too large')
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            if body is not None and status == 400:
                raise NativeStartRejected() from None
            raise RuntimeError('Hourglass request was not confirmed; no request was retried') from None
        except Exception:
            raise RuntimeError('Hourglass response is unavailable; no request was retried') from None

    def read(self):
        health = self.request('/api/health')
        if (health.get('app') != 'Hourglass' or health.get('version') != 2
                or not isinstance(health.get('controller_instance'), str) or health.get('shutting_down')):
            raise ValueError('Compatible running Hourglass controller required')
        state = self.request('/api/state')
        if state.get('app') != 'Hourglass' or state.get('version') != 2:
            raise ValueError('Unsupported Hourglass catalogue')
        return health, state

    def check_target(self):
        t = self.target
        container = self.docker.inspect(t['container_id'])
        if (not container or not container['State']['Running']
                or container['State']['StartedAt'] != t['started_at']
                or digest(signature(container)) != t['signature_sha256']):
            return False
        native_address(t['url'], container)
        response = self.docker.native_request(t['url'], '/v1/models')
        if response['status'] != 200:
            return False
        body = json.loads(base64.b64decode(response['body_base64'], validate=True))
        return any(row.get('id') == t['model'] for row in body.get('data', []))

    def idle(self):
        return self.docker.idle(self.target['url'])

    def verify_request(self, payload):
        """Recheck a saved review using GETs only; never enqueue a job."""
        if payload != self.plan['native_request']:
            raise ValueError('Reviewed native request changed')
        health, state = self.read()
        model = next(m for m in state['model_configs'] if m.get('name') == payload['model'])
        tasks = state['tasks']
        if (set(payload) != {'model', 'tasks', 'repeat', 'models_revision', 'hardware_revision', 'task_bundles'}
                or payload['repeat'] != 1 or not tasks or any(t.get('issues') for t in tasks)
                or len({t['id'] for t in tasks}) != len(tasks)
                or len(set(payload['tasks'])) != len(payload['tasks'])
                or set(payload['tasks']) != {t['id'] for t in tasks}
                or payload['task_bundles'] != {t['id']: t['task_bundle_sha'] for t in tasks}
                or state['score_policy']['window_s'] != 3600
                or state['score_policy']['metric'] != self.console['metric']
                or state['score_policy']['scoring_policy'] != self.console['scoring_policy']
                or state['jobs']['running'] or state['jobs']['pending']
                or state['benchmark_version'] != self.console['benchmark_version']):
            raise ValueError('The reviewed measurement scope changed')
        if (health['controller_instance'] != self.console['controller_instance']
                or model.get('base_url') != self.console['endpoint']
                or model.get('model') != self.target['model']
                or state['models_revision'] != payload['models_revision']
                or state['endpoint_hardware']['revision'] != payload['hardware_revision']):
            raise ValueError('The reviewed Hourglass setup changed')

    def submit(self, payload):
        # A failed GET-only preflight proves this call has not posted a run.
        try:
            self.verify_request(payload)
        except Exception:
            raise NativeStartRejected() from None
        result = self.request('/api/run', payload)
        if result.get('ok') is not True or not re.fullmatch(r'[a-f0-9]{32}', result.get('job', '')):
            raise RuntimeError('Native start acknowledgement is invalid; no start was retried')
        return {'job_id': result['job']}

    def observe(self, job):
        if not re.fullmatch(r'[a-f0-9]{32}', job):
            raise ValueError('Use the accepted native job identity')
        _, state = self.read()
        # A replacement controller may retain the same native job. Its exact
        # receipt/model can be observed without preparing or starting it again.
        matches = [row for group in ['running', 'pending', 'done'] for row in state['jobs'].get(group, [])
            if row.get('id') == job and row.get('model') == self.plan['native_request']['model']]
        if len(matches) != 1:
            return {'state': 'unknown'}
        return {'state': matches[0].get('state', 'unknown')}
