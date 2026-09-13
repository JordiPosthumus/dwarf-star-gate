import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ServerRecords,recordsForChat} from './server-records.mjs';
import {chatContext} from './genie-chat.mjs';
import {loadConfig} from './config.mjs';
const record=(kind='observed')=>({schema:1,worker_id:'example',kind,recorded_at:'2026-01-01T00:00:00Z',runtime:{name:'vLLM',version:'example-version'},model:{name:'example-model'},settings:{context_length:262144,server_concurrency:2,prefix_caching:true},configuration:{credential_reference:'/private/example-secret',command:['PRIVATE_COMMAND']},evidence:[{path:'/private/example-evidence'}],restoration:{retention:'unverified'},discrepancies:['recovery_binding_differs']});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'server-records-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));for(const k of ['observed','approved','proposed'])fs.mkdirSync(path.join(root,k));return {root,reader:new ServerRecords(root),write:(r,kind=r.kind)=>fs.writeFileSync(path.join(root,kind,'example.json'),JSON.stringify(r))};}

test('records keep observed, approved and proposed separate and expose no private recipe material',t=>{
 const {reader,write}=fixture(t);write(record());write({...record('approved'),approval:{at:'2026-01-02T00:00:00Z',reference:'private approval receipt'}});write({...record('proposed'),settings:{server_concurrency:4}});
 const s=reader.snapshot(['example']),r=s.records[0];assert.equal(r.observed.settings.server_concurrency,2);assert.equal(r.proposed.settings.server_concurrency,4);assert.equal(r.approved.approval.at,'2026-01-02T00:00:00Z');assert.notEqual(r.observed.revision,r.proposed.revision);assert.equal(s.authority,'none');
 const context=chatContext({server_records:s});assert.equal(context.configuration_records.records[0].observed.runtime.name,'vLLM');assert.doesNotMatch(JSON.stringify(context),/PRIVATE_COMMAND|private approval|private\/example|credential_reference/);assert.equal(r.observed.restoration.drill.status,'unproven');
});
test('an observation cannot become approved by copying it into the approved directory',t=>{
 const {reader,write}=fixture(t);write(record(),'approved');assert.equal(reader.snapshot(['example']).records[0].approved,null);
 write(record('approved'));assert.equal(reader.snapshot(['example']).records[0].approved,null);
});
test('missing or malformed records never take the dashboard down and are not rewritten',t=>{
 const {root,reader,write}=fixture(t);write(record());fs.writeFileSync(path.join(root,'proposed/example.json'),'{broken');
 const s=reader.snapshot(['example','other']);assert.equal(s.records[0].observed.runtime.name,'vLLM');assert.deepEqual(s.unavailable,[{worker_id:'example',kind:'proposed'}]);assert.equal(s.records[1].observed,null);assert.equal(fs.readFileSync(path.join(root,'proposed/example.json'),'utf8'),'{broken');
 assert.deepEqual(new ServerRecords().snapshot(),{configured:false,records:[]});
});
test('record reads reject symlink files, directories and unsafe worker IDs',t=>{
 const {root,reader}=fixture(t),secret=path.join(root,'private.json');fs.writeFileSync(secret,JSON.stringify(record()));fs.symlinkSync(secret,path.join(root,'observed/example.json'));
 const s=reader.snapshot(['example','../../private']);assert.equal(s.records.length,1);assert.equal(s.records[0].observed,null);assert.equal(s.unavailable.length,1);
 fs.unlinkSync(path.join(root,'observed/example.json'));fs.rmdirSync(path.join(root,'observed'));fs.symlinkSync(path.join(root,'approved'),path.join(root,'observed'));assert.equal(reader.snapshot(['example']).records[0].observed,null);
});
test('revisions follow edited content and stale evidence never becomes a restoration claim',t=>{
 const {reader,write}=fixture(t);write(record());const before=reader.snapshot(['example']).records[0].observed;
 write({...record(),runtime:{name:'oMLX',version:'another-version'},restoration:{retention:'retained',drill:{status:'restored-in-drill'}}});const after=reader.snapshot(['example']).records[0].observed;
 assert.notEqual(after.revision,before.revision);assert.equal(after.runtime.name,'oMLX');assert.equal(after.restoration.drill.status,'unproven');
});
test('configuration-library path is relative to its config file, not the process directory',t=>{
 const {root}=fixture(t),file=path.join(root,'config.json');fs.writeFileSync(file,JSON.stringify({state_file:'runtime/state.json',server_records_directory:'records'}));assert.equal(loadConfig(file).config.server_records_directory,path.join(root,'records'));
});
test('a recorded restoration drill survives chat projection without disclosing the receipt path',t=>{
 const {reader,write}=fixture(t);write({...record('approved'),approval:{at:'2026-01-02T00:00:00Z',reference:'owner approval'},restoration:{retention:'retained',drill:{status:'restored-in-drill',at:'2026-01-03T00:00:00Z',receipt:'/private/drill-receipt.md'}}});
 const s=reader.snapshot(['example']),chat=recordsForChat(s);
 assert.deepEqual(chat.records[0].approved.restoration,s.records[0].approved.restoration);
 assert.equal(chat.records[0].approved.restoration.drill.status,'restored-in-drill');assert.doesNotMatch(JSON.stringify(chat),/private\/drill/);
});
test('alternate snapshot suppliers still pass through the chat allowlist',()=>{
 const s={configured:true,records:[{worker_id:'example',observed:{...record(),revision:'a'.repeat(64),api_key:'PRIVATE_TOKEN'}}],extra:'PRIVATE_CONFIG'};
 assert.doesNotMatch(JSON.stringify(recordsForChat(s)),/PRIVATE_TOKEN|PRIVATE_CONFIG|PRIVATE_COMMAND/);
});
