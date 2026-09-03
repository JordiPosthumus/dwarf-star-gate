// Optional development tool. Always creates its own synthetic server: no live URL input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDemoServer } from '../examples/dashboard-demo.mjs';
import { projectRoot } from '../ds4-gateway/config.mjs';
const modulePath=process.env.DSG_PLAYWRIGHT_MODULE;
const {chromium}=await import(modulePath?pathToFileURL(path.resolve(modulePath)).href:'playwright');
const server=createDemoServer();
let browser,learningServer;
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,channel:process.env.DSG_SCREENSHOT_CHANNEL||undefined});
  const context=await browser.newContext({viewport:{width:1440,height:1100},deviceScaleFactor:1,locale:'en-US',timezoneId:'UTC',reducedMotion:'reduce'});
  const errors=[];
  const allowedOrigins=new Set([origin]);
  await context.route('**/*',route=>{
    if(allowedOrigins.has(new URL(route.request().url()).origin))return route.continue();
    errors.push('Unexpected non-demo network request');return route.abort();
  });
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(()=>document.querySelectorAll('.device').length===3&&document.querySelectorAll('#genie-reports details').length===1&&document.querySelectorAll('#analytics-chart circle').length>0);
  assert.equal(await page.locator('h1').innerText(),'Dwarf Star Gate');
  assert.match(await page.locator('#connection').innerText(),/Demo/);
  assert.match(await page.locator('#predictor-status').innerText(),/0 validated models/);
  assert.match(await page.locator('#embedding-detail').innerText(),/384 dimensions/);
  assert.ok(await page.locator('.gate-art').evaluate(img=>img.complete&&img.naturalWidth>0));
  const output=path.join(projectRoot,'docs/images');await fs.mkdir(output,{recursive:true});
  const devices=await page.locator('#devices').boundingBox();
  await page.screenshot({path:path.join(output,'dashboard-overview.png'),fullPage:true,clip:{x:0,y:0,width:1440,height:Math.ceil(devices.y+devices.height+24)},animations:'disabled'});
  await page.locator('#genie-reports summary').click();
  // A real poll must not collapse the open report; don't replace DOM to stage screenshots.
  const checked=await page.locator('#updated').innerText();
  await page.waitForFunction(previous=>document.getElementById('updated').textContent!==previous,checked,{timeout:10000});
  assert.equal(await page.locator('#genie-reports details').getAttribute('open'),'');
  await page.locator('.insights').screenshot({path:path.join(output,'dashboard-genie.png'),animations:'disabled'});
  await page.locator('#analytics-metric').selectOption('xgb-remaining');
  await page.waitForFunction(()=>document.querySelectorAll('#analytics-chart circle').length===20);
  assert.match(await page.locator('#analytics-status').innerText(),/Synthetic demo/);
  assert.equal(await page.locator('#analytics-version-label').isVisible(),true);
  await page.evaluate(()=>window.scrollTo(0,0));
  const analytics=await page.locator('#analytics').boundingBox();
  const requests=await page.locator('#requests').boundingBox();
  await page.screenshot({path:path.join(output,'dashboard-cache-and-requests.png'),fullPage:true,clip:{x:0,y:Math.floor(analytics.y-16),width:1440,height:Math.ceil(requests.y+requests.height-analytics.y+40)},animations:'disabled'});
  for(const [file,minHeight] of [['dashboard-overview.png',1200],['dashboard-genie.png',250],['dashboard-cache-and-requests.png',700]]) {
    const png=await fs.readFile(path.join(output,file));
    assert.ok(png.readUInt32BE(20)>=minHeight,`${file}: screenshot was clipped`);
  }
  await page.locator('#analytics-metric').selectOption('queue');
  assert.equal(await page.locator('#analytics-version-label').isVisible(),false);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile page must not overflow horizontally');
  // Separate synthetic scenario: exercise persistent notice UX and safe reset.
  // No live configuration, telemetry or model server is read by either demo.
  learningServer=createDemoServer({learningMilestone:true});
  await new Promise(resolve=>learningServer.listen(0,'127.0.0.1',resolve));
  const learningOrigin=`http://127.0.0.1:${learningServer.address().port}`;allowedOrigins.add(learningOrigin);
  await page.setViewportSize({width:1440,height:1100});await page.goto(learningOrigin);
  await page.waitForFunction(()=>document.querySelectorAll('.learning-milestone').length===1);
  assert.match(await page.locator('#learning-milestone-items').innerText(),/33\.3%.*42 requests/);
  assert.match(await page.locator('#learning-milestone-items').innerText(),/<No HTML is interpreted\./);
  await page.locator('[data-milestone]').focus();
  const notice=await page.locator('.learning-milestone').elementHandle();
  const updated=await page.locator('#updated').innerText();
  await page.waitForFunction(previous=>document.getElementById('updated').textContent!==previous,updated,{timeout:10000});
  assert.equal(await notice.evaluate(el=>el===document.querySelector('.learning-milestone')),true,'Polling replaced the notice being read');
  assert.equal(await page.locator('[data-milestone]').evaluate(el=>el===document.activeElement),true);
  await page.reload();await page.locator('[data-milestone]').waitFor();
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-predictor="reset_baseline"]').click();
  await page.waitForFunction(()=>document.getElementById('predictor-status').textContent.includes('0 validated models'));
  assert.match(await page.locator('[data-predictor="automatic_training"]').innerText(),/on/);
  assert.match(await page.locator('[data-predictor="automatic_promotion"]').innerText(),/on/);
  assert.equal(await page.locator('.learning-milestone').count(),1,'Reset must not erase a historical milestone');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Milestone must wrap on mobile');
  await page.locator('[data-milestone]').click();await page.waitForFunction(()=>document.getElementById('learning-milestones').hidden);
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.device').length===3);
  assert.equal(await page.locator('#learning-milestones').isHidden(),true,'Acknowledged milestone reappeared after reload');
  assert.deepEqual(errors,[]);
  console.log('Saved three synthetic screenshots; verified title, logo, polling, analytics labels, mobile width, persistent milestone dismissal and reset UX.');
} finally {
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(learningServer){learningServer.closeAllConnections();await new Promise(resolve=>learningServer.close(resolve));}
}
