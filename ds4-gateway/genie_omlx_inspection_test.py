import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from genie_omlx import inspect_omlx


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


if __name__ == '__main__':
    unittest.main()
