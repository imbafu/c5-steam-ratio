// ==UserScript==
// @name         C5 DOTA2 Steam 余额比例分析
// @namespace    https://github.com/imbafu/c5-steam-ratio
// @version      0.3.0
// @description  C5 刀塔2列表的比例、费后余额、成交活跃度与候选筛选；手动低频查询
// @match        https://www.c5game.com/*
// @match        https://c5game.com/*
// @match        https://steamcommunity.com/market/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      steamcommunity.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';
  const KEY = 'c5sr:v1:';
  const TTL = 5 * 60 * 1000;
  const defaults = { maxDiscount: 0.77, minPrice:250, minVolume: 30, maxGap: 15, maxSpread: 5, haircut: 3, extraCost: 0, maxPrice: 5000, only: false, sort: 'discount' };
  function number(text) {
    const match = String(text).replace(/\s/g, '').match(/(?:¥|￥)\s*([\d,]+(?:\.\d+)?)/);
    return match ? Number(match[1].replace(/,/g, '')) : NaN;
  }
  // Invert the fee-added buyer total in integer CNY cents. Each fee floors
  // separately and has a one-cent minimum. A gap is conservatively retained.
  function netCents(gross) {
    if (!Number.isSafeInteger(gross) || gross < 3) return 0;
    let lo = 0, hi = gross;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const total = mid + Math.max(1, Math.floor(mid * 0.05)) + Math.max(1, Math.floor(mid * 0.10));
      if (total <= gross) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  function parseQuote(json, at = Date.now()) {
    if (json.success !== true) throw new Error('Steam 未返回有效报价');
    const lowest = number(json.lowest_price), median = number(json.median_price);
    const volumeText = String(json.volume ?? '').replace(/,/g, '');
    const volume = /^\d+$/.test(volumeText) ? Number(volumeText) : null;
    if (!(lowest > 0) || !Number.isFinite(lowest)) throw new Error('缺少人民币最低价，停止估算');
    return { lowest, median: median > 0 ? median : null, volume, at };
  }
  function analyze(cost, quote, settings, at = Date.now(), special = false) {
    if (!(cost > 0) || !quote || !(quote.lowest > 0)) return null;
    const fresh = Number.isFinite(quote.at) && at >= quote.at && at - quote.at < TTL;
    const base = quote.median > 0 ? Math.min(quote.lowest, quote.median) : quote.lowest;
    const gross = Math.floor(base * (1 - settings.haircut / 100) * 100 + 1e-7);
    const net = netCents(gross) / 100;
    const total = cost + settings.extraCost;
    const gap = quote.median > 0 ? Math.abs(quote.lowest - quote.median) / quote.median * 100 : null;
    const ratio = quote.lowest / cost, netRatio = net / total;
    const book = quote.book;
    const bookFresh = book && at >= book.at && at - book.at < 5 * 60000;
    const bidNet = bookFresh && book.currency === 23 && book.bid > 0 ? netCents(book.bid) / 100 : null;
    const bidRatio = bidNet === null ? null : bidNet / total;
    const discount = net > 0 ? total / net : Infinity;
    const bidDiscount = bidNet > 0 ? total / bidNet : null;
    const spread = bookFresh && book.ask > 0 && book.bid > 0 && book.ask >= book.bid ? (book.ask - book.bid) / book.ask * 100 : null;
    const referenceMet = discount <= settings.maxDiscount;
    const watch = fresh && !special && Number.isSafeInteger(quote.volume) && quote.volume >= settings.minVolume && gap !== null && gap <= settings.maxGap && discount < 1 && cost > settings.minPrice && cost <= settings.maxPrice;
    const candidate = watch && bidDiscount !== null && spread !== null && spread <= settings.maxSpread && book.topQuantity > 0;
    const instant = candidate && bidDiscount < 1;
    const maxBuyPrice = Math.max(0, Math.floor((net * settings.maxDiscount - settings.extraCost) * 100 + 1e-7) / 100);
    return { ratio, netRatio, discount, bidDiscount, maxBuyPrice, referenceMet, net, gain: net - total, gap, fresh, watch, candidate, instant, bidNet, bidRatio, spread, bookFresh };
  }
  function pageBook(ssr, hash, at = Date.now()) {
    let queryData = ssr?.renderContext?.queryData;
    if (typeof queryData === 'string') queryData = JSON.parse(queryData);
    const query = queryData?.queries?.find(q => q.queryKey?.[0] === 'market' && q.queryKey?.[1] === 'orderbook' && q.queryKey?.[2] === 570 && q.queryKey?.[3] === hash);
    if (!query || query.state?.status !== 'success') throw new Error('此页没有对应饰品的公开求购数据');
    // Keep the source timestamp; opening an old page must not rejuvenate its quote.
    const sourceAt = query.state.dataUpdatedAt;
    if (!Number.isFinite(sourceAt) || sourceAt > at || at - sourceAt >= TTL) throw new Error('此页盘口已过期，请正常刷新Steam页面');
    return parseBook({data:{success:true,data:query.state.data}},sourceAt);
  }
  function parseBook(json, at = Date.now()) {
    const b = json?.data?.data;
    if (json?.data?.success !== true || !b || !Number.isInteger(b.eCurrency) || !Number.isSafeInteger(b.amtMaxBuyOrder) || !Number.isSafeInteger(b.amtMinSellOrder) || b.amtMaxBuyOrder < 0 || b.amtMinSellOrder < 0) throw new Error('求购盘口数据无效');
    const topQuantity = Array.isArray(b.rgCompactBuyOrders) && b.rgCompactBuyOrders[0] === b.amtMaxBuyOrder && Number.isSafeInteger(b.rgCompactBuyOrders[1]) ? b.rgCompactBuyOrders[1] : null;
    return { currency:b.eCurrency, bid:b.amtMaxBuyOrder, ask:b.amtMinSellOrder, totalBuy:Number.isSafeInteger(b.cBuyOrders) ? b.cBuyOrders : null, topQuantity, at };
  }
  function stateItems(state) {
    const items = new Map(), seen = new WeakSet();
    function walk(x, depth) {
      if (!x || typeof x !== 'object' || depth > 10 || seen.has(x)) return;
      seen.add(x);
      if (x.appId === 570 && x.marketHashName && (x.itemId || x.id)) items.set(String(x.itemId || x.id), x);
      for (const value of Object.values(x)) walk(value, depth + 1);
    }
    walk(state, 0); return items;
  }
  function readCards(doc, items) {
    return [...doc.querySelectorAll('#market_index .list .el-row > .el-col')].flatMap((col, index) => {
      const link = col.querySelector('a[href^="/dota2/"]'), card = col.querySelector('.goodsCard');
      const id = link?.getAttribute('href')?.match(/^\/dota2\/(\d+)\//)?.[1];
      const price = number(card?.querySelector('.price p')?.textContent || '');
      if (!id || !card || !(price > 0)) return [];
      const item = items.get(id);
      return [{ col, card, id, index, price, name: card.querySelector('h4')?.textContent.trim() || id, hash: item?.marketHashName || null }];
    });
  }
  // Export only in a non-browser test harness.
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { number, netCents, parseQuote, parseBook, pageBook, analyze, stateItems, readCards, defaults, TTL };
    return;
  }
  const storage = {
    get(k, fallback) { try { return GM_getValue(KEY + k, fallback); } catch { return fallback; } },
    set(k, value) { GM_setValue(KEY + k, value); }
  };
  function saveQuote(hash, quote) {
    storage.set('quote:' + hash, quote);
    let index = storage.get('cacheIndex', []);
    if (!Array.isArray(index)) index = [];
    index = index.filter(x => typeof x === 'string' && x !== hash); index.push(hash);
    while (index.length > 500) GM_deleteValue(KEY + 'quote:' + index.shift());
    storage.set('cacheIndex', index);
  }
  if (location.hostname === 'steamcommunity.com') {
    const match = location.pathname.match(/^\/market\/listings\/570\/([^/]+)\/?$/);
    if (!match) return;
    let hash; try { hash = decodeURIComponent(match[1]); } catch { return; }
    const bridge = document.createElement('div');
    bridge.id = 'c5sr-steam-bridge';
    bridge.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;background:#142333;color:white;padding:12px;border-radius:8px;max-width:360px;font:14px/1.6 sans-serif';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '将本页求购报价用于C5推荐';
    const result = document.createElement('div'); result.textContent = '只保存当前饰品盘口；不读取或导出登录凭据。';
    button.onclick = () => {
      try {
        let ssr = unsafeWindow.SSR;
        const dataNode = document.getElementById('valve-ssr-data');
        if (!ssr?.renderContext?.queryData && dataNode) ssr = JSON.parse(dataNode.textContent);
        const book = pageBook(ssr, hash);
        storage.set('pageBook:' + hash, book);
        result.textContent = book.currency === 23 ? `已保存人民币求购 ¥${(book.bid/100).toFixed(2)}，顶档${book.topQuantity ?? '未知'}件。返回C5重新查询/调整筛选即可读取。` : `此页实际盘口币种编号${book.currency}，不会用于人民币收益。`;
      } catch(e) { result.textContent = e.message; }
    };
    bridge.append(button,result); document.body.append(bridge); return;
  }
  let settings = { ...defaults }, cards = [], running = false, stop = false, timer;
  const stored = storage.get('settings', {});
  for (const k of Object.keys(defaults)) if (typeof stored[k] === typeof defaults[k]) settings[k] = stored[k];
  const limits = { maxDiscount: [0.01, 10], minPrice:[0,1000000], minVolume: [0, 1000000], maxGap: [0, 100], maxSpread:[0,100], haircut: [0, 50], extraCost: [0, 10000], maxPrice: [0.01, 1000000] };
  for (const [k, [min, max]] of Object.entries(limits)) if (!Number.isFinite(settings[k]) || settings[k] < min || settings[k] > max) settings[k] = defaults[k];
  if (!storage.get('discountMigration',false)) { settings.maxDiscount=0.77; settings.sort='discount'; storage.set('settings',settings); storage.set('discountMigration',true); }
  if (!storage.get('pricePreferenceMigration',false)) { settings.minPrice=250; if(settings.maxPrice===500)settings.maxPrice=5000; storage.set('settings',settings);storage.set('pricePreferenceMigration',true); }
  if (!['original','discount','bidDiscount','volume','gain'].includes(settings.sort)) settings.sort = 'discount';
  const panel = document.createElement('section'); panel.id = 'c5sr-panel';
  panel.innerHTML = `<strong>C5 → Steam 买入推荐</strong> <span>成本 ÷ Steam扣费后到账 · 越低越好 · 单件优先超过¥250</span>
    <details><summary>筛选与估算设置</summary><div class="c5sr-settings"></div></details>
    <div><button data-action="query">查询本页（最多10件/20次请求）</button> <button data-action="stop">停止</button> <button data-action="clear">清除本页缓存</button>
    <select aria-label="排序"><option value="original">原顺序</option><option value="discount">挂售成本比例升序</option><option value="bidDiscount">求购成本比例升序</option><option value="volume">成交量降序</option><option value="gain">余额增量降序</option></select>
    <label><input type="checkbox" data-only>只看候选</label></div>
    <p class="c5sr-status"></p><small>挂售到账是估算；求购报价仅适用于当前顶档数量。买入前核对实际支付价、可交易/可上市时间及款式宝石。成交量不保证售出速度，Steam余额不能提现。</small>
    <div class="c5sr-ranking"></div>`;
  const style = document.createElement('style');
  style.textContent = `#c5sr-panel{background:#142333;color:#eef3fa;border:1px solid #3e566c;border-radius:8px;padding:14px;margin:12px 0;font:14px/1.6 sans-serif}#c5sr-panel button,#c5sr-panel select,#c5sr-panel input{color:#18232f;background:#fff;border-radius:4px;padding:4px;margin:4px}#c5sr-panel input[type=number]{width:82px}.c5sr-settings{display:flex;flex-wrap:wrap;gap:12px}.c5sr-tag{font:12px/1.7 sans-serif;padding:8px;background:#eaf0f6;color:#223344;white-space:normal;border-radius:4px}.c5sr-candidate{background:#d8f4df;color:#154825}.c5sr-ranking a{color:#9ad5ff}.c5sr-ranking{max-height:250px;overflow:auto}.c5sr-hidden{display:none!important}`;
  document.head.append(style);
  style.textContent += '.c5sr-ranking table{border-collapse:collapse;min-width:950px;width:100%;font-size:12px}.c5sr-ranking th,.c5sr-ranking td{padding:7px;border-bottom:1px solid #3e566c;text-align:left}.c5sr-ranking th{white-space:nowrap}.c5sr-ranking{max-height:360px}.c5sr-ranking td a{display:block}';
  const labels = { maxDiscount: '挂售参考比例', minPrice:'单件买入价高于¥', minVolume: '最低Steam近期成交量', maxGap: '最大中位价偏差%', maxSpread:'最大盘口价差%', haircut: '售价折让%', extraCost: '单件额外成本¥', maxPrice: '最高C5售价¥' };
  for (const [key, label] of Object.entries(labels)) {
    const wrap = document.createElement('label'); wrap.textContent = label;
    const input = document.createElement('input'); input.type = 'number'; input.step = key === 'minVolume' ? '1' : '0.01'; input.min = limits[key][0]; input.max = limits[key][1]; input.value = settings[key];
    input.onchange = () => { const value = Number(input.value); if (input.value === '' || !Number.isFinite(value) || value < limits[key][0] || value > limits[key][1]) { input.value = settings[key]; return; } settings[key] = value; storage.set('settings', settings); render(); };
    wrap.append(input); panel.querySelector('.c5sr-settings').append(wrap);
  }
  const status = (message) => { panel.querySelector('.c5sr-status').textContent = message; };
  panel.querySelector('select').value = settings.sort;
  panel.querySelector('select').onchange = e => { settings.sort = e.target.value; storage.set('settings', settings); render(); };
  panel.querySelector('[data-only]').checked = settings.only;
  panel.querySelector('[data-only]').onchange = e => { settings.only = e.target.checked; storage.set('settings', settings); render(); };
  function cached(hash) {
    const q = storage.get('quote:' + hash, null);
    if (!q || !Number.isFinite(q.lowest) || !(q.lowest > 0) || !Number.isFinite(q.at)) return null;
    const fromPage = storage.get('pageBook:' + hash,null);
    if (fromPage?.currency === 23 && Number.isFinite(fromPage.at) && Date.now() >= fromPage.at && Date.now()-fromPage.at < TTL && (!q.book || q.book.currency !== 23 || fromPage.at > q.book.at)) return {...q,book:fromPage};
    return q;
  }
  function scan() {
    const list = document.querySelector('#market_index .list');
    if (!/^\/dota2\/?$/.test(location.pathname) || !list) { panel.remove(); cards = []; return; }
    if (!panel.isConnected) list.before(panel);
    const items = stateItems(unsafeWindow.$nuxt?.$store?.state);
    // Nuxt page component data holds the current page after client-side navigation.
    const components = [unsafeWindow.$nuxt]; const seen = new Set();
    while (components.length && seen.size < 300) {
      const comp = components.shift(); if (!comp || seen.has(comp)) continue; seen.add(comp);
      for (const [id, item] of stateItems(comp.$data)) items.set(id, item);
      components.push(...(comp.$children || []));
    }
    for (const [id, item] of stateItems(unsafeWindow.__NUXT__)) if (!items.has(id)) items.set(id, item);
    cards = readCards(document, items);
    render();
    if (!running) status(`识别 ${cards.length} 个商品；${cards.filter(c => c.hash).length} 个有精确Steam市场名。点击查询后才访问Steam。`);
  }
  const money = n => Number.isFinite(n) ? `¥${n.toFixed(2)}` : '未知';
  function render() {
    panel.querySelector('span').textContent = `成本 ÷ Steam扣费后到账 · 越低越好 · 参考${settings.maxDiscount}（不硬筛）· 单件>${money(settings.minPrice)}`;
    const ranked = [];
    for (const c of cards) {
      const q = c.hash ? cached(c.hash) : null;
      const special = /^(Unusual|Heroic)\b/.test(c.hash || '') || /独特|铭刻宝石|棱彩|虚灵/.test(c.name);
      const a = analyze(c.price, q, settings, Date.now(), special);
      let tag = c.card.querySelector('.c5sr-tag');
      if (!tag) { tag = document.createElement('div'); tag.className = 'c5sr-tag'; c.card.append(tag); }
      tag.classList.toggle('c5sr-candidate', !!a?.candidate);
      const bookText = q?.book && a?.bookFresh ? `求购 ${q.book.currency === 23 ? 'CNY' : q.book.currency === 11 ? 'MYR' : '币种#'+q.book.currency} ${(q.book.bid/100).toFixed(2)} · 顶档 ${q.book.topQuantity ?? '未知'}件 / 总求购 ${q.book.totalBuy ?? '未知'}件\n盘口价差 ${a.spread === null ? '未知' : a.spread.toFixed(1)+'%'} · 求购成本比例 ${a.bidDiscount === null ? '币种未确认' : a.bidDiscount.toFixed(3)}` : '求购盘口未查询或已过期，暂不推荐';
      tag.textContent = !c.hash ? '未找到精确市场名，暂不估算' : !a ? (c.error || 'Steam报价未查询') : `${a.instant ? '★ 求购可成交候选' : a.candidate ? '★ 挂售候选（需等成交）' : a.watch ? '价格可考虑 · 流动性待核验' : '未达推荐条件'}${a.fresh ? '' : ' · 报价已过期'}\nC5 ${money(c.price)} · 估算挂售到账 ${money(a.net)}\n成本 ÷ 扣费到账 = ${a.discount.toFixed(3)} · ${a.referenceMet?'达到参考值':'高于参考值，但不因此排除'}\n参考比例买价上限 ${money(a.maxBuyPrice)} · 余额增量 ${money(a.gain)}\n近期成交 ${q.volume ?? '未知'} · 中位价偏差 ${a.gap === null ? '未知' : a.gap.toFixed(1) + '%'}\n${bookText}${special ? ' · 特殊属性需核验' : ''}${c.error ? '\n'+c.error : ''}`;
      tag.style.whiteSpace = 'pre-line';
      tag.title = q ? `报价时间：${new Date(q.at).toLocaleString()}；Steam最低挂单价与中位价取低，再折让${settings.haircut}%，扣手续费。挂售到账属于估算；求购到账只适用于当前顶档数量。` : '';
      c.col.classList.toggle('c5sr-hidden', settings.only && !a?.candidate);
      // Avoid moving framework-owned DOM: present a separately sorted list.
      if (a) ranked.push({ c, q, a });
    }
    const ranking = panel.querySelector('.c5sr-ranking'); ranking.replaceChildren();
    const summary = document.createElement('strong'); summary.textContent = `本页已报价 ${ranked.length}/${cards.length} 件；推荐 ${ranked.filter(x=>x.a.candidate).length} 件，其中求购可成交 ${ranked.filter(x=>x.a.instant).length} 件。`; ranking.append(summary);
    if (settings.sort !== 'original') {
      ranked.sort((x,y) => Number(y.a.candidate)-Number(x.a.candidate) || Number(y.c.price>settings.minPrice)-Number(x.c.price>settings.minPrice) || (settings.sort === 'volume' ? (y.q.volume ?? -1)-(x.q.volume ?? -1) : settings.sort === 'gain' ? y.a.gain-x.a.gain : (x.a[settings.sort] ?? Infinity)-(y.a[settings.sort] ?? Infinity)) || x.c.index-y.c.index);
      if (!ranked.some(x=>x.a.candidate)) { const empty=document.createElement('p'); empty.textContent='暂无符合门槛且流动性已核验的推荐。下方是待核验/未达标对照，不代表建议买入。'; ranking.append(empty); }
      const table=document.createElement('table'); const head=document.createElement('tr');
      for(const label of ['状态','饰品','买入价','挂售到账估算','成本比例','近期成交量','求购到账','顶档件数','达到参考值的买价上限']) { const th=document.createElement('th'); th.textContent=label; head.append(th); }
      table.append(head);
      for (const { c, a } of ranked.filter(x => !settings.only || x.a.candidate)) {
        const row = document.createElement('tr'), link = document.createElement('a');
        link.href = c.col.querySelector('a').href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = c.name;
        const steam = document.createElement('a'); steam.href=`https://steamcommunity.com/market/listings/570/${encodeURIComponent(c.hash)}`; steam.target='_blank'; steam.rel='noopener noreferrer'; steam.textContent='Steam核验';
        const q=cached(c.hash);
        const values=[a.instant?'求购可成交候选':a.candidate?'挂售候选':'待核验/未达标',null,money(c.price),money(a.net),a.discount.toFixed(3),q?.volume??'未知',money(a.bidNet),a.bookFresh?q?.book?.topQuantity??'未知':'未知',money(a.maxBuyPrice)];
        for(let i=0;i<values.length;i++){const td=document.createElement('td');if(i===1)td.append(link,steam);else td.textContent=values[i];row.append(td);}
        if(!a.fresh) row.firstChild.textContent='报价已过期';
        table.append(row);
      }
      ranking.append(table);
    }
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  function request(hash, isBook = false) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: 'GET', url: isBook ? `https://steamcommunity.com/market/orderbook?q=Load&qp=${encodeURIComponent(JSON.stringify([570,hash]))}&currency=23` : `https://steamcommunity.com/market/priceoverview/?appid=570&currency=23&market_hash_name=${encodeURIComponent(hash)}`, ...(isBook ? {headers:{'x-valve-request-type':'queryAction'}} : {}), anonymous: false, timeout: 15000,
        onload(r) {
          if ([401, 403, 429].includes(r.status) || /captcha|g-recaptcha|cf-chl|sign in/i.test(r.responseText.slice(0,500))) {
            storage.set('cooldown', Date.now() + (r.status === 429 ? 30 : 15) * 60000);
            reject(new Error(`Steam访问受限(${r.status})，暂停本批查询`)); return;
          }
          try { if (r.status !== 200) throw new Error(`Steam HTTP ${r.status}`); resolve((isBook ? parseBook : parseQuote)(JSON.parse(r.responseText))); } catch (e) { reject(e); }
        }, onerror: () => reject(new Error('Steam网络错误，暂停本批查询')), ontimeout: () => reject(new Error('Steam请求超时，暂停本批查询')) });
    });
  }
  async function query() {
    if (running) return;
    if (storage.get('cooldown', 0) > Date.now()) { status('Steam冷却中，请稍后手动查询。'); return; }
    // A shared GM lease reduces overlap between tabs. GM storage is not atomic.
    if (storage.get('lease', { until: 0 }).until > Date.now()) { status('其他C5标签页正在查询，请等待。'); return; }
    const owner = Math.random().toString(36).slice(2);
    storage.set('lease', { owner, until: Date.now() + 30000 });
    await wait(150 + Math.random() * 150);
    if (storage.get('lease', {}).owner !== owner) { status('其他标签页已取得查询队列。'); return; }
    running = true; stop = false; const route = location.href;
    const targets = [...new Map(cards.filter(c => c.hash).map(c => [c.hash, c])).values()].filter(c => { const q = cached(c.hash); return !q || q.at > Date.now() || Date.now() - q.at >= TTL || !q.book || q.book.at > Date.now() || Date.now() - q.book.at >= 5*60000; }).slice(0,10);
    try {
      for (let i = 0; i < targets.length; i++) {
        if (stop || route !== location.href || !targets[i].card.isConnected) break;
        if (storage.get('lease', {}).owner !== owner) throw new Error('查询队列已转交其他标签页');
        if (storage.get('cooldown', 0) > Date.now()) throw new Error('Steam冷却中');
        storage.set('lease', { owner, until: Date.now() + 30000 });
        await wait(Math.max(0, storage.get('nextRequest',0) - Date.now()));
        if (stop || route !== location.href) break;
        storage.set('nextRequest', Date.now() + 5000 + Math.random() * 1500);
        const c = targets[i]; status(`查询 ${i + 1}/${targets.length}：${c.name}`);
        try {
          let q = cached(c.hash);
          if (!q || q.at > Date.now() || Date.now()-q.at >= TTL) { q = await request(c.hash); saveQuote(c.hash, q); render(); }
          storage.set('lease',{owner,until:Date.now()+30000});
          await wait(Math.max(0,storage.get('nextRequest',0)-Date.now()));
          if(stop || route !== location.href) break;
          if(storage.get('lease',{}).owner !== owner) throw new Error('其他标签页取得查询队列');
          storage.set('nextRequest',Date.now()+5000+Math.random()*1500);
          q.book = await request(c.hash,true); saveQuote(c.hash,q); c.error = null;
        }
        catch (e) { c.error = e.message; throw e; }
        render();
      }
      status(stop ? '已停止；已取得的报价已缓存。' : '本批查询结束。报价与盘口缓存5分钟；排序与筛选不会发起请求。');
    } catch (e) { status(e.message); }
    finally { running = false; if (storage.get('lease', {}).owner === owner) storage.set('lease', { until: 0 }); render(); }
  }
  panel.querySelector('[data-action=query]').onclick = query;
  panel.querySelector('[data-action=stop]').onclick = () => { stop = true; status('停止后续请求，当前请求仍可能完成。'); };
  panel.querySelector('[data-action=clear]').onclick = () => { if (running) { status('请先停止并等待当前查询结束。'); return; } for (const c of cards) if (c.hash) storage.set('quote:' + c.hash, null); render(); status('本页报价缓存已清除。'); };
  new MutationObserver(records => {
    if (records.every(r => r.target.closest?.('#c5sr-panel,.c5sr-tag') || ([...r.addedNodes, ...r.removedNodes].length > 0 && [...r.addedNodes, ...r.removedNodes].every(n => n.nodeType === 1 && n.matches?.('.c5sr-tag,#c5sr-panel'))))) return;
    clearTimeout(timer); timer = setTimeout(scan, 400);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  // Refresh freshness labels even when the user leaves the page idle; no requests.
  setInterval(() => { if (panel.isConnected && !running) render(); },15000);
  scan();
})();
