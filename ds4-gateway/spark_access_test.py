import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

import spark_access_key as key_setup
import spark_access_ssh as transport


class PrivateTransportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.known = self.root / 'known_hosts'
        self.known.write_text('# fixture\n')
        self.known.chmod(0o600)
        self.password = 'disposable-test-password'
        self.payload = {'ssh': 'owner@' + '.'.join(('10', '27', '0', '9')), 'known_hosts': str(self.known), 'password': self.password, 'code': 'pass'}

    def execute(self, source, timeout=2):
        program = self.root / 'fake_ssh.py'
        program.write_text(source)
        def child(_file, args):
            os.execv(sys.executable, [sys.executable, str(program), *args[1:]])
        return transport.run(self.payload, timeout=timeout, execute=child)

    def test_password_uses_the_terminal_only_and_pinned_options_are_retained(self):
        result = self.execute("""import os,sys,json
print("owner@fixture's password: ",end='',flush=True)
password=input()
print('DSG_ACCESS_RESULT='+json.dumps({'accepted':password=='disposable-test-password','argv_leak':any(password in a for a in sys.argv),'environment_leak':any(password in value for value in os.environ.values()),'args':sys.argv}))
""")
        self.assertTrue(result['ok'])
        self.assertTrue(result['result']['accepted'])
        self.assertFalse(result['result']['argv_leak'])
        self.assertFalse(result['result']['environment_leak'])
        args = result['result']['args']
        for option in ('StrictHostKeyChecking=yes', 'NumberOfPasswordPrompts=1', 'ControlPath=none', 'GlobalKnownHostsFile=/dev/null', 'ForwardAgent=no', 'ClearAllForwardings=yes'):
            self.assertIn(option, args)
        self.assertNotIn(self.password, json.dumps(result))
        self.assertEqual({p.name for p in self.root.iterdir()}, {'known_hosts', 'fake_ssh.py'})

    def test_echoed_password_and_raw_errors_never_escape_a_failed_transport(self):
        result = self.execute("""import sys
print('Password: ',end='',flush=True)
print(input(),flush=True)
print('private terminal failure detail',flush=True)
sys.exit(255)
""")
        self.assertEqual(result, {'ok': False, 'reason': 'ssh_access_unconfirmed'})
        self.assertNotIn(self.password, json.dumps(result))

    def test_password_change_prompt_never_receives_a_second_password(self):
        result = self.execute("""print('Password: ',end='',flush=True)
input()
print('New password: ',end='',flush=True)
input()
print('DSG_ACCESS_RESULT={"wrong":true}',flush=True)
""", timeout=.2)
        self.assertEqual(result, {'ok': False, 'reason': 'observation_timeout'})

    def test_timeout_terminates_only_the_created_session(self):
        pid_file = self.root / 'child-pid'
        started = time.monotonic()
        result = self.execute(f"import os,time\nopen({str(pid_file)!r},'w').write(str(os.getpid()))\ntime.sleep(20)\n", timeout=.2)
        self.assertEqual(result['reason'], 'observation_timeout')
        self.assertLess(time.monotonic() - started, 3)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid_file.read_text()), 0)

    def test_host_key_failure_is_reported_without_a_credential_attempt(self):
        result = self.execute("import sys\nprint('Host key verification failed.',flush=True)\nsys.exit(255)\n")
        self.assertEqual(result, {'ok': False, 'reason': 'host_key_unverified'})

    def test_outer_cancellation_reaps_only_the_owned_ssh_child(self):
        pid_file = self.root / 'cancel-child-pid'
        fake_ssh = self.root / 'ssh'
        fake_ssh.write_text(f'#!{sys.executable}\nimport os,time\nopen({str(pid_file)!r},"w").write(str(os.getpid()))\ntime.sleep(30)\n')
        fake_ssh.chmod(0o700)
        child = subprocess.Popen([sys.executable, '-I', '-B', str(Path(transport.__file__).resolve())],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={**os.environ, 'PATH': str(self.root) + os.pathsep + os.environ['PATH']})
        try:
            child.stdin.write(json.dumps(self.payload).encode())
            child.stdin.close()
            deadline = time.monotonic() + 5
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(pid_file.exists(), 'Owned SSH child never started')
            child.send_signal(signal.SIGTERM)
            child.wait(timeout=5)
            self.assertEqual(json.loads(child.stdout.read()), {'ok': False, 'reason': 'private_transport_unavailable'})
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid_file.read_text()), 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdout.close()
            child.stderr.close()

    def test_unsupported_password_and_nonprivate_destinations_are_refused(self):
        for value in ('bad\nvalue', '', 'x' * 1025):
            with self.assertRaises(ValueError):
                transport.run({**self.payload, 'password': value})
        with self.assertRaises(ValueError):
            transport.run({**self.payload, 'ssh': 'owner@8.8.8.8'})


class RemoteKeySetupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        file = self.home / 'fixture-key'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(file)], check=True)
        self.key = ' '.join(Path(str(file) + '.pub').read_text().split()[:2])
        self.identity = 'a' * 64
        self.request = {'operation_id': str(uuid.uuid4()), 'identity': self.identity, 'public_key': self.key}

    def install(self, request=None):
        return key_setup.install(request or self.request, home=self.home, identify=lambda: self.identity)

    def test_preserves_existing_bytes_and_mode_keeps_private_backup_and_is_idempotent(self):
        ssh = self.home / '.ssh'
        ssh.mkdir(mode=0o700)
        target = ssh / 'authorized_keys'
        before = b'# owner policy\nssh-ed25519 AAAA retained-key'
        target.write_bytes(before)
        target.chmod(0o640)
        result = self.install()
        self.assertEqual(result, {'state': 'key_present', 'changed': True, 'backup_retained': True})
        after = target.read_bytes()
        self.assertTrue(after.startswith(before + b'\n'))
        self.assertEqual(target.stat().st_mode & 0o777, 0o640)
        backups = list(self.home.rglob('authorized-keys-before-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.install(), {'state': 'key_present', 'changed': False})
        self.assertEqual(target.read_bytes(), after)

    def test_new_key_file_is_private_and_wrong_hardware_cannot_create_any_ssh_files(self):
        changed = {**self.request, 'identity': 'b' * 64}
        self.assertEqual(self.install(changed)['state'], 'identity_changed')
        self.assertFalse((self.home / '.ssh').exists())
        self.assertEqual(self.install()['state'], 'key_present')
        self.assertEqual((self.home / '.ssh/authorized_keys').stat().st_mode & 0o777, 0o600)

    def test_restricted_existing_key_is_not_silently_upgraded(self):
        (self.home / '.ssh').mkdir(mode=0o700)
        target = self.home / '.ssh/authorized_keys'
        before = f'restrict,command="echo restricted" {self.key} retained\n'
        target.write_text(before)
        self.assertEqual(self.install(), {'state': 'existing_key_restricted', 'changed': False})
        self.assertEqual(target.read_text(), before)

    def test_symlinked_keys_are_preserved_and_a_reused_operation_cannot_change_its_key(self):
        (self.home / '.ssh').mkdir(mode=0o700)
        target = self.home / '.ssh/authorized_keys'
        target.symlink_to(self.home / 'fixture-key.pub')
        with self.assertRaises(ValueError):
            self.install()
        self.assertTrue(target.is_symlink())
        target.unlink()
        self.install()
        with self.assertRaises(ValueError):
            self.install({**self.request, 'public_key': 'ssh-ed25519 YW5vdGhlcg=='})

    def test_concurrent_owner_edit_is_preserved_without_adding_a_key(self):
        (self.home / '.ssh').mkdir(mode=0o700)
        target = self.home / '.ssh/authorized_keys'
        target.write_text('# before\n')
        original = os.open
        def opening(file, flags, *args, **kwargs):
            if Path(file) == target and flags & os.O_APPEND:
                with target.open('a') as stream:
                    stream.write('# owner addition\n')
            return original(file, flags, *args, **kwargs)
        with patch.object(key_setup.os, 'open', side_effect=opening), self.assertRaises(ValueError):
            self.install()
        self.assertEqual(target.read_text(), '# before\n# owner addition\n')


if __name__ == '__main__':
    unittest.main()
