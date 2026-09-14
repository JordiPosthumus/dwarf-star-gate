import test from 'node:test';import assert from 'node:assert/strict';import {chatProgress} from './ui/genie-progress.js';
test('waiting and liveness are not invented from the clock',()=>{
 const m={state:'working',at:1000,text:''};const p=chatProgress(m,{now:62000});assert.match(p.label,/Waiting/);assert.match(p.detail,/No new activity for 1m 1s/);assert.match(p.activity,/may be queued or generating/);
 assert.match(chatProgress(m,{now:62000,connected:false}).label,/progress unknown/);assert.equal(chatProgress({...m,state:'complete'}),null);
});
test('real reasoning, tool progress, queue and quiet periods have distinct status',()=>{
 const m={state:'working',at:0,text:'',progress:{phase:'reasoning',step:2,reasoning_chars:1400,at:9000}};assert.match(chatProgress(m,{now:10000}).label,/Reasoning/);
 m.research={events:[{kind:'search',state:'complete',at:new Date(9500).toISOString(),query:'vLLM MTP',sources:[]}]};assert.match(chatProgress(m,{now:10000}).label,/Sources returned/);assert.match(chatProgress(m,{now:10000}).activity,/vLLM MTP/);
 m.progress={...m.progress,phase:'model_wait',step:3,at:11000};assert.match(chatProgress(m,{now:12000}).label,/Waiting/);
 assert.match(chatProgress({...m,state:'queued'},{now:12000}).detail,/not been sent/);assert.match(chatProgress({...m,state:'queued'},{suspended:true}).label,/testing/);
});

test('earlier answer text does not hide current reasoning or model wait',()=>{
 const m={state:'working',at:0,text:'An earlier partial answer',progress:{phase:'reasoning',step:4,reasoning_chars:400,at:9000}};
 assert.match(chatProgress(m,{now:10000}).label,/Reasoning/);
 m.progress.phase='model_wait';assert.match(chatProgress(m,{now:10000}).label,/Waiting/);
 m.progress.phase='answer';assert.match(chatProgress(m,{now:10000}).label,/Writing/);
});
