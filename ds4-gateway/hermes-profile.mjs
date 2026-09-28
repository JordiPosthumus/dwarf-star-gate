import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

// The native Hermes launcher must use this directory as HERMES_HOME.
// OS HOME, tools, and filesystem access are not changed by a profile directory.
export function hermesHome(config) {
  return path.join(path.dirname(config.state_file), 'hermes-home');
}

export function createSoulStore(home, seedFile = new URL('../hermes/SOUL.md', import.meta.url)) {
  const file = path.join(home, 'SOUL.md');
  const backups = path.join(home, 'soul-history');
  fs.mkdirSync(home, {recursive:true, mode:0o700});
  try { fs.writeFileSync(file, fs.readFileSync(seedFile), {flag:'wx', mode:0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const revision = text => createHash('sha256').update(text).digest('hex');
  const read = () => {
    const content = fs.readFileSync(file, 'utf8');
    return {content, revision:revision(content), path:file, backups};
  };
  return {read, save(input) {
    if (!input || typeof input.content !== 'string' || typeof input.revision !== 'string')
      throw Object.assign(new Error('Content and its loaded revision are required.'), {status:400});
    const current = read();
    if (input.revision !== current.revision)
      throw Object.assign(new Error('SOUL changed on disk. Your draft is still here. Copy it before loading the saved version to compare.'), {status:409});
    if (input.content === current.content) return current;
    fs.mkdirSync(backups, {recursive:true, mode:0o700});
    const stamp = new Date().toISOString().replaceAll(':','-') + '-' + randomUUID();
    fs.writeFileSync(path.join(backups, stamp + '.md'), current.content, {flag:'wx', mode:0o600});
    const temporary = path.join(home, '.SOUL-' + stamp + '.tmp');
    try {
      fs.writeFileSync(temporary, input.content, {flag:'wx', mode:0o600});
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, {force:true}); }
    return read();
  }};
}
