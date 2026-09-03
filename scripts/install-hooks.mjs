import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...args) => execFileSync('git', ['-C',root,...args], {encoding:'utf8'}).trim();
  let existing;
  try {existing = git('config','--get','core.hooksPath');}
  catch (error) {if (error.status !== 1) throw error;}
  if (existing && existing !== '.githooks') throw new Error('An existing hooksPath is configured; integrate the privacy hook manually. Nothing changed.');
  if (!existing) {
    const hooks = path.resolve(root, git('rev-parse','--git-path','hooks'));
    const custom = fs.existsSync(hooks) ? fs.readdirSync(hooks).filter(name=>!name.endsWith('.sample') && !name.startsWith('.')) : [];
    if (custom.length) throw new Error('Existing hook files found; integrate the privacy hook manually. Nothing changed.');
  }
  fs.chmodSync(path.join(root,'.githooks','pre-commit'),0o755);
  git('config','--local','core.hooksPath','.githooks');
  console.log('Installed this checkout\'s staged-content privacy hook. New clones must opt in with npm run hooks:install.');
} catch (error) {console.error(error.message); process.exitCode=1;}
