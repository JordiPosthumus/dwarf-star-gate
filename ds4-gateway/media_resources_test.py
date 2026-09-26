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
            if args[:2] == ('docker', 'ps'):
                return ''
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
        self.assertEqual(len(commands), 4)
        self.assertTrue(all('exec' not in c and 'start' not in c and 'stop' not in c for c in commands))

    def test_inventory_filters_private_config_and_bounds_observation(self):
        import json
        ids = [format(i, '064x') for i in range(130)]
        calls = []
        def command(*args):
            calls.append(args)
            if args[1] == 'ps': return '\n'.join(ids)
            return json.dumps([{'Id': value, 'Image': 'sha256:' + 'a'*64,
                'State': {'Running': False}, 'Config': {'Env': ['SECRET=private']},
                'HostConfig': {'PortBindings': {'8002/tcp': [{'HostIp':'127.0.0.1','HostPort':'8002'}]}}}
                for value in args[5:]])
        with patch.object(resources, 'command', side_effect=command):
            result = resources.native_port_inventory()
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['containers']), 128)
        self.assertNotIn('SECRET', str(result))
        self.assertTrue(all(c[1] in ('ps', 'inspect') for c in calls))

    def test_missing_docker_or_gpu_is_visible(self):
        with patch.object(resources.platform, 'system', return_value='Linux'), patch.object(resources, 'command', side_effect=OSError('unavailable')):
            result = resources.collect({})
        self.assertIn('NVIDIA hardware unavailable', result['errors'])
        self.assertIn('Docker storage inspection unavailable', result['errors'])

    def test_recipe_checks_bind_candidates_and_keep_missing_proof_separate(self):
        import json
        ids = [format(i, '064x') for i in range(6)]
        image = 'sha256:' + 'b' * 64
        def command(*args):
            if args[1] == 'ps': return '\n'.join(ids)
            return json.dumps([{'Id': cid, 'Image': image, 'State': {'Running': False},
                'HostConfig': {'PortBindings': {'8002/tcp': [{'HostPort': '8002'}]}}} for cid in ids])
        calls = []
        def probe(cid, selected_image):
            calls.append((cid, selected_image))
            if cid == ids[0]:
                return {'state': 'verified', 'container': cid, 'image': selected_image,
                        'container_state_unchanged': True, 'supported': {'sampler_mode': ['heun']}}
            if cid == ids[1]: raise OSError('private Docker error and secret path')
            if cid == ids[2]: return {'state': 'verified', 'container': ids[0], 'image': image, 'container_state_unchanged': True}
            return {'state': 'verified', 'container': cid, 'image': image, 'container_state_unchanged': False}
        with patch.object(resources, 'command', side_effect=command):
            result = resources.native_port_inventory(probe)
        self.assertEqual(calls, [(cid, image) for cid in ids[:4]])
        self.assertEqual([r['recipe_contract']['state'] for r in result['containers']],
                         ['verified', 'unverified', 'unverified', 'unverified', 'not_checked', 'not_checked'])
        self.assertEqual(result['state'], 'observed')
        self.assertNotIn('secret', str(result))
        self.assertTrue(all(r['running'] is False for r in result['containers']))

    def test_video_port_does_not_trigger_ace_source_reads(self):
        import json
        cid = 'a' * 64
        def command(*args):
            if args[1] == 'ps': return cid
            return json.dumps([{'Id': cid, 'Image': 'sha256:' + 'b'*64,
                'State': {'Running': False}, 'HostConfig': {'PortBindings': {'8188/tcp': [{'HostPort': '8188'}]}}}])
        with patch.object(resources, 'command', side_effect=command):
            result = resources.native_port_inventory(lambda *_: self.fail('Video is not an ACE candidate'))
        self.assertNotIn('recipe_contract', result['containers'][0])


if __name__ == '__main__':
    unittest.main()
