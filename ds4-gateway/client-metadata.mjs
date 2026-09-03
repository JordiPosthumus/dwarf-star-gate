// Optional, client-reported admission hints. No prompt parsing or authority.
export const CLIENT_METADATA_HEADER = 'x-dsg-client-metadata';
const fields = ['prompt_tokens_estimate', 'turn_index', 'compaction_count', 'reasoning_effort'];
const limits = {prompt_tokens_estimate:16777216, turn_index:1000000, compaction_count:1000000};
const efforts = new Set(['none','minimal','low','medium','high','xhigh']);
const empty = status => ({schema:1, status, source:'client_header',
  ...Object.fromEntries(fields.map(key=>[key,null]))});

function values(input) {
  if(!input || typeof input!=='object' || Array.isArray(input) || input.schema!==1 ||
    Object.keys(input).some(key=>key!=='schema'&&!fields.includes(key)))return null;
  const result=empty('ready');
  for(const key of fields) {
    const value=input[key];
    if(value==null)continue;
    if(key==='reasoning_effort' ? !efforts.has(value) : !Number.isSafeInteger(value)||value<0||value>limits[key])return null;
    result[key]=value;
  }
  return result;
}

export function clientMetadata(header) {
  if(header===undefined)return empty('missing');
  // Duplicate HTTP headers become an array or comma-joined invalid JSON. Never
  // persist a raw header, parser error or an unknown field from this envelope.
  if(typeof header!=='string'||Buffer.byteLength(header)>512)return empty('invalid');
  try{return values(JSON.parse(header))??empty('invalid');}catch{return empty('invalid');}
}

export function safeClientMetadata(input) {
  if(input?.schema!==1||!['ready','missing','invalid'].includes(input.status))return empty('invalid');
  if(input.status!=='ready')return empty(input.status);
  return values({schema:1,...Object.fromEntries(fields.map(key=>[key,input[key]]))})??empty('invalid');
}
