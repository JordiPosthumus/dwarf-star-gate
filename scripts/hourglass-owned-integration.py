#!/usr/bin/env python3
"""Opt-in complete owned-measurement HTTP/runner test with synthetic serving.

Copies trusted Hourglass source into a retained temporary fixture. Uses the real
gateway, dashboard, preparation CLI, frozen runner, and copied native HTTP API.
SSH/Docker/model endpoints and elapsed benchmark time are explicitly synthetic.
No native benchmark worker or production configuration is loaded.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import json
import os
from pathlib import Path
import shlex
import socketserver
import subprocess
import sys
import tempfile
import threading
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--node', default='node')
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    args.evidence.mkdir(parents=True, exist_ok=False)
    root = Path(tempfile.mkdtemp(prefix='sg-hg-owned-')).resolve()
    (args.evidence / 'fixture-path.txt').write_text(str(root) + '\n')
    native_root = root / 'native'; native_root.mkdir()
    hashes = {}
    for source in sorted(args.source.glob('*.py')):
        if source.is_symlink() or not source.is_file(): raise ValueError('Use regular native source')
        data = source.read_bytes(); (native_root / source.name).write_bytes(data)
        hashes[source.name] = hashlib.sha256(data).hexdigest()
    sys.path.insert(0, str(native_root)); sys.dont_write_bytecode = True
    web = importlib.import_module('web')
    assert web.ROOT == native_root and web.worker_thread is None
    release_request = threading.Event(); native_active = [0, 0]; calls = []

    def model_handler(index):
        class Model(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path not in ['/metrics', '/v1/models', '/health']:
                    # Dashboard telemetry may query capabilities this synthetic
                    # backend does not expose. Report unavailable normally.
                    self.send_response(404); self.end_headers(); return
                self.send_response(200); self.end_headers()
                if self.path == '/metrics':
                    data = f'vllm:num_requests_running{{model="fixture-model"}} {native_active[index]}\nvllm:num_requests_waiting{{model="fixture-model"}} 0\n'
                else:
                    data = json.dumps({'data': [{'id': 'fixture-model', 'max_model_len': 262144}]})
                self.wfile.write(data.encode())

            def do_POST(self):
                assert self.path == '/v1/chat/completions'
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                held = body['messages'][0]['content'] == 'fixture-hold'
                native_active[index] += 1
                try:
                    if held: release_request.wait()
                    content = 'held request finished' if held else 'spare'
                    self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                    self.wfile.write(json.dumps({'id': 'fixture', 'object': 'chat.completion', 'model': 'fixture-model',
                        'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}],
                        'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}).encode())
                finally: native_active[index] -= 1

            def log_message(self, *args): pass
        return Model

    servers = [ThreadingHTTPServer(('127.0.0.1', 0), model_handler(i)) for i in range(2)]
    endpoint = f'http://127.0.0.1:{servers[0].server_port}'
    container = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, 'Name': '/fixture',
        'State': {'Running': True, 'StartedAt': '2026-01-01T00:00:00Z'},
        'Config': {'Image': 'sha256:' + 'b' * 64, 'Cmd': ['--max-model-len', '262144', '--max-num-seqs', '1'], 'Env': []},
        'HostConfig': {'PortBindings': {'8000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(servers[0].server_port)}]}}, 'Mounts': []}
    class DockerHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append({'kind': 'docker', 'method': 'GET', 'path': self.path})
            assert self.path in ['/containers/fixture/json', '/containers/' + 'a' * 64 + '/json']
            self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(container).encode())
        def do_POST(self):
            raise AssertionError('Measurement must not mutate Docker')
        def log_message(self, *args): pass
    class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True
    docker_socket = root / 'docker.sock'
    servers.append(UnixServer(str(docker_socket), DockerHandler))
    class NativeHandler(web.H):
        def do_POST(self):
            calls.append({'kind': 'hourglass', 'method': 'POST', 'path': self.path})
            assert self.path == '/api/run' and native_active[0] == 0
            return super().do_POST()
        def log_message(self, *args): pass
    native = web.ThreadingHTTPServer(('127.0.0.1', 0), NativeHandler)
    web.PORT = native.server_address[1]; servers.append(native)
    task = native_root / 'tasks/example/task.json'; task.parent.mkdir(parents=True)
    task.write_text(json.dumps({'id': 'example', 'kind': 'mcq', 'mode': 'option_id', 'prompt': 'Synthetic fixture.',
        'options': [{'id': '001', 'text': 'A'}, {'id': '002', 'text': 'B'}], 'answer': '001'}))
    model = {'name': 'owned-fixture', 'model': 'fixture-model', 'base_url': endpoint + '/v1',
        'max_tokens': 262144, 'context_window': 262144, 'reasoning': 'xhigh'}
    (native_root / 'models.json').write_text(json.dumps({'models': [model]}))
    library = root / 'records'; (library / 'approved').mkdir(parents=True)
    (library / 'approved/worker.json').write_text(json.dumps({'schema': 1, 'worker_id': 'worker', 'kind': 'approved',
        'model': {'name': 'fixture-model'}, 'approval': {'at': '2026-01-01T00:00:00Z', 'reference': 'fixture'}}))
    for command in [['init', '-q'], ['add', 'approved/worker.json'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
            '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic approved record']]:
        subprocess.run(['git', '-C', str(library), *command], check=True, capture_output=True)
    config = {'host': '127.0.0.1', 'port': 0, 'api_key': 'fixture', 'model': 'fixture-model', 'context_length': 262144,
        'state_file': str(root / 'affinity.json'), 'control_socket': str(root / 'gateway.sock'), 'ui_worker_management': True,
        'health_interval_ms': 100000, 'server_records_directory': str(library), 'genie': {'enabled': False},
        'genie_chat': {'enabled': False, 'python': sys.executable, 'source': str(root / 'unused-hermes-fixture'),
            'url': endpoint + '/v1', 'model': 'fixture-model',
            'inspection': {'workers': {'worker': {'ssh': ['fixture-only'], 'container': 'fixture'}}}},
        'nodes': [{'id': 'worker' if i == 0 else 'spare', 'url': f'http://127.0.0.1:{s.server_port}/v1', 'backend': 'openai',
            'context_length': 262144, 'max_concurrent_requests': 1} for i, s in enumerate(servers[:2])],
        'hourglass_console': {'url': f'http://127.0.0.1:{web.PORT}', 'targets': [{'model': model['name'], 'worker_id': 'worker',
            'route': 'direct', 'maintenance': {'native_url': endpoint, 'docker_socket': str(docker_socket)}}]}}
    (root / 'stargate.json').write_text(json.dumps(config))
    bindir = root / 'bin'; bindir.mkdir(); ssh = bindir / 'ssh'
    # Only the fixture alias and the adapter's fixed Python bootstrap may run.
    # The real Docker/native transport implementation then talks to our sockets.
    ssh.write_text('#!' + sys.executable + '\nimport sys,shlex\n'
        "assert sys.argv[-2]=='fixture-only'\ncommand=shlex.split(sys.argv[-1])\n"
        "assert command[:2]==['python3','-c'] and len(command)==3\nexec(compile(command[2],'<fixture-ssh-bootstrap>','exec'))\n")
    ssh.chmod(0o700)
    threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in servers]
    for thread in threads: thread.start()
    process = None
    try:
        log = (args.evidence / 'node.log').open('w')
        with log:
            process = subprocess.Popen([args.node, str(Path(__file__).with_suffix('.mjs')), str(root)],
                stdout=log, stderr=subprocess.STDOUT, env={**os.environ, 'PATH': str(bindir) + os.pathsep + os.environ.get('PATH', '')})
            while process.poll() is None:
                try: phase = json.loads((root / 'fixture-phase.json').read_text())['phase']
                except (FileNotFoundError, json.JSONDecodeError): phase = None
                if phase in ['release_active_request', 'complete_synthetic_measurement', 'cleanup']: release_request.set()
                if web.queue:
                    job = web.queue.popleft(); job.update(state='running', started=time.time()); web.running.append(job)
                    manifest = json.loads((native_root / 'evaluations' / (job['id'] + '.json')).read_text())
                    assert manifest['model_config_snapshot'] == model
                if phase in ['complete_synthetic_measurement', 'cleanup']:
                    for job in list(web.running):
                        ended = time.time(); job.update(state='completed', started=ended-3600, ended=ended,
                            active_intervals=[{'start': ended-3600, 'end': ended}])
                        web.done.append(job); web.running.remove(job)
                time.sleep(0.1)
        assert process.returncode == 0, 'See retained node.log and fixture receipts'
        result = json.loads((root / 'integration-result.json').read_text())
        assert len([c for c in calls if c['kind'] == 'hourglass']) == 1
        assert web.worker_thread is None and not web.running and not web.queue
        assert all(hashlib.sha256((args.source / name).read_bytes()).hexdigest() == h for name, h in hashes.items())
        (args.evidence / 'verification.json').write_text(json.dumps({**result, 'native_source_sha256': hashes,
            'calls': calls, 'worker_started': False, 'synthetic_completion': True, 'fixture': str(root)}, indent=2) + '\n')
        print(json.dumps({'passed': True, 'evidence': str(args.evidence), 'fixture': str(root)}))
    finally:
        release_request.set()
        # On fixture assertion failure, keep its HTTP endpoints available while
        # the Node coordinator observes synthetic completion and closes its real
        # runner/gateway. Never abandon a child waiting on a closed test console.
        if process is not None:
            while process.poll() is None:
                for job in list(web.queue) + list(web.running):
                    ended = time.time(); job.update(state='completed', started=ended-3600, ended=ended,
                        active_intervals=[{'start': ended-3600, 'end': ended}])
                    if job in web.queue: web.queue.remove(job)
                    if job in web.running: web.running.remove(job)
                    web.done.append(job)
                time.sleep(0.1)
        for server in servers: server.shutdown(); server.server_close()
        for thread in threads: thread.join(5)
        assert all(not thread.is_alive() for thread in threads)


if __name__ == '__main__': main()
