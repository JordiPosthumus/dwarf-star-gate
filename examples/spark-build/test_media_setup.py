import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import io

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('model_setup', ROOT / 'download-models.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class ModelSetupTests(unittest.TestCase):
    def manifest(self, root, data=b'complete model'):
        path = root / 'models.json'
        path.write_text(json.dumps({'files': [{'path': 'model/weights', 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest(), 'url': 'https://example.invalid/weights'}]}))
        return path

    def test_existing_different_asset_is_preserved_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / 'models/model/weights'
            target.parent.mkdir(parents=True)
            target.write_bytes(b'personal model')
            with patch.object(setup.urllib.request, 'urlopen') as network:
                with self.assertRaisesRegex(ValueError, 'preserved'):
                    setup.install(self.manifest(root), root / 'models')
                network.assert_not_called()
            self.assertEqual(target.read_bytes(), b'personal model')

    def test_interrupted_download_resumes_and_verifies_complete_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / 'models/model/weights'
            target.parent.mkdir(parents=True)
            partial = target.with_name('weights.stargate-download')
            partial.write_bytes(b'complete ')
            response = io.BytesIO(b'model')
            response.status = 206
            response.headers = {'Content-Range': 'bytes 9-13/14'}
            with patch.object(setup.urllib.request, 'urlopen', return_value=response) as network:
                setup.install(self.manifest(root), root / 'models')
                self.assertEqual(network.call_args.args[0].get_header('Range'), 'bytes=9-')
            self.assertEqual(target.read_bytes(), b'complete model')
            self.assertFalse(partial.exists())

    def test_corrupt_download_is_retained_but_never_published(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            response = io.BytesIO(b'corrupt model!')
            response.status = 200
            with patch.object(setup.urllib.request, 'urlopen', return_value=response):
                with self.assertRaisesRegex(ValueError, 'hash differs'):
                    setup.install(self.manifest(root), root / 'models')
            self.assertFalse((root / 'models/model/weights').exists())
            self.assertEqual((root / 'models/model/weights.stargate-download').read_bytes(), b'corrupt model!')


if __name__ == '__main__':
    unittest.main()
