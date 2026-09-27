from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from genie_native_sessions import NativeSessionRequests


class NativeSessions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'requests'
        self.inject = Mock(return_value=True)
        self.requests = NativeSessionRequests(self.directory, ['owner-session'], self.inject)
        self.payload = {'action': 'send', 'request_id': '12345678-1234-4234-8234-123456789abc',
                        'session_key': 'owner-session', 'message': 'Inspect the enrolled fleet.'}

    def test_accepted_is_not_completion_and_restart_does_not_replay(self):
        receipt = self.requests.dispatch(self.payload)
        self.assertEqual(receipt['state'], 'accepted_unverified')
        restarted = NativeSessionRequests(self.directory, ['owner-session'], self.inject)
        self.assertEqual(restarted.dispatch(self.payload), receipt)
        self.assertEqual(self.inject.call_count, 1)
        self.assertIn(self.payload['request_id'], self.inject.call_args.args[0])
        self.assertEqual(restarted.dispatch({'action': 'status', 'request_id': self.payload['request_id']}), receipt)

    def test_crash_after_injection_leaves_uncertainty_without_replay(self):
        original = self.requests._save
        def save(file, value):
            if value['state'] != 'dispatching':
                raise OSError('Fixture crash after native acceptance')
            original(file, value)
        with patch.object(self.requests, '_save', side_effect=save):
            with self.assertRaises(OSError):
                self.requests.dispatch(self.payload)
        restarted = NativeSessionRequests(self.directory, ['owner-session'], self.inject)
        self.assertEqual(restarted.dispatch(self.payload)['state'], 'dispatching')
        self.assertEqual(self.inject.call_count, 1)

    def test_rejects_other_sessions_changed_instructions_and_extra_fields(self):
        for change in ({'session_key': 'other'}, {'session_key': []}, {'request_id': '../escape'},
                       {'message': ''}, {'command': 'start'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.requests.dispatch({**self.payload, **change})
        self.inject.assert_not_called()
        self.requests.dispatch(self.payload)
        with self.assertRaises(ValueError):
            self.requests.dispatch({**self.payload, 'message': 'Update instead'})
        self.assertEqual(self.inject.call_count, 1)

    def test_injection_failure_never_becomes_success_or_automatic_replay(self):
        for outcome, state in ((False, 'not_accepted'), (RuntimeError('unavailable'), 'unknown')):
            with self.subTest(state=state):
                directory = self.directory / state
                inject = Mock(side_effect=outcome) if isinstance(outcome, Exception) else Mock(return_value=outcome)
                requests = NativeSessionRequests(directory, ['owner-session'], inject)
                self.assertEqual(requests.dispatch(self.payload)['state'], state)
                self.assertEqual(requests.dispatch(self.payload)['state'], state)
                self.assertEqual(inject.call_count, 1)

    def test_private_storage_and_explicit_session_configuration(self):
        with self.assertRaises(ValueError):
            NativeSessionRequests(self.directory, 'owner-session', self.inject)
        self.requests.dispatch(self.payload)
        file = self.directory / (self.payload['request_id'] + '.json')
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(self.payload['message'], file.read_text())
        self.directory.chmod(0o755)
        with self.assertRaises(ValueError):
            NativeSessionRequests(self.directory, ['owner-session'], self.inject)


if __name__ == '__main__':
    unittest.main()
