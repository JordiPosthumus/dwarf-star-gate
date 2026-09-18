// Explicit setup. Preserve existing configuration, personal Hermes and identity edits.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {configPath,projectRoot} from '../ds4-gateway/config.mjs';
import {installHermes} from './genie-runtime.mjs';
import {hermesProvider} from '../ds4-gateway/genie-hermes.mjs';
import {seedGenieHome} from '../ds4-gateway/genie-identity.mjs';

const usage='npm run setup -- [--controls] [--model-url URL --model ID] [--connection PRIVATE_JSON] [--reasoning EFFORT] [--max-tokens N] [--gateway-only]';
let rl,hidden=false;
async function question(prompt,{secret=false}={}){
  if(!process.stdin.isTTY)throw new Error('Interactive setup needs a terminal. Supply --model-url and --model, or --connection with private model settings.');
  if(!rl){const output=new Writable({write(chunk,encoding,callback){if(!hidden)process.stdout.write(chunk,encoding);callback();}});rl=createInterface({input:process.stdin,output,terminal:true});}
  if(secret){process.stdout.write(prompt);hidden=true;try{return (await rl.question('')).trim();}finally{hidden=false;rl.history=[];process.stdout.write('\n');}}
  return (await rl.question(prompt)).trim();
}
function privateJSON(text,label){try{return JSON.parse(text);}catch{throw new Error('Cannot read valid '+label+'. No configuration was overwritten.');}}
function modelURL(value){
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Use an HTTP(S) model API URL without embedded credentials, query or fragment.');
  url.pathname=url.pathname.replace(/\/$/,'')||'/v1';
  return url.toString().replace(/\/$/,'');
}
try{
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(['--controls','--gateway-only','--help'].includes(key))options[key]=true;
    else if(['--model-url','--model','--connection','--reasoning','--max-tokens'].includes(key)&&args[i+1]&&!args[i+1].startsWith('--'))options[key]=args[++i];
    else throw new Error('Usage: '+usage);
  }
  if(options['--help']){console.log(usage+'\nNormal setup installs a private pinned Hermes runtime and checks a model reply. --gateway-only explicitly skips Genie.');process.exit(0);}
  const destination=configPath(),before=fs.existsSync(destination)?fs.readFileSync(destination,'utf8'):null;
  const config=before?privateJSON(before,'gateway configuration'):Object.assign(JSON.parse(fs.readFileSync(path.join(projectRoot,'examples/config.json'))),{
    api_key:randomBytes(32).toString('base64url'),nodes:[],state_file:'./runtime/affinity.json',control_socket:'./runtime/control.sock',ui_worker_management:Boolean(options['--controls']),...(options['--controls']?{spark_setup:{enabled:true,targets:{}}}:{}),
  });
  if(before&&config.genie_chat){console.log('Configuration and existing Genie preserved; nothing overwritten. Use the Genie tab to check your connection.');process.exit(0);}
  if(before&&options['--gateway-only'])throw new Error('Configuration already exists; nothing overwritten.');
  const directory=path.resolve(path.dirname(destination),path.dirname(config.state_file??'runtime/affinity.json'),'genie/chat');
  if(!options['--gateway-only']){
    console.log('Gate Genie setup: installs private dependencies and sends one short connection-check message to the model you choose.');
    let connection={};
    if(options['--connection'])connection=privateJSON(fs.readFileSync(path.resolve(options['--connection']),'utf8'),'model connection JSON');
    const url=modelURL(options['--model-url']??connection.url??await question('Model API URL (for example http://localhost:8000/v1): '));
    let key=connection.api_key??'';
    if(url===`http://127.0.0.1:${config.port}/v1`)key=config.api_key;
    else if(!options['--connection']&&process.stdin.isTTY)key=await question('Model API key (hidden; Enter if none): ',{secret:true});
    const modelHeaders=key?{authorization:`Bearer ${key}`} : {};
    let models=[];
    try{const response=await fetch(url+'/models',{headers:modelHeaders,signal:AbortSignal.timeout(15000)});if(response.ok){const data=await response.json();models=(data.data??[]).map(m=>m.id).filter(x=>typeof x==='string');}}
    catch{/* Some compatible providers do not implement discovery. The actual reply is checked below. */}
    let model=options['--model']??connection.model;
    if(!model&&models.length===1){model=models[0];console.log('Found one model: '+model);}
    if(!model){models.forEach((name,i)=>console.log(`${i+1}. ${name}`));const selected=await question('Model name'+(models.length?' or number':'')+': ');model=models[Number(selected)-1]??selected;}
    if(typeof model!=='string'||!model.trim())throw new Error('Choose a model before continuing.');
    const reasoning=options['--reasoning']??connection.reasoning_effort??null;
    const maxTokens=Number(options['--max-tokens']??connection.max_tokens??8192);
    if(!Number.isSafeInteger(maxTokens)||maxTokens<1)throw new Error('max-tokens must be a positive integer.');
    const runtime=await installHermes(projectRoot);
    const chat={...runtime,url,model,reasoning_effort:reasoning,max_tokens:maxTokens,...(key&&url!==`http://127.0.0.1:${config.port}/v1`?{api_key:key}:{})};
    // Exact local pool URL inherits its key in the dashboard, without duplicating it on disk.
    seedGenieHome(directory);
    console.log('Checking an actual Genie reply…');
    const provider=hermesProvider({...chat,api_key:key},{directory});
    try{const answer=await provider.generate({message:'Introduce yourself in one short sentence. This is the Star Gate installation connection check.',history:[],context:{installation_check:true,servers:[]},sessionId:'installation-check',onDelta:()=>{}});if(!answer.text?.trim())throw new Error('No model reply.');console.log('Genie connection verified.');}
    finally{provider.close();}
    config.genie_chat=chat;
  }
  const after=JSON.stringify(config,null,2)+'\n';
  if(before!==null){
    if(fs.readFileSync(destination,'utf8')!==before)throw new Error('Configuration changed during setup; it was not overwritten.');
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const backup=path.join(projectRoot,'runtime','setup-backups',stamp);fs.mkdirSync(backup,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(backup,'config.before.json'),before,{flag:'wx',mode:0o600});
    const temp=destination+'.genie-setup-'+process.pid;fs.writeFileSync(temp,after,{flag:'wx',mode:0o600});fs.renameSync(temp,destination);
  }else fs.writeFileSync(destination,after,{flag:'wx',mode:0o600});
  console.log(`Private configuration saved: ${destination}\n${options['--gateway-only']?'Genie was explicitly skipped.':'Gate Genie is configured, with its own SOUL.md and Hermes runtime.'}\nRun npm run doctor next. ${process.platform==='darwin'?'Then run ./start-dsg.sh to start Star Gate.':'Then run npm start, npm run door and npm run ui in separate terminals.'} Open http://127.0.0.1:${config.ui_port??30010}/#genie to chat. No existing services or model settings were changed.`);
}catch(error){console.error(error.publicMessage??error.message);process.exitCode=1;}
finally{rl?.close();}
