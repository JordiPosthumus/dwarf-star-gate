// Browser integration against real notebook storage and synthetic workers only.
// No installation config, credentials, models or live gateway are read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {GenieMemory} from '../ds4-gateway/genie-memory.mjs';
import {createDemoServer} from '../examples/dashboard-demo.mjs';
import {projectRoot} from '../ds4-gateway/config.mjs';
const {chromium}=await import(process.env.DSG_PLAYWRIGHT_MODULE?pathToFileURL(path.resolve(process.env.DSG_PLAYWRIGHT_MODULE)).href:'playwright');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-memory-browser-')));
let memory=new GenieMemory(path.join(root,'memory')),server,browser;
const origins=new Set(),errors=[];
const start=async()=>{
  server=createDemoServer({memory});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;origins.add(origin);return origin;
};
const stop=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
try{
  browser=await chromium.launch({headless:true,channel:process.env.DSG_SCREENSHOT_CHANNEL||undefined});
  const context=await browser.newContext({viewport:{width:1440,height:1100},deviceScaleFactor:1,locale:'en-US',timezoneId:'UTC',reducedMotion:'reduce'});
  await context.route('**/*',r=>origins.has(new URL(r.request().url()).origin)?r.continue():(errors.push('Unexpected non-fixture network request'),r.abort()));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(await start());await page.locator('#genie-memory > summary').click();
  await page.waitForFunction(()=>document.getElementById('memory-toggle').disabled===false);
  assert.equal(memory.enabled,false);await page.locator('#memory-toggle').click();
  await page.waitForFunction(()=>document.getElementById('memory-status').textContent.includes('on'));
  const stamp=Date.now(),snapshot={time:stamp,gateway_at:stamp,gateway:{workers:[{id:'sparkA',is_healthy:false,drained:false,context_length:262144,quarantine:{reason:'accelerator_checkpoint_failure',request_id:'aaaaaaaa-0000-4000-8000-000000000001',at:new Date(stamp-1000).toISOString()}}]}};
  memory.observe(snapshot);
  memory.observe({...snapshot,gateway:{workers:[{id:'sparkA',is_healthy:true,drained:false,context_length:262144}],recovery:{operations:[{worker_id:'sparkA',id:'bbbbbbbb-0000-4000-8000-000000000001',state:'recovered',updated_at:stamp}]}}});
  const text='Synthetic operator note: preserve warm caches during calibration. <No HTML executes.>';
  await page.locator('#memory-note-text').fill(text);await page.locator('#memory-note-save').click();
  await page.waitForFunction(()=>document.getElementById('memory-message').textContent.startsWith('Saved '));
  const operator=page.locator('#memory-notes details').filter({hasText:text});await operator.locator('summary').click();
  const handle=await operator.elementHandle();
  await page.waitForFunction(()=>document.querySelectorAll('#memory-notes details').length===4);
  const firstPoll=await page.locator('#updated').innerText();
  await page.waitForFunction(old=>document.getElementById('updated').textContent!==old,firstPoll,{timeout:10000});
  assert.equal(await handle.evaluate(el=>el.isConnected&&el.open),true,'Polling must retain the open note');
  assert.equal(await page.locator('#memory-notes script').count(),0);
  await operator.getByRole('button',{name:'Edit',exact:true}).click();await page.locator('#memory-note-text').fill('Synthetic correction: preserve warm caches; verify evidence before recovery.');
  const secondPoll=await page.locator('#updated').innerText();
  await page.waitForFunction(old=>document.getElementById('updated').textContent!==old,secondPoll,{timeout:10000});
  assert.match(await page.locator('#memory-note-text').inputValue(),/^Synthetic correction/);
  await page.locator('#memory-note-save').click();await page.waitForFunction(()=>document.getElementById('memory-message').textContent.includes(' r2.'));
  await stop();memory=new GenieMemory(memory.directory);await page.goto(await start());await page.locator('#genie-memory > summary').click();
  await page.waitForFunction(()=>document.querySelectorAll('#memory-notes details').length===4);
  assert.equal(memory.enabled,true);assert.match(await page.locator('#memory-notes').innerText(),/operator note/);
  for(const summary of await page.locator('#memory-notes summary').all())await summary.click();
  const output=path.join(projectRoot,'docs/images');fs.mkdirSync(output,{recursive:true});
  await page.locator('#genie-memory').screenshot({path:path.join(output,'genie-memory.png'),animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Notebook must wrap on mobile');
  await page.getByRole('button',{name:'Archive',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('memory-message').textContent.startsWith('Archived'));
  assert.ok(fs.readFileSync(memory.file,'utf8').includes(text),'Archive must not erase prior revisions');
  await page.reload();await page.locator('#genie-memory > summary').click();
  await page.waitForFunction(()=>document.querySelectorAll('#memory-notes details').length===3);
  await page.locator('#memory-toggle').click();await page.waitForFunction(()=>document.getElementById('memory-status').textContent.includes('off'));
  assert.equal(new GenieMemory(memory.directory).enabled,false);assert.equal(memory.notes.size,4);
  assert.deepEqual(errors,[]);
  console.log('Notebook browser checks passed: opt-in, create/edit/archive, escaping, polling, dashboard restart, mobile and preserved history. Saved synthetic screenshot.');
}finally{
  await browser?.close();if(server?.listening)await stop();
  fs.rmSync(root,{recursive:true,force:true});
}
