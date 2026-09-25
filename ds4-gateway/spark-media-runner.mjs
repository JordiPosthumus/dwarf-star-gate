import {selectedMediaPreparation} from './media-reuse.mjs';
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';import {promisify,isDeepStrictEqual} from 'node:util';import {once} from 'node:events';import {fileURLToPath} from 'node:url';import {setTimeout as delay} from 'node:timers/promises';
import {MediaJobs} from './media-jobs.mjs';import {MediaBackend} from './media-backend.mjs';import {saveMediaReceipt} from './media-execution.mjs';import {setupTransport} from './genie-spark-setup.mjs';import {qualifySparkMedia,mediaPlanIdentity} from './spark-media-cycle.mjs';
const folder=path.resolve(process.argv[2]),plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json'))),execute=promisify(execFile);
fs.writeFileSync(path.join(folder,'runner-claim.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
const save=(name,value)=>saveMediaReceipt(folder,name,{...value,at:new Date().toISOString()});
let lastProgress={engine:'prepared_media',phase:'preflight'};
const progress=(engine,phase,detail)=>{lastProgress={engine,phase,detail};save('progress.json',{state:'running',...lastProgress});};
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const remote=async args=>(await execute('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','--',plan.target.ssh,args.map(quote).join(' ')],{maxBuffer:8*1024*1024})).stdout;
const inspect=async id=>JSON.parse(await remote(['docker','inspect',id]))[0];let lock;
try{
 // Verify the output tools before starting a remote engine.
 await execute('ffprobe',['-version']);await execute('ffmpeg',['-version']);
 const code="import fcntl,pathlib,sys; p=pathlib.Path.home()/'.cache/star-gate-spark-setup.lock'; p.parent.mkdir(parents=True,exist_ok=True); f=p.open('a'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('locked',flush=True); sys.stdin.read()";
 lock=spawn('ssh',['-T','-o','BatchMode=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','--',plan.target.ssh,'python3 -I -c '+quote(code)],{stdio:['pipe','pipe','pipe']});lock.stderr.resume();lock.stdin.on('error',()=>{});
 await new Promise((resolve,reject)=>{lock.once('error',reject);lock.once('exit',()=>reject(Error('Host setup lock unavailable')));lock.stdout.once('data',data=>data.toString().trim()==='locked'?resolve():reject(Error('Host lock not confirmed')));});
 const current=selectedMediaPreparation(await setupTransport(plan.target,{action:'media_plan'}),plan.reuse);save('preflight-observation.json',current);
 assert.ok(isDeepStrictEqual(mediaPlanIdentity(current),mediaPlanIdentity(plan.preparation)),'Prepared media configuration changed before execution');
 const result=await qualifySparkMedia(plan,{save,progress,inspect,owned:()=>lock.exitCode===null&&lock.signalCode===null,delay,
  start:id=>remote(['docker','start',id]),stop:id=>remote(['docker','stop','-t','120',id]),
  jobs:new MediaJobs(path.join(folder,'jobs.json')),
  payload:kind=>JSON.parse(fs.readFileSync(new URL('../examples/media/'+(kind==='music'?'ace-step-xl-text-to-music.json':'h3-text-to-video.json'),import.meta.url))),
  decode:async(file,kind)=>{
   const probe=JSON.parse((await execute('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels','-of','json',file])).stdout);
   assert.ok(Number(probe.format?.duration)>0);assert.ok(probe.streams.some(s=>['audio','video'].includes(s.codec_type)),'Media stream missing');
   await execute('ffmpeg',['-v','error','-xerror','-i',file,'-map','0','-f','null','-']);return {...probe,full_decode:true};
  },
  connect:async engine=>{
   const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
   const fd=fs.openSync(path.join(folder,'tunnels.log'),'a',0o600);const child=spawn('ssh',['-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-L',`127.0.0.1:${port}:127.0.0.1:${engine.port}`,plan.target.ssh],{stdio:['ignore','ignore',fd]});fs.closeSync(fd);await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
   return {backend:new MediaBackend({kind:engine.kind,url:`http://127.0.0.1:${port}`}),close:()=>child.kill('SIGTERM')};
  }
 });save('progress.json',result);save('completion.json',result);
}catch(error){save('progress.json',{...lastProgress,state:'needs_attention',error:error.message});process.exitCode=1;}
finally{lock?.stdin.end();}
