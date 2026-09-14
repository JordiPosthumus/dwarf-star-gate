import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HERMES_REVISION} from '../scripts/genie-runtime.mjs';
const defaults=fileURLToPath(new URL('../genie/',import.meta.url));
const hash=file=>{try{return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch{return null;}};
const revision=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)?value:null;
export function identityStatus(home,bundled=defaults){
  return ['SOUL.md','AGENTS.md'].map(name=>{const installed_sha256=hash(path.join(home,name)),bundled_sha256=hash(path.join(bundled,name));return {name,installed_sha256,bundled_sha256,state:!installed_sha256?'missing':installed_sha256===bundled_sha256?'matches_bundle':'differs_preserved'};});
}
// A dated source inspection is evidence of that inspection, not continuous attestation.
// In particular, never accept the enclosing Star Gate repository as Hermes provenance.
export function runtimeProvenance(source){
  const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(source,name),'utf8'));}catch{return null;}};
  let marker=null;try{marker=revision(fs.readFileSync(path.join(source,'STARGATE_SOURCE_REVISION'),'utf8').trim());}catch{}
  let own_git=false,git_revision=null,tracked_changes=null;
  if(fs.existsSync(path.join(source,'.git')))try{
    const git=(...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim();
    own_git=fs.realpathSync(git('rev-parse','--show-toplevel'))===fs.realpathSync(source);
    if(own_git){git_revision=revision(git('rev-parse','HEAD'));tracked_changes=git('status','--porcelain','--untracked-files=no')!=='';}
  }catch{}
  const receipt=read('star-gate-install.json'),check=read('STARGATE_SOURCE_VERIFICATION.json');
  const last_source_check=check&&revision(check.expected_revision)&&Number.isFinite(Date.parse(check.checked_at))?{
    revision:check.expected_revision,checked_at:check.checked_at,tracked_files:Number.isSafeInteger(check.tracked_files)?check.tracked_files:null,
    changed_files:Array.isArray(check.changed)?check.changed.length:null,line_ending_only_files:Array.isArray(check.line_ending_only)?check.line_ending_only.length:null,
    missing_files:Array.isArray(check.missing)?check.missing.length:null,extra_code_files:Array.isArray(check.extra_code)?check.extra_code.length:null,
    scope:'Recorded source comparison at the stated time; dependencies and subsequent edits are not verified.'}:null;
  return {expected_revision:HERMES_REVISION,source_marker:marker,own_git,git_revision,tracked_changes,installation_receipt_revision:revision(receipt?.revision),last_source_check,dependencies_verified:false};
}
