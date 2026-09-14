import http from 'node:http';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {hermesProvider} from './genie-hermes.mjs';
import {genieLoopbackFetch} from './genie-transport.mjs';

const LIMIT=1024*1024;
const jsonResponse=(status,value,node=null)=>({ok:status>=200&&status<300,status,node,body:Readable.from([JSON.stringify(value)])});
// Hermes owns the review conversation and native identity. The existing Node
// transport owns the single provider dispatch, cancellation and refusal proof.
// A library retry can revisit this private adapter, but cannot replay inference.
export function hermesReviewFetch(runtime,{directory,providerFactory=hermesProvider,fetchImpl=genieLoopbackFetch}={}){
  const review=async(url,{body,headers,signal,timeoutMs}={})=>{
    const original=JSON.parse(body),evidence=JSON.parse(original.messages[1].content).evidence;
    const controller=new AbortController(),key=randomUUID();let dispatched=false,upstreamError=null,upstreamStatus=null,servedOn=null,provider,response;
    let overflow=false,lengthFinished=false;
    const server=http.createServer(async(req,res)=>{
      const reply=(status,value)=>{if(!res.destroyed&&!res.headersSent){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}};
      if(req.headers.authorization!==`Bearer ${key}`)return reply(401,{error:{message:'Private review adapter'}});
      if(req.method==='GET'&&req.url==='/v1/models')return reply(200,{object:'list',data:[{id:original.model,...(Number.isSafeInteger(evidence?.context_length)?{context_length:evidence.context_length}:{})}]});
      if(req.method!=='POST'||req.url!=='/v1/chat/completions')return reply(404,{error:{message:'Unsupported review request'}});
      if(dispatched)return reply(409,{error:{message:'This review already used its provider attempt; it cannot be replayed'}});
      dispatched=true;
      try{
        let bytes=0,chunks=[];for await(const chunk of req)chunks.push(chunk);
        if(signal?.aborted)throw new DOMException('Aborted','AbortError');
        const generated=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(generated.model!==original.model||(generated.tools?.length??0)>0||!Array.isArray(generated.messages))throw new Error('Unexpected review model or tools');
        // Hermes supplies its native identity and conversation messages. All
        // serving parameters remain exactly the established review envelope;
        // library sampling defaults or retries cannot silently replace them.
        const request={...original,messages:generated.messages};
        response=await fetchImpl(url,{method:'POST',headers,body:JSON.stringify(request),signal:controller.signal});upstreamStatus=response.status;servedOn=response.node??null;
        bytes=0;chunks=[];for await(const chunk of response.body){bytes+=chunk.length;if(bytes>LIMIT){overflow=true;throw new Error('Model response exceeded observation budget');}chunks.push(Buffer.from(chunk));}
        const output=Buffer.concat(chunks),text=output.toString('utf8');
        if(response.ok){
          const parts=request.stream?text.split('\n').filter(x=>x.startsWith('data: ')&&!x.includes('[DONE]')).map(x=>{try{return JSON.parse(x.slice(6));}catch{return {};}}):[JSON.parse(text)];
          lengthFinished=parts.some(p=>p.choices?.some(c=>c.finish_reason==='length'));
        }
        if(!res.destroyed){res.writeHead(response.status,{'content-type':request.stream&&response.ok?'text/event-stream':'application/json'});res.end(output);}
      }catch(error){upstreamError=error;reply(502,{error:{message:'Review provider attempt failed; no replay'}});}
    });
    const abort=()=>{controller.abort();response?.body?.destroy?.();provider?.close();server.closeAllConnections();};
    signal?.addEventListener('abort',abort,{once:true});
    try{
      if(signal?.aborted)throw new DOMException('Aborted','AbortError');
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      provider=providerFactory({python:runtime.python,source:runtime.source,url:`http://127.0.0.1:${server.address().port}/v1`,model:original.model,api_key:key,max_tokens:original.max_tokens,reasoning_effort:original.reasoning_effort??null,timeout_ms:timeoutMs},{directory,review:true});
      let answer,error;
      try{answer=await provider.generate({message:original.messages[1].content,history:[],context:{},instructions:original.messages[0].content,sessionId:randomUUID(),signal:controller.signal,onDelta:()=>{}});}catch(e){error=e;}
      if(signal?.aborted)throw new DOMException('Aborted','AbortError');
      if(upstreamError)throw upstreamError; // Preserve the exact witnessed refusal object for fallback.
      if(overflow)throw new Error('Model response exceeded observation budget');
      if(upstreamStatus>=400)return jsonResponse(upstreamStatus,{error:{message:'Model rejected review'}});
      if(lengthFinished)throw new Error('Observation reached its token budget; no complete report');
      if(error)throw error;
      if(!dispatched||!answer?.text)throw new Error('Model returned no answer');
      return jsonResponse(200,{choices:[{finish_reason:'stop',message:{content:answer.text}}]},servedOn);
    }finally{signal?.removeEventListener('abort',abort);controller.abort();response?.body?.destroy?.();provider?.close();server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve()));}
  };
  review.engine='Hermes';return review;
}
