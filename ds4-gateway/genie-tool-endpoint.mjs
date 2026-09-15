// Private loopback transport shared by conversational fleet tools.
import {randomBytes,timingSafeEqual} from 'node:crypto';
export function createToolEndpoint(route,header,tool){
  const toolConfig={url:null,token:randomBytes(32).toString('hex')};
  function handle(req,res){
    if(req.url!==route)return false;
    const reply=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    const token=Buffer.from(req.headers[header]??''),expected=Buffer.from(toolConfig.token);
    if(req.method!=='POST'||token.length!==expected.length||!timingSafeEqual(token,expected)){reply(403,{error:'Authorized tool session required.'});return true;}
    if(req.headers['content-type']!=='application/json'){reply(415,{error:'JSON required.'});return true;}
    let body='',ended=false;req.setEncoding('utf8');const timer=setTimeout(()=>{ended=true;reply(408,{error:'Incomplete tool request.'});},5000);
    req.on('error',()=>{ended=true;clearTimeout(timer);});req.on('aborted',()=>{ended=true;clearTimeout(timer);});
    req.on('data',chunk=>{if(ended)return;body+=chunk;if(Buffer.byteLength(body)>2048){ended=true;clearTimeout(timer);reply(413,{error:'Tool request too large.'});}});
    req.on('end',()=>{clearTimeout(timer);if(ended)return;ended=true;let input;try{input=JSON.parse(body);}catch{reply(400,{error:'Invalid JSON.'});return;}
      void tool(input).then(v=>reply(200,v)).catch(e=>reply(409,{error:e.message}));});return true;
  }
  return {toolConfig,tool,handle,bind(port){toolConfig.url=`http://127.0.0.1:${port}${route}`;}};
}
