// UI proof against the synthetic demo only; never accepts a live target URL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createChatDemo} from '../examples/genie-chat-demo.mjs';
const modulePath=process.env.DSG_PLAYWRIGHT_MODULE;
const {chromium}=await import(modulePath?pathToFileURL(path.resolve(modulePath)).href:'playwright');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-chat-ui-'));
const output=path.resolve('runtime/chat-browser-proof');fs.mkdirSync(output,{recursive:true});
const {server}=createChatDemo({directory});let browser;
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,channel:process.env.DSG_SCREENSHOT_CHANNEL||undefined});
  const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/#genie`);
  await page.waitForFunction(()=>!document.getElementById('conversation-send').disabled);
  // Starting a chat and immediately composing must not race a second creation.
  await page.locator('#conversation-new').click();
  await page.locator('#conversation-input').fill('My name is Ada.');
  await page.waitForFunction(()=>!document.getElementById('conversation-send').disabled);
  await page.locator('#conversation-shell').screenshot({path:path.join(output,'welcome.png')});
  async function send(message){await page.locator('#conversation-input').fill(message);await page.locator('#conversation-input').press('Enter');await page.waitForFunction(()=>!document.getElementById('conversation-send').disabled&&document.querySelectorAll('.conversation-message[data-role="assistant"]').length>0);}
  await send('My name is Ada.');
  await send('What is my name?');
  assert.match(await page.locator('#conversation-messages').innerText(),/You told me your name is Ada/);
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.conversation-message').length===4);
  await send('What servers can you see?');
  assert.match(await page.locator('#conversation-messages').innerText(),/sparkA, sparkB, mac-ultra/);
  await page.locator('#conversation-shell').screenshot({path:path.join(output,'conversation.png')});
  const original=await page.locator('#conversation-list button').first().innerText();
  await page.locator('#conversation-new').click();await page.waitForFunction(()=>document.querySelectorAll('.conversation-message').length===0);
  await send('What is my name?');assert.match(await page.locator('#conversation-messages').innerText(),/haven’t told me your name/);
  await page.getByRole('button',{name:original,exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.conversation-message').length===6);
  await page.locator('#conversation-input').fill('An unsent draft');await page.reload();await page.waitForFunction(()=>document.getElementById('conversation-input').value==='An unsent draft');
  let disconnected=true;
  await context.route('**/api/genie/chat',route=>disconnected?route.abort():route.fallback());
  await page.waitForFunction(()=>document.getElementById('conversation-error').textContent.includes('Connection unavailable'));
  assert.equal(await page.locator('#conversation-send').isDisabled(),true);
  assert.equal(await page.locator('#conversation-input').inputValue(),'An unsent draft');
  disconnected=false;
  await page.waitForFunction(()=>!document.getElementById('conversation-send').disabled&&!document.getElementById('conversation-error').textContent);
  await page.setViewportSize({width:390,height:844});await page.locator('#conversation-shell').screenshot({path:path.join(output,'mobile.png')});
  assert.equal(await page.locator('#conversation-shell').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);
  assert.deepEqual(errors,[]);
  console.log('Browser passed: multi-turn history, reload, new-chat isolation, chat switching, draft and connection recovery, mobile layout, no script errors.');
  console.log(`Synthetic screenshots: ${output}`);
}finally{await browser?.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});}
