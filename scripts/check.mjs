import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes:true })) {
    if (e.name === 'runtime') continue;
    const f = path.join(dir,e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.m?js$/.test(f)) execFileSync(process.execPath,['--check',f],{stdio:'inherit'});
  }
}
walk('ds4-gateway'); walk('scripts'); walk('examples');
for (const f of fs.readdirSync('.').filter(f=>f.endsWith('.sh'))) execFileSync('/bin/bash',['-n',f],{stdio:'inherit'});
console.log('JavaScript and shell syntax checks passed.');
