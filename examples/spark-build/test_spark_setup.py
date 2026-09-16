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
        self.exercise_resume()

    def test_music_only_never_builds_or_downloads_llm_or_video(self):
        self.exercise_resume(['ace-step'])

    def test_both_media_engines_resume_without_preparing_llm(self):
        self.exercise_resume(['h3', 'ace-step'])

    def test_resume_cannot_silently_expand_or_replace_engine_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            setup.Setup(tmp, ['ace-step'])
            before = (Path(tmp) / 'setup.json').read_bytes()
            for selected in (None, ['h3'], ['h3', 'ace-step']):
                with self.assertRaisesRegex(ValueError, 'selection changed'):
                    setup.Setup(tmp, selected)
                self.assertEqual((Path(tmp) / 'setup.json').read_bytes(), before)

    def test_invalid_engine_selection_does_not_create_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'setup'
            for selected in ([], ['unknown'], ['ace-step', 'ace-step']):
                with self.assertRaisesRegex(ValueError, 'supported engine'):
                    setup.Setup(target, selected)
                self.assertFalse(target.exists())

    def test_legacy_all_engine_receipt_and_reordered_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            initial = setup.Setup(tmp)
            del initial.state['selected_engines'];initial.save()
            self.assertEqual(setup.Setup(tmp).engines, setup.ENGINES)
            with self.assertRaisesRegex(ValueError, 'selection changed'):
                setup.Setup(tmp, ['h3'])
        with tempfile.TemporaryDirectory() as tmp:
            setup.Setup(tmp, ['ace-step', 'h3'])
            self.assertEqual(setup.Setup(tmp, ['h3', 'ace-step']).engines, ('h3', 'ace-step'))

    def exercise_resume(self, engines=None):
        commands, containers = [], {}
        fail_once = True
        selected = tuple(engines or setup.ENGINES)

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
                if command[2] == selected[0]:
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
                setup.Setup(tmp, engines).prepare()
            failed = json.loads((Path(tmp) / 'setup.json').read_text())
            self.assertEqual(failed['state'], 'failed')
            self.assertEqual(failed['phase'], 'verify_or_download_models')
            result = setup.Setup(tmp, engines).prepare()
            self.assertEqual(result['state'], 'prepared_stopped')
            self.assertEqual(set(result['engines']), set(selected))
            self.assertEqual(len(containers), len(selected))
            self.assertEqual(len([c for c in commands if c[:2] == ['docker', 'build']]), len(selected))
            downloads = [c[2] for c in commands if len(c) > 2 and Path(c[1]).name == 'download-models.py']
            self.assertEqual(set(downloads), set(selected))
            for engine in set(setup.ENGINES) - set(selected):
                self.assertFalse((Path(tmp) / engine).exists())
            if 'qwen38-repaired' not in selected:
                self.assertFalse(any(Path(c[1]).name == 'create-llm.py' for c in commands))
            self.assertFalse(any(c[:2] in (['docker', 'start'], ['docker', 'stop'], ['docker', 'rm']) for c in commands))


if __name__ == '__main__':
    unittest.main()
