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
let browser,learningServer,holdServer;
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,channel:process.env.DSG_SCREENSHOT_CHANNEL||undefined});
  const context=await browser.newContext({viewport:{width:1440,height:1100},deviceScaleFactor:1,locale:'en-US',timezoneId:'UTC',reducedMotion:'reduce'});
  const errors=[];
  const allowedOrigins=new Set([origin]);
  let workerControlFailures=1;
  await context.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());
    if(allowedOrigins.has(url.origin)&&url.pathname==='/api/workers'&&request.method()==='GET'&&workerControlFailures-- > 0)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Worker controls unavailable'})});
    if(allowedOrigins.has(url.origin))return route.continue();
    errors.push('Unexpected non-demo network request');return route.abort();
  });
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(()=>document.getElementById('routing-message').classList.contains('error'));
  await page.waitForFunction(()=>document.getElementById('routing-message').textContent===''&&!document.getElementById('routing-message').classList.contains('error'));
  await page.waitForFunction(()=>document.querySelectorAll('.device').length===3&&document.querySelectorAll('#genie-reports details').length===1&&document.querySelectorAll('#analytics-chart circle').length>0);
  await page.setViewportSize({width:951,height:900});
  assert.equal(await page.locator('.device').evaluateAll(cards=>cards.every(card=>{
    const box=card.getBoundingClientRect(),header=card.querySelector('.device-top');
    return header.scrollWidth<=header.clientWidth&&[...header.querySelectorAll('.remaining-estimate,.server-verdict,.badge,.routing-toggle')].every(el=>el.getBoundingClientRect().right<=box.right+.5);
  })),true,'Narrow server-card headers must keep ETA, backlog, phase and routing controls inside the card');
  await page.setViewportSize({width:1440,height:1100});
  for(const width of [390,750,1440]){
    await page.setViewportSize({width,height:1100});
    assert.equal(await page.locator('.dashboard-header').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'Unified header must fit without horizontal overflow');
    assert.equal(await page.locator('#connection').isVisible(),true);
    assert.equal(await page.getByRole('link',{name:'Download a DSG debug snapshot'}).isVisible(),true);
  }
  assert.equal(await page.locator('header').count(),1,'No separate empty branding strip');
  assert.ok((await page.locator('.dashboard-header').boundingBox()).height<180,'Desktop header stays compact');
  assert.ok(await page.locator('#devices .chart-gap-line').count()>=4,'Demo includes compressed gaps for both rate charts');
  assert.equal(await page.locator('#devices .chart-bridge,#devices .chart-pause-dot').count(),0);
  const pause=page.locator('#devices .chart-gap').first();
  assert.match(await pause.getAttribute('aria-label'),/no interpolated speed/);
  assert.equal(await pause.locator('.chart-gap-line').evaluate(el=>getComputedStyle(el).stroke),'rgb(196, 135, 135)');
  assert.equal(await page.locator('.phase-legend').count(),0,'No repeated legend text beneath the activity bars');
  for(const [kind,ceiling] of [['prefill',1250.5],['decode',40.5]]){
    const labels=await page.locator(`#devices .chart.${kind}`).evaluateAll(charts=>charts.map(chart=>chart.getAttribute('aria-label')));
    assert.equal(labels.length,3);assert.ok(labels.every(label=>label.includes(`zero to ${ceiling} tokens`)),'Every worker shares its phase record scale');
  }
  for(const [kind,color] of [['prefill','rgb(120, 174, 232)'],['decode','rgb(185, 216, 137)']]){
    assert.equal(await page.locator(`.activity-timeline .phase-${kind}`).first().evaluate(el=>getComputedStyle(el).fill),color);
    assert.equal(await page.locator(`.rate.${kind}`).first().evaluate(el=>getComputedStyle(el).color),color);
    assert.equal(await page.locator(`.chart.${kind} polyline`).first().evaluate(el=>getComputedStyle(el).stroke),color);
    assert.equal(await page.locator(`.chart.${kind} circle`).first().evaluate(el=>getComputedStyle(el).fill),color);
  }
  await pause.focus();assert.equal(await pause.evaluate(el=>el===document.activeElement),true);
  const thinking=page.locator('#devices .requested-thinking').first();
  assert.match(await thinking.innerText(),/^Thinking\s+/);
  assert.doesNotMatch(await thinking.innerText(),/Current request|REQUESTED THINKING/);
  assert.ok((await thinking.boundingBox()).height<40,'Thinking settings use a compact single row');
  assert.equal(await page.locator('#devices .metric-block>.label').first().innerText(),'DECODE');
  assert.equal(await page.locator('#devices .metric-block>.label').nth(1).innerText(),'PREFILL');
  assert.equal(await page.locator('#tab-fleet').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('#view-fleet').isVisible(),true);
  assert.equal(await page.locator('#view-genie').isHidden(),true);
  await page.locator('#tab-fleet').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tab-genie').getAttribute('aria-selected'),'true');
  assert.equal(new URL(page.url()).hash,'#genie');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#tab-fleet').getAttribute('aria-selected'),'true');
  assert.equal(new URL(page.url()).hash,'');
  await page.locator('#tab-genie').click();
  const enrollmentGuide=page.getByRole('link',{name:'Setup guide for your agent ↗'});
  assert.equal(await enrollmentGuide.count(),1);
  assert.equal(await enrollmentGuide.getAttribute('href'),'https://github.com/JordiPosthumus/dwarf-star-gate/blob/main/docs/agent-recovery-enrollment.md');
  assert.equal(await enrollmentGuide.getAttribute('rel'),'noopener noreferrer');
  assert.equal(await enrollmentGuide.evaluate(el=>getComputedStyle(el).textDecorationLine),'underline');
  assert.match(await enrollmentGuide.locator('..').innerText(),/does not grant restart permission/);
  assert.equal(await page.locator('#genie-hardening').isVisible(),true);
  assert.equal(await page.locator('#agent-watch').isVisible(),true);
  assert.match(await page.locator('#agent-watch-status').innerText(),/2 enrolled.*2 fresh/);
  await page.locator('#agent-watch summary').click();
  assert.match(await page.locator('#agent-watch-items').innerText(),/waiting inside DSG.*local tool active/s);
  assert.doesNotMatch(await page.locator('#agent-watch').innerText(),/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  assert.match(await page.locator('#genie-hardening-status').innerText(),/1 suggestion.*1 durable.*newest first/);
  await page.locator('#genie-hardening summary').click();
  assert.match(await page.locator('#genie-hardening-items').innerText(),/Exercise incomplete-stream continuation.*Developer suggestion|Exercise incomplete-stream continuation/s);
  await page.locator('#genie-hardening summary').click();
  assert.equal(await page.locator('#routing-message').innerText(),'','A successful control read must clear a stale error banner');
  assert.equal(await page.locator('h1').innerText(),'Dwarf Star Gate');
  assert.match(await page.locator('#connection').innerText(),/Demo/);
  await page.locator('#tab-analytics').click();
  await page.locator('details.predictor-panel>summary').click();
  assert.match(await page.locator('#predictor-status').innerText(),/0 validated models/);
  assert.equal(await page.locator('#predictor-recipe option').count(),3);
  assert.equal(await page.locator('#predictor-recipe').inputValue(),'standard-v1');
  assert.match(await page.locator('#calibration-status').innerText(),/skipped.*cache-preserving/);
  await page.locator('.analytics-collection>summary').click();
  assert.match(await page.locator('#embedding-detail').innerText(),/384 dimensions/);
  await page.locator('.analytics-collection>summary').click();
  await page.locator('#tab-fleet').click();
  await page.waitForFunction(()=>document.getElementById('fleet-decode-speed').textContent!=='—');
  assert.equal(await page.locator('#fleet-speed-window').inputValue(),'12h');
  assert.equal(await page.locator('#fleet-decode-speed').innerText(),'20');
  assert.equal(await page.locator('#fleet-prefill-speed').innerText(),'680');
  assert.match(await page.locator('#fleet-speed-value').innerText(),/tok · ≈.* kWh · .* tok\/kWh/);
  assert.match(await page.locator('#fleet-speed-summary').getAttribute('title'),/duration-weighted active mean/i);
  assert.match(await page.locator('#fleet-speed-summary').getAttribute('title'),/measured.?power/i);
  assert.equal(await page.locator('.hardware-strip').count(),3);
  assert.equal(await page.locator('.hardware-reading').count(),9);
  assert.match(await page.locator('.hardware-reading.memory').first().getAttribute('title'),/not dedicated GPU RAM/);
  assert.match(await page.locator('.hardware-reading.power').first().getAttribute('title'),/energy integration/);
  await page.locator('#fleet-speed-window').selectOption('1h');
  const speedPoll=await page.locator('#updated').innerText();
  await page.waitForFunction(previous=>document.getElementById('updated').textContent!==previous,speedPoll,{timeout:10000});
  assert.equal(await page.locator('#fleet-speed-window').inputValue(),'1h','Polling must preserve the selected fleet-speed window');
  await page.reload();await page.waitForFunction(()=>document.getElementById('fleet-decode-speed').textContent!=='—');
  assert.equal(await page.locator('#fleet-speed-window').inputValue(),'1h','Fleet-speed window is a browser-local preference');
  await page.locator('#fleet-speed-window').selectOption('12h');
  assert.match(await page.locator('#continuity-door-status').innerText(),/Continuity Door ready.*2 active proxied streams.*no request-body spooling or replay/);
  assert.equal(await page.locator('#fleet-summary').count(),0);
  assert.match(await page.locator('#capacity-note').getAttribute('title'),/mac-ultra is free; sparkA's next queued session keeps its warm home for up to 4m more; then the DSG core may hand it over automatically/);
  assert.ok(await page.locator('.gate-art').evaluate(img=>img.complete&&img.naturalWidth>0));
  const statusBand=await page.locator('.status-deck').boundingBox(),activityTab=await page.locator('#tab-activity').boundingBox(),settingsTab=await page.locator('#tab-settings').boundingBox();
  assert.ok(statusBand&&statusBand.height<150,`Fleet status band is too tall: ${statusBand?.height}px`);
  assert.ok(activityTab&&settingsTab&&settingsTab.x>activityTab.x+activityTab.width,'Settings must be the far-right workspace tab');
  const output=path.join(projectRoot,'docs/images');await fs.mkdir(output,{recursive:true});
  await page.locator('#tab-settings').click();
  await page.locator('#queue-timeout-form').waitFor();
  assert.equal(await page.locator('#queue-timeout-input').inputValue(),'20000');
  await page.locator('#queue-timeout-input').fill('21000');
  const queuePoll=await page.locator('#updated').innerText();
  await page.waitForFunction(previous=>document.getElementById('updated').textContent!==previous,queuePoll,{timeout:10000});
  assert.equal(await page.locator('#queue-timeout-input').inputValue(),'21000','Polling must preserve unsaved queue edits');
  await page.getByRole('button',{name:'Save queue allowance',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('queue-timeout-current').textContent.includes('21,000'));
  await page.locator('#queue-timeout-input').fill('20000');page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Save queue allowance',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('queue-timeout-current').textContent.includes('20,000'));
  await page.reload();await page.locator('#queue-timeout-form').waitFor();
  assert.equal(await page.locator('#queue-timeout-input').inputValue(),'20000');
  assert.match(await page.locator('#relocation-controls').innerText(),/Safe queued handovers.*configured first-refusal window.*gateway core may move/s);
  assert.equal(await page.locator('#relocation-offers button').count(),1);
  assert.match(await page.locator('#relocation-offers button').getAttribute('title'),/warm cache/);
  const maintenanceRow=page.locator('#worker-rows tr').filter({hasText:'mac-ultra'}),answers=['spark-speed-test','External DS4 benchmark in progress','4'];
  const answerDialogs=dialog=>dialog.accept(answers.shift());page.on('dialog',answerDialogs);
  await maintenanceRow.getByRole('button',{name:'Maintenance lock',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('worker-rows').textContent.includes('Maintenance: spark-speed-test'));
  page.off('dialog',answerDialogs);assert.equal(answers.length,0);
  assert.equal(await maintenanceRow.locator('[data-action="resume"]').isDisabled(),true);
  assert.match(await maintenanceRow.innerText(),/MAINTENANCE LOCK · NOT ROUTING/);
  await page.locator('#worker-management').screenshot({path:path.join(output,'worker-management.png'),animations:'disabled'});
  page.once('dialog',dialog=>dialog.accept('Benchmark complete and endpoint checked'));
  await maintenanceRow.getByRole('button',{name:'Release spark-speed-test',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('worker-rows').textContent.includes('Maintenance: spark-speed-test')&&document.getElementById('worker-rows').textContent.includes('Operator pause'));
  await maintenanceRow.getByRole('button',{name:'Resume routing',exact:true}).click();
  await maintenanceRow.getByText('ROUTING ENABLED',{exact:true}).waitFor();
  await page.locator('#tab-fleet').click();
  await page.waitForFunction(()=>document.querySelectorAll('.device').length===3&&document.querySelectorAll('#analytics-chart circle').length>0);
  await page.evaluate(()=>window.scrollTo(0,0));
  const devices=await page.locator('#devices').boundingBox();
  await page.screenshot({path:path.join(output,'dashboard-overview.png'),fullPage:true,clip:{x:0,y:0,width:1440,height:Math.ceil(devices.y+devices.height+24)},animations:'disabled'});
  await page.locator('#tab-genie').click();
  await page.locator('#genie-reports summary').click();
  // A real poll must not collapse the open report; don't replace DOM to stage screenshots.
  const checked=await page.locator('#updated').innerText();
  await page.waitForFunction(previous=>document.getElementById('updated').textContent!==previous,checked,{timeout:10000});
  assert.equal(await page.locator('#genie-reports details').getAttribute('open'),'');
  await page.locator('#view-genie').screenshot({path:path.join(output,'dashboard-genie.png'),animations:'disabled'});
  await page.locator('#tab-analytics').click();
  await page.locator('#analytics-question').selectOption('remaining');
  await page.waitForFunction(()=>document.querySelectorAll('#analytics-chart circle').length===20);
  assert.match(await page.locator('#analytics-status').innerText(),/Synthetic demo/);
  assert.equal(await page.locator('#analytics-version-label').isVisible(),true);
  assert.match(await page.locator('#predictor-models').textContent(),/3 known sessions · 2 requests without identity/);
  await page.locator('details.predictor-panel').evaluate(el=>{el.open=false;});
  await page.evaluate(()=>window.scrollTo(0,0));
  // Element screenshots scroll tall panels under the sticky tab bar, obscuring
  // the first heading. Capture document coordinates without that auto-scroll.
  await page.screenshot({path:path.join(output,'dashboard-analytics.png'),fullPage:true,clip:await page.locator('#view-analytics').boundingBox(),animations:'disabled'});
  await page.locator('#tab-activity').click();
  await page.locator('#view-activity').screenshot({path:path.join(output,'dashboard-activity.png'),animations:'disabled'});
  for(const [file,minHeight] of [['dashboard-overview.png',950],['dashboard-genie.png',250],['dashboard-analytics.png',700],['dashboard-activity.png',150]]) {
    const png=await fs.readFile(path.join(output,file));
    assert.ok(png.readUInt32BE(20)>=minHeight,`${file}: screenshot was clipped`);
  }
  await page.locator('#tab-analytics').click();await page.locator('#analytics-question').selectOption('queue');
  assert.equal(await page.locator('#analytics-version-label').isVisible(),false);
  await page.locator('details.predictor-panel>summary').click();
  await page.locator('#predictor-recipe').selectOption('interactions-v1');
  const recipePoll=await page.locator('#updated').innerText();
  await page.waitForFunction(previous=>document.getElementById('updated').textContent!==previous,recipePoll,{timeout:10000});
  assert.equal(await page.locator('#predictor-recipe').inputValue(),'interactions-v1','Polling must preserve the operator choice');
  const trainRequest=page.waitForRequest(r=>r.url().endsWith('/api/workers/predictor')&&r.method()==='POST');
  const trainResponse=page.waitForResponse(r=>r.url().endsWith('/api/workers/predictor')&&r.request().method()==='POST');
  await page.locator('[data-predictor="train"]').click();
  assert.deepEqual((await trainRequest).postDataJSON(),{action:'train',recipe_id:'interactions-v1'});
  assert.equal((await trainResponse).ok(),false,'The demo must refuse real training');
  await page.locator('#tab-fleet').click();
  await page.setViewportSize({width:390,height:844});
  const mobileLayout=await page.evaluate(()=>({
    width:window.innerWidth,
    scrollWidth:document.documentElement.scrollWidth,
    overflow:[...document.querySelectorAll('body *')].map(element=>{
      const rect=element.getBoundingClientRect();
      const parent=element.parentElement;const parentRect=parent?.getBoundingClientRect();
      return {tag:element.tagName,id:element.id,className:String(element.className||''),left:rect.left,right:rect.right,width:rect.width,parent:parent?`${parent.tagName}#${parent.id}.${parent.className}`:null,parentWidth:parentRect?.width,parentOverflow:parent?getComputedStyle(parent).overflow:null};
    }).filter(item=>item.right>window.innerWidth+1||item.left<-1).slice(0,50)
  }));
  assert.ok(mobileLayout.scrollWidth<=mobileLayout.width,`Mobile page must not overflow horizontally: ${JSON.stringify(mobileLayout)}`);
  await page.locator('.overview').screenshot({path:path.join(output,'overview-mobile.png'),animations:'disabled'});
  // Separate synthetic scenario: exercise persistent notice UX and safe reset.
  // No live configuration, telemetry or model server is read by either demo.
  learningServer=createDemoServer({learningMilestone:true});
  await new Promise(resolve=>learningServer.listen(0,'127.0.0.1',resolve));
  const learningOrigin=`http://127.0.0.1:${learningServer.address().port}`;allowedOrigins.add(learningOrigin);
  await page.setViewportSize({width:1440,height:1100});await page.goto(learningOrigin);
  await page.waitForFunction(()=>document.querySelectorAll('.learning-milestone').length===1);
  await page.locator('#tab-genie').click();
  assert.match(await page.locator('#learning-milestone-items').innerText(),/33\.3%.*42 requests/);
  assert.match(await page.locator('#learning-milestone-items').innerText(),/<No HTML is interpreted\./);
  await page.locator('[data-milestone]').focus();
  const notice=await page.locator('.learning-milestone').elementHandle();
  const updated=await page.locator('#updated').innerText();
  await page.waitForFunction(previous=>document.getElementById('updated').textContent!==previous,updated,{timeout:10000});
  assert.equal(await notice.evaluate(el=>el===document.querySelector('.learning-milestone')),true,'Polling replaced the notice being read');
  assert.equal(await page.locator('[data-milestone]').evaluate(el=>el===document.activeElement),true);
  await page.reload();await page.locator('[data-milestone]').waitFor();
  await page.locator('#tab-analytics').click();
  await page.locator('details.predictor-panel>summary').click();
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-predictor="reset_baseline"]').click();
  await page.waitForFunction(()=>document.getElementById('predictor-status').textContent.includes('0 validated models'));
  assert.match(await page.locator('[data-predictor="automatic_training"]').innerText(),/on/);
  assert.match(await page.locator('[data-predictor="automatic_promotion"]').innerText(),/on/);
  await page.locator('#tab-genie').click();
  assert.equal(await page.locator('.learning-milestone').count(),1,'Reset must not erase a historical milestone');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Milestone must wrap on mobile');
  await page.locator('[data-milestone]').click();await page.waitForFunction(()=>document.getElementById('learning-milestones').hidden);
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.device').length===3);
  assert.equal(await page.locator('#learning-milestones').isHidden(),true,'Acknowledged milestone reappeared after reload');
  holdServer=createDemoServer({agentHold:true});await new Promise(resolve=>holdServer.listen(0,'127.0.0.1',resolve));
  const holdOrigin=`http://127.0.0.1:${holdServer.address().port}`;allowedOrigins.add(holdOrigin);
  await page.setViewportSize({width:1440,height:1100});await page.goto(holdOrigin);
  await page.locator('#tab-settings').click();
  const held=page.locator('#worker-rows tr').filter({hasText:'mac-ultra'});
  await held.waitFor();assert.match(await held.innerText(),/Held by test-agent: <DS4 compatibility test>/);
  assert.equal(await held.locator('[data-action="resume"]').isDisabled(),true);
  assert.equal(await held.locator('[data-action="remove"]').isDisabled(),true);
  await held.getByRole('button',{name:'Keep paused',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('worker-rows').textContent.includes('Operator pause'));
  assert.equal(await held.getByRole('button',{name:'Keep paused',exact:true}).count(),0);
  const holdPoll=await page.locator('#updated').innerText();await page.waitForFunction(previous=>document.getElementById('updated').textContent!==previous,holdPoll,{timeout:10000});
  assert.match(await held.innerText(),/Held by test-agent/);assert.match(await held.innerText(),/Operator pause/);
  // Isolated synthetic response changes prove that polling cannot move study
  // dots or choose a newer model behind the reader's back.
  const auditPage=await context.newPage();auditPage.on('pageerror',e=>errors.push(e.message));
  let auditData=await(await page.request.get(origin+'/api/analytics')).json();
  await auditPage.route('**/api/analytics',route=>route.fulfill({json:auditData}));
  await auditPage.goto(origin+'/#analytics');
  await auditPage.waitForFunction(()=>document.querySelectorAll('#analytics-chart circle').length>0);
  const studyCount=await auditPage.locator('#analytics-chart circle').count(),studyPin=await auditPage.locator('#analytics-version').inputValue();
  const studyModel=auditData.model_series.find(m=>m.id===studyPin&&m.stage==='admission');
  studyModel.rows.push({...studyModel.rows[1],at:Date.now(),service_ms:99000});
  auditData.model_series.push({...structuredClone(studyModel),id:'f'.repeat(64),last_forecast_at:Date.now()});
  await auditPage.waitForFunction(()=>document.getElementById('analytics-snapshot-note').textContent.includes('Newer evidence'),null,{timeout:20000});
  assert.equal(await auditPage.locator('#analytics-chart circle').count(),studyCount);
  assert.equal(await auditPage.locator('#analytics-version').inputValue(),studyPin);
  assert.match(await auditPage.locator('#analytics-snapshot-note').innerText(),/Newer evidence/);
  await auditPage.locator('#analytics-refresh').click();
  await auditPage.waitForFunction(n=>document.querySelectorAll('#analytics-chart circle').length===n,studyCount+1);
  assert.equal(await auditPage.locator('#analytics-version').inputValue(),studyPin);
  await auditPage.locator('#analytics-latest').click();assert.equal(await auditPage.locator('#analytics-version').inputValue(),'f'.repeat(64));
  await auditPage.locator('#analytics-method').selectOption('reference');
  assert.ok(await auditPage.locator('#analytics-chart circle').count()>0,'Paired reference values are visible separately');
  await auditPage.locator('.analytics-evidence>summary').click();assert.match(await auditPage.locator('#analytics-accounting').innerText(),/not file deletion/);
  for(const width of [390,750,1440]){await auditPage.setViewportSize({width,height:1000});assert.ok(await auditPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Analytics must fit mobile and desktop');}
  // No predictor artifacts, Python runtime, encoder or telemetry history is
  // required to render the optional analytics empty state.
  const freshStatus=await(await page.request.get(origin+'/api/status')).json();
  freshStatus.gateway.predictor=null;freshStatus.gateway.dataset={enabled:false};freshStatus.devices=[];
  await auditPage.route('**/api/status',route=>route.fulfill({json:freshStatus}));
  for(const status of ['disabled','waiting','unavailable']){
    auditData={enabled:status!=='disabled',status,rows:[],model_series:[]};await auditPage.reload();
    await auditPage.waitForFunction(()=>document.getElementById('analytics-counts').textContent.includes('0 eligible'));
    assert.equal(await auditPage.locator('#analytics-chart circle').count(),0);
    assert.match(await auditPage.locator('#analytics-use').innerText(),/Ordinary routing works without models/);
  }
  await auditPage.close();
  assert.deepEqual(errors,[]);
  console.log('Saved six synthetic dashboard screenshots; verified tab navigation, polling, analytics, compact hardware telemetry, named maintenance locks, mobile, reset/milestones, escaped agent holds and Keep paused UX.');
} finally {
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(learningServer){learningServer.closeAllConnections();await new Promise(resolve=>learningServer.close(resolve));}
  if(holdServer){holdServer.closeAllConnections();await new Promise(resolve=>holdServer.close(resolve));}
}
