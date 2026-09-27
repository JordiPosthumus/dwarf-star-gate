import fs from 'node:fs/promises';
import path from 'node:path';

// A view of native files, not a second memory store or an agent task.
export function createMemoryView(home) {
  async function document(relative, label, kind) {
    const file = path.join(home, relative);
    try {
      const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
      return {id:relative, label, kind, path:file, present:true, updated_at:stat.mtime.toISOString(), content};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {id:relative, label, kind, path:file, present:false, updated_at:null, content:''};
    }
  }
  return {async read() {
    const documents = await Promise.all([
      document('memories/MEMORY.md', 'Memory', 'memory'),
      document('memories/USER.md', 'About you', 'memory'),
    ]);
    const visited = new Set();
    async function walk(relative) {
      const directory = path.join(home, relative);
      let real;
      try { real = await fs.realpath(directory); } catch (error) { if(error.code === 'ENOENT') return; throw error; }
      if(visited.has(real)) return; visited.add(real);
      const entries = await fs.readdir(directory, {withFileTypes:true});
      for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
        const child = path.join(relative, entry.name);
        if(entry.isDirectory()) await walk(child);
        else if(entry.isFile() && /\.md$/i.test(entry.name)) {
          const skill = entry.name === 'SKILL.md';
          documents.push(await document(child, skill ? path.basename(relative) : child.slice(7), skill ? 'skill' : 'note'));
        }
      }
    }
    await walk('skills');
    return {observed_at:new Date().toISOString(), documents};
  }};
}
