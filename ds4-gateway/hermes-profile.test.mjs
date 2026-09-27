import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createSoulStore} from './hermes-profile.mjs';
import {createDashboard} from './dashboard.mjs';

function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-soul-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  return {home,store:createSoulStore(home)};
}
test('owner SOUL survives initialization, saves exactly, and keeps prior versions including empty content',t=>{
  const {home,store}=fixture(t),initial=store.read();
  const text='Owner’s own instructions.\n\nNo imposed tool list. 🎵\n';
  let next=store.save({content:text,revision:initial.revision});
  assert.equal(next.content,text);
  assert.equal(createSoulStore(home).read().content,text);
  assert.equal(fs.readFileSync(path.join(next.backups,fs.readdirSync(next.backups)[0]),'utf8'),initial.content);
  assert.throws(()=>store.save({content:'stale draft',revision:initial.revision}),{status:409});
  assert.equal(store.read().content,text);
  next=store.save({content:'',revision:next.revision});
  assert.equal(createSoulStore(home).read().content,'');
  assert.equal(fs.readdirSync(next.backups).length,2);
  store.save({content:'',revision:next.revision});
  assert.equal(fs.readdirSync(next.backups).length,2);
});
test('external edits are protected and invalid saves leave the file intact',t=>{
  const {store}=fixture(t),initial=store.read();
  fs.writeFileSync(initial.path,'Edited in a terminal\n');
  assert.throws(()=>store.save({content:'stale browser',revision:initial.revision}),{status:409});
  assert.throws(()=>store.save({content:42,revision:initial.revision}),{status:400});
  assert.equal(store.read().content,'Edited in a terminal\n');
});
test('SOUL HTTP editor roundtrip, conflict and same-origin protections',async t=>{
  const {store}=fixture(t);
  const server=createDashboard(()=>({}), {soul:store});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const loaded=await (await fetch(base+'/api/soul')).json();
  assert.equal(loaded.content,store.read().content);
  const body=JSON.stringify({content:'From dashboard\n',revision:loaded.revision});
  let r=await fetch(base+'/api/soul',{method:'PUT',headers:{'content-type':'application/json'},body});
  assert.equal(r.status,403);
  const headers={'content-type':'application/json',origin:base,'x-dsg-csrf':loaded.csrf_token};
  r=await fetch(base+'/api/soul',{method:'PUT',headers:{...headers,origin:'http://other.test'},body});
  assert.equal(r.status,403);
  r=await fetch(base+'/api/soul',{method:'PUT',headers,body});
  assert.equal(r.status,200);
  assert.equal((await r.json()).content,'From dashboard\n');
  assert.equal(fs.readFileSync(loaded.path,'utf8'),'From dashboard\n');
  r=await fetch(base+'/api/soul',{method:'PUT',headers,body});
  assert.equal(r.status,409);
  assert.equal((await fetch(base+'/api/genie')).status,410);
  const html=await (await fetch(base)).text();
  assert.match(html,/data-workspace-tab="soul"/);
  for(const asset of ['/soul.js','/soul.css'])assert.equal((await fetch(base+asset)).status,200);
});
