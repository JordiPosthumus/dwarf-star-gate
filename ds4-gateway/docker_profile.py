"""Retained Docker serving profiles for the approved-operation coordinator.

This module is not an LLM tool or an approval authority. The coordinator must
bind the reviewed plan to owner approval, own a gateway maintenance lock, and
qualify the result before readmission. Started is deliberately not verified.
"""
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import time
import urllib.parse
import urllib.request

ID = re.compile(r'[a-f0-9]{64}')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def signature(container):
    host = copy.deepcopy(container['HostConfig'])
    if host.get('OomKillDisable') is None:
        host['OomKillDisable'] = False
    return {'Id': container['Id'], 'Image': container['Image'],
            'Config': container['Config'], 'HostConfig': host,
            'Mounts': sorted(container['Mounts'], key=lambda m: m['Destination'])}


def require_retention(container):
    if any(m.get('Type') != 'bind' for m in container['Mounts']) or container['Config'].get('Volumes'):
        raise ValueError('This profile needs an explicit volume-retention adapter')
    if container['HostConfig'].get('AutoRemove') or container['HostConfig'].get('RestartPolicy', {}).get('Name') == 'always':
        raise ValueError('Previous-container retention across stops and daemon restarts is not established')


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, filename, timeout):
        super().__init__('localhost', timeout=timeout)
        self.filename = filename

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.filename)


class Docker:
    def __init__(self, filename='/var/run/docker.sock'):
        self.filename = filename

    def request(self, method, path, body=None, timeout=20, missing=False):
        connection = UnixHTTP(self.filename, timeout)
        try:
            connection.request(method, path, None if body is None else json.dumps(body),
                               {'Content-Type': 'application/json'})
            response = connection.getresponse()
            data = response.read()
            if missing and response.status == 404:
                return None
            if not 200 <= response.status < 300:
                # Docker errors can include private commands or environment values.
                raise RuntimeError('Docker operation failed: HTTP ' + str(response.status))
            return json.loads(data) if data else None
        finally:
            connection.close()

    def inspect(self, name):
        return self.request('GET', '/containers/' + urllib.parse.quote(name, safe='') + '/json', missing=True)

    def image(self, name):
        return self.request('GET', '/images/' + urllib.parse.quote(name, safe='') + '/json', missing=True)

    def create(self, name, body):
        return self.request('POST', '/containers/create?name=' + urllib.parse.quote(name, safe=''), body)

    def stop(self, cid):
        # Wait for graceful termination; do not introduce a kill deadline.
        return self.request('POST', '/containers/' + cid + '/stop?t=-1', timeout=None)

    def rename(self, cid, name):
        return self.request('POST', '/containers/' + cid + '/rename?name=' + urllib.parse.quote(name, safe=''))

    def start(self, cid):
        return self.request('POST', '/containers/' + cid + '/start', timeout=None)


def native_address(url, container=None):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'http' or parsed.hostname not in ['127.0.0.1', '::1'] or not parsed.port or parsed.path not in ['', '/'] or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Use the enrolled direct loopback endpoint')
    if container is not None:
        bindings = container['HostConfig'].get('PortBindings', {})
        addresses = {'', '0.0.0.0', '127.0.0.1'} if parsed.hostname == '127.0.0.1' else {'', '::', '::1'}
        if not any(str(parsed.port) == row.get('HostPort') and row.get('HostIp', '') in addresses
                   for port, rows in bindings.items() if port.endswith('/tcp') for row in rows or []):
            raise ValueError('Native idle endpoint is not bound to the reviewed container')
    return parsed


def native_idle(url):
    native_address(url)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(url.rstrip('/') + '/metrics', timeout=10) as response:
        lines = response.read().decode().splitlines()
    counts = [[float(line.rsplit(' ', 1)[1]) for line in lines if line.startswith('vllm:' + key + '{')]
              for key in ['num_requests_running', 'num_requests_waiting']]
    return all(group and all(value == 0 for value in group) for group in counts)


