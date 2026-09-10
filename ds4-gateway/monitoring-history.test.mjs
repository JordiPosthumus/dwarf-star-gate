import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {MonitoringHistory} from './monitoring-history.mjs';import {Activity} from './ui/activity.js';
const worker={id:'m3',backend:'openai',url:'http://private-host:8013/v1',api_key_file:'/PRIVATE_KEY_PATH'};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-monitoring-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'history.json');}
test('restart preserves prefill bands, short-prefill evidence and rates, but never bridges downtime or restores counters',t=>{
 const file=fixture(t),first=new MonitoringHistory(file,{now:()=>2000}),activity=new Activity(),telemetry={histories:new Map()};first.sync([worker],activity,telemetry);
 activity.history.set('m3',[{start:1000,end:1900,phase:'prefill'}]);activity.markers.set('m3',[{time:1500,phase:'prefill',tokens:100,basis:'completed_request'}]);telemetry.histories.set('m3',[{time:1500,kind:'prefill',tps:300,scope:'active_request_average',PRIVATE:'do not save'}]);
 first.save(activity,telemetry);assert.equal(first.status,'ready');assert.equal(fs.statSync(file).mode&0o777,0o600);const raw=fs.readFileSync(file,'utf8');for(const secret of ['PRIVATE','private-host','api_key_file'])assert.ok(!raw.includes(secret));
 const next=new MonitoringHistory(file,{now:()=>2500}),restored=new Activity(),newTelemetry={histories:new Map()};next.sync([worker],restored,newTelemetry);
 assert.deepEqual(restored.get('m3'),[{start:1000,end:1900,phase:'prefill'},{start:1900,end:2500,phase:'unknown'}]);assert.equal(restored.getMarkers('m3',2500).length,1);assert.equal(newTelemetry.histories.get('m3')[0].tps,300);assert.equal(next.snapshot().counter_baselines_persisted,false);
});
test('changed endpoint identity cannot inherit saved phase or rates; stale/future/malformed evidence is ignored',t=>{
 const file=fixture(t),a=new Activity(),e={histories:new Map()},store=new MonitoringHistory(file,{now:()=>2000});store.sync([worker],a,e);
 a.history.set('m3',[{start:1000,end:1800,phase:'decode'}]);store.save(a,e);
 const changed=new MonitoringHistory(file,{now:()=>2200}),b=new Activity(),f={histories:new Map()};changed.sync([{...worker,url:'http://another-host/v1'}],b,f);assert.deepEqual(b.get('m3'),[]);assert.equal(f.histories.size,0);
 const old=new MonitoringHistory(file,{now:()=>1000000}),c=new Activity();old.sync([worker],c,{histories:new Map()});assert.deepEqual(c.get('m3'),[]);
 const raw=JSON.parse(fs.readFileSync(file,'utf8'));raw.workers.m3.phases=[{start:1,end:999999,phase:'prefill'},{start:1,end:1800,phase:'PRIVATE'},{start:1900,end:1800,phase:'decode'}];fs.writeFileSync(file,JSON.stringify(raw));
 const invalid=new MonitoringHistory(file,{now:()=>2200}),d=new Activity();invalid.sync([worker],d,{histories:new Map()});assert.deepEqual(d.get('m3'),[]);
});
test('history faults and symlinks do not affect live observations or overwrite targets',t=>{
 const file=fixture(t),target=file+'.target';fs.writeFileSync(target,'PRIVATE');fs.symlinkSync(target,file);const a=new Activity(),e={histories:new Map()},store=new MonitoringHistory(file);assert.equal(store.status,'unavailable');store.sync([worker],a,e);store.save(a,e);assert.equal(store.status,'unavailable');assert.equal(fs.readFileSync(target,'utf8'),'PRIVATE');
 a.observe({id:'m3',backend:'openai',endpoint_metrics:{connected:true,at:1000,running:1,phase:'prefill'}},{...worker,is_healthy:true,load:0},1000);assert.equal(a.get('m3')[0].phase,'prefill');
});
