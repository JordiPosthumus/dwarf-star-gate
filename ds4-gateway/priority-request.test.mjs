import test from 'node:test';
import assert from 'node:assert/strict';
import {requestUserExcerpt} from './priority-request.mjs';

test('request excerpt selects only the latest user text and excludes tools, reasoning and images',()=>{
  assert.equal(requestUserExcerpt({messages:[{role:'system',content:'PRIVATE_SYSTEM'},{role:'user',content:'Old task'},{role:'assistant',content:'PRIVATE_REASONING'},{role:'tool',content:'PRIVATE_TOOL'},{role:'user',content:[{type:'image_url',image_url:{url:'PRIVATE_IMAGE'}},{type:'text',text:'Fix the export format.'},{type:'tool_result',content:'PRIVATE_RESULT'}]},{role:'assistant',content:'PRIVATE_ASSISTANT'}]}),'Fix the export format.');
});
test('request excerpt is bounded in UTF-8 bytes and abstains when no supported user text was observed',()=>{
  const text=requestUserExcerpt({messages:[{role:'user',content:'💡'.repeat(1000)}]});
  assert.equal(Buffer.byteLength(text),1024);assert.ok(!text.includes('\ufffd'));
  for(const body of [null,{}, {messages:[{role:'tool',content:'tool'}]}, {messages:[{role:'user',content:[{type:'image_url',image_url:{url:'image'}}]}]}, {messages:Array.from({length:10001},()=>({role:'user',content:'Too many'}))}])assert.equal(requestUserExcerpt(body),null);
});
