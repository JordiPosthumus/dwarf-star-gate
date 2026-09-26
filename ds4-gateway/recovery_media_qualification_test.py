import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import media_maintenance as m


class QualificationPermissionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='ace-qualification-policy-')
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.plan = {'operation_id': '11111111-1111-4111-8111-111111111111', 'worker_id': 'pair',
                     'control_socket': '/fixture.sock', 'llm_pair': {'members': []}, 'separate_workers': ['other'],
                     'ace_qualification': {'candidate_operation_id': '22222222-2222-4222-8222-222222222222'}}
        self.raw = json.dumps(self.plan).encode()
        (self.root/'plan.json').write_bytes(self.raw)

    def test_private_permit_binds_saved_plan_and_job_and_refuses_denial_or_unreadable_reply(self):
        calls = []
        response = {'status': 200, 'bytes': b'{"allowed":true}'}
        class Connection:
            def __init__(self, socket, timeout): calls.append(('connect', socket, timeout))
            def request(self, method, route, body, headers): calls.append((method, route, json.loads(body)))
            def getresponse(self):
                return type('Response', (), {'status': response['status'], 'read': lambda _, n: response['bytes']})()
            def close(self): calls.append(('closed',))
        with patch.object(m, 'UnixHTTP', Connection):
            m.qualification_permit(self.plan, self.raw)
            self.assertEqual(calls[1], ('POST', '/media-qualification-permit', {
                'operation_id': self.plan['ace_qualification']['candidate_operation_id'],
                'job_id': self.plan['operation_id'], 'plan_file_sha256': hashlib.sha256(self.raw).hexdigest()}))
            for status, raw in [(409, b'{}'), (200, b'{"allowed":false}'), (200, b'bad')]:
                response.update(status=status, bytes=raw)
                with self.assertRaises(Exception): m.qualification_permit(self.plan, self.raw)
                self.assertEqual(calls[-1], ('closed',))

    def test_withdrawal_blocks_borrowing_and_new_transitions_but_not_owned_restoration_or_finish(self):
        actions = []
        class Window:
            def __init__(self, *args, **kwargs): pass
            def acquire(self): actions.append('acquire')
            def wait_idle(self, *args): actions.append('idle')
            def owned(self): actions.append('owned');return True
            def release(self): actions.append('release')
            def resume_if_unchanged(self): actions.append('resume');return {'state': 'readmitted'}
        with patch.object(m, 'Maintenance', Window), patch.object(m, 'GatewayControl', lambda _: lambda route: {'workers': []}), \
                patch.object(m, 'qualification_permit', side_effect=RuntimeError('withdrawn')) as permit:
            for action in ['prepare', 'transition']:
                with self.assertRaisesRegex(RuntimeError, 'withdrawn'): m.main(self.root, action)
            self.assertEqual(actions, [])
            self.assertTrue(m.main(self.root, 'owned')['owned'])
            self.assertEqual(m.main(self.root, 'finish')['state'], 'readmitted')
            self.assertEqual(permit.call_count, 2)
            self.assertEqual(actions, ['owned', 'idle', 'release', 'resume'])

    def test_existing_media_plans_do_not_gain_a_new_policy_requirement(self):
        plan = {k: v for k,v in self.plan.items() if k != 'ace_qualification'}
        with patch.object(m, 'UnixHTTP', side_effect=AssertionError('legacy must not call')):
            m.qualification_permit(plan, json.dumps(plan).encode())
