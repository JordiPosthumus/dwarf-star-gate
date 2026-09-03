import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareFallbackTieBreak} from './fallback-tiebreak.mjs';
import {evidence} from './dataset.mjs';

const now=1700000000000;
const active=(id,seconds,experimental=false)=>({node:{id,active:{id:id+'-active'},queue:[]},forecast:{remaining:{seconds,at:now-1000,experimental}}});

test('validated remaining evidence can disagree with the deterministic tie-break without changing it',()=>{
  const a=active('a',120),b=active('b',20),map={['a-active']:a.forecast,['b-active']:b.forecast};
  const result=compareFallbackTieBreak([a.node,b.node],a.node,id=>map[id],{now});
  assert.equal(result.verdict,'would_change');assert.equal(result.selected,'a');assert.equal(result.alternative,'b');
  assert.deepEqual(result.candidates.map(c=>Math.round(c.predicted_wait_seconds)),[119,19]);
});

test('one unsupported tied candidate makes the comparator abstain',()=>{
  const a=active('a',120),b=active('b',20,true),map={['a-active']:a.forecast,['b-active']:b.forecast};
  const result=compareFallbackTieBreak([a.node,b.node],a.node,id=>map[id],{now});
  assert.equal(result.verdict,'insufficient_evidence');assert.equal(result.candidates[1].status,'missing_active_remaining');
});

test('queued service evidence is required and immediate-free ties need no prediction',()=>{
  const free=[{id:'a',queue:[]},{id:'b',queue:[]}];assert.equal(compareFallbackTieBreak(free,free[0],()=>null,{now}).verdict,'free_tie');
  const nodes=[{id:'a',active:{id:'aa'},queue:[{id:'aq'}]},{id:'b',active:{id:'bb'},queue:[{id:'bq'}]}],map={aa:{remaining:{seconds:10,at:now,experimental:false}},bb:{remaining:{seconds:20,at:now,experimental:false}},aq:{admission:{seconds:30,experimental:false}}};
  const result=compareFallbackTieBreak(nodes,nodes[0],id=>map[id],{now});assert.equal(result.verdict,'insufficient_evidence');assert.equal(result.candidates[1].status,'missing_queued_service');
});

test('unequal deterministic load is outside the tie-break scope',()=>{
  const nodes=[{id:'a',active:{id:'aa'},queue:[]},{id:'b',queue:[]}];assert.equal(compareFallbackTieBreak(nodes,nodes[1],()=>null,{now}).verdict,'not_tied');
});

test('persisted comparator evidence is bounded and contains no request or session text',()=>{
  const request_id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',row=evidence('routing_tiebreak_shadow',{request_id,node:'a',schema:1,mode:'shadow',policy:'validated_remaining_tiebreak',selected:'a',alternative:'b',minimum_load:1,verdict:'would_change',prompt:'PRIVATE',candidates:[{node:'a',load:1,status:'supported',predicted_wait_seconds:20,evidence:['active_remaining'],session:'PRIVATE'},{node:'b',load:1,status:'supported',predicted_wait_seconds:5,evidence:['active_remaining']} ]});
  assert.equal(row.verdict,'would_change');assert.equal(row.candidate_costs.length,2);assert.ok(!JSON.stringify(row).includes('PRIVATE'));
});
