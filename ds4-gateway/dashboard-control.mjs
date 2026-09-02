import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const here = path.dirname(fileURLToPath(import.meta.url));
const label = 'local.dwarf-star-gate.dashboard';
const domain = `gui/${process.getuid()}`, target = `${domain}/${label}`;
const url = 'http://127.0.0.1:30010';
const configPath = path.resolve(process.env.DWARF_GATE_CONFIG || (fs.existsSync(path.join(here, '..', 'config.local.json')) ? path.join(here, '..', 'config.local.json') : path.join(here, 'config.production.json')));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const runtime = path.join(path.dirname(path.resolve(config.state_file)), 'dashboard');
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const command = process.argv[2] || 'start';
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const launch = (...args) => execFileSync('/bin/launchctl', args, { encoding: 'utf8' });
const loaded = () => { try { execFileSync('/bin/launchctl', ['print', target], { stdio: 'ignore' }); return true; } catch { return false; } };
async function status() {
  const r = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`UI HTTP ${r.status}`);
  const s = await r.json(); if (s.version !== 1 || s.read_only !== true) throw new Error('Unexpected service on dashboard port');
  return s;
}
async function start() {
  if (!loaded()) {
    // Never replace an unrelated process already listening on this port.
    try { await status(); console.log(`${url} (already running outside launchd)`); return; } catch { /* launchd will report bind conflicts */ }
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    if (fs.existsSync(plist)) fs.copyFileSync(plist, `${plist}.bak-${Date.now()}`, fs.constants.COPYFILE_EXCL);
    const args = [process.execPath, path.join(here, 'dashboard.mjs'), configPath];
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(s => `<string>${xml(s)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(path.dirname(here))}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>${xml(path.join(runtime, 'ui.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(runtime, 'ui.error.log'))}</string></dict></plist>\n`, { mode: 0o600 });
    launch('bootstrap', domain, plist);
  }
  for (let i = 0; i < 20; i++) { try { await status(); console.log(url); return; } catch { await delay(500); } }
  throw new Error('Dashboard not ready; inspect ds4-gateway/runtime/dashboard/ui.error.log. Inference was not changed.');
}
try {
  if (command === 'start' || command === 'open') { await start(); if (command === 'open') execFileSync('/usr/bin/open', [url]); }
  else if (command === 'stop') {
    if (loaded()) launch('bootout', target);
    console.log('Dashboard unloaded. Gateway and model servers untouched. The start script can enable it again.');
  } else if (command === 'status') console.log(JSON.stringify(await status(), null, 2));
  else if (command === 'snapshot') {
    const snapshot = await status(); fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const destination = path.join(runtime, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(destination, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(destination);
  } else throw new Error('Usage: dashboard-control.mjs start|open|stop|status|snapshot');
} catch (e) { console.error(e.message); process.exitCode = 1; }
