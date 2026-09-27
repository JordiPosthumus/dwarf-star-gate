// Domain-tool discovery for an upstream Hermes gateway profile. This endpoint
// supplies private tool credentials only to the authenticated local plugin.
// Hermes owns channels and session persistence; DSG owns fleet execution.
import {createToolEndpoint} from './genie-tool-endpoint.mjs';
import {chatContext} from './genie-chat.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const capability={research:'research',inspection:'inspection',operations:'server_changes',hourglass:'hourglass',queue:'rebalance',recovery:'recovery',spark_setup:'spark_setup',media:'media',power:'fleet_power',admission:'server_changes'};
export function createNativeHermesContext({snapshot,tools,isEnabled=()=>false,isTesting=()=>false}){
  if(typeof snapshot!=='function'||typeof tools!=='function')throw Error('Native Hermes needs current snapshot and tool providers');
  const tool=async input=>{
    if(input?.action!=='context'||Object.keys(input).length!==1)throw Error('Read native context only');
    const context=chatContext(await snapshot());
    const configured=await tools();
    const available=Object.fromEntries(Object.entries(configured).filter(([section,value])=>value&&capability[section]));
    const enabled_sections=Object.keys(available).filter(section=>!isTesting()&&(['power','recovery','spark_setup','media'].includes(section)||isEnabled(capability[section])));
    return {schema:1,context,tools:available,enabled_sections};
  };
  return {...createToolEndpoint('/api/genie/native-tools','x-sg-native-tool',tool),tool};
}

// The descriptor is the only credential the native profile needs to retain.
// Publish after all domain endpoints bind, and rotate it on every restart.
export function publishNativeHermesDescriptor(file,toolConfig){
  if(!path.isAbsolute(file)||!toolConfig.url||!toolConfig.token)throw Error('A bound native bridge and absolute descriptor path are required');
  const directory=path.dirname(file);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const owner=fs.lstatSync(directory);
  if(!owner.isDirectory()||owner.isSymbolicLink()||(owner.mode&0o077)||owner.uid!==process.getuid())throw Error('Native bridge directory must be private and owned by this account');
  const existing=fs.lstatSync(file,{throwIfNoEntry:false});
  if(existing&&(!existing.isFile()||existing.isSymbolicLink()||(existing.mode&0o077)||existing.uid!==process.getuid()))throw Error('Refusing to replace an unsafe native bridge descriptor');
  const content=JSON.stringify({url:toolConfig.url,token:toolConfig.token})+'\n';
  const temporary=path.join(directory,'.bridge-'+randomUUID());
  try{
    fs.writeFileSync(temporary,content,{mode:0o600,flag:'wx'});
    fs.renameSync(temporary,file);
  }finally{fs.rmSync(temporary,{force:true});}
  return ()=>{
    // An older process closing must not remove its successor's credentials.
    const current=fs.lstatSync(file,{throwIfNoEntry:false});
    if(current?.isFile()&&!current.isSymbolicLink()&&fs.readFileSync(file,'utf8')===content)fs.unlinkSync(file);
  };
}
