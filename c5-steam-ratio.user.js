// ==UserScript==
// @name         C5 DOTA2 Steam 余额比例分析
// @namespace    https://github.com/imbafu/c5-steam-ratio
// @version      0.1.0
// @description  C5 刀塔2列表的比例、费后余额、成交活跃度与候选筛选；手动低频查询
// @match        https://www.c5game.com/*
// @match        https://c5game.com/*
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
  const TTL = 30 * 60 * 1000;
  const defaults = { minRatio: 1.15, minBidRatio: 1.05, minVolume: 30, maxGap: 15, maxSpread: 5, haircut: 3, extraCost: 0, maxPrice: 500, only: false, sort: 'original' };
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
    const spread = bookFresh && book.ask > 0 && book.bid > 0 && book.ask >= book.bid ? (book.ask - book.bid) / book.ask * 100 : null;
    const watch = fresh && !special && quote.volume !== null && quote.volume >= settings.minVolume && gap !== null && gap <= settings.maxGap && netRatio >= settings.minRatio && cost <= settings.maxPrice;
    const candidate = watch && bidRatio !== null && bidRatio >= settings.minBidRatio && spread !== null && spread <= settings.maxSpread && book.topQuantity > 0;
    return { ratio, netRatio, net, gain: net - total, gap, fresh, watch, candidate, bidNet, bidRatio, spread, bookFresh };
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
    if (typeof module !== 'undefined') module.exports = { number, netCents, parseQuote, parseBook, analyze, stateItems, readCards, defaults, TTL };
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
  let settings = { ...defaults }, cards = [], running = false, stop = false, timer;
  const stored = storage.get('settings', {});
  for (const k of Object.keys(defaults)) if (typeof stored[k] === typeof defaults[k]) settings[k] = stored[k];
  const limits = { minRatio: [0.1, 10], minBidRatio: [0.1, 10], minVolume: [0, 1000000], maxGap: [0, 100], maxSpread:[0,100], haircut: [0, 50], extraCost: [0, 10000], maxPrice: [0.01, 1000000] };
  for (const [k, [min, max]] of Object.entries(limits)) if (!Number.isFinite(settings[k]) || settings[k] < min || settings[k] > max) settings[k] = defaults[k];
  if (!['original','netRatio','bidRatio','volume','gain'].includes(settings.sort)) settings.sort = 'original';
  const panel = document.createElement('section'); panel.id = 'c5sr-panel';
  panel.innerHTML = `<strong>C5 → Steam 余额</strong> <span>人民币 · 比例越高越好</span>
    <details><summary>筛选与估算设置</summary><div class="c5sr-settings"></div></details>
    <div><button data-action="query">查询本页（最多10件/20次请求）</button> <button data-action="stop">停止</button> <button data-action="clear">清除本页缓存</button>
    <select aria-label="排序"><option value="original">原顺序</option><option value="netRatio">挂单费后比例降序</option><option value="bidRatio">人民币求购费后比例降序</option><option value="volume">成交量降序</option><option value="gain">余额增量降序</option></select>
    <label><input type="checkbox" data-only>只看候选</label></div>
    <p class="c5sr-status"></p><small>最低挂单 ≠ 即时成交；余额不能提现。偏差是最低挂单与成交中位价的差异，并非买卖盘口价差。特殊宝石/独特饰品需人工核验。</small>
    <div class="c5sr-ranking"></div>`;
  const style = document.createElement('style');
  style.textContent = `#c5sr-panel{background:#142333;color:#eef3fa;border:1px solid #3e566c;border-radius:8px;padding:14px;margin:12px 0;font:14px/1.6 sans-serif}#c5sr-panel button,#c5sr-panel select,#c5sr-panel input{color:#18232f;background:#fff;border-radius:4px;padding:4px;margin:4px}#c5sr-panel input[type=number]{width:82px}.c5sr-settings{display:flex;flex-wrap:wrap;gap:12px}.c5sr-tag{font:12px/1.7 sans-serif;padding:8px;background:#eaf0f6;color:#223344;white-space:normal;border-radius:4px}.c5sr-candidate{background:#d8f4df;color:#154825}.c5sr-ranking a{color:#9ad5ff}.c5sr-ranking{max-height:250px;overflow:auto}.c5sr-hidden{display:none!important}`;
  document.head.append(style);
  const labels = { minRatio: '最低挂单费后比例', minBidRatio:'最低人民币求购费后比例', minVolume: '最低Steam近24h成交量', maxGap: '最大中位价偏差%', maxSpread:'最大盘口价差%', haircut: '售价折让%', extraCost: '单件额外成本¥', maxPrice: '最高C5售价¥' };
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
    const ranked = [];
    for (const c of cards) {
      const q = c.hash ? cached(c.hash) : null;
      const special = /^(Unusual|Heroic)\b/.test(c.hash || '') || /独特|铭刻宝石|棱彩|虚灵/.test(c.name);
      const a = analyze(c.price, q, settings, Date.now(), special);
      let tag = c.card.querySelector('.c5sr-tag');
      if (!tag) { tag = document.createElement('div'); tag.className = 'c5sr-tag'; c.card.append(tag); }
      tag.classList.toggle('c5sr-candidate', !!a?.candidate);
      const bookText = q?.book && a?.bookFresh ? `求购 ${q.book.currency === 23 ? 'CNY' : q.book.currency === 11 ? 'MYR' : '币种#'+q.book.currency} ${(q.book.bid/100).toFixed(2)} · 顶档 ${q.book.topQuantity ?? '未知'}件 / 总求购 ${q.book.totalBuy ?? '未知'}件\n盘口价差 ${a.spread === null ? '未知' : a.spread.toFixed(1)+'%'} · 人民币求购费后比例 ${a.bidRatio === null ? '未确认，暂不推荐' : a.bidRatio.toFixed(3)}` : '求购盘口未查询或已过期，暂不推荐';
      tag.textContent = !c.hash ? '未找到精确市场名，暂不估算' : !a ? (c.error || 'Steam报价未查询') : `${a.candidate ? '★ 买入核验候选' : a.watch ? '挂单比例候选 · 求购待确认' : '观察'}${a.fresh ? '' : ' · 缓存已过期'}\nSteam ${money(q.lowest)} / C5 ${money(c.price)} = ${a.ratio.toFixed(3)}\n挂单费后 ${money(a.net)} · 比例 ${a.netRatio.toFixed(3)} · 余额增量 ${money(a.gain)}\n近24h成交 ${q.volume ?? '未知'} · 中位价偏差 ${a.gap === null ? '未知' : a.gap.toFixed(1) + '%'}\n${bookText}${special ? ' · 特殊属性需核验' : ''}${c.error ? '\n'+c.error : ''}`;
      tag.style.whiteSpace = 'pre-line';
      tag.title = q ? `报价时间：${new Date(q.at).toLocaleString()}；Steam最低挂单价与中位价取低，再折让${settings.haircut}%，扣手续费。无买单深度，无法估计立即卖出收益。` : '';
      c.col.classList.toggle('c5sr-hidden', settings.only && !a?.candidate);
      // Avoid moving framework-owned DOM: present a separately sorted list.
      if (a) ranked.push({ c, q, a });
    }
    const ranking = panel.querySelector('.c5sr-ranking'); ranking.replaceChildren();
    if (settings.sort !== 'original') {
      ranked.sort((x, y) => (settings.sort === 'volume' ? (y.q.volume ?? -1) - (x.q.volume ?? -1) : (y.a[settings.sort] ?? -1) - (x.a[settings.sort] ?? -1)) || x.c.index - y.c.index);
      for (const { c, a } of ranked.filter(x => !settings.only || x.a.candidate)) {
        const row = document.createElement('div'), link = document.createElement('a');
        link.href = c.col.querySelector('a').href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = c.name;
        row.append(link, ` — 费后比例 ${a.netRatio.toFixed(3)} · 余额增量 ${money(a.gain)}${a.fresh ? '' : ' · 已过期'}`); ranking.append(row);
      }
    }
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  function request(hash, isBook = false) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: 'GET', url: isBook ? `https://steamcommunity.com/market/orderbook?q=Load&qp=${encodeURIComponent(JSON.stringify([570,hash]))}&currency=23` : `https://steamcommunity.com/market/priceoverview/?appid=570&currency=23&market_hash_name=${encodeURIComponent(hash)}`, ...(isBook ? {headers:{'x-valve-request-type':'queryAction'}} : {}), anonymous: true, timeout: 15000,
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
      status(stop ? '已停止；已取得的报价已缓存。' : '本批查询结束。报价缓存30分钟；排序与筛选不会发起请求。');
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
  scan();
})();
