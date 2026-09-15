import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from docker_profile import native_request


class NativeHTTPTest(unittest.TestCase):
    def setUp(self):
        self.requests, self.status = [], 200
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                fixture.requests.append(('GET', self.path, None))
                self.send_response(fixture.status)
                if fixture.status == 302: self.send_header('Location', '/private-target')
                self.end_headers(); self.wfile.write(b'{"fixture":true}')
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                fixture.requests.append(('POST', self.path, json.loads(body)))
                self.send_response(fixture.status); self.end_headers(); self.wfile.write(body)
            def log_message(self, *args): pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def test_real_http_post_keeps_json_data_and_response_bytes(self):
        body = {'messages': [{'role': 'user', 'content': '$(fixture-only) café'}]}
        result = native_request(self.url, '/v1/chat/completions', body)
        self.assertEqual(result['status'], 200)
        self.assertEqual(json.loads(base64.b64decode(result['body_base64'])), body)
        self.assertEqual(self.requests, [('POST', '/v1/chat/completions', body)])

    def test_http_error_is_retained_as_response_evidence_without_retry(self):
        self.status = 400
        result = native_request(self.url, '/v1/completions', {'prompt': [1, 2], 'max_tokens': 1})
        self.assertEqual(result['status'], 400); self.assertEqual(len(self.requests), 1)

    def test_native_observation_does_not_follow_redirects(self):
        self.status = 302
        result = native_request(self.url, '/v1/models')
        self.assertEqual(result['status'], 302)
        self.assertEqual(self.requests, [('GET', '/v1/models', None)])


if __name__ == '__main__': unittest.main()
