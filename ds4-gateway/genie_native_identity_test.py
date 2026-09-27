from pathlib import Path
import tempfile
import unittest

from genie_native_identity import prepare_native_identity, validate_native_identity


class NativeIdentity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.originals = {'SOUL.md': b'Owner-customized Genie identity.\n',
                          'AGENTS.md': b'Preserve my established settings.\n'}
        for name, data in self.originals.items():
            (self.source / name).write_bytes(data)
        self.home = self.root / 'native'

    def test_stage_preserves_owner_identity_and_reuse_is_read_only(self):
        receipt = prepare_native_identity(self.source, self.home)
        before = {file.name: (file.read_bytes(), file.stat().st_mtime_ns) for file in self.home.iterdir()}
        self.assertEqual(prepare_native_identity(self.source, self.home), receipt)
        self.assertEqual(before, {file.name: (file.read_bytes(), file.stat().st_mtime_ns) for file in self.home.iterdir()})
        self.assertEqual((self.home / 'SOUL.md').read_bytes(), self.originals['SOUL.md'])
        self.assertTrue((self.home / 'AGENTS.md').read_bytes().startswith(self.originals['AGENTS.md']))
        for name, data in self.originals.items():
            self.assertEqual((self.source / name).read_bytes(), data)
        self.assertEqual(self.home.stat().st_mode & 0o777, 0o700)
        for file in self.home.iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_changed_source_or_native_files_never_get_overwritten(self):
        prepare_native_identity(self.source, self.home)
        (self.home / 'SOUL.md').write_text('Native custom edit')
        with self.assertRaisesRegex(ValueError, 'nothing replaced'):
            prepare_native_identity(self.source, self.home)
        self.assertEqual((self.home / 'SOUL.md').read_text(), 'Native custom edit')
        (self.home / 'SOUL.md').write_bytes(self.originals['SOUL.md'])
        (self.source / 'AGENTS.md').write_text('Owner changed their instructions')
        with self.assertRaisesRegex(ValueError, 'nothing replaced'):
            prepare_native_identity(self.source, self.home)

    def test_native_launch_requires_complete_private_unmodified_guidance(self):
        receipt = prepare_native_identity(self.source, self.home)
        required = receipt['required_context_file_max_chars']
        self.assertGreater(required, 20000)
        for limit in (None, 20000, required - 1, True):
            with self.assertRaisesRegex(ValueError, 'context_file_max_chars'):
                validate_native_identity(self.home, {'context_file_max_chars': limit})
        self.assertEqual(validate_native_identity(self.home, {'context_file_max_chars': required}), receipt)
        (self.home / 'AGENTS.md').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'not private'):
            validate_native_identity(self.home, {'context_file_max_chars': required})

    def test_occupied_destination_or_source_alias_cannot_replace_identity(self):
        with self.assertRaises(ValueError):
            prepare_native_identity(self.source, self.source)
        self.home.mkdir(mode=0o700)
        (self.home / 'config.yaml').write_text('Existing profile')
        with self.assertRaisesRegex(ValueError, 'occupied'):
            prepare_native_identity(self.source, self.home)
        self.assertEqual((self.home / 'config.yaml').read_text(), 'Existing profile')
        (self.source / 'SOUL.md').unlink()
        (self.source / 'SOUL.md').symlink_to(self.source / 'AGENTS.md')
        with self.assertRaisesRegex(ValueError, 'regular files'):
            prepare_native_identity(self.source, self.root / 'other')


if __name__ == '__main__':
    unittest.main()
