// Domain-tool discovery for an upstream Hermes gateway profile. This endpoint
// supplies private tool credentials only to the authenticated local plugin.
// Hermes owns channels and session persistence; DSG owns fleet execution.
import {createToolEndpoint} from './genie-tool-endpoint.mjs';
import {chatContext} from './genie-chat.mjs';
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
