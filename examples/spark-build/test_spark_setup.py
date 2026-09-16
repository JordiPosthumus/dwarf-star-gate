import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('spark_setup', Path(__file__).with_name('setup-spark.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SparkSetupTests(unittest.TestCase):
    def test_active_gpu_work_is_rejected_without_mutation(self):
        with patch.object(setup.platform, 'system', return_value='Linux'), patch.object(setup.platform, 'machine', return_value='aarch64'), patch.object(setup.sys, 'version_info', (3, 12)), patch.object(setup.subprocess, 'check_output', side_effect=['arm64\n', 'NVIDIA GB10\n', '123\n']) as commands:
            with self.assertRaisesRegex(ValueError, 'GPU work is active'):
                setup.preflight()
            self.assertEqual(len(commands.call_args_list), 3)
            self.assertTrue(all(c.args[0][0] in ('docker', 'nvidia-smi') for c in commands.call_args_list))

    def test_unrelated_directory_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            personal = Path(tmp) / 'personal.txt'
            personal.write_text('Keep this')
            with self.assertRaisesRegex(ValueError, 'empty setup directory'):
                setup.Setup(tmp)
            self.assertEqual(personal.read_text(), 'Keep this')
            self.assertFalse((Path(tmp) / 'setup.json').exists())

    def test_resume_after_download_failure_keeps_built_image_and_partial(self):
        commands, containers = [], {}
        fail_once = True

        def run(command, **kwargs):
            nonlocal fail_once
            commands.append(command)
            if command[:2] == ['docker', 'build']:
                target = Path(command[command.index('--iidfile') + 1])
                target.write_text('sha256:' + target.parent.name)
            elif any(Path(arg).name in ('prepare.py', 'prepare-media.py') for arg in command):
                folder = Path(command[-1]); folder.mkdir()
                (folder / 'build-receipt.json').write_text('{}')
            elif Path(command[1]).name == 'download-models.py':
                models = Path(command[-1]); models.mkdir(exist_ok=True)
                partial = models / 'weights.stargate-download'
                if fail_once:
                    fail_once = False
                    partial.write_bytes(b'resumable')
                    raise subprocess.CalledProcessError(1, command)
                if command[2] == 'qwen38-repaired':
                    self.assertEqual(partial.read_bytes(), b'resumable')
            elif Path(command[1]).name in ('create-llm.py', 'create-media.py'):
                data = Path(command[command.index('--data') + 1]); data.mkdir()
                image = command[command.index('--image') + 1]
                cid = command[command.index('--name') + 1]
                containers[cid] = {'Id': cid, 'Image': image, 'State': {'Running': False}}
                (data / 'container.json').write_text(json.dumps({'container': cid, 'image': image}))
            else:
                self.fail(f'Unexpected mutating command: {command}')

        def inspect(command, **kwargs):
            if command[:3] == ['docker', 'image', 'inspect']:
                return json.dumps([{'Id': command[-1]}])
            self.assertEqual(command[:2], ['docker', 'inspect'])
            return json.dumps([containers[command[-1]]])

        with tempfile.TemporaryDirectory() as tmp, patch.object(setup, 'preflight'), patch.object(setup.subprocess, 'run', side_effect=run), patch.object(setup.subprocess, 'check_output', side_effect=inspect):
            with self.assertRaises(subprocess.CalledProcessError):
                setup.Setup(tmp).prepare()
            failed = json.loads((Path(tmp) / 'setup.json').read_text())
            self.assertEqual(failed['state'], 'failed')
            self.assertEqual(failed['phase'], 'verify_or_download_models')
            result = setup.Setup(tmp).prepare()
            self.assertEqual(result['state'], 'prepared_stopped')
            self.assertEqual(len(containers), 3)
            self.assertEqual(len([c for c in commands if c[:2] == ['docker', 'build']]), 3)
            self.assertFalse(any(c[:2] in (['docker', 'start'], ['docker', 'stop'], ['docker', 'rm']) for c in commands))


if __name__ == '__main__':
    unittest.main()
