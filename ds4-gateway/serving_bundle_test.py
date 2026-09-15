import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

from serving_bundle import MODULES, build_executor


FIXTURE = '''
import hashlib
from docker_profile_remote import SSHDocker
from serving_operation import ServingOperation
from serving_records import ServingRecordPublisher
def execute(plan, folder, progress):
    transport = SSHDocker('fixture.invalid', source=_BUNDLED_SOURCES['docker_profile'])
    with (folder / 'effect.txt').open('x') as stream: stream.write('one fixture effect')
    progress('fixture_complete', 'Checked frozen imports without contacting a server.')
    return {'state':'completed', 'transport_sha256':hashlib.sha256(transport.source.encode()).hexdigest(),
            'components':[ServingOperation.__name__, ServingRecordPublisher.__name__],
            'scope':'Frozen-code fixture only, not a serving operation'}
'''


class BundleTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.folder = self.root / str(uuid.uuid4()); self.folder.mkdir()
        self.sources = self.root / 'installed'; self.sources.mkdir()
        for name in MODULES:
            shutil.copyfile(Path(__file__).with_name(name + '.py'), self.sources / (name + '.py'))
        (self.sources / 'serving_executor.py').write_text(FIXTURE)
        self.execution = build_executor(self.folder, source_directory=self.sources)
        self.record = self.root / 'record.json'; self.record.write_text('{"worker_id":"fixture"}')
        revision = hashlib.sha256(self.record.read_bytes()).hexdigest()
        self.plan = {'worker_id':'fixture', 'record_file':str(self.record), 'record_revision':revision, 'execution':self.execution}
        raw = json.dumps(self.plan).encode(); (self.folder / 'plan.json').write_bytes(raw)
        binding = {'plan_revision':hashlib.sha256(raw).hexdigest(), 'record_revision':revision}
        for name in ('prepared.json','approved.json','launch-intent.json'):
            (self.folder / name).write_text(json.dumps({**binding, 'actor':'owner'}))
        (self.folder / 'proposal.json').write_text(json.dumps({'id':self.folder.name,'worker_id':'fixture'}))

    def run_runner(self):
        return subprocess.run([sys.executable, '-I', str(Path(__file__).with_name('operation_runner.py')), 'run', str(self.folder)],
            capture_output=True, text=True, timeout=15)

    def test_installed_source_changes_cannot_change_approved_dependencies_or_ssh_source(self):
        expected = hashlib.sha256((self.sources / 'docker_profile.py').read_bytes()).hexdigest()
        for source in self.sources.glob('*.py'):
            source.write_text('raise RuntimeError("A changed checkout must never execute")\n')
        completed = self.run_runner(); self.assertEqual(completed.returncode,0,completed.stdout + completed.stderr)
        result = json.loads((self.folder / 'runner-result.json').read_text())
        self.assertEqual(result['state'],'completed'); self.assertEqual(result['transport_sha256'],expected)
        self.assertEqual(result['components'],['ServingOperation','ServingRecordPublisher'])
        self.assertEqual((self.folder / 'effect.txt').read_text(),'one fixture effect')
        self.assertEqual(self.run_runner().returncode,0)
        self.assertEqual(json.loads((self.folder / 'runner-result.json').read_text()),result)

    def test_changed_frozen_executor_is_rejected_before_any_effect(self):
        with Path(self.execution['path']).open('a') as stream: stream.write('\n# changed after approval\n')
        result = self.run_runner(); self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.folder / 'effect.txt').exists()); self.assertFalse((self.folder / 'runner-started.json').exists())

    def test_existing_executor_is_not_overwritten_by_preparation_retry(self):
        before = Path(self.execution['path']).read_bytes()
        with self.assertRaises(FileExistsError): build_executor(self.folder,source_directory=self.sources)
        self.assertEqual(Path(self.execution['path']).read_bytes(),before)
        manifest = json.loads((self.folder / 'executor-sources.json').read_text())
        self.assertEqual(set(manifest['modules']),set(MODULES))


if __name__ == '__main__': unittest.main()
