#!/usr/bin/env python3
"""Opt-in native HTTP contract check; copies Python source, never a real bank.

Usage: python3 scripts/hourglass-native-integration.py --source /path/to/Hourglass
Requires a trusted Hourglass checkout and Node 22+. No benchmark worker is started.
"""
import argparse
import hashlib
import importlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--node', default='node')
    parser.add_argument('--model-file', type=Path,
        help='Optional private JSON model entry to freeze in the synthetic run; no model work starts')
    args = parser.parse_args()
    adapter = (Path(__file__).resolve().parents[1] / 'ds4-gateway/hourglass-console.mjs').as_uri()
    with tempfile.TemporaryDirectory(prefix='sg-hourglass-contract-') as temporary:
        root = Path(temporary).resolve()
        hashes = {}
        # Module-relative paths now point at this disposable tree. Never import
        # from the live checkout, copy private data, or call its launch script.
        paths = sorted(args.source.glob('*.py'))
        paths += [args.source / name for name in
            ['harness/pi.mjs', 'harness/inference-settings.mjs', 'harness/pi-lock.json']
            if (args.source / name).exists()]
        for path in paths:
            if path.is_symlink() or not path.is_file():
                raise ValueError('Expected regular native source files')
            data = path.read_bytes()
            name = str(path.relative_to(args.source))
            destination = root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            hashes[name] = hashlib.sha256(data).hexdigest()
        if 'web.py' not in hashes:
            raise ValueError('Source must contain the native web.py console')
        sys.path.insert(0, str(root))
        sys.dont_write_bytecode = True
        web = importlib.import_module('web')
        assert web.ROOT == root and web.worker_thread is None
        task = root / 'tasks/example/task.json'
        task.parent.mkdir(parents=True)
        task.write_text(json.dumps({'id': 'example', 'kind': 'mcq', 'mode': 'option_id',
            'prompt': 'Synthetic contract question.',
            'options': [{'id': '001', 'text': 'A'}, {'id': '002', 'text': 'B'}], 'answer': '001'}))
        model = {'name': 'example', 'model': 'example-native-id',
            'base_url': 'http://example.invalid/v1', 'max_tokens': 262144,
            'context_window': 262144, 'reasoning': 'xhigh'}
        if args.model_file:
            model = json.loads(args.model_file.read_text())
            if not isinstance(model, dict) or not isinstance(model.get('name'), str):
                raise ValueError('Expected one native model object')
        model_name = json.dumps(model['name'])
        models = root / 'models.json'
        models.write_text(json.dumps({'models': [model]}))
        server = web.ThreadingHTTPServer(('127.0.0.1', 0), web.H)
        web.PORT = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = 'http://127.0.0.1:' + str(web.PORT)

        def node(code):
            prefix = ('import assert from "node:assert/strict"; import {HourglassConsole} from '
                + json.dumps(adapter) + '; const c=new HourglassConsole(' + json.dumps(origin) + '); ')
            return json.loads(subprocess.check_output([args.node, '--input-type=module', '-e', prefix + code],
                text=True, timeout=60))

        try:
            result = node('const p=await c.prepare(' + model_name + '); '
                'assert.equal(p.window_seconds,3600); '
                'const r=await c.submit(p.id,{ownerConfirmedIdle:true}); '
                'const o=await c.observe(r.job_id,' + model_name + '); assert.equal(o.state,"pending"); '
                'console.log(JSON.stringify({review:p,receipt:r,observation:o}));')
            assert web.worker_thread is None and len(web.queue) == 1 and not web.running
            job = web.queue.popleft()
            assert job['id'] == result['receipt']['job_id']
            manifest = json.loads((root / 'evaluations' / (job['id'] + '.json')).read_text())
            assert manifest['model_config_snapshot'] == model
            assert job['tasks'] == ['example'] and job['repeat'] == 1
            # Synthetic terminal state only. This does not measure a model or
            # claim an hour elapsed. Native aggregation and HTTP remain real.
            ended = time.time()
            job.update(state='completed', started=ended - 3600, ended=ended,
                active_intervals=[{'start': ended - 3600, 'end': ended}])
            web.done.append(job)
            report = node('const id=' + json.dumps(job['id']) + '; '
                'assert.equal((await c.observe(id,' + model_name + ')).state,"completed"); '
                'console.log(JSON.stringify(await c.report(id)));')
            summary = report['summary']
            assert summary['benchmark_version'] == result['review']['benchmark_version']
            assert summary['score']['version'] == result['review']['metric']
            assert summary['score']['value'] == 0 and summary['state'] == 'final'
            assert summary['active_seconds'] == 3600
            assert web.worker_thread is None and not web.queue and not web.running
            stale_reviews = []
            for change, path, content in [
                ('model', models, models.read_text() + '\n'),
                ('bank', task, task.read_text() + '\n'),
                ('hardware', root / 'hardware-profiles.json',
                    json.dumps({model['base_url']: {'label': 'Changed fixture hardware'}})),
            ]:
                before = path.read_bytes() if path.exists() else None
                try:
                    rejection = node('import fs from "node:fs"; '
                        'const p=await c.prepare(' + model_name + '); fs.writeFileSync('
                        + json.dumps(str(path)) + ',' + json.dumps(content) + '); '
                        'await assert.rejects(c.submit(p.id,{ownerConfirmedIdle:true}),'
                        'e=>e.status===400 && e.uncertain===false); '
                        'console.log(JSON.stringify({rejected:true}));')
                    assert rejection['rejected'] and not web.queue and not web.running
                    assert len(list((root / 'evaluations').glob('*.json'))) == 1
                    stale_reviews.append(change)
                finally:
                    if before is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.write_bytes(before)
            # Detect source edits during the copy/test; hashes identify the
            # actual snapshot, not an assumed Git revision of a dirty checkout.
            assert all(hashlib.sha256((args.source / name).read_bytes()).hexdigest() == digest
                for name, digest in hashes.items()), 'Native source changed during verification'
            print(json.dumps({'native_source_sha256': hashes,
                'benchmark_version': result['review']['benchmark_version'],
                'metric': result['review']['metric'], 'native_http': True,
                'frozen_model_preserved': True, 'pending_and_terminal_observed': True,
                'stale_reviews_rejected': stale_reviews,
                'collected_summary': summary, 'worker_started': False,
                'synthetic_completion': True}, indent=2))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
            assert not thread.is_alive()


if __name__ == '__main__':
    main()
