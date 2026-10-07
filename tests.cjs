const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, 'c5-steam-ratio.user.js'), 'utf8');
const box = { module: { exports: {} } };
vm.runInNewContext(script, box);
const { netCents, parseQuote, parseBook, pageBook, analyze, defaults:appDefaults, stateItems, TTL } = box.module.exports;
const defaults={...appDefaults,minPrice:0};
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
assert.equal(analyze(90, q, defaults, 1000).watch, true);
assert.equal(analyze(100, q, defaults, 1000).candidate, false);
const book = parseBook({data:{success:true,data:{eCurrency:23,amtMaxBuyOrder:14500,amtMinSellOrder:15000,cBuyOrders:100,rgCompactBuyOrders:[14500,3]}}},1000);
assert.equal(analyze(90,{...q,book},defaults,1000).candidate,true);
assert.equal(analyze(90,{...q,book},defaults,1000).instant,true);
assert.equal(analyze(100,{...q,book},defaults,1000).candidate,true);
assert.equal(analyze(100,{...q,book},defaults,1000).referenceMet,false);
const computed=analyze(90,q,defaults,1000);
assert.equal(computed.discount,90/computed.net);
assert.ok((computed.maxBuyPrice+defaults.extraCost)/computed.net<=0.77);
assert.ok((computed.maxBuyPrice+0.01+defaults.extraCost)/computed.net>0.77);
const rawBook={eCurrency:23,amtMaxBuyOrder:14500,amtMinSellOrder:15000,cBuyOrders:100,rgCompactBuyOrders:[14500,3]};
const pageSSR={renderContext:{queryData:JSON.stringify({queries:[{queryKey:['market','orderbook',570,'Test'],state:{status:'success',data:rawBook,dataUpdatedAt:1000}}]})}};
assert.equal(pageBook(pageSSR,'Test',1000).currency,23);
assert.throws(()=>pageBook(pageSSR,'Other',1000));
assert.throws(()=>pageBook(pageSSR,'Test',1000+TTL));
assert.equal(analyze(90,{...q,book:{...book,currency:11}},defaults,1000).candidate,false);
assert.equal(analyze(90,{...q,book:{...book,at:1000-5*60000}},defaults,1000).candidate,false);
const waitBook={...book,bid:14300,ask:15000};
assert.equal(analyze(124.5,{...q,book:waitBook},defaults,1000).candidate,true);
assert.equal(analyze(124.5,{...q,book:waitBook},defaults,1000).instant,false);
const expensive={lowest:500,median:490,volume:100,at:1000,book:{...book,bid:48000,ask:50000}};
assert.equal(analyze(199.99,expensive,appDefaults,1000).candidate,false);
assert.equal(analyze(200,expensive,appDefaults,1000).candidate,true);
assert.equal(analyze(400,expensive,appDefaults,1000).candidate,true);
assert.equal(analyze(400,expensive,appDefaults,1000).referenceMet,false);
assert.throws(()=>parseBook({data:{success:true,data:{eCurrency:23,amtMaxBuyOrder:'14500'}}}));
assert.equal(analyze(90, {...q,book}, defaults, 1000 + TTL).candidate, false);
assert.equal(analyze(90, { ...q, book, volume: null }, defaults, 1000).candidate, false);
assert.equal(analyze(90, { ...q, book, median: null }, defaults, 1000).candidate, false);
assert.equal(analyze(90, { ...q, book, lowest: 500 }, defaults, 1000).candidate, false);
assert.equal(analyze(90, {...q,book}, defaults, 1000, true).candidate, false);
assert.equal(analyze(90, {...q,book}, { ...defaults, extraCost: 100 }, 1000).candidate, false);
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
      window.__testStore = new Map(); window.__testRequests = []; window.__testAnonymous = [];
      window.GM_getValue = (k, fallback) => window.__testStore.has(k) ? window.__testStore.get(k) : fallback;
      window.GM_setValue = (k, v) => window.__testStore.set(k, v);
      window.GM_xmlhttpRequest = options => {
        window.__testRequests.push(options.url);
        window.__testAnonymous.push(options.anonymous);
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
    await page.locator('#c5sr-panel select').selectOption('discount');
    assert.ok(await page.locator('.c5sr-ranking a').count() > 0);
    const rows=await page.locator('.c5sr-ranking tr').evaluateAll(rows=>rows.slice(1).map(r=>({price:Number(r.children[2].textContent.replace('¥','')),cost:Number(r.children[4].textContent)})));
    assert.ok(rows.every((r,i)=>r.price>=200 && (i===0 || r.cost>=rows[i-1].cost)),'all rows meet minimum and sort by ascending ratio');
    assert.match(await page.locator('.c5sr-tag').first().textContent(), /估算挂售到账 ¥124.84/);
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
    assert.equal(await page.evaluate(() => window.__testAnonymous[0]), false);
    await page.locator('[data-action=query]').click();
    assert.match(await status.textContent(), /冷却中/);
    assert.equal(await page.evaluate(() => window.__testRequests.length), 1);
    await page.screenshot({ path: path.join(__dirname,'research/browser-test.png'), fullPage:false });
    fs.writeFileSync(path.join(__dirname, 'research/browser-test.json'), JSON.stringify({ date:new Date().toISOString(), url:page.url(), cards:42, exactNames:42, checks:['no automatic requests','fee rendering','sorting','filtering','429 stop','persistent cooldown'], pageErrors:errors }, null, 2));
    console.log('PASS: C5 DOM replay, 42 exact names, UI math/filter/sort, simulated HTTP 429/cooldown. Steam request mocked; Tampermonkey integration not tested.');
    const steamPage=await browser.newPage();
    await steamPage.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body>Steam fixture</body></html>'}));
    await steamPage.goto('https://steamcommunity.com/market/listings/570/Test');
    await steamPage.evaluate(b=>{
      window.unsafeWindow=window; window.__store=new Map();
      window.GM_getValue=(k,f)=>window.__store.has(k)?window.__store.get(k):f;
      window.GM_setValue=(k,v)=>window.__store.set(k,v);
      window.SSR={renderContext:{queryData:JSON.stringify({queries:[{queryKey:['market','orderbook',570,'Test'],state:{status:'success',data:b,dataUpdatedAt:Date.now()}}]})}};
    },rawBook);
    await steamPage.addScriptTag({content:script});
    await steamPage.locator('#c5sr-steam-bridge button').click();
    assert.match(await steamPage.locator('#c5sr-steam-bridge').textContent(),/已保存人民币求购/);
    assert.equal(await steamPage.evaluate(()=>window.__store.get('c5sr:v1:pageBook:Test').currency),23);
    await steamPage.close();
    console.log('PASS: same-item CNY page bridge, source freshness, ratio direction and session request setting');
  } catch(e) { console.log('Failure URL:',page.url()); await page.screenshot({path:path.join(__dirname,'research/failure.png')}); throw e; }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });


