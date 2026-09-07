import test from 'node:test';
import assert from 'node:assert/strict';
import {requestUserExcerpt} from './request-preview.mjs';

test('request excerpt selects only the latest user text and excludes tools, reasoning and images',()=>{
  assert.equal(requestUserExcerpt({messages:[{role:'system',content:'PRIVATE_SYSTEM'},{role:'user',content:'Old task'},{role:'assistant',content:'PRIVATE_REASONING'},{role:'tool',content:'PRIVATE_TOOL'},{role:'user',content:[{type:'image_url',image_url:{url:'PRIVATE_IMAGE'}},{type:'text',text:'Fix the export format.'},{type:'tool_result',content:'PRIVATE_RESULT'}]},{role:'assistant',content:'PRIVATE_ASSISTANT'}]}),'Fix the export format.');
});
test('request excerpt is bounded in UTF-8 bytes and abstains when no supported user text was observed',()=>{
  const text=requestUserExcerpt({messages:[{role:'user',content:'💡'.repeat(1000)}]});
  assert.equal(Buffer.byteLength(text),1024);assert.ok(!text.includes('\ufffd'));
  for(const body of [null,{}, {messages:[{role:'tool',content:'tool'}]}, {messages:[{role:'user',content:[{type:'image_url',image_url:{url:'image'}}]}]}, {messages:Array.from({length:10001},()=>({role:'user',content:'Too many'}))}])assert.equal(requestUserExcerpt(body),null);
});

test('short continuation replies keep bounded earlier user task context rather than becoming the task name',()=>{
  for(const latest of ['Proceed','please continue.','Yes!','Background task failed: synthetic worker unavailable']){
    const body={messages:[{role:'user',content:'Create a lighthouse poem.'},{role:'assistant',content:'PRIVATE_ASSISTANT'},{role:'user',content:'Continue'},{role:'tool',content:'PRIVATE_TOOL'},{role:'user',content:latest}]};
    const result=requestUserExcerpt(body);
    assert.equal(result,`Earlier user request: Create a lighthouse poem.\nLatest user reply: ${latest}`);
    assert.ok(!result.includes('PRIVATE_'));
  }
  const long=requestUserExcerpt({messages:[{role:'user',content:'💡'.repeat(1000)},{role:'user',content:'Background task failed: '+'é'.repeat(1000)}]});
  assert.ok(Buffer.byteLength(long)<=1024);assert.ok(!long.includes('\ufffd'));
  assert.equal(requestUserExcerpt({messages:[{role:'user',content:'Older task'},{role:'user',content:'Write a poem'}]}),'Write a poem');
});

test('clipboard attachment paths do not crowd out task words and unsupported intervening tasks are not crossed',()=>{
  const attachment=['','var','folders','synthetic','T','pi-clipboard-example.png'].join('/');
  const task=attachment+' Design a red kite for a spring festival.';
  assert.equal(requestUserExcerpt({messages:[{role:'user',content:task}]}),'[Attached image] Design a red kite for a spring festival.');
  assert.equal(requestUserExcerpt({messages:[{role:'user',content:'Inspect '+attachment}]}),'Inspect '+attachment);
  assert.equal(requestUserExcerpt({messages:[{role:'user',content:'Old unrelated task'},{role:'user',content:[{type:'image_url',image_url:{url:'PRIVATE_IMAGE'}}]},{role:'user',content:'Proceed'}]}),'Proceed');
  assert.equal(requestUserExcerpt({messages:[{role:'user',content:'Old task'},...Array.from({length:9},()=>({role:'user',content:'Proceed'}))]}),'Proceed');
});
