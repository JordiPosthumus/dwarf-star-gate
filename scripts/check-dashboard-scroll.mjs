// Optional real-browser regression; only synthetic workers, never live controls.
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {createDemoServer} from '../examples/dashboard-demo.mjs';
const server=createDemoServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]) {
    const browser=await engine.launch({headless:true,...(name==='chromium'?{channel:process.env.DSG_SCREENSHOT_CHANNEL||'chrome'}:{})});
    try {
      const page=await browser.newPage({viewport:{width:1000,height:700}});
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(()=>document.querySelectorAll('.device').length===3);
      await page.waitForTimeout(1500);
      await page.evaluate(()=>window.scrollTo(0,1000));
      const before=await page.evaluate(()=>window.scrollY);
      assert.ok(before>500,'Fixture must actually scroll below the page header');
      // Cover status, Genie, analytics and slow chart refresh intervals.
      await page.waitForTimeout(17000);
      const after=await page.evaluate(()=>window.scrollY);
      assert.ok(Math.abs(after-before)<=1,`${name} background refresh moved viewport ${before} → ${after}`);
      console.log(`${name}: viewport preserved at ${after}px across polling`);
    } finally {await browser.close();}
  }
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
