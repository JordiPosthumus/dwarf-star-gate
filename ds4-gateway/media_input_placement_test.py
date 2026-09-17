import tempfile
import unittest
from pathlib import Path
from media_input_placement import collect


class InputPlacementTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.container = {'Id': 'a'*64, 'Image': 'sha256:'+'b'*64,
                          'Config': {'WorkingDir': '/opt/ComfyUI', 'Entrypoint': ['/usr/local/bin/h3-entrypoint']},
                          'Mounts': [{'Type': 'bind', 'Source': str(self.root), 'Destination': '/opt/ComfyUI/input'}]}

    def inspect(self, name):
        return collect({'container': 'a'*64, 'image': 'sha256:'+'b'*64, 'files': [{'name': name}]}, lambda _: self.container)['files'][0]

    def test_presence_changes_with_worker_files_not_filename_alone(self):
        self.assertEqual(self.inspect('portrait.png')['state'], 'missing')
        (self.root/'portrait.png').write_bytes(b'image')
        row = self.inspect('portrait.png')
        self.assertEqual(row['state'], 'present')
        self.assertEqual(row['bytes'], 5)
        (self.root/'folder').mkdir()
        self.assertEqual(self.inspect('folder')['state'], 'not_a_file')

    def test_custom_roots_and_comfy_suffix(self):
        self.container['Config']['Env'] = ['COMFYUI_EXTRA_ARGS=--input-directory /data/images']
        self.container['Mounts'][0]['Destination'] = '/data/images'
        (self.root/'portrait.png').touch()
        self.assertEqual(self.inspect('portrait.png [input]')['state'], 'present')

    def test_unsupported_paths_and_launchers_stay_unknown(self):
        for name in ['../secret', '/absolute', '', 'null\x00byte']:
            self.assertEqual(self.inspect(name)['state'], 'unknown')
        (self.root/'link').symlink_to('/does-not-exist')
        self.assertEqual(self.inspect('link')['state'], 'unknown')
        self.container['Mounts'] = []
        self.assertEqual(self.inspect('portrait.png')['state'], 'unknown')
        self.container['Config']['Entrypoint'] = ['custom-launcher']
        self.assertEqual(self.inspect('portrait.png')['state'], 'unknown')

    def test_identity_mismatch_is_not_missing(self):
        self.container['Image'] = 'another-image'
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            self.inspect('portrait.png')

    def test_nested_volume_does_not_probe_hidden_parent_bind(self):
        self.container['Mounts'].append({'Type': 'volume', 'Destination': '/opt/ComfyUI/input/nested'})
        self.assertEqual(self.inspect('nested/portrait.png')['state'], 'unknown')


if __name__ == '__main__': unittest.main()
