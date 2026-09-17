import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading
import types
import sys
import unittest
from unittest.mock import patch

from genie_hourglass import register_hourglass, NAMES


class HourglassToolsTest(unittest.TestCase):
    def setUp(self):
        self.calls, self.events, self.catalog = [], [], {}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.calls.append((self.path, self.headers.get('X-SG-Hourglass-Tool'), body))
                if getattr(owner, 'redirect', False):
                    self.send_response(302)
                    self.send_header('Location', '/must-not-follow')
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'prepared': {'id': 'fixture'}}).encode())

            def log_message(self, *args):
                pass

        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join()))
        module = types.ModuleType('tools.registry')
        module.registry = types.SimpleNamespace(register=lambda **kw: self.catalog.update({kw['name']: kw}))
        context = patch.dict(sys.modules, {'tools.registry': module})
        context.start()
        self.addCleanup(context.stop)
        self.config = {'url': f'http://127.0.0.1:{server.server_port}/api/genie/hourglass-tools',
            'token': 'fixture-token', 'models': ['fixture-model']}
        register_hourglass(self.config, lambda kind, **kw: self.events.append((kind, kw)))

    def test_tools_send_only_preparation_or_status_and_record_results(self):
        self.assertEqual(set(self.catalog), NAMES)
        for name, args in [('prepare_hourglass_measurement', {'model': 'fixture-model'}),
                ('hourglass_measurement_status', {})]:
            result = json.loads(self.catalog[name]['handler'](args))
            self.assertEqual(result['prepared']['id'], 'fixture')
        self.assertEqual([call[2] for call in self.calls], [
            {'action': 'prepare', 'model': 'fixture-model'}, {'action': 'status'}])
        self.assertEqual([e[1]['event']['state'] for e in self.events],
            ['reading', 'complete', 'reading', 'complete'])
        self.assertNotIn('fixture-token', json.dumps(self.events))
        self.assertEqual(self.events[0][1]['event']['request'],
            {'action': 'prepare', 'model': 'fixture-model'})

    def test_extra_authority_and_unknown_targets_never_reach_dashboard(self):
        for name, args in [('prepare_hourglass_measurement', {'model': 'unknown'}),
                ('prepare_hourglass_measurement', {'model': 'fixture-model', 'start': True}),
                ('hourglass_measurement_status', {'action': 'start'})]:
            self.assertIn('error', json.loads(self.catalog[name]['handler'](args)))
        self.assertEqual(self.calls, [])

    def test_comparison_sends_only_retained_report_revisions_and_keeps_receipt(self):
        args = {'baseline_revision': 'a' * 64, 'candidate_revision': 'b' * 64}
        self.catalog['compare_hourglass_reports']['handler'](args)
        self.assertEqual(self.calls[0][2], {'action': 'compare', **args})
        self.assertEqual(self.events[-1][1]['event']['state'], 'complete')
        for invalid in [{**args, 'start': True}, {**args, 'baseline_revision': '/private/report'}, {'baseline_revision': 'a' * 64}]:
            self.assertIn('error', json.loads(self.catalog['compare_hourglass_reports']['handler'](invalid)))
        self.assertEqual(len(self.calls), 1)

    def test_redirect_is_not_followed_or_retried(self):
        self.redirect = True
        result = json.loads(self.catalog['hourglass_measurement_status']['handler']({}))
        self.assertIn('error', result)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.events[-1][1]['event']['state'], 'failed')

    def test_optional_operation_association_is_forwarded_without_extra_authority(self):
        args = {'baseline_revision': 'a' * 64, 'candidate_revision': 'b' * 64,
                'operation_id': '11111111-2222-4333-8444-555555555555'}
        self.catalog['compare_hourglass_reports']['handler'](args)
        self.assertEqual(self.calls[0][2], {'action': 'compare', **args})
        for invalid in [{**args, 'operation_id': '/private/path'}, {**args, 'operation_id': None}, {**args, 'approve': True}]:
            self.assertIn('error', json.loads(self.catalog['compare_hourglass_reports']['handler'](invalid)))
        self.assertEqual(len(self.calls), 1)

    def test_endpoint_must_be_fixed_loopback_tool_route(self):
        for url in ['http://example.invalid/api/genie/hourglass-tools',
                'http://127.0.0.1:1/api/hourglass', 'http://127.0.0.1:1/api/genie/hourglass-tools?secret=yes']:
            with self.assertRaises(ValueError):
                register_hourglass({**self.config, 'url': url}, lambda *a, **kw: None)


if __name__ == '__main__':
    unittest.main()