class RetainedProfile:
    def __init__(self, directory, *, docker=None, lease_check=None, idle=native_idle, sleep=time.sleep):
        self.directory = Path(directory)
        self.docker = docker or Docker()
        self.lease_check = lease_check
        self.idle = idle
        self.sleep = sleep

    def prepare(self, container, image, command, native_url, record_revision):
        if not IMAGE.fullmatch(image) or not ID.fullmatch(record_revision):
            raise ValueError('Exact image and configuration-record revision required')
        if not isinstance(command, list) or not command or any(not isinstance(arg, str) or '\0' in arg for arg in command):
            raise ValueError('Use the complete reviewed argument array')
        before = self.docker.inspect(container)
        if not before or not before['State']['Running']:
            raise ValueError('Current serving container must be identified and running')
        native_address(native_url, before)
        selected = self.docker.image(image)
        if not ID.fullmatch(before['Id']) or not selected or selected['Id'] != image:
            raise ValueError('Selected image must already be retained locally')
        # This first adapter preserves existing explicit bind mounts. Anonymous
        # Docker volumes need their own retained identity before recreating them.
        require_retention(before)
        body = copy.deepcopy(before['Config'])
        body.update(Image=image, Cmd=command, HostConfig=copy.deepcopy(before['HostConfig']))
        return {'version': 1, 'record_revision': record_revision, 'before': signature(before),
                'started_at': before['State']['StartedAt'], 'name': before['Name'].lstrip('/'),
                'native_url': native_url, 'create': body,
                'scope': 'Only image and command change; existing host settings and bind mounts are preserved.'}

    def _save(self, folder, name, value):
        # A new receipt is never overwritten. fsync before an external action.
        with (folder / name).open('x', encoding='utf-8') as stream:
            os.chmod(folder / name, 0o600)
            json.dump(value, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        fd = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _owned_idle(self, operation_id, plan, running=True):
        if not self.lease_check or self.lease_check(operation_id) is not True:
            raise RuntimeError('Owned gateway maintenance window is not established')
        if running:
            for count in range(2):
                if self.idle(plan['native_url']) is not True:
                    raise RuntimeError('Native work is active or idle could not be established')
                if count == 0:
                    self.sleep(3)
        if self.lease_check(operation_id) is not True:
            raise RuntimeError('Gateway maintenance ownership changed')

    def _step(self, folder, name, action):
        self._save(folder, name + '.intent.json', {'at': time.time()})
        result = action()
        self._save(folder, name + '.result.json', {'at': time.time(), 'result': result})
        return result

    def apply(self, operation_id, plan, approved_digest):
        if not UUID.fullmatch(operation_id) or digest(plan) != approved_digest:
            raise ValueError('The exact reviewed operation plan is required')
        native_address(plan['native_url'], plan['before'])
        require_retention(plan['before'])
        expected = copy.deepcopy(plan['before']['Config'])
        expected.update(Image=plan['create']['Image'], Cmd=plan['create']['Cmd'],
                        HostConfig=copy.deepcopy(plan['before']['HostConfig']))
        actual = copy.deepcopy(plan['create'])
        if actual['HostConfig'].get('OomKillDisable') is None:
            actual['HostConfig']['OomKillDisable'] = False
        if actual != expected or not IMAGE.fullmatch(actual['Image']):
            raise ValueError('Only the reviewed image and command may change in this adapter')
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        folder = self.directory / operation_id
        if folder.exists():
            if digest(json.loads((folder / 'plan.json').read_text())) != approved_digest:
                raise ValueError('Operation ID already belongs to a different plan')
            return self.observe(operation_id)  # Never replay an uncertain operation.
        folder.mkdir(mode=0o700)
        self._save(folder, 'plan.json', plan)
        self._save(folder, 'approval-binding.json', {'plan_sha256': approved_digest,
                   'scope': 'Content binding supplied by coordinator; this file is not independent owner approval.'})
        before = self.docker.inspect(plan['before']['Id'])
        if not before or signature(before) != plan['before'] or before['State']['StartedAt'] != plan['started_at'] or not before['State']['Running'] or before['Name'] != '/' + plan['name']:
            raise RuntimeError('The observed serving configuration changed')
        candidate_name = 'stargate-profile-' + operation_id
        retained_name = 'stargate-retained-' + operation_id
        if self.docker.inspect(candidate_name) or self.docker.inspect(retained_name):
            raise RuntimeError('Operation container name already exists')
        self._owned_idle(operation_id, plan)
        created = self._step(folder, 'create', lambda: self.docker.create(candidate_name, plan['create']))
        cid = created['Id']
        if not ID.fullmatch(cid):
            raise RuntimeError('Invalid created container identity; inspect the receipt')
        candidate = self.docker.inspect(cid)
        if not candidate or candidate['State']['Running'] or candidate['Image'] != plan['create']['Image'] or candidate['Config']['Cmd'] != plan['create']['Cmd']:
            raise RuntimeError('Created candidate differs from the reviewed recipe')
        expected_candidate = copy.deepcopy(plan['before'])
        expected_candidate.update(Id=cid, Image=plan['create']['Image'],
                                  Config={k: v for k, v in plan['create'].items() if k != 'HostConfig'})
        if signature(candidate) != expected_candidate or candidate['Name'] != '/' + candidate_name:
            raise RuntimeError('Created candidate changed an unrelated setting or mount')
        self._save(folder, 'candidate.created.json', signature(candidate))
        # Check ownership and direct work again immediately before stopping.
        self._owned_idle(operation_id, plan)
        current = self.docker.inspect(before['Id'])
        if signature(current) != plan['before'] or current['State']['StartedAt'] != plan['started_at'] or not current['State']['Running'] or current['Name'] != '/' + plan['name']:
            raise RuntimeError('Serving configuration changed before cutover')
        candidate_now = self.docker.inspect(cid)
        if signature(candidate_now) != signature(candidate) or candidate_now['State']['Running']:
            raise RuntimeError('Candidate changed before cutover')
        self._step(folder, 'stop-previous', lambda: self.docker.stop(before['Id']))
        self._step(folder, 'retain-previous', lambda: self.docker.rename(before['Id'], retained_name))
        self._step(folder, 'activate-name', lambda: self.docker.rename(cid, plan['name']))
        self._step(folder, 'start-candidate', lambda: self.docker.start(cid))
        return self.observe(operation_id)

    def observe(self, operation_id):
        if not UUID.fullmatch(operation_id):
            raise ValueError('Invalid operation ID')
        folder = self.directory / operation_id
        plan = json.loads((folder / 'plan.json').read_text())
        previous = self.docker.inspect(plan['before']['Id'])
        created = folder / 'create.result.json'
        candidate = self.docker.inspect(json.loads(created.read_text())['result']['Id']) if created.exists() else self.docker.inspect('stargate-profile-' + operation_id)
        steps = {p.name.removesuffix('.intent.json'): (folder / p.name.replace('.intent.json', '.result.json')).exists()
                 for p in folder.glob('*.intent.json')}
        retained_ok = previous is not None and signature(previous) == plan['before']
        original_candidate = folder / 'candidate.created.json'
        candidate_ok = candidate is not None and original_candidate.exists() and signature(candidate) == json.loads(original_candidate.read_text())
        restoration = folder / 'restore'
        state = 'requires_reconciliation'
        if retained_ok and candidate_ok:
            if restoration.exists():
                if (restoration / 'start-previous.result.json').exists() and previous['State']['Running'] and not candidate['State']['Running'] and previous['Name'] == '/' + plan['name']:
                    state = 'restored_unverified'
            elif steps.get('start-candidate') and candidate['State']['Running'] and not previous['State']['Running'] and candidate['Name'] == '/' + plan['name']:
                state = 'started_unverified'
        return {'operation_id': operation_id, 'state': state,
                'previous': previous, 'candidate': candidate, 'acknowledged_steps': steps,
                'scope': 'Read-only operation observation. Container startup is not qualification or permission to readmit.'}

    def restore(self, operation_id, approved_digest):
        if not UUID.fullmatch(operation_id):
            raise ValueError('Invalid operation ID')
        folder = self.directory / operation_id
        plan = json.loads((folder / 'plan.json').read_text())
        if digest(plan) != approved_digest:
            raise ValueError('Restoration must bind the same reviewed operation')
        recovery = folder / 'restore'
        if recovery.exists():
            return self.observe(operation_id)
        state = self.observe(operation_id)
        old, current = state['previous'], state['candidate']
        expected_candidate = folder / 'candidate.created.json'
        if not old or signature(old) != plan['before'] or old['State']['Running'] or not current or not expected_candidate.exists() or signature(current) != json.loads(expected_candidate.read_text()) or not state['acknowledged_steps'].get('start-candidate') or current['Name'] != '/' + plan['name']:
            raise RuntimeError('Restoration requires the exact retained version and reconciled candidate')
        self._owned_idle(operation_id, plan, running=current['State']['Running'])
        old_now, current_now = self.docker.inspect(old['Id']), self.docker.inspect(current['Id'])
        if not old_now or signature(old_now) != plan['before'] or old_now['State']['Running'] or not current_now or signature(current_now) != signature(current) or current_now['State']['StartedAt'] != current['State']['StartedAt'] or current_now['Name'] != current['Name']:
            raise RuntimeError('Container identity changed before restoration')
        recovery.mkdir(mode=0o700)
        if current['State']['Running']:
            self._step(recovery, 'stop-candidate', lambda: self.docker.stop(current['Id']))
        self._step(recovery, 'retain-candidate', lambda: self.docker.rename(current['Id'], 'stargate-profile-' + operation_id))
        self._step(recovery, 'restore-name', lambda: self.docker.rename(old['Id'], plan['name']))
        self._step(recovery, 'start-previous', lambda: self.docker.start(old['Id']))
        return self.observe(operation_id)
