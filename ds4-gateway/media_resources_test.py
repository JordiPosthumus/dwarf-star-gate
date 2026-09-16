import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from collections import namedtuple

spec = importlib.util.spec_from_file_location('resources', Path(__file__).with_name('media_resources.py'))
resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)


class Resources(unittest.TestCase):
    def test_host_facts_no_model_execution_and_no_private_paths(self):
        commands = []
        def command(*args):
            commands.append(args)
            if args[0] == 'nvidia-smi':
                return 'NVIDIA GB10'
            if args[:2] == ('docker', 'info'):
                return '{"Architecture":"aarch64","DockerRootDir":"/private/docker"}'
            if args[:2] == ('docker', 'inspect'):
                return '[{"Mounts":[{"Type":"bind","Source":"/private/models","Destination":"/models"}]}]'
            self.fail('Unexpected command: ' + str(args))
        usage = namedtuple('usage', 'total used free')(1000, 400, 600)
        with patch.object(resources.platform, 'system', return_value='Linux'), patch.object(resources.platform, 'machine', return_value='aarch64'), patch.object(resources, 'command', side_effect=command), patch.object(resources.Path, 'read_text', return_value='MemTotal: 128000 kB\nMemAvailable: 4000 kB\n'), patch.object(resources.shutil, 'disk_usage', return_value=usage), patch.object(resources.os, 'stat', return_value=namedtuple('stat', 'st_dev')(42)):
            result = resources.collect({'container': 'a' * 64})
        self.assertEqual(result['memory_total_bytes'], 128000 * 1024)
        self.assertEqual(result['memory_available_bytes'], 4000 * 1024)
        self.assertEqual(len(result['disks']), 1)
        self.assertEqual(result['disks'][0]['locations'], ['home', 'docker', 'existing container mount: /models'])
        self.assertNotIn('/private/', str(result))
        self.assertEqual(len(commands), 3)
        self.assertTrue(all('exec' not in c and 'start' not in c and 'stop' not in c for c in commands))

    def test_missing_docker_or_gpu_is_visible(self):
        with patch.object(resources.platform, 'system', return_value='Linux'), patch.object(resources, 'command', side_effect=OSError('unavailable')):
            result = resources.collect({})
        self.assertIn('NVIDIA hardware unavailable', result['errors'])
        self.assertIn('Docker storage inspection unavailable', result['errors'])


if __name__ == '__main__':
    unittest.main()
