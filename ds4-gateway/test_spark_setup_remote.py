import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote', Path(__file__).with_name('spark_setup_remote.py'))
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


def bundle(script):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in [('examples/spark-build/setup-spark.py', script.encode()), ('ds4-gateway/spark_setup_remote.py', Path(remote.__file__).read_bytes())]:
            info = tarfile.TarInfo(name); info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    raw = buffer.getvalue()
    return {'bundle': base64.b64encode(raw).decode(), 'bundle_sha256': hashlib.sha256(raw).hexdigest()}


class RemoteSetupTests(unittest.TestCase):
    def test_preflight_failure_preserves_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'setup'
            with self.assertRaisesRegex(ValueError, 'busy GPU'):
                remote.start(root, bundle("def preflight(): raise ValueError('busy GPU')\n"))
            self.assertFalse(root.exists())

    def test_existing_unknown_directory_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); personal = root / 'personal'; personal.write_text('Keep')
            self.assertEqual(remote.start(root, {})['state'], 'needs_attention')
            self.assertEqual(personal.read_text(), 'Keep')
            self.assertEqual(list(root.iterdir()), [personal])

    def test_detached_preparation_is_observable_and_cannot_be_launched_twice(self):
        script = '''import json,sys,time
from pathlib import Path
def preflight(): pass
if __name__ == '__main__':
 root=Path(sys.argv[1]);root.mkdir()
 (root/'setup.json').write_text(json.dumps({'state':'running','phase':'fixture'}))
 while not (root.parent/'finish').exists(): time.sleep(.02)
 (root/'setup.json').write_text(json.dumps({'state':'prepared_stopped','phase':'complete'}))
'''
        with tempfile.TemporaryDirectory() as tmp, patch.object(remote.Path, 'home', return_value=Path(tmp)):
            root = Path(tmp) / 'setup'
            try:
                self.assertEqual(remote.start(root, bundle(script))['state'], 'accepted')
                self.assertEqual(remote.start(root, {})['state'], 'running')
                with self.assertRaisesRegex(ValueError, 'Another Spark preparation'):
                    remote.start(Path(tmp) / 'other', bundle(script))
                self.assertFalse((Path(tmp) / 'other').exists())
            finally:
                (root / 'finish').touch()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                state = remote.status(root)
                if state['state'] != 'running': break
                time.sleep(.02)
            self.assertEqual(state['state'], 'prepared_stopped', state)
            self.assertEqual(state['exit_code'], 0)
            self.assertEqual(remote.start(root, {})['state'], 'prepared_stopped')


if __name__ == '__main__':
    unittest.main()
