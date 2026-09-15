import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from prepare import prepare


class PreparationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        (self.source / 'repair/vllm').mkdir(parents=True)
        self.repair = b'# synthetic repair\n'
        (self.source / 'repair/vllm/example.py').write_bytes(self.repair)
        self.original = b'FROM upstream:tag\n'
        self.manifest = {'upstream': {'repository': 'https://github.com/example/source',
            'revision': 'a' * 40, 'files': [{'path': 'Dockerfile.v0.29',
                'sha256': hashlib.sha256(self.original).hexdigest()}]},
            'upstream_base_line': 'FROM upstream:tag',
            'base_image': 'upstream:tag@sha256:' + 'b' * 64,
            'repair_files': [{'path': 'vllm/example.py',
                'sha256': hashlib.sha256(self.repair).hexdigest()}]}
        (self.source / 'manifest.json').write_text(json.dumps(self.manifest))
        for name in ['NOTICE.md', 'LICENSE-APACHE-2.0']:
            (self.source / name).write_text('Synthetic fixture only.\n')

    def test_pins_base_and_preserves_exact_repair_bytes(self):
        target = self.root / 'output'
        receipt = prepare(target, fetch=lambda _: self.original, source=self.source)
        self.assertEqual((target / 'repair/vllm/example.py').read_bytes(), self.repair)
        self.assertIn('FROM ' + self.manifest['base_image'], (target / 'Dockerfile').read_text())
        self.assertIn('COPY repair/vllm/example.py ', (target / 'Dockerfile').read_text())
        self.assertEqual(json.loads((target / 'build-receipt.json').read_text()), receipt)

    def test_existing_destination_is_preserved_without_network(self):
        target = self.root / 'existing'
        target.mkdir()
        (target / 'personal').write_text('preserve me')
        with self.assertRaises(FileExistsError):
            prepare(target, fetch=lambda _: self.fail('Must not download'), source=self.source)
        self.assertEqual((target / 'personal').read_text(), 'preserve me')

    def test_wrong_download_or_local_repair_has_no_completion_receipt(self):
        target = self.root / 'bad-download'
        with self.assertRaisesRegex(ValueError, 'hash differs'):
            prepare(target, fetch=lambda _: b'different', source=self.source)
        self.assertFalse((target / 'build-receipt.json').exists())
        (self.source / 'repair/vllm/example.py').write_bytes(b'changed')
        target = self.root / 'bad-repair'
        with self.assertRaisesRegex(ValueError, 'hash differs'):
            prepare(target, fetch=lambda _: self.original, source=self.source)
        self.assertFalse((target / 'build-receipt.json').exists())


if __name__ == '__main__':
    unittest.main()
