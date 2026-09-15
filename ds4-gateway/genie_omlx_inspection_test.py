import hashlib
import subprocess
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from genie_omlx import inspect_omlx, read_sources


class LocalInspection(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'state').mkdir()
        (self.root / 'state/settings.json').write_text(json.dumps({'api_key': 'PRIVATE_TEST_KEY', 'cache': {'size': '372GB'}}))
        (self.root / 'state/model_settings.json').write_text(json.dumps({'example': {'mtp_enabled': True, 'max_tokens': 262144}}))
        (self.root / 'serve.sh').write_text('exec omlx serve --api-key PRIVATE_TEST_KEY --max-context 262144\n')
        (self.root / 'server.pid').write_text('37\n')
        self.key = self.root / 'key'
        self.key.write_text('PRIVATE_TEST_KEY\n')
        self.key.chmod(0o600)
        self.requests = []
        self.redirect = False
        parent = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                parent.requests.append((self.path, self.headers.get('Authorization')))
                if parent.redirect:
                    self.send_response(302)
                    self.send_header('Location', '/capture')
                    self.end_headers()
                else:
                    data = json.dumps({'data': [{'id': 'example', 'max_model_len': 262144}]}).encode()
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(data)
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.target = dict(kind='omlx-local', root=str(self.root), url=f'http://127.0.0.1:{self.server.server_port}/v1', api_key_file=str(self.key))

    def test_real_metadata_request_redacts_credentials_and_preserves_nonsecret_settings(self):
        with patch('genie_omlx.subprocess.check_output', return_value='p37\n'):
            result = inspect_omlx(self.target)
        self.assertEqual(self.requests, [('/v1/models', 'Bearer PRIVATE_TEST_KEY')])
        self.assertNotIn('PRIVATE_TEST_KEY', json.dumps(result))
        self.assertIn('--max-context 262144', result['files']['serve.sh']['content'])
        self.assertEqual(result['files']['state/settings.json']['content']['cache']['size'], '372GB')
        self.assertEqual(result['files']['state/model_settings.json']['content']['example']['mtp_enabled'], True)
        self.assertTrue(result['process']['recorded_pid_matches_listener'])
        self.assertEqual(result['source_on_disk']['loaded_revision'], 'not established')
        self.assertEqual(result['files']['start.py']['state'], 'unavailable')

    def test_credentials_are_not_forwarded_on_redirect(self):
        self.redirect = True
        with self.assertRaises(HTTPError) as raised:
            inspect_omlx(self.target)
        raised.exception.close()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0][0], '/v1/models')

    def test_private_key_and_explicit_loopback_enrollment_required(self):
        for target in [dict(self.target, url='http://example.test/v1'), dict(self.target, command='do something')]:
            with self.assertRaises(ValueError):
                inspect_omlx(target)
        self.key.chmod(0o644)
        with self.assertRaises(ValueError):
            inspect_omlx(self.target)
        self.assertEqual(self.requests, [])

    def test_source_bytes_hashes_missing_paths_and_large_runtime_file_without_execution(self):
        source=self.root/'omlx-src';package=source/'omlx';package.mkdir(parents=True)
        text='raise RuntimeError("must not execute")\n'+'# source fixture\n'*20000
        (package/'server.py').write_text(text)
        (package/'__init__.py').write_text('raise RuntimeError("must not import")\n')
        with patch('genie_omlx.subprocess.check_output',return_value='p37\n'):
            result=inspect_omlx(self.target,source_files=['omlx/server.py','omlx/absent.py'])
        rows=result['sources']['files'];self.assertEqual(rows[0]['text'],text)
        self.assertEqual(rows[0]['sha256'],hashlib.sha256(text.encode()).hexdigest())
        self.assertGreater(rows[0]['bytes'],262144)
        self.assertEqual(rows[1],{'path':'omlx/absent.py','status':'not_found'})
        self.assertFalse(list(source.rglob('__pycache__')))
        page=read_sources(source,['omlx/server.py'],{'offset':300000,'length':4000})['files'][0]
        self.assertEqual(page['text'],text[300000:304000]);self.assertEqual(page['sha256'],rows[0]['sha256'])
        self.assertEqual(page['window']['next_offset'],304000);self.assertFalse(page['window']['complete_file'])
        tail=read_sources(source,['omlx/server.py'],{'offset':len(text)-10,'length':4000})['files'][0]
        self.assertEqual(tail['text'],text[-10:]);self.assertIsNone(tail['window']['next_offset'])
        self.assertFalse(tail['window']['complete_file'])
        for paths in [['omlx/../serve.py'],['vllm/server.py'],['omlx//server.py'],['omlx/server.py']*2,[]]:
            with self.assertRaises(ValueError):read_sources(source,paths)
        (package/'escape.py').symlink_to(self.root/'serve.sh')
        with self.assertRaises(ValueError):read_sources(source,['omlx/escape.py'])
        (package/'huge.py').write_bytes(b'x'*524289)
        with self.assertRaises(ValueError):read_sources(source,['omlx/huge.py'])

    def test_current_modified_runtime_paths_come_from_own_git_checkout(self):
        source=self.root/'omlx-src';package=source/'omlx';package.mkdir(parents=True)
        file=package/'server.py';file.write_text('# before\n')
        subprocess.run(['git','init','-q',str(source)],check=True)
        subprocess.run(['git','-C',str(source),'add','.'],check=True)
        subprocess.run(['git','-C',str(source),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)
        file.write_text('# after\n')
        (package/'helper.py').write_text('# local addition\n')
        original=subprocess.check_output
        def command(args,**kwargs):
            return 'p37\n' if args[0]=='/usr/sbin/lsof' else original(args,**kwargs)
        with patch('genie_omlx.subprocess.check_output',side_effect=command):result=inspect_omlx(self.target)
        self.assertEqual(result['source_on_disk']['changed_python_files'],['omlx/server.py'])
        self.assertTrue(result['source_on_disk']['tracked_changes'])
        self.assertEqual(result['source_on_disk']['untracked_python_files'],['omlx/helper.py'])
        self.assertEqual(result['source_on_disk']['loaded_revision'],'not established')


if __name__ == '__main__':
    unittest.main()
