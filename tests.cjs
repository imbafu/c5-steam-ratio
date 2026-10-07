const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, 'c5-steam-ratio.user.js'), 'utf8');
const box = { module: { exports: {} } };
vm.runInNewContext(script, box);
const { netCents, parseQuote, parseBook, analyze, defaults, stateItems, TTL } = box.module.exports;
for (let gross = 0; gross <= 100000; gross++) {
  const net = netCents(gross);
  const total = n => n + Math.max(1, Math.floor(n * .05)) + Math.max(1, Math.floor(n * .10));
  if (gross >= 3) {
    assert.ok(total(net) <= gross);
    assert.ok(total(net + 1) > gross);
  } else assert.equal(net, 0);
}
assert.equal(netCents(11500), 10000);
assert.equal(netCents(3), 1);
assert.equal(netCents(2), 0);
const quote = parseQuote({ success: true, lowest_price: '¥ 1,234.56', median_price: '¥ 1,200.00', volume: '1,234' }, 1000);
assert.equal(quote.lowest, 1234.56); assert.equal(quote.volume, 1234);
assert.throws(() => parseQuote({ success: true, lowest_price: '$ 10.00' }));
assert.throws(() => parseQuote({ success: false }));
const q = { lowest: 150, median: 148, volume: 80, at: 1000 };
assert.equal(analyze(100, q, defaults, 1000).watch, true);
assert.equal(analyze(100, q, defaults, 1000).candidate, false);
const book = parseBook({data:{success:true,data:{eCurrency:23,amtMaxBuyOrder:14500,amtMinSellOrder:15000,cBuyOrders:100,rgCompactBuyOrders:[14500,3]}}},1000);
assert.equal(analyze(100,{...q,book},defaults,1000).candidate,true);
assert.equal(analyze(100,{...q,book:{...book,currency:11}},defaults,1000).candidate,false);
assert.equal(analyze(100,{...q,book:{...book,at:1000-5*60000}},defaults,1000).candidate,false);
assert.throws(()=>parseBook({data:{success:true,data:{eCurrency:23,amtMaxBuyOrder:'14500'}}}));
assert.equal(analyze(100, q, defaults, 1000 + TTL).candidate, false);
assert.equal(analyze(100, { ...q, volume: null }, defaults, 1000).candidate, false);
assert.equal(analyze(100, { ...q, median: null }, defaults, 1000).candidate, false);
assert.equal(analyze(100, { ...q, lowest: 500 }, defaults, 1000).candidate, false);
assert.equal(analyze(100, q, defaults, 1000, true).candidate, false);
assert.equal(analyze(100, q, { ...defaults, extraCost: 100 }, 1000).candidate, false);
assert.equal(analyze(0, q, defaults, 1000), null);
const cycle = { appId: 570, itemId: 123, marketHashName: 'Test' }; cycle.self = cycle;
assert.equal(stateItems(cycle).size, 1);
console.log('PASS: fee inversion 100001 buyer totals, currency parsing, stale/missing data, thresholds, special items, state cycles');

if (process.argv.includes('--browser')) (async () => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    if (process.argv.includes('--live')) {
      await page.goto('https://www.c5game.com/dota2', { waitUntil: 'domcontentloaded', timeout: 45000 });
    } else {
      // Offline replay of the actual public HTML; no bypass of C5 console-ban.
      const raw = fs.readFileSync(path.join(__dirname,'fixtures/c5-dota2.html'),'utf8');
      const safeData = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/items.json'),'utf8'));
      const safeHtml = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
      await page.route('**/*', route => route.request().isNavigationRequest() ? route.fulfill({contentType:'text/html',body:safeHtml}) : route.abort());
      await page.goto('https://www.c5game.com/dota2');
      await page.evaluate(data => { window.__NUXT__={data}; }, safeData);
    }
    await page.locator('#market_index .goodsCard').first().waitFor({ timeout: 20000 });
    await page.evaluate(() => {
      window.unsafeWindow = window;
      window.__testStore = new Map(); window.__testRequests = [];
      window.GM_getValue = (k, fallback) => window.__testStore.has(k) ? window.__testStore.get(k) : fallback;
      window.GM_setValue = (k, v) => window.__testStore.set(k, v);
      window.GM_xmlhttpRequest = options => {
        window.__testRequests.push(options.url);
        setTimeout(() => options.onload({ status: window.__testStatus || 200, responseText: window.__testStatus === 429 ? '{}' : JSON.stringify({ success: true, lowest_price: '¥ 150.00', median_price: '¥ 148.00', volume: '80' }) }), 20);
      };
    });
    await page.addScriptTag({ content: script });
    const status = page.locator('.c5sr-status');
    assert.match(await status.textContent(), /识别 42 个商品；42 个有精确Steam市场名/);
    assert.equal(await page.locator('.c5sr-tag').count(), 42);
    await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(() => window.__testRequests.length), 0);
    // Seed fresh synthetic quotes to test math and rendering without bulk Steam requests.
    await page.evaluate(() => {
      const find = x => { if (!x || typeof x !== 'object') return; if (x.marketHashName && x.appId === 570) window.__testStore.set('c5sr:v1:quote:' + x.marketHashName, { lowest:150, median:148, volume:80, at:Date.now() }); Object.values(x).forEach(find); };
      find(window.__NUXT__.data); find(window.__NUXT__.fetch);
    });
    await page.locator('#c5sr-panel select').selectOption('netRatio');
    assert.ok(await page.locator('.c5sr-ranking a').count() > 0);
    assert.match(await page.locator('.c5sr-tag').first().textContent(), /费后 ¥124.84/);
    await page.locator('[data-only]').check();
    assert.ok(await page.locator('.c5sr-hidden').count() > 0);
    await page.locator('[data-only]').uncheck();
    assert.equal(await page.locator('.c5sr-hidden').count(), 0);
    await page.locator('[data-action=clear]').click();
    await page.evaluate(() => { window.__testStatus = 429; });
    await page.locator('[data-action=query]').click();
    await page.waitForTimeout(1000);
    assert.match(await status.textContent(), /访问受限\(429\)/);
    assert.equal(await page.evaluate(() => window.__testRequests.length), 1);
    await page.locator('[data-action=query]').click();
    assert.match(await status.textContent(), /冷却中/);
    assert.equal(await page.evaluate(() => window.__testRequests.length), 1);
    await page.screenshot({ path: path.join(__dirname,'research/browser-test.png'), fullPage:false });
    fs.writeFileSync(path.join(__dirname, 'research/browser-test.json'), JSON.stringify({ date:new Date().toISOString(), url:page.url(), cards:42, exactNames:42, checks:['no automatic requests','fee rendering','sorting','filtering','429 stop','persistent cooldown'], pageErrors:errors }, null, 2));
    console.log('PASS: C5 DOM replay, 42 exact names, UI math/filter/sort, simulated HTTP 429/cooldown. Steam request mocked; Tampermonkey integration not tested.');
  } catch(e) { console.log('Failure URL:',page.url()); await page.screenshot({path:path.join(__dirname,'research/failure.png')}); throw e; }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
