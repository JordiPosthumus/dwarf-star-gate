// Optional browser regression: synthetic API receipts only; never live controls.
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {createDemoServer} from '../examples/dashboard-demo.mjs';
const server=createDemoServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try {
  for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]) {
    const browser=await engine.launch({headless:true,...(name==='chromium'?{channel:process.env.DSG_SCREENSHOT_CHANNEL||'chrome'}:{})});
    try {
      const page=await browser.newPage({viewport:{width:1100,height:850},timezoneId:'UTC'});
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.origin!==origin)return route.abort();
        if(url.pathname!=='/api/genie')return route.continue();
        const response=await route.fetch(),data=await response.json();
        data.provider_actions=Array.from({length:35},(_,i)=>({id:`demo-${i}`,time:Date.UTC(2026,8,4,12)-i*600000,served_by:'pool_fallback',served_on:`demo-worker-${i%3+1}`}));
        await route.fulfill({response,json:data});
      });
      await page.goto(origin+'/#genie');
      const list=page.locator('#genie-action-items');
      await page.waitForFunction(()=>document.querySelectorAll('#genie-action-items li').length===30);
      assert.equal(await list.evaluate(el=>getComputedStyle(el).overflowY),'auto');
      assert.ok(await list.evaluate(el=>el.scrollHeight>el.clientHeight&&el.clientHeight<=320));
      await list.focus();await page.keyboard.press('End');
      await page.waitForFunction(()=>{const el=document.getElementById('genie-action-items');return el.scrollTop>0&&Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<=1;});
      const before=await list.evaluate(el=>el.scrollTop);
      await page.waitForTimeout(17000); // Exercise real periodic status/Genie refresh.
      const after=await list.evaluate(el=>el.scrollTop);
      assert.ok(Math.abs(after-before)<=1,`${name}: ledger scroll changed ${before} → ${after}`);
      const providerCount=await list.locator('strong').evaluateAll(items=>items.filter(el=>el.textContent.startsWith('Pool commandeered')).length);
      assert.ok(providerCount>=28,'Synthetic history should be mostly provider actions');
      await page.locator('#genie-action-filter').selectOption('attention');
      assert.match(await list.innerText(),/No actions match this filter/);
      await page.locator('#genie-action-filter').selectOption('provider');
      assert.equal(await list.locator('li').count(),providerCount);
      await page.locator('#genie-action-filter').selectOption('all');
      assert.equal(await list.locator('li').count(),30);
      await list.evaluate(el=>{el.scrollTop=0;el.blur();});
      if(name==='chromium'&&process.env.DSG_LEDGER_SCREENSHOT)await page.locator('#genie-action-ledger').screenshot({path:process.env.DSG_LEDGER_SCREENSHOT,animations:'disabled'});
      await page.setViewportSize({width:390,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile ledger must not overflow the page');
      console.log(`${name}: 30 newest-first rows, keyboard scroll, refresh preservation and filters passed`);
    } finally {await browser.close();}
  }
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
