// Inspect index blobs, never a cleaned working copy in place of staged content.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { findings } from './privacy-policy.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== '--staged')) throw new Error('Usage: privacy-check.mjs [--staged]');
  const stagedOnly = args[0] === '--staged';
  const git = (...values) => execFileSync('git', values, {maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});
  const entries = git('ls-files', '--stage', '-z').toString('utf8').split('\0').filter(Boolean);
  const failures = new Set();
  const report = (file, label) => failures.add(`${JSON.stringify(file)}: ${label}`);
  for (const entry of entries) {
    const match = /^(\d+) ([a-f0-9]+) (\d+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Unrecognized Git index entry');
    const [, mode, object, stage, file] = match;
    if (stage !== '0') {report(file, 'unresolved index conflict'); continue;}
    if (!['100644','100755'].includes(mode)) {report(file, 'symlink/submodule or unsupported file mode'); continue;}
    const staged = git('cat-file', 'blob', object);
    for (const label of findings(file, staged)) report(file, label);
    if (!stagedOnly) {
      let stat;
      try {stat = fs.lstatSync(file);} catch (error) {if (error.code !== 'ENOENT') throw error;}
      if (stat && !stat.isFile()) report(file, 'working copy is not a regular file');
      else if (stat) for (const label of findings(file, fs.readFileSync(file))) report(file, label);
    }
  }
  if (!entries.length) throw new Error('No indexed files; stage the intended publication first');
  if (failures.size) {
    console.error([...failures].join('\n'));
    console.error('Keep deployment records private. Review docs/publication-policy.md; no matched values are printed.');
    process.exitCode = 1;
  } else console.log(`Privacy guard passed for ${entries.length} indexed files${stagedOnly?'':' and their working copies'}. Manual prose/image review is still required.`);
} catch {
  // Git errors can echo unexpected input. Fail closed without dumping file content.
  console.error('Privacy guard could not complete; check index state, file access, size limits and arguments.');
  process.exitCode = 1;
}
