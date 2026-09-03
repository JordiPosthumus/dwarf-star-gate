import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes:true })) {
    if (['runtime', '.venv', '__pycache__', 'node_modules'].includes(e.name)) continue;
    const f = path.join(dir,e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.m?js$/.test(f)) execFileSync(process.execPath,['--check',f],{stdio:'inherit'});
  }
}
walk('ds4-gateway'); walk('scripts'); walk('examples'); walk('predictor');
for (const f of fs.readdirSync('.').filter(f=>f.endsWith('.sh'))) execFileSync('/bin/bash',['-n',f],{stdio:'inherit'});
execFileSync('/bin/sh',['-n','.githooks/pre-commit'],{stdio:'inherit'});
console.log('JavaScript and shell syntax checks passed.');
