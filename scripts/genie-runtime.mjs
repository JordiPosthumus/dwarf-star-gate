// Installation-owned dependencies only: no global Python, uv or personal Hermes changes.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {NATIVE_POLICY_VERSION,applyNativeHermesPolicy,verifyNativeHermesPolicy} from './hermes-native-policy.mjs';

export const HERMES_REVISION='2237be355906fbe6065ce1815711eee52b2d646e';
const UV_VERSION='0.11.8';
const UV_ARCHIVES={
  'darwin-arm64':['aarch64-apple-darwin','c729adb365114e844dd7f9316313a7ed6443b89bb5681d409eebac78b0bd06c8'],
  'darwin-x64':['x86_64-apple-darwin','c59d73bf34b58bc8e33a11629f7a255c11789fd00f03cd3e68ab2d1603645de9'],
  'linux-arm64':['aarch64-unknown-linux-gnu','eee8dd658d20e5ac85fec9c2326b6cbc9d83a1eef09ef07433e58698ac849591'],
  'linux-x64':['x86_64-unknown-linux-gnu','56dd1b66701ecb62fe896abb919444e4b83c5e8645cca953e6ddd496ff8a0feb'],
};
export const NATIVE_RUNTIME_GENERATION=2;
const NATIVE_UV_VERSION='0.12.19';
// Official release asset digests: github.com/astral-sh/uv/releases/tag/0.12.19.
const NATIVE_UV_ARCHIVES={
  'darwin-arm64':['aarch64-apple-darwin','a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba'],
  'darwin-x64':['x86_64-apple-darwin','cb5fa57bafe68fc0fb94b17f06bee0b0b9a7feb94ccbd110445afa0696e39273'],
  'linux-arm64':['aarch64-unknown-linux-gnu','0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436'],
  'linux-x64':['x86_64-unknown-linux-gnu','23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8'],
};
export function run(command,args,options={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{...options,stdio:['ignore','pipe','pipe']});let output='';
    for(const stream of [child.stdout,child.stderr])stream.on('data',x=>{output=(output+x).slice(-16000);});
    child.on('error',()=>reject(new Error(`Could not start ${path.basename(command)}. Check that Git and tar are installed.`)));
    child.on('close',code=>code===0?resolve(output.trim()):reject(new Error(`${path.basename(command)} failed (${code}). ${output}`)));
  });
}
export async function nativeRuntimeEvidence(python,source,env){
  const code=`import sys,sqlite3,json
sys.path.insert(0,sys.argv[1])
from hermes_cli.sqlite_runtime import is_sqlite_wal_reset_vulnerable
if sys.version_info[:2] != (3,12): raise RuntimeError('Native Hermes requires the selected Python 3.12 runtime')
if is_sqlite_wal_reset_vulnerable(sqlite3.sqlite_version_info): raise RuntimeError('Native Hermes SQLite runtime needs an upstream-fixed build; previous environments are preserved')
with sqlite3.connect(':memory:') as db: source_id=db.execute('SELECT sqlite_source_id()').fetchone()[0]
print(json.dumps({'python_version':sys.version,'base_prefix':sys.base_prefix,'sqlite_version':sqlite3.sqlite_version,'sqlite_source_id':source_id}))`;
  return JSON.parse(await run(python,['-I','-c',code,source],{cwd:source,env}));
}
export async function installHermes(root,{log=console.log,nativeGateway=false}={}){
  const uvVersion=nativeGateway?NATIVE_UV_VERSION:UV_VERSION;
  const target=(nativeGateway?NATIVE_UV_ARCHIVES:UV_ARCHIVES)[`${process.platform}-${process.arch}`];
  if(!target)throw new Error('Genie setup currently supports macOS and glibc Linux on ARM64 or x64.');
  // Native channels need messaging dependencies. Use a separate environment so
  // staging the gateway cannot change a running reviewer or personal Hermes.
  const base=path.join(root,'runtime',nativeGateway?'genie-native-runtime':'genie-runtime');
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:path.join(base,'installer-home'),
    UV_CACHE_DIR:path.join(base,'cache'),UV_PYTHON_INSTALL_DIR:path.join(base,nativeGateway?'python-runtime'+NATIVE_RUNTIME_GENERATION:'python'),
    UV_PYTHON_BIN_DIR:path.join(base,'bin'),UV_NO_CONFIG:'1',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LANG:'en_US.UTF-8'};
  fs.mkdirSync(env.HOME,{recursive:true,mode:0o700});
  const source=path.join(base,'hermes-'+HERMES_REVISION+(nativeGateway?'-telegram-policy'+NATIVE_POLICY_VERSION+'-runtime'+NATIVE_RUNTIME_GENERATION:'')),python=path.join(source,'.venv','bin','python');
  const receipt=path.join(source,'star-gate-install.json');
  const verify=async()=>{
    await run(python,['-I','-c','import sys; sys.path.insert(0,sys.argv[1]); from run_agent import AIAgent'+(nativeGateway?'; import aiohttp, telegram; from gateway.run import GatewayRunner':''),source],{cwd:source,env});
    return nativeGateway?nativeRuntimeEvidence(python,source,env):null;
  };
  if(fs.existsSync(receipt)){
    const saved=JSON.parse(fs.readFileSync(receipt));
    if(saved.revision!==HERMES_REVISION||(nativeGateway&&(saved.native_gateway!==true||saved.native_policy!==NATIVE_POLICY_VERSION||saved.native_runtime!==NATIVE_RUNTIME_GENERATION||saved.uv!==uvVersion))||!fs.existsSync(path.join(source,'.git'))||
      fs.realpathSync(await run('git',['rev-parse','--show-toplevel'],{cwd:source,env}))!==fs.realpathSync(source)||
      await run('git',['rev-parse','HEAD'],{cwd:source,env})!==HERMES_REVISION||
      (nativeGateway?!verifyNativeHermesPolicy(source,env):await run('git',['status','--porcelain','--untracked-files=no'],{cwd:source,env})!==''))
      throw new Error('The dedicated Hermes runtime differs from its installation record; nothing replaced.');
    const runtime=await verify();
    if(nativeGateway&&JSON.stringify(saved.runtime)!==JSON.stringify(runtime))throw Error('Native Python/SQLite differs from its verified installation record; nothing replaced.');
    return {source,python};
  }
  const lock=path.join(base,'.install-lock');
  try{fs.mkdirSync(lock);}catch{throw new Error(`A Genie installation is already running or was interrupted. Check it before removing ${lock} and retrying.`);}
  try{
    const tools=path.join(base,'uv-'+uvVersion);fs.mkdirSync(tools,{recursive:true});
    const uv=path.join(tools,'uv-'+target[0],'uv');
    if(!fs.existsSync(uv)){
      log('Downloading Star Gate’s private installer…');
      const url=`https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-${target[0]}.tar.gz`;
      const response=await fetch(url,{signal:AbortSignal.timeout(180000)});
      if(!response.ok)throw new Error(`Installer download failed (${response.status}). Run setup again to retry.`);
      const bytes=Buffer.from(await response.arrayBuffer());
      if(createHash('sha256').update(bytes).digest('hex')!==target[1])throw new Error('Installer checksum does not match the pinned release.');
      const archive=path.join(tools,'download.tar.gz');fs.writeFileSync(archive,bytes);
      await run('tar',['-xzf',archive,'-C',tools],{env});fs.unlinkSync(archive);
    }
    if(nativeGateway&&!(await run(uv,['--version'],{env})).startsWith('uv '+uvVersion+' '))throw Error('Private installer version differs from the pinned release');
    if(!fs.existsSync(path.join(source,'.git'))){
      if(fs.existsSync(source)&&fs.readdirSync(source).length)throw new Error('The dedicated runtime directory is occupied; nothing overwritten.');
      fs.mkdirSync(source,{recursive:true});await run('git',['init','-q'],{cwd:source,env});
    }
    log('Downloading the pinned Hermes source…');
    await run('git',['fetch','--depth','1','https://github.com/NousResearch/hermes-agent.git',HERMES_REVISION],{cwd:source,env});
    await run('git',['checkout','--detach',HERMES_REVISION],{cwd:source,env});
    if(nativeGateway)applyNativeHermesPolicy(source,env);
    log('Installing private Python 3.12 and Hermes dependencies. This may take a few minutes…');
    await run(uv,['sync','--frozen','--no-dev','--python','3.12','--managed-python',...(nativeGateway?['--extra','messaging']:[])],{cwd:source,env});
    const runtime=await verify();
    fs.writeFileSync(receipt,JSON.stringify({revision:HERMES_REVISION,uv:uvVersion,...(nativeGateway?{native_gateway:true,native_policy:NATIVE_POLICY_VERSION,native_runtime:NATIVE_RUNTIME_GENERATION,runtime}:{}),installed_at:new Date().toISOString()},null,2)+'\n',{mode:0o600});
    return {source,python};
  }finally{fs.rmdirSync(lock);}
}
