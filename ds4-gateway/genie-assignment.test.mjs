import test from 'node:test';
import assert from 'node:assert/strict';
import {fastGenieAssignment,freeGeniePool} from './genie-assignment.mjs';
const now=100000,poolUrl='http://127.0.0.1:9002/v1';
const config={url:'http://127.0.0.1:9001/v1',timeout_ms:7200000,fallback:{url:poolUrl,model:'deepseek-v4-flash',timeout_ms:7200000}};
const evidence=()=>({gateway_at:now,gateway_error:null,gateway:{genie_admission_version:1,genie_flexible_assignment:true,model:'deepseek-v4-flash',draining:false,workers:[{is_healthy:true,load:0,queued:0}]}});
const history=[{provider:'dedicated',started_at:0,finished_at:now-1,outcome:'complete'}];
test('fast assignment needs recent slowness/failure and proven fresh compatible free capacity',()=>{
  const input={config,source:'primary',history,snapshot:evidence(),poolUrl,now};
  assert.equal(fastGenieAssignment(input).servedBy,'pool_assigned');assert.equal(fastGenieAssignment(input).flexible,true);
  assert.equal(fastGenieAssignment({...input,history:[]}).servedBy,'dedicated');
  assert.equal(fastGenieAssignment({...input,history:[{...history[0],started_at:now-10}]}).servedBy,'dedicated');
  assert.equal(fastGenieAssignment({...input,history:[{...history[0],started_at:now-10,outcome:'failed'}]}).reason,'recent_dedicated_failure');
  assert.equal(fastGenieAssignment({...input,now:now+300001,snapshot:{...evidence(),gateway_at:now+300001}}).servedBy,'pool_assigned','evidence survives the normal five-minute review cadence');
  assert.equal(fastGenieAssignment({...input,now:now+1800001,snapshot:{...evidence(),gateway_at:now+1800001}}).servedBy,'dedicated');
  for(const mutate of [s=>s.gateway_at=now-6001,s=>s.gateway_error='stale',s=>s.gateway.draining=true,s=>s.gateway.genie_admission_version=null,s=>s.gateway.model='other-model',s=>s.gateway.workers[0].load=1,s=>s.gateway.workers[0].queued=1,s=>s.gateway.workers[0].holds=[{id:'owner'}],s=>s.gateway.workers[0].maintenance_locks=[{id:'maintenance'}],s=>s.gateway.workers[0].quarantine={},s=>s.gateway.workers[0].drained=true]){
    const snapshot=evidence();mutate(snapshot);assert.equal(fastGenieAssignment({...input,snapshot}).servedBy,'dedicated');
  }
  assert.equal(freeGeniePool(evidence(),config.fallback,'http://127.0.0.1:7777/v1',now),false);
  assert.equal(config.timeout_ms,7200000);assert.equal(config.fallback.timeout_ms,7200000);
});
test('explicit pool selection keeps the original request pending for flexible assignment when supported',()=>{
  const snapshot=evidence();snapshot.gateway.workers[0].load=1;
  const selected=fastGenieAssignment({config,source:'pool',snapshot,poolUrl,now});assert.equal(selected.servedBy,'pool');assert.equal(selected.flexible,true);snapshot.gateway.genie_flexible_assignment=false;assert.equal(fastGenieAssignment({config,source:'pool',snapshot,poolUrl,now}).flexible,false);snapshot.gateway.genie_flexible_assignment=true;
  snapshot.gateway.workers[0].load=0;assert.equal(fastGenieAssignment({config,source:'pool',snapshot,poolUrl,now}).flexible,true);
  assert.equal(fastGenieAssignment({config:{...config,url:poolUrl},source:'primary',snapshot,poolUrl,now}).servedBy,'pool');
});
