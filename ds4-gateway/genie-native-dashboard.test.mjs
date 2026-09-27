import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeDashboardChat,nativeDashboardView,nativeReplyId} from './genie-native-dashboard.mjs';
import {chatProgress} from './ui/genie-progress.js';

const base=()=>({id:'fixture',title:'Native fixture',history_complete:true,busy:true,queued:0,native_session_key:'key',native_session_id:'session',native_turn_id:'exact-native-turn',native_hold:null,observed_at:new Date(1000).toISOString(),messages:[{id:'old-row',role:'assistant',state:'working',text:'Old partial response',at:100}],updated_at:100});
function fixture(){
  const f={view:base(),calls:[],time:1000,fail:false};
  f.client={bindings:new Map([['fixture',{}]]),discover:async()=>[],read:async()=>{if(f.fail)throw Error('unavailable');return structuredClone(f.view);},
    stop:async(id,turn,hold)=>{f.calls.push({action:'stop',id,turn,hold});f.view.busy=false;f.view.native_turn_id=null;f.view.native_hold={hold_id:hold,turn_id:turn,state:'held',queued:2};if(f.lost)throw Error('Lost response');},
    resume:async(id,hold)=>{f.calls.push({action:'resume',id,hold});f.view.native_hold=null;f.view.busy=true;f.view.native_turn_id='next-turn';}};
  f.facade=()=>new NativeDashboardChat({client:f.client,now:()=>f.time});f.chat=f.facade();return f;
}

test('native dashboard never attaches live controls to unfinished historical text',()=>{
  const source=base(),view=nativeDashboardView(source,null,1000);
  assert.equal(source.messages[0].state,'working');assert.equal(view.messages[0].state,'unverified');
  const active=view.messages[1];assert.equal(active.native_execution,true);assert.equal(active.native_turn_id,'exact-native-turn');assert.equal(active.state,'working');
  assert.notEqual(active.id,'old-row');assert.equal(nativeDashboardView({...source,observed_at:new Date(2000).toISOString()},view,2000).messages[1].at,1000);
  assert.match(chatProgress(active,{now:1000}).label,/active turn/);assert.match(chatProgress(active,{now:17000}).label,/unavailable/);
  assert.equal(nativeDashboardView({...source,native_turn_id:null},null).messages[1].state,'unverified');
  assert.throws(()=>nativeDashboardView({...source,history_complete:false}),/unavailable/);
});

test('stale displayed reply cannot stop a newer native turn',async()=>{
  const f=fixture();await f.chat.refresh();const displayed=f.chat.get('fixture').messages.at(-1).id;
  f.view.native_turn_id='later-turn';await assert.rejects(f.chat.stop('fixture',displayed),/no longer/);assert.equal(f.calls.length,0);
  await assert.rejects(f.chat.stop('fixture','old-row'),/no longer/);assert.equal(f.calls.length,0);
});

test('lost stop acknowledgment remains a visible native hold after facade reconstruction',async()=>{
  const f=fixture();await f.chat.refresh();const displayed=f.chat.get('fixture').messages.at(-1).id;f.lost=true;
  await assert.rejects(f.chat.stop('fixture',displayed),/Lost response/);
  const restarted=f.facade();await restarted.refresh();const held=restarted.get('fixture');
  assert.equal(held.queue_paused,displayed);assert.equal(held.queue_resume_supported,true);assert.equal(held.queued,2);
  assert.equal(f.calls.length,1);await assert.rejects(restarted.resume('fixture','old-row'),/changed/);
  const next=await restarted.resume('fixture',displayed);assert.equal(next.native_hold,null);assert.equal(f.calls.length,2);
  await assert.rejects(restarted.resume('fixture',displayed),/changed/);assert.equal(f.calls.length,2);
});

test('uncertain holds, failed observations and expired views never become permission to continue',async()=>{
  const f=fixture();f.view.busy=false;f.view.native_hold={hold_id:'fixture-hold',turn_id:'exact-native-turn',state:'uncertain',queued:3};
  await f.chat.refresh();assert.equal(f.chat.get('fixture').queue_resume_supported,false);
  await assert.rejects(f.chat.resume('fixture',nativeReplyId('fixture','exact-native-turn')),/unconfirmed/);assert.equal(f.calls.length,0);
  f.fail=true;await assert.rejects(f.chat.refresh(),/unavailable/);assert.equal(f.chat.status().available,false);assert.equal(f.chat.status().conversations[0].busy,null);assert.throws(()=>f.chat.get('fixture'),/unavailable/);
  f.fail=false;await f.chat.refresh();f.time+=16000;assert.equal(f.chat.status().available,false);assert.throws(()=>f.chat.get('fixture'),/unavailable/);assert.equal(f.calls.length,0);
});

test('concurrent refreshes cannot overwrite newer execution with an earlier response',async()=>{
  const f=fixture();let release;const original=f.client.read;f.client.read=async()=>{const value=structuredClone(f.view);await new Promise(r=>release=r);f.client.read=original;return value;};
  const first=f.chat.refresh();await new Promise(r=>setImmediate(r));f.view.native_turn_id='next-turn';const second=f.chat.refresh();release();await Promise.all([first,second]);
  assert.equal(f.chat.get('fixture').native_turn_id,'next-turn');
});
