// Generic operator client. Never starts/stops/restarts a model or gateway.
import fs from 'node:fs';
import path from 'node:path';
import { workerControl } from './worker-client.mjs';
const config = JSON.parse(fs.readFileSync(process.env.DWARF_GATE_CONFIG || 'config.local.json', 'utf8'));
const command = process.argv[2] || 'status';
try {
  if (command === 'status') {
    const r = await fetch(`http://127.0.0.1:${config.port}/gateway/status`, { headers:{ authorization:`Bearer ${config.api_key}` }, signal:AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Status HTTP ${r.status}`); console.log(JSON.stringify(await r.json(), null, 2));
  } else if (command === 'drain-worker' || command === 'resume-worker') {
    if (!config.control_socket) throw new Error('No operator control socket configured');
    const workers = process.argv.slice(3); if (!workers.length) throw new Error('Specify worker IDs');
    const body = await workerControl(path.resolve(config.control_socket),command === 'drain-worker' ? '/drain-workers' : '/resume-workers',{workers});
    console.log(JSON.stringify(body));
  } else throw new Error('Usage: control.mjs status|drain-worker ID...|resume-worker ID...');
} catch (e) { console.error(e.message); process.exitCode = 1; }
