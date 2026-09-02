// Inspects the exact index contents AND working copies. Never prints matched secrets.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git',args,{encoding:'utf8'});
const files = git('ls-files','-z').split('\0').filter(Boolean);
const failures = [];
const forbidden = /(?:^|\/)(?:runtime|sessions|snapshots|backups|training|artifacts|\.venv|__pycache__|\.pi|pi-setup|node_modules)(?:\/|$)|(?:^|\/)(?:auth|models-store|config\.local|config\.production|config\.candidate|worker-profiles\.local)\.json$|\.(?:kv|gguf|ubj|pyc|key|pem|log|jsonl|plist)$|\.bak/;
const patterns = [
  ['personal home path', /\/(?:Users|home)\/[a-zA-Z][\w.-]*\//],
  ['private network address', /\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/],
  ['personal email', /[\w.+-]+@(?:gmail|icloud|hotmail|outlook|yahoo)\.com\b/i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential-shaped token', /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|sk-[A-Za-z0-9_-]{25,})\b/],
];
for (const file of files) {
  if (forbidden.test(file)) failures.push(`${file}: excluded runtime/private file`);
  const indexed = git('show',`:${file}`);
  const texts = [indexed];
  if (fs.existsSync(file)) { if (fs.lstatSync(file).isSymbolicLink()) { failures.push(`${file}: symlink not permitted`); continue; } texts.push(fs.readFileSync(file,'utf8')); }
  for (const [label,pattern] of patterns) if (texts.some(text=>pattern.test(text))) failures.push(`${file}: ${label}`);
}
if (!files.length) throw new Error('No indexed files; stage the intended publication first');
if (failures.length) { console.error(failures.join('\n')); process.exitCode=1; }
else console.log(`Privacy guard passed for ${files.length} indexed files and their working copies. Manual review is still required.`);
