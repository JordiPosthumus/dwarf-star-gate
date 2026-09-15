"""Opt-in CPU-only Docker qualification; never pull an image or touch fleet containers.

Set DSG_TEST_DOCKER_SOCKET, DSG_TEST_DOCKER_IMAGE (cached Node image ID), and a
new DSG_TEST_DOCKER_EVIDENCE directory on a Docker-shared filesystem. Evidence
survives the test. Only the exact container IDs created here are cleaned up.
"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import socket
import time
import unittest
import urllib.request
import uuid

spec = importlib.util.spec_from_file_location('profile', Path(__file__).with_name('docker_profile.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


@unittest.skipUnless(all(os.environ.get(k) for k in ['DSG_TEST_DOCKER_SOCKET', 'DSG_TEST_DOCKER_IMAGE', 'DSG_TEST_DOCKER_EVIDENCE']), 'Explicit disposable Docker fixture required')
class NativeProfile(unittest.TestCase):
    def test_real_busy_refusal_cutover_retention_and_restoration(self):
        root = Path(os.environ['DSG_TEST_DOCKER_EVIDENCE']).absolute()
        root.mkdir(mode=0o700)  # An uncertain run must be inspected, not replayed.
        (root / 'source-hashes.json').write_text(json.dumps({name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in ['docker_profile.py', 'docker_profile_native_test.py']}, indent=2))
        fixture = root / 'fixture'
        fixture.mkdir()
        (fixture / 'busy').write_text('0')
        (fixture / 'server.mjs').write_text("""import http from 'node:http';import fs from 'node:fs';
const server=http.createServer((req,res)=>{if(req.url==='/metrics'){res.end('vllm:num_requests_running{engine=\"fixture\"} '+fs.readFileSync('/fixture/busy','utf8').trim()+'\\nvllm:num_requests_waiting{engine=\"fixture\"} 0\\n');}else{res.end(JSON.stringify({profile:process.argv[2],keep:process.env.KEEP}));}}).listen(18080,'0.0.0.0');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
""")
        docker = m.Docker(os.environ['DSG_TEST_DOCKER_SOCKET'])
        image = os.environ['DSG_TEST_DOCKER_IMAGE']
        self.assertRegex(image, r'^sha256:[a-f0-9]{64}$')
        self.assertEqual(docker.image(image)['Id'], image)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        url = 'http://127.0.0.1:' + str(port)
        nonce = str(uuid.uuid4())
        name = 'stargate-test-profile-' + nonce
        body = {'Image': image, 'Cmd': ['node', '/fixture/server.mjs', 'original'],
                'Env': ['KEEP=fixture-preserved'], 'Labels': {'stargate.test': nonce},
                'ExposedPorts': {'18080/tcp': {}},
                'HostConfig': {'Binds': [str(fixture) + ':/fixture:ro'],
                               'Memory': 268435456, 'NanoCpus': 1000000000,
                               'PortBindings': {'18080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]},
                               'RestartPolicy': {'Name': 'no'}}}
        (root / 'fixture.intent.json').write_text(json.dumps({'name': name, 'body': body}, indent=2))
        original = docker.create(name, body)['Id']
        (root / 'fixture.created.json').write_text(json.dumps({'Id': original}))
        created = {original}
        operation = str(uuid.uuid4())

        def read_profile(expected):
            end = time.monotonic() + 30
            while time.monotonic() < end:
                try:
                    with urllib.request.urlopen(url, timeout=2) as response:
                        value = json.loads(response.read())
                    if value == {'profile': expected, 'keep': 'fixture-preserved'}:
                        return value
                except (OSError, ValueError):
                    pass
                time.sleep(.2)
            self.fail('Disposable fixture did not serve the expected profile')

        driver = m.RetainedProfile(root / 'operations', docker=docker,
                                   lease_check=lambda _: True)
        try:
            docker.start(original)
            read_profile('original')
            before = docker.inspect(original)
            plan = driver.prepare(original, image, ['node', '/fixture/server.mjs', 'candidate'], url, 'd' * 64)
            binding = m.digest(plan)
            (root / 'reviewed-plan.json').write_text(json.dumps(plan, indent=2))
            (fixture / 'busy').write_text('1')
            with self.assertRaisesRegex(RuntimeError, 'Native work'):
                driver.apply(str(uuid.uuid4()), plan, binding)
            self.assertEqual(docker.inspect(original)['State']['StartedAt'], before['State']['StartedAt'])
            (fixture / 'busy').write_text('0')
            result = driver.apply(operation, plan, binding)
            candidate = result['candidate']['Id']
            created.add(candidate)
            self.assertEqual(result['state'], 'started_unverified')
            candidate_reply = read_profile('candidate')
            self.assertFalse(docker.inspect(original)['State']['Running'])
            self.assertEqual(docker.inspect(candidate)['HostConfig']['Memory'], 268435456)
            restored = driver.restore(operation, binding)
            self.assertEqual(restored['state'], 'restored_unverified')
            original_reply = read_profile('original')
            after = docker.inspect(original)
            self.assertEqual(m.signature(before), m.signature(after))
            self.assertNotEqual(before['State']['StartedAt'], after['State']['StartedAt'])
            self.assertFalse(docker.inspect(candidate)['State']['Running'])
            self.assertEqual(driver.apply(operation, plan, binding)['state'], 'restored_unverified')
            self.assertEqual(docker.inspect(original)['State']['StartedAt'], after['State']['StartedAt'])
            (root / 'verification.json').write_text(json.dumps({'state': 'disposable-docker-cutover-and-restore-passed',
                'original_id': original, 'candidate_id': candidate, 'candidate_reply': candidate_reply,
                'restored_reply': original_reply, 'busy_request_refused': True, 'retained_both_versions': True,
                'scope': 'Real local Docker and native-idle checks with a CPU fixture. Synthetic maintenance ownership; no real gateway approval, model server or model qualification.'}, indent=2))
        finally:
            # An uncertain create may have returned no receipt. Inspect only this
            # test's exact unique candidate name before cleaning up its fixtures.
            candidate = docker.inspect('stargate-profile-' + operation)
            if candidate and candidate['Config']['Labels'].get('stargate.test') == nonce:
                created.add(candidate['Id'])
            receipt = root / 'operations' / operation / 'create.result.json'
            if receipt.exists():
                created.add(json.loads(receipt.read_text())['result']['Id'])
            for cid in created:
                container = docker.inspect(cid)
                if container and container['Config']['Labels'].get('stargate.test') == nonce:
                    if container['State']['Running']:
                        docker.stop(cid)
                    docker.request('DELETE', '/containers/' + cid)
            (root / 'cleanup.json').write_text(json.dumps({'fixture_container_ids': sorted(created),
                'all_removed': all(docker.inspect(cid) is None for cid in created)}, indent=2))


if __name__ == '__main__':
    unittest.main()
