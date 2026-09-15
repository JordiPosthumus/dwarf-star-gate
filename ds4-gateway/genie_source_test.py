import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from genie_inspection import SOURCE_QUERY, valid_source_files


class InstalledSourceReads(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'vllm').mkdir()
        (self.root / 'vllm/__init__.py').write_text('raise RuntimeError("Runtime must not be imported")\n')
        self.source = self.root / 'vllm/example.py'
        self.source.write_text('raise RuntimeError("Source must not execute")\n')

    def read(self, paths):
        return subprocess.run([sys.executable, '-B', '-c', SOURCE_QUERY, json.dumps(paths)],
                              env={**os.environ, 'PYTHONPATH': str(self.root)},
                              capture_output=True, text=True, timeout=10)

    def test_reads_bytes_without_import_and_reports_exact_missing_path(self):
        p = self.read(['vllm/example.py', 'vllm/absent.py'])
        self.assertEqual(p.returncode, 0, p.stderr)
        rows = json.loads(p.stdout)['files']
        self.assertEqual(rows[0]['text'], self.source.read_text())
        self.assertEqual(rows[0]['sha256'], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(rows[1], {'path': 'vllm/absent.py', 'status': 'not_found'})
        self.assertFalse(list(self.root.rglob('__pycache__')))

    def test_traversal_absolute_and_non_package_paths_are_rejected(self):
        for name in ['vllm/../secret.py', '/etc/settings.py', 'vllm//example.py',
                     'other/example.py', 'vllm/example.py;echo unsafe']:
            with self.subTest(name=name):
                self.assertFalse(valid_source_files([name]))
                self.assertNotEqual(self.read([name]).returncode, 0)

    def test_symlink_outside_package_never_returns_contents(self):
        secret = self.root / 'secret.py'
        secret.write_text('PRIVATE_SOURCE_FIXTURE')
        (self.root / 'vllm/link.py').symlink_to(secret)
        p = self.read(['vllm/link.py'])
        self.assertNotEqual(p.returncode, 0)
        self.assertNotIn('PRIVATE_SOURCE_FIXTURE', p.stdout + p.stderr)

    def test_source_budget_is_separate_from_model_limits(self):
        self.source.write_bytes(b'x' * 262145)
        self.assertNotEqual(self.read(['vllm/example.py']).returncode, 0)
        self.assertFalse(valid_source_files([]))
        self.assertFalse(valid_source_files(['vllm/example.py'] * 9))


if __name__ == '__main__':
    unittest.main()
