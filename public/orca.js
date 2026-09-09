// public/orca.js
//
// The FireFun launch page. Plain browser JS (no bundler); talks to the
// /api/orca/* routes plus the wallet / token / balance endpoints. api.js
// (loaded first) attaches the session header to every /api call.
//
// State survives reloads in localStorage so a launch interrupted mid-way can
// be resumed with the same wallet: /api/orca/launch skips pools, positions
// and locks that already exist on chain.

(function () {
  'use strict';

  const STORE_KEY = 'firefun.launch.v1';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  // Bind without throwing if the element is missing (a stale cached page
  // paired with a newer script must never abort the rest of this file).
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); else console.warn('missing element', sel); };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  const state = {
    meta: null,
    wallet: null,          // { publicKey, secretKeyB58, qrCode }
    savedSecret: false,
    token: null,           // { mint, name, symbol, totalSupply, decimals, imageUri }
    quotes: {},            // mint -> { on, pct, info, forced, custom }
    customQuotes: [],
    tickSpacing: null,
    ladderSteps: 10,
    config: null,
    estimate: null,
    launch: null,          // { results, plan, feeRate, tickSpacing }
    launching: false,
    finishing: false,
    finish: null,
    destWallet: '',
  };
  let lastBalance = null;

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        // The secret key never persists here: the server's pending-wallet
        // list holds it, and every request resolves the signer by public key.
        wallet: state.wallet ? { publicKey: state.wallet.publicKey, qrCode: state.wallet.qrCode } : null,
        savedSecret: state.savedSecret,
        token: state.token,
        quotes: Object.fromEntries(Object.entries(state.quotes).map(([m, q]) => [m, { on: q.on, pct: q.pct }])),
        customQuotes: state.customQuotes,
        tickSpacing: state.tickSpacing,
        ladderSteps: state.ladderSteps,
        config: state.config,
        launch: state.launch,
        finish: state.finish,
        destWallet: state.destWallet,
        form: {
          name: $('#tokName').value, symbol: $('#tokSymbol').value, supply: $('#tokSupply').value,
          desc: $('#tokDesc').value, mcap: $('#tokMcap').value,
        },
      }));
    } catch (_) { /* storage is a convenience */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function describeError(err) {
    if (err && err.code === 'OP_IN_FLIGHT') {
      return `Another operation ('${err.op}') is still running for this wallet (started ${err.runningForSec}s ago). Wait for it to finish, then try again.`;
    }
    return err && err.message ? err.message : String(err);
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {} };
    if (opts.body instanceof FormData) init.body = opts.body;
    else if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch (_) { data = { success: false, error: `HTTP ${res.status}` }; }
    if (!res.ok || data.success === false) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      Object.assign(err, data);
      throw err;
    }
    return data;
  }

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    if (n >= 1) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (n >= 0.01) return '$' + n.toFixed(4);
    return '$' + n.toPrecision(3);
  }
  function fmtNum(n, d = 4) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (Math.abs(n) >= 0.001) return n.toFixed(d);
    return n.toPrecision(3);
  }
  function fmtPct(n) { return `${Math.round(n * 100) / 100}%`; }
  function short(s, n = 4) { return s ? `${s.slice(0, n)}…${s.slice(-n)}` : ''; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function isPubkey(s) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || '').trim()); }
  function txLink(sig, n = 5) { return sig ? `<a class="mono" target="_blank" rel="noopener" href="https://solscan.io/tx/${esc(sig)}">${short(sig, n)}</a>` : ''; }
  function acctLink(pk, label) { return pk ? `<a class="mono" target="_blank" rel="noopener" href="https://solscan.io/account/${esc(pk)}">${esc(label || short(pk))}</a>` : ''; }
  function ago(unix) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 172800) return 'yesterday';
    return `${Math.floor(s / 86400)}d ago`;
  }
  function jupUrl(sell, buy) { return `https://jup.ag/?sell=${encodeURIComponent(sell)}&buy=${encodeURIComponent(buy)}`; }
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  function setMsg(sel, text, kind) {
    $(sel).innerHTML = text ? `<div class="msg ${kind || ''}">${text}</div>` : '';
  }
  function setPill(sel, text, kind) {
    const el = $(sel);
    if (!text) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.className = `pill right ${kind || ''}`;
  }
  function setStep(sel, status, n) {
    const el = $(sel);
    el.className = `step ${status}`;
    el.textContent = status === 'done' ? '✓' : String(n);
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ---- base58 (Solana alphabet) ---------------------------------------
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58decode(str) {
    const bytes = [0];
    for (const ch of str) {
      const v = B58.indexOf(ch);
      if (v < 0) throw new Error('not base58');
      let carry = v;
      for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (const ch of str) { if (ch !== '1') break; bytes.push(0); }
    return Uint8Array.from(bytes.reverse());
  }
  function b58encode(bytes) {
    const digits = [0];
    for (const b of bytes) {
      let carry = b;
      for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = '';
    for (const b of bytes) { if (b !== 0) break; out += '1'; }
    for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
    return out;
  }
  // Accepts a base58 64-byte secret or a JSON array; returns { secretKey, publicKey }.
  function parseSecretKey(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    let bytes;
    if (text.startsWith('[')) bytes = Uint8Array.from(JSON.parse(text));
    else bytes = b58decode(text);
    if (bytes.length !== 64) throw new Error(`secret key must be 64 bytes (got ${bytes.length})`);
    return { secretKey: Array.from(bytes), publicKey: b58encode(bytes.subarray(32)) };
  }

  // Signer fields for launch-wallet requests. The server first looks the
  // key up in its recovery list by public key; when this page holds the
  // secret (pasted, or just generated) it is sent inline as the fallback.
  function signerFields() {
    const out = { walletPublicKey: state.wallet.publicKey };
    if (Array.isArray(state.wallet.secretKey)) out.tempWalletSecretKey = JSON.stringify(state.wallet.secretKey);
    return out;
  }
  const SESSION_SECRET_KEY = 'firefun.launch.secret';
  function stashSecret() {
    try {
      if (state.wallet?.secretKey) sessionStorage.setItem(SESSION_SECRET_KEY, JSON.stringify({ publicKey: state.wallet.publicKey, secretKey: state.wallet.secretKey }));
      else sessionStorage.removeItem(SESSION_SECRET_KEY);
    } catch (_) { /* tab-scoped convenience */ }
  }
  function isSignerError(err) {
    return /could not resolve a signer|resolved secret key must be/i.test(String(err && err.message || ''));
  }
  function needSecret(show) {
    $('#needSecret').classList.toggle('hidden', !show);
    if (show) { scrollToCard('#card-wallet'); $('#lateSecret').focus(); }
  }

  document.addEventListener('click', (ev) => {
    const cl = ev.target.closest('[data-copylink]');
    if (cl) {
      ev.preventDefault();
      navigator.clipboard?.writeText(cl.dataset.copylink).then(() => {
        cl.innerHTML = '<i class="fas fa-check"></i> copied';
        setTimeout(() => { cl.innerHTML = '<i class="far fa-copy"></i> link'; }, 1200);
      });
      return;
    }
    const b = ev.target.closest('[data-copy]');
    if (!b) return;
    const el = $(b.getAttribute('data-copy'));
    const text = el?.dataset.full || el?.textContent || '';
    navigator.clipboard?.writeText(text).then(() => {
      b.innerHTML = '<i class="fas fa-check"></i>'; b.classList.add('ok');
      setTimeout(() => { b.innerHTML = '<i class="far fa-copy"></i>'; b.classList.remove('ok'); }, 1200);
    });
  });

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------

  // Explore is the landing screen; a launch in progress (wallet chosen) or
  // a #launch hash brings the launcher up instead.
  let tab = 'explore';
  function showTab(name) {
    tab = name;
    $$('.tab[data-tab]').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-tab') === name));
    $('#tab-launch').classList.toggle('hidden', name !== 'launch');
    $('#tab-explore').classList.toggle('hidden', name !== 'explore');
    if (name === 'explore') loadFeed();
    if (!tokenPageMint) { try { history.replaceState(null, '', name === 'launch' ? '#launch' : '#'); } catch (_) { /* fine */ } }
    renderDock();
  }
  $$('.tab[data-tab]').forEach((btn) => btn.addEventListener('click', () => showTab(btn.getAttribute('data-tab'))));
  on('#btnStartLaunch', 'click', () => { showTab('launch'); window.scrollTo({ top: 0 }); });

  // ---------------------------------------------------------------------
  // Meta (config, fee tiers, quotes)
  // ---------------------------------------------------------------------

  async function loadMeta(configAddr) {
    const q = configAddr ? `?config=${encodeURIComponent(configAddr)}` : '';
    const meta = await api(`/api/orca/meta${q}`);
    state.meta = meta;
    state.config = meta.config?.address || meta.defaultConfig;
    const pf = meta.config?.defaultProtocolFeeRate;
    $('#feeBadge').textContent = Number.isInteger(pf) ? `fee ${pf / 100}%` : 'fee ?';
    $('#feeBadge').className = `pill ${pf === meta.requiredProtocolFeeRate ? 'ok' : 'bad'}`;
    if (Number.isInteger(pf) && pf !== meta.requiredProtocolFeeRate) {
      setMsg('#quoteMsg', `This config's protocol fee is ${pf / 100}%, not the required ${meta.requiredProtocolFeeRate / 100}%. Launches on it are refused.`, 'bad');
    }
    $('#forcedNames').textContent = meta.forcedQuotes.map((q) => '$' + q.symbol.toUpperCase()).join(' + ');
    $('#configAddr').value = state.config;
    const cfgLink = $('#exploreConfig');
    cfgLink.textContent = short(state.config, 4);
    cfgLink.href = `https://solscan.io/account/${state.config}`;
    $('#exploreSince').textContent = new Date(meta.discoverySinceUnix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    $('#configNote').textContent = meta.config?.error
      ? `could not read config: ${meta.config.error}`
      : `fee authority ${short(meta.config.feeAuthority)} · protocol fee ${meta.config.defaultProtocolFeeRate / 100}% of swap fees`;

    for (const q of meta.forcedQuotes) {
      state.quotes[q.mint] = { ...(state.quotes[q.mint] || {}), on: true, info: q, forced: true };
      if (!(state.quotes[q.mint].pct >= q.minSupplyPercent)) state.quotes[q.mint].pct = q.minSupplyPercent;
    }
    for (const q of meta.optionalQuotes) {
      const prev = state.quotes[q.mint];
      state.quotes[q.mint] = { on: prev ? !!prev.on : q.symbol === 'SOL', pct: prev?.pct ?? 0, info: q, forced: false };
    }
    for (const mint of state.customQuotes) {
      if (!state.quotes[mint]?.info) {
        try {
          const { quote } = await api(`/api/orca/quote-info?mint=${encodeURIComponent(mint)}`);
          state.quotes[mint] = { on: true, pct: state.quotes[mint]?.pct ?? 0, info: quote, forced: false, custom: true };
        } catch (_) { /* dropped */ }
      } else {
        state.quotes[mint].custom = true;
      }
    }
    if (!Object.values(state.quotes).some((q) => q.on && !q.forced)) {
      const sol = meta.optionalQuotes.find((q) => q.symbol === 'SOL');
      if (sol) state.quotes[sol.mint].on = true;
    }
    if (!Object.values(state.quotes).some((q) => q.on && !q.forced && q.pct > 0)) applyDefaultSplit();

    const sel = $('#feeTier');
    sel.innerHTML = '';
    for (const t of meta.feeTiers) {
      const opt = document.createElement('option');
      opt.value = String(t.tickSpacing);
      opt.textContent = `${t.feePercent}% fee · tick spacing ${t.tickSpacing}${t.fullRangeOnly ? ' (full-range only)' : ''}${t.feeRate === 0 ? ' (0% — no fees)' : ''}`;
      opt.disabled = !t.usable;
      sel.appendChild(opt);
    }
    const wanted = state.tickSpacing && meta.feeTiers.find((t) => t.tickSpacing === state.tickSpacing && t.usable)
      ? state.tickSpacing : meta.defaultFeeTier?.tickSpacing;
    if (wanted) sel.value = String(wanted);
    state.tickSpacing = Number(sel.value) || null;
    $('#feeTierNote').textContent = meta.feeTierSource === 'fallback'
      ? 'RPC refused the fee tier scan; showing the last known tiers for this config.'
      : `${meta.feeTiers.length} tier${meta.feeTiers.length === 1 ? '' : 's'} live on the config.`;
    renderQuotes();
  }

  function applyDefaultSplit() {
    const forced = Object.values(state.quotes).filter((q) => q.forced);
    const optional = Object.values(state.quotes).filter((q) => q.on && !q.forced);
    if (optional.length === 0) {
      const each = Math.round((100 / forced.length) * 100) / 100;
      forced.forEach((q) => { q.pct = Math.max(q.info.minSupplyPercent, each); });
      return;
    }
    let used = 0;
    forced.forEach((q) => { q.pct = q.info.minSupplyPercent; used += q.pct; });
    const rest = 100 - used;
    const each = Math.floor((rest / optional.length) * 100) / 100;
    let assigned = 0;
    optional.forEach((q, i) => {
      q.pct = i === optional.length - 1 ? Math.round((rest - assigned) * 100) / 100 : each;
      assigned += q.pct;
    });
  }

  // ---------------------------------------------------------------------
  // Quotes UI
  // ---------------------------------------------------------------------

  const DOTS = {
    SOL: 'linear-gradient(135deg,#9945ff,#14f195)', USDC: '#2775ca', USDT: '#26a17b',
    TOKEN: 'linear-gradient(135deg,#7c3aed,#ef4444)', INFITY: 'linear-gradient(135deg,#f472b6,#fbbf24)',
  };
  function dotFor(info) {
    if (info.imageUrl) return `<img class="dot" src="${esc(info.imageUrl)}" alt="">`;
    const bg = DOTS[String(info.symbol || '').toUpperCase()] || 'linear-gradient(135deg,#ffd166,#ff7a3d)';
    return `<span class="dot" style="background:${bg}"></span>`;
  }

  function orderedQuotes() {
    const list = Object.entries(state.quotes).map(([mint, q]) => ({ mint, ...q }));
    list.sort((a, b) => (b.forced - a.forced) || ((b.custom ? 0 : 1) - (a.custom ? 0 : 1)));
    return list;
  }

  function renderQuotes() {
    const host = $('#quoteRows');
    host.innerHTML = '';
    for (const q of orderedQuotes()) {
      const row = document.createElement('div');
      row.className = `qrow${q.on ? '' : ' off'}`;
      const t22 = q.info.programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'Token-2022' : '';
      const fee = q.info.transferFeeBps ? `${q.info.transferFeeBps / 100}% transfer fee` : '';
      const meta = [q.info.name, fmtUsd(q.info.priceUsd), t22, fee].filter(Boolean).join(' · ');
      row.innerHTML = `
        <button class="sw${q.on ? ' on' : ''}${q.forced ? ' forced' : ''}" data-toggle="${esc(q.mint)}" ${q.forced ? 'disabled' : ''} title="${q.forced ? 'required' : 'include'}"><span class="knob"></span></button>
        <div style="min-width:0">
          <div class="qname">${dotFor(q.info)}<span>${esc(q.info.symbol)}</span>${q.forced ? `<span class="req"><i class="fas fa-lock"></i>required · min ${q.info.minSupplyPercent}%</span>` : ''}</div>
          <div class="qmeta">${esc(meta)} · ${acctLink(q.mint)}</div>
        </div>
        <div class="qright">
          <div class="pct"><input type="number" step="0.01" min="${q.forced ? q.info.minSupplyPercent : 0.01}" max="100" value="${q.pct}" data-pct="${esc(q.mint)}" ${q.on ? '' : 'disabled'} inputmode="decimal"><span>%</span></div>
          ${q.custom ? `<button class="qx" data-remove="${esc(q.mint)}" title="remove"><i class="fas fa-times"></i></button>` : ''}
        </div>`;
      host.appendChild(row);
    }
    host.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      const q = state.quotes[b.dataset.toggle];
      if (q.forced) return;
      q.on = !q.on;
      applyDefaultSplit();
      renderQuotes();
    }));
    host.querySelectorAll('[data-pct]').forEach((inp) => inp.addEventListener('change', () => {
      const q = state.quotes[inp.dataset.pct];
      q.pct = Math.max(0, Number(inp.value) || 0);
      if (q.forced && q.pct < q.info.minSupplyPercent) q.pct = q.info.minSupplyPercent;
      inp.value = q.pct;
      refreshEstimate();
    }));
    host.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
      delete state.quotes[b.dataset.remove];
      state.customQuotes = state.customQuotes.filter((m) => m !== b.dataset.remove);
      applyDefaultSplit();
      renderQuotes();
    }));
    refreshEstimate();
  }

  function currentPlan() {
    return orderedQuotes().filter((q) => q.on).map((q) => ({ mint: q.mint, supplyPercent: q.pct }));
  }

  let estimateTimer = null;
  function refreshEstimate() {
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(async () => {
      renderImplied();
      persist();
      try {
        const { plan, cost } = await api('/api/orca/estimate', { body: { quotes: currentPlan(), ladderSteps: state.ladderSteps } });
        state.estimate = { plan, cost };
        $('#ladderVal').textContent = `${state.ladderSteps} per pool`;
        $('#ladderNote').textContent = `${plan.quotes.length} pools × ${state.ladderSteps} bands = ${cost.positionCount} locked positions · ~${cost.txCount} transactions · ~${cost.estMinutes} min · ${cost.totalSol} SOL`;
        $('#sumPools').textContent = plan.quotes.length;
        $('#sumPct').textContent = fmtPct(plan.totalPercent);
        $('#sumRem').textContent = fmtPct(plan.remainderPercent);
        $('#sumSol').textContent = cost.totalSol;
        $('#fundNeed').textContent = cost.totalSol;
        $('#fundNeed2').textContent = cost.totalSol;
        $('#quotesSummary').textContent = `${plan.quotes.length} pools · ${fmtPct(plan.totalPercent)} in`;
        if (!$('#quoteMsg').textContent.includes('protocol fee')) setMsg('#quoteMsg', '');
        renderPoolPreview(plan);
      } catch (err) {
        state.estimate = null;
        $('#sumPools').textContent = '—'; $('#sumSol').textContent = '—';
        $('#quotesSummary').textContent = '';
        setMsg('#quoteMsg', esc(err.message), 'bad');
        $('#poolPreview').innerHTML = '';
      }
      updateGates();
    }, 250);
  }

  function launchPriceUsd() {
    const supply = Number($('#tokSupply').value);
    const mcap = Number($('#tokMcap').value);
    return supply > 0 && mcap > 0 ? mcap / supply : null;
  }

  function renderImplied() {
    const p = launchPriceUsd();
    $('#impliedPrice').textContent = p ? fmtUsd(p) : '—';
    $('#impliedPerDollar').textContent = p ? `${fmtNum(1 / p, 0)} tokens` : '—';
    $$('#mcapPresets .preset').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.mcap) === Number($('#tokMcap').value)));
  }

  function renderPoolPreview(plan) {
    const p = launchPriceUsd();
    const supply = Number($('#tokSupply').value);
    $('#poolPreview').innerHTML = plan.quotes.map((q) => {
      const info = state.quotes[q.mint]?.info || {};
      const inQuote = p && info.priceUsd ? `${fmtNum(p / info.priceUsd, 6)} ${esc(info.symbol)}` : 'no price';
      return `<div class="prow">
        <div class="n">${esc(info.symbol || short(q.mint))}${q.forced ? ' <i class="fas fa-lock" style="font-size:9px;color:var(--gold)"></i>' : ''} <span>· ${fmtPct(q.supplyPercent)}</span></div>
        <div class="r">${fmtNum(supply * q.supplyPercent / 100, 0)} locked</div>
        <div class="d">opens ${inQuote}</div>
        <div class="r gold">${fmtUsd(p)}</div>
      </div>`;
    }).join('');
  }

  on('#btnAddQuote', 'click', async () => {
    const mint = $('#customQuote').value.trim();
    if (!isPubkey(mint)) return setMsg('#quoteMsg', 'That is not a valid mint address.', 'bad');
    if (state.quotes[mint]) return setMsg('#quoteMsg', 'Already in the list.', 'warn');
    setMsg('#quoteMsg', '<i class="fas fa-circle-notch spin"></i> looking up mint…');
    try {
      const { quote } = await api(`/api/orca/quote-info?mint=${encodeURIComponent(mint)}`);
      if (!quote.priceUsd) throw new Error(`${quote.symbol}: no USD price found — the launch cannot derive an opening price for it.`);
      state.quotes[mint] = { on: true, pct: 0, info: quote, forced: false, custom: true };
      state.customQuotes.push(mint);
      $('#customQuote').value = '';
      applyDefaultSplit();
      renderQuotes();
    } catch (err) {
      setMsg('#quoteMsg', esc(err.message), 'bad');
    }
  });

  on('#feeTier', 'change', () => { state.tickSpacing = Number($('#feeTier').value); persist(); updateGates(); });
  on('#ladder', 'input', () => { state.ladderSteps = Number($('#ladder').value); $('#ladderVal').textContent = `${state.ladderSteps} per pool`; refreshEstimate(); });
  on('#btnLoadConfig', 'click', async () => {
    const addr = $('#configAddr').value.trim();
    if (!isPubkey(addr)) return;
    $('#configNote').textContent = 'loading…';
    try { await loadMeta(addr); } catch (err) { $('#configNote').textContent = err.message; }
  });
  on('#btnListConfigs', 'click', async () => {
    const host = $('#configList');
    host.classList.remove('hidden');
    host.innerHTML = '<span class="note mono">scanning configs…</span>';
    try {
      const { configs } = await api('/api/orca/configs');
      host.innerHTML = configs.map((c) => `<button class="cfgbtn" data-cfg="${esc(c.address)}">${esc(c.address)} <span>· fee ${c.defaultProtocolFeeRate / 100}%</span></button>`).join('');
      host.querySelectorAll('[data-cfg]').forEach((b) => b.addEventListener('click', () => { $('#configAddr').value = b.dataset.cfg; host.classList.add('hidden'); $('#btnLoadConfig').click(); }));
    } catch (err) {
      host.innerHTML = `<span class="note mono">${esc(err.message)}</span>`;
    }
  });

  // ---------------------------------------------------------------------
  // Token form + market cap
  // ---------------------------------------------------------------------

  ['#tokName', '#tokSymbol', '#tokSupply', '#tokDesc', '#tokMcap'].forEach((sel) => {
    $(sel).addEventListener('input', () => { renderImplied(); refreshEstimate(); });
  });
  $$('#mcapPresets .preset').forEach((b) => b.addEventListener('click', () => {
    $('#tokMcap').value = b.dataset.mcap;
    renderImplied(); refreshEstimate();
  }));
  // Logos are shrunk in the browser before upload: <=512px on the long
  // side, PNG if that fits in ~95KB, otherwise JPEG at falling quality. The
  // metadata upload is priced per byte and the server caps uploads.
  const LOGO_MAX_PX = 512;
  const LOGO_TARGET_BYTES = 95 * 1024;
  let logoBlob = null;
  async function prepareLogo(file) {
    if (!file) return null;
    if ((file.type === 'image/png' || file.type === 'image/jpeg') && file.size <= LOGO_TARGET_BYTES) return file;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('That file is not an image the browser can read.'));
        el.src = url;
      });
      const scale = Math.min(1, LOGO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const toBlob = (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
      const png = await toBlob('image/png');
      if (png && png.size <= LOGO_TARGET_BYTES) return new File([png], 'logo.png', { type: 'image/png' });
      for (const q of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
        const jpg = await toBlob('image/jpeg', q);
        if (jpg && jpg.size <= LOGO_TARGET_BYTES) return new File([jpg], 'logo.jpg', { type: 'image/jpeg' });
      }
      const last = await toBlob('image/jpeg', 0.35);
      return new File([last], 'logo.jpg', { type: 'image/jpeg' });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  on('#tokLogo', 'change', async () => {
    const file = $('#tokLogo').files[0];
    logoBlob = null;
    if (!file) { $('#logoLabel').textContent = 'png / jpg / gif / webp'; return; }
    $('#logoLabel').textContent = 'shrinking…';
    try {
      logoBlob = await prepareLogo(file);
      $('#logoLabel').textContent = `${file.name} · ${Math.round(logoBlob.size / 1024)}KB`;
    } catch (err) {
      $('#tokLogo').value = '';
      $('#logoLabel').textContent = describeError(err);
    }
  });

  // ---------------------------------------------------------------------
  // Wallet
  // ---------------------------------------------------------------------

  function renderWallet() {
    const has = !!state.wallet;
    $('#walletEmpty').classList.toggle('hidden', has);
    $('#walletInfo').classList.toggle('hidden', !has);
    if (has) {
      $('#walletAddr').textContent = state.wallet.publicKey;
      $('#walletQr').src = state.wallet.qrCode || '';
      const hasSecret = !!state.wallet.secretKeyB58;
      $('#secretBlock').classList.toggle('hidden', !hasSecret);
      $('#noSecret').classList.toggle('hidden', hasSecret);
      $('#noSecret').textContent = state.wallet.secretKey && !hasSecret
        ? 'secret key loaded in this tab — it is sent with each signed request and forgotten when the tab closes'
        : 'secret held by the server (recovery list) — not shown again';
      const sec = $('#walletSecret');
      sec.dataset.full = state.wallet.secretKeyB58 || '';
      $('#savedSecret').classList.toggle('on', state.savedSecret);
      setPill('#walletState', short(state.wallet.publicKey), 'ok mono');
      startBalancePolling();
    } else {
      setPill('#walletState', '');
      stopBalancePolling();
    }
    updateGates();
  }

  on('#btnGenWallet', 'click', async () => {
    $('#btnGenWallet').disabled = true;
    try {
      const { wallet } = await api('/api/generate-wallet', { body: {} });
      state.wallet = { publicKey: wallet.publicKey, secretKeyB58: wallet.secretKeyB58, qrCode: wallet.qrCode, secretKey: wallet.secretKey || null };
      state.savedSecret = false;
      stashSecret();
      state.token = null; state.launch = null; state.finish = null;
      lastBalance = 0;
      $('#walletSecret').textContent = '••••••••••••••••••••••••••••••••';
      $('#walletSecret').className = 't dim';
      renderWallet(); persist();
    } catch (err) {
      alert(describeError(err));
    } finally {
      $('#btnGenWallet').disabled = false;
    }
  });

  async function adoptWallet({ publicKey, secretKey }) {
    let qrCode = null;
    try { const r = await api(`/api/wallet-qr?publicKey=${encodeURIComponent(publicKey)}`); qrCode = r.qrCode || null; } catch (_) { /* optional */ }
    state.wallet = { publicKey, secretKeyB58: null, qrCode, secretKey: secretKey || null };
    state.savedSecret = true;
    lastBalance = null;
    stashSecret();
    renderWallet(); persist();
  }

  on('#btnUseWallet', 'click', async () => {
    const secretRaw = $('#existingSecret').value.trim();
    const pk = $('#existingWallet').value.trim();
    try {
      if (secretRaw) {
        const parsed = parseSecretKey(secretRaw);
        if (pk && isPubkey(pk) && pk !== parsed.publicKey) throw new Error(`that secret key belongs to ${short(parsed.publicKey)}, not ${short(pk)}`);
        $('#existingSecret').value = '';
        await adoptWallet(parsed);
        return;
      }
      if (!isPubkey(pk)) throw new Error('Enter the wallet public key, or paste its secret key.');
      await adoptWallet({ publicKey: pk, secretKey: null });
    } catch (err) {
      alert(describeError(err));
    }
  });

  on('#btnLateSecret', 'click', () => {
    try {
      const parsed = parseSecretKey($('#lateSecret').value);
      if (!parsed) throw new Error('Paste the secret key first.');
      if (parsed.publicKey !== state.wallet.publicKey) throw new Error(`that secret key belongs to ${short(parsed.publicKey)}, not this wallet (${short(state.wallet.publicKey)})`);
      state.wallet.secretKey = parsed.secretKey;
      $('#lateSecret').value = '';
      stashSecret();
      needSecret(false);
      setMsg('#launchMsg', 'Secret key loaded for this tab. Press Launch again.', 'ok');
      updateGates();
    } catch (err) {
      alert(describeError(err));
    }
  });

  on('#btnRevealSecret', 'click', () => {
    const sec = $('#walletSecret');
    if (!state.wallet?.secretKeyB58) return;
    const hidden = sec.textContent.startsWith('•');
    sec.textContent = hidden ? state.wallet.secretKeyB58 : '••••••••••••••••••••••••••••••••';
    sec.className = hidden ? 't lit' : 't dim';
    $('#btnRevealSecret').innerHTML = hidden ? '<i class="far fa-eye-slash"></i>' : '<i class="far fa-eye"></i>';
  });
  on('#savedSecret', 'click', () => {
    state.savedSecret = !state.savedSecret;
    $('#savedSecret').classList.toggle('on', state.savedSecret);
    persist(); updateGates();
  });
  // Reset the launcher for a fresh run. The old launch wallet stays in the
  // server's recovery list; pools and locks are on chain and unaffected.
  function resetLauncher({ clearForm }) {
    if (state.launch && !state.finish) {
      if (!confirm('This wallet has pools launched but not yet handed off. Start over anyway? (The wallet stays in the recovery list.)')) return false;
    } else if (state.wallet && !state.launch && (lastBalance || 0) > 0.001) {
      if (!confirm(`This launch wallet still holds ${(lastBalance || 0).toFixed(3)} SOL. Start over anyway? (It stays in the recovery list.)`)) return false;
    }
    state.wallet = null; state.token = null; state.launch = null; state.finish = null; state.savedSecret = false;
    state.launching = false; state.finishing = false; state.estimate = null;
    lastBalance = null;
    stopProgressPolling();
    stashSecret();
    needSecret(false);
    $('#launchProg').innerHTML = ''; $('#launchResults').classList.add('hidden'); $('#finishProg').innerHTML = ''; $('#finishResults').classList.add('hidden');
    $('#tokenCreated').classList.add('hidden'); setMsg('#launchMsg', ''); setMsg('#finishMsg', '');
    setPill('#tokenState', ''); setPill('#launchState', ''); setPill('#finishState', '');
    ['#tokName', '#tokSymbol', '#tokSupply', '#tokDesc', '#tokLogo'].forEach((s) => { $(s).disabled = false; });
    if (clearForm) {
      $('#tokName').value = ''; $('#tokSymbol').value = ''; $('#tokDesc').value = ''; $('#tokLogo').value = '';
      $('#tokSupply').value = '1000000000'; $('#tokMcap').value = '10000'; $('#destWallet').value = ''; state.destWallet = '';
      logoBlob = null; $('#logoLabel').textContent = 'png / jpg / gif / webp';
      state.customQuotes = [];
      for (const [mint, q] of Object.entries(state.quotes)) { if (q.custom) delete state.quotes[mint]; else if (!q.forced) q.on = q.info?.symbol === 'SOL'; }
      applyDefaultSplit();
      renderQuotes();
      renderImplied();
    }
    renderWallet(); persist();
    showTab('launch');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
  }
  on('#btnForgetWallet', 'click', () => resetLauncher({ clearForm: false }));
  on('#btnNewLaunch', 'click', () => resetLauncher({ clearForm: true }));
  on('#btnNewLaunch2', 'click', () => resetLauncher({ clearForm: true }));

  // ---------------------------------------------------------------------
  // Funding
  // ---------------------------------------------------------------------

  let balanceTimer = null;
  async function pollBalance() {
    if (!state.wallet) return;
    try {
      const { balance } = await api('/api/check-balance', { body: { publicKey: state.wallet.publicKey } });
      lastBalance = Number(balance) || 0;
      updateGates();
    } catch (_) { /* transient */ }
  }
  function startBalancePolling() { stopBalancePolling(); pollBalance(); balanceTimer = setInterval(pollBalance, 6000); }
  function stopBalancePolling() { clearInterval(balanceTimer); balanceTimer = null; }

  function renderFunding(need, funded) {
    const bal = lastBalance || 0;
    $('#fundBal').textContent = bal.toFixed(3);
    $('#fundBal').className = `n${funded ? ' ok' : ''}`;
    $('#fundLabel').textContent = funded ? 'funded ✓' : (bal > 0 ? 'receiving…' : 'waiting for SOL');
    $('#fundLabel').className = `lab${funded ? ' ok' : ''}`;
    $('#fundBar').style.width = `${need > 0 ? Math.min(100, (bal / need) * 100) : 0}%`;
  }

  // ---------------------------------------------------------------------
  // Gates, steps, dock
  // ---------------------------------------------------------------------

  function tokenFormValid() {
    return $('#tokName').value.trim().length > 0 && $('#tokSymbol').value.trim().length > 0
      && Number($('#tokSupply').value) > 0 && Number($('#tokMcap').value) > 0;
  }

  let ready = false;
  function updateGates() {
    const need = state.estimate?.cost?.totalSol || 0;
    const on = state.estimate?.plan?.quotes?.length || 0;
    const total = state.estimate?.plan?.totalPercent ?? 0;
    const hasWallet = !!state.wallet;
    const funded = hasWallet && need > 0 && (lastBalance || 0) >= need;
    const launched = !!state.launch && !state.launch.partial;
    const tokenOk = !!state.token || tokenFormValid();
    const gates = [
      { ok: tokenOk, label: state.token ? `Token ${state.token.symbol} minted` : 'Token name, symbol, supply & market cap' },
      { ok: on > 0 && !!state.estimate && !!state.tickSpacing, label: state.estimate ? `${on} pool${on === 1 ? '' : 's'} planned · ${fmtPct(total)} of supply` : 'Pick your quotes' },
      { ok: hasWallet && state.savedSecret, label: hasWallet ? (state.savedSecret ? 'Launch wallet ready' : 'Confirm you saved the secret key') : 'Generate a launch wallet' },
      { ok: funded || launched, label: funded ? `Funded · ${(lastBalance || 0).toFixed(3)} SOL` : `Fund ${need || '—'} SOL` },
    ];
    ready = gates.every((g) => g.ok) && !state.launching && !launched;
    const resumable = !!state.launch?.partial && !state.launching && hasWallet;
    $('#gates').innerHTML = launched ? '' : gates.map((g) => `<div class="gate${g.ok ? ' ok' : ''}"><i class="${g.ok ? 'fas fa-check-circle' : 'far fa-circle'}"></i>${esc(g.label)}</div>`).join('');

    const btn = $('#btnLaunch');
    btn.disabled = !(ready || resumable);
    btn.className = `launch-btn${launched ? ' done' : (ready || resumable) ? ' ready' : ''}`;
    btn.querySelector('i').className = state.launching ? 'fas fa-circle-notch spin' : launched ? 'fas fa-lock' : 'fas fa-rocket';
    $('#btnLaunchLabel').textContent = state.launching ? 'Launching…' : launched ? 'Locked forever' : resumable ? 'Resume launch' : 'Launch';
    $('#card-launch').className = `card${launched ? ' ok' : (ready || resumable) ? ' ready' : ''}`;

    $('#btnNewLaunch').classList.toggle('hidden', !launched);
    $('#btnNewLaunch2').classList.toggle('hidden', !state.finish);
    $('#btnFinish').disabled = !(launched && isPubkey($('#destWallet').value) && !state.finish && !state.finishing);
    $('#card-finish').className = `card${state.finish ? ' ok' : launched ? '' : ' dimmed'}`;
    $('#card-wallet').className = `card${hasWallet && state.savedSecret ? ' ok' : ''}`;
    $('#card-token').className = `card${state.token ? ' ok' : ''}`;

    setStep('#stepToken', state.token ? 'done' : '', 1);
    setStep('#stepQuotes', launched ? 'done' : '', 2);
    setStep('#stepWallet', hasWallet && state.savedSecret && (funded || launched) ? 'done' : hasWallet ? 'active' : '', 3);
    setStep('#stepLaunch', launched ? 'done' : (ready || state.launching) ? 'active' : '', 4);
    setStep('#stepFinish', state.finish ? 'done' : launched ? 'active' : '', 5);
    if (state.token) ['#tokName', '#tokSymbol', '#tokSupply', '#tokDesc', '#tokLogo'].forEach((s) => { $(s).disabled = true; });
    if (hasWallet) renderFunding(need, funded);
    renderDock({ gates, on, need, launched });
  }

  function renderDock(ctx) {
    const dock = $('#dock');
    if (tab !== 'launch' || !ctx) { dock.classList.add('hidden'); return; }
    const { gates, on, need, launched } = ctx;
    let k, v, label, active, action;
    if (!launched) {
      const first = gates.find((g) => !g.ok);
      k = ready ? 'Ready' : 'Next step';
      v = ready ? `${on} pools · ${need} SOL` : (first?.label || '');
      label = state.launching ? 'Launching…' : 'Launch';
      active = ready;
      action = () => { if (ready) $('#btnLaunch').click(); else scrollToCard('#card-launch'); };
    } else if (!state.finish) {
      k = 'Locked'; v = `${state.launch.results.length} pools · 100% LP is yours`; label = 'Send home'; active = true;
      action = () => { scrollToCard('#card-finish'); $('#destWallet').focus(); };
    } else {
      k = 'Done'; v = `${state.launch.results.length} pools locked · handed off`; label = 'Launch another'; active = true;
      action = () => resetLauncher({ clearForm: true });
    }
    dock.classList.remove('hidden');
    $('#dockK').textContent = k; $('#dockV').textContent = v;
    const b = $('#dockBtn'); b.textContent = label; b.className = `btn${active ? ' active' : ''}`; b.onclick = action;
  }
  function scrollToCard(sel) {
    const el = $(sel);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------------
  // Launch: token create + orca pools, with live progress
  // ---------------------------------------------------------------------

  function progRow(id, label, sub) {
    return `<div id="${id}" class="pr${sub ? ' sub' : ''}"><span class="st"><i class="far fa-circle"></i></span><span class="lb">${label}</span><span class="ex"></span></div>`;
  }
  function progSet(id, status, extra) {
    const li = document.getElementById(id);
    if (!li) return;
    const st = li.querySelector('.st');
    st.className = `st ${status}`;
    st.innerHTML = status === 'done' ? '<i class="fas fa-check-circle"></i>'
      : status === 'running' ? '<i class="fas fa-circle-notch"></i>'
      : status === 'failed' ? '<i class="fas fa-times-circle"></i>'
      : '<i class="far fa-circle"></i>';
    if (extra !== undefined) li.querySelector('.ex').innerHTML = extra;
  }

  function buildLaunchTree(plan) {
    const rows = [progRow('p-token', state.token ? `Token ${esc(state.token.symbol)} (already minted)` : 'Mint token + metadata, renounce authorities')];
    plan.quotes.forEach((q, i) => {
      const sym = esc(state.quotes[q.mint]?.info?.symbol || short(q.mint));
      rows.push(progRow(`p-${i}`, `Pool vs ${sym} — ${fmtPct(q.supplyPercent)} of supply`));
      rows.push(progRow(`p-${i}-pool`, 'create Whirlpool', true));
      rows.push(progRow(`p-${i}-pos`, `open + deposit + lock ${state.ladderSteps} ladder positions`, true));
    });
    $('#launchProg').innerHTML = rows.join('');
    if (state.token) progSet('p-token', 'done', acctLink(state.token.mint, short(state.token.mint)));
  }

  let progressPoll = null;
  function startProgressPolling(onEvent) {
    let since = 0;
    stopProgressPolling();
    progressPoll = setInterval(async () => {
      if (!state.wallet) return;
      try {
        const { state: st } = await api(`/api/lp-progress?wallet=${encodeURIComponent(state.wallet.publicKey)}&since=${since}`);
        if (!st) return;
        for (const ev of st.events) onEvent(ev);
        since = st.totalEvents;
      } catch (_) { /* keep polling */ }
    }, 1200);
  }
  function stopProgressPolling() { clearInterval(progressPoll); progressPoll = null; }

  function onLaunchEvent(ev) {
    const i = ev.quoteIndex;
    switch (ev.stage) {
      case 'pool_create_start': progSet(`p-${i}`, 'running'); progSet(`p-${i}-pool`, 'running'); break;
      case 'pool_exists': progSet(`p-${i}`, 'running'); progSet(`p-${i}-pool`, 'done', acctLink(ev.poolId, 'exists')); break;
      case 'pool_create_done': progSet(`p-${i}-pool`, 'done', txLink(ev.txId)); break;
      case 'position_open_start': progSet(`p-${i}-pos`, 'running', `${ev.bandIndex + 1}/${ev.bands} opening`); break;
      case 'position_open_done': progSet(`p-${i}-pos`, 'running', `${ev.bandIndex + 1}/${ev.bands} open`); break;
      case 'deposit_lock_start': case 'lock_start': progSet(`p-${i}-pos`, 'running', `${ev.bandIndex + 1}/${ev.bands} locking`); break;
      case 'lock_exists': case 'lock_done': progSet(`p-${i}-pos`, 'running', `${ev.bandIndex + 1}/${ev.bands} locked ${ev.txId ? txLink(ev.txId) : ''}`); break;
      case 'pool_done': progSet(`p-${i}-pos`, 'done', `${ev.bands} locked`); progSet(`p-${i}`, 'done'); break;
      case 'pool_failed': progSet(`p-${i}`, 'failed', esc(ev.error || '')); break;
      default: break;
    }
  }

  async function createTokenIfNeeded() {
    if (state.token) return state.token;
    progSet('p-token', 'running');
    const fd = new FormData();
    for (const [k, v] of Object.entries(signerFields())) fd.append(k, v);
    fd.append('name', $('#tokName').value.trim());
    fd.append('symbol', $('#tokSymbol').value.trim());
    fd.append('description', $('#tokDesc').value.trim());
    fd.append('totalSupply', String(Math.floor(Number($('#tokSupply').value))));
    const logo = logoBlob || (await prepareLogo($('#tokLogo').files[0]));
    if (logo) fd.append('logo', logo, logo.name || 'logo.png');
    const r = await api('/api/create-token', { body: fd });
    state.token = {
      mint: r.tokenMint, name: r.name, symbol: r.symbol, totalSupply: Number(r.totalSupply),
      decimals: r.decimals || 9, imageUri: r.imageUri || null, metadataUri: r.metadataUri || null,
    };
    persist();
    progSet('p-token', 'done', acctLink(state.token.mint, short(state.token.mint)));
    renderTokenCreated();
    return state.token;
  }

  function renderTokenCreated() {
    if (!state.token) return;
    $('#tokenCreated').classList.remove('hidden');
    $('#tokenCreated').innerHTML = `Minted <strong style="font-family:inherit">${esc(String(state.token.symbol).toUpperCase())}</strong> · ${acctLink(state.token.mint, short(state.token.mint, 6))} · mint &amp; freeze authorities renounced.`;
    setPill('#tokenState', 'minted', 'ok');
  }

  on('#btnLaunch', 'click', async () => {
    if (!state.estimate || state.launching) return;
    state.launching = true;
    setMsg('#launchMsg', '');
    setPill('#launchState', 'running', 'warn');
    updateGates();
    const plan = state.estimate.plan;
    buildLaunchTree(plan);
    stopBalancePolling();
    try {
      const mcap = Number($('#tokMcap').value);
      const token = await createTokenIfNeeded();
      startProgressPolling(onLaunchEvent);
      const r = await api('/api/orca/launch', {
        body: {
          ...signerFields(),
          tokenMint: token.mint,
          tokenDecimals: token.decimals,
          tokenTotalSupply: token.totalSupply,
          targetMarketCapUsd: mcap,
          quotes: plan.quotes.map((q) => ({ mint: q.mint, supplyPercent: q.supplyPercent })),
          whirlpoolsConfig: state.config,
          tickSpacing: state.tickSpacing,
          ladderSteps: state.ladderSteps,
          priorResults: state.launch?.results || [],
        },
      });
      await sleep(1500);
      stopProgressPolling();
      state.launch = { results: r.results, plan: r.plan, feeRate: r.feeRate, tickSpacing: r.tickSpacing, whirlpoolsConfig: r.whirlpoolsConfig, mcap };
      persist();
      r.results.forEach((res, i) => { progSet(`p-${i}`, 'done'); progSet(`p-${i}-pool`, 'done', acctLink(res.poolId)); progSet(`p-${i}-pos`, 'done', `${(res.positions || []).length} locked`); });
      renderLaunchResults();
      setPill('#launchState', `${r.results.length} pools locked`, 'ok');
      setMsg('#launchMsg', `Every position is permanently locked. Your token page: <a href="/token/${esc(token.mint)}" class="mono">${esc(location.host)}/token/${short(token.mint, 6)}</a>. Enter your wallet below to receive the locked positions, the un-pooled supply and the leftover SOL.`, 'ok');
    } catch (err) {
      stopProgressPolling();
      if (Array.isArray(err.partialResults) && err.partialResults.length) {
        state.launch = { ...(state.launch || {}), results: err.partialResults, partial: true };
        persist();
      }
      setPill('#launchState', 'failed', 'bad');
      if (isSignerError(err)) {
        setMsg('#launchMsg', 'This server does not hold the key for this launch wallet. Paste its secret key in the wallet card, then press Launch again.', 'bad');
        needSecret(true);
      } else {
        const retry = err.failedPhase === 'pre_flight' || err.code === 'OP_IN_FLIGHT' ? '' : '<br><span class="m">Nothing is lost: fix the cause (usually funding) and press Launch again with this wallet — finished pools are skipped.</span>';
        setMsg('#launchMsg', `${esc(describeError(err))}${retry}`, 'bad');
      }
    } finally {
      state.launching = false;
      startBalancePolling();
      updateGates();
    }
  });

  function renderLaunchResults() {
    const L = state.launch;
    if (!L?.results?.length) return;
    $('#launchResults').classList.remove('hidden');
    $('#launchResults').innerHTML = L.results.map((r) => `<div class="res pop">
      <div class="n">${esc(r.quoteSymbol)}${r.forced ? ' <i class="fas fa-lock" style="font-size:9px;color:var(--gold)"></i>' : ''} <span>· ${fmtPct(r.supplyPercent)} · opened ${fmtUsd(r.launchPriceUsd)}</span></div>
      <span class="lk${r.locked ? '' : ' bad'}"><i class="fas fa-${r.locked ? 'lock' : 'exclamation-triangle'}"></i> ${r.locked ? `${(r.positions || [r]).length} locked` : `${(r.positions || []).filter((p) => p.locked).length}/${r.bandCount || (r.positions || []).length || 1} locked`}</span>
      <div class="links">pool ${acctLink(r.poolId)} · <a target="_blank" rel="noopener" href="${jupUrl(r.quoteMint, state.token?.mint || '')}">jup</a> · <a target="_blank" rel="noopener" href="https://www.orca.so/pools/${esc(r.poolId)}">orca</a> · ${(r.positions || [r]).length} band${(r.positions || [r]).length === 1 ? '' : 's'}</div>
      <span class="tx">${txLink(r.lockTxId)}</span>
    </div>`).join('');
  }

  // ---------------------------------------------------------------------
  // Finish
  // ---------------------------------------------------------------------

  on('#destWallet', 'input', () => { state.destWallet = $('#destWallet').value.trim(); persist(); updateGates(); });

  function onFinishEvent(ev) {
    switch (ev.stage) {
      case 'position_transfer_start': progSet(`f-${ev.positionMint}`, 'running'); break;
      case 'position_transfer_done': progSet(`f-${ev.positionMint}`, 'done', txLink(ev.txId)); break;
      case 'position_transfer_failed': progSet(`f-${ev.positionMint}`, 'failed', esc(ev.error || '')); break;
      case 'sweep_tokens_start': progSet('f-tokens', 'running'); break;
      case 'sweep_tokens_done': progSet('f-tokens', 'done', `${ev.transferred} transfer${ev.transferred === 1 ? '' : 's'}`); break;
      case 'sweep_sol_start': progSet('f-sol', 'running'); break;
      case 'sweep_sol_done': progSet('f-sol', 'done', `${fmtNum(Number(ev.sol) || 0, 4)} SOL`); break;
      default: break;
    }
  }

  on('#btnFinish', 'click', async () => {
    const dest = $('#destWallet').value.trim();
    if (!isPubkey(dest) || state.finishing) return;
    if (!confirm(`Send every locked position, the un-pooled tokens and the leftover SOL to\n\n${dest}\n\nThis cannot be undone. Double-check the address.`)) return;
    state.finishing = true;
    setMsg('#finishMsg', '');
    setPill('#finishState', 'running', 'warn');
    updateGates();
    const positions = state.launch.results.flatMap((r) => (r.positions && r.positions.length ? r.positions : [r]).filter((p) => p.locked && p.positionMint).map((p) => ({ positionMint: p.positionMint, quoteSymbol: r.quoteSymbol })));
    $('#finishProg').innerHTML = positions.map((p, idx) => progRow(`f-${p.positionMint}`, `locked position ${idx + 1}/${positions.length} (${esc(p.quoteSymbol)}) → your wallet`)).join('')
      + progRow('f-tokens', 'sweep un-pooled tokens') + progRow('f-sol', 'sweep leftover SOL');
    stopBalancePolling();
    startProgressPolling(onFinishEvent);
    try {
      const r = await api('/api/orca/finish', { body: { ...signerFields(), destinationWallet: dest, positions } });
      await sleep(1200);
      stopProgressPolling();
      state.finish = { destinationWallet: dest, transfers: r.transfers, sol: r.sol, walletEmpty: r.walletEmpty };
      persist();
      r.transfers.forEach((t) => progSet(`f-${t.positionMint}`, 'done', t.skipped ? 'already there' : txLink(t.txId)));
      progSet('f-tokens', 'done'); progSet('f-sol', 'done', `${fmtNum(Number(r.sol) || 0, 4)} SOL`);
      setPill('#finishState', 'done', 'ok');
      renderFinished();
    } catch (err) {
      stopProgressPolling();
      setPill('#finishState', 'failed', 'bad');
      if (isSignerError(err)) {
        setMsg('#finishMsg', 'This server does not hold the key for this launch wallet. Paste its secret key in the wallet card, then press Send again.', 'bad');
        needSecret(true);
      } else {
        setMsg('#finishMsg', `${esc(describeError(err))}<br><span class="m">Press Send again; completed transfers are skipped.</span>`, 'bad');
      }
    } finally {
      state.finishing = false;
      startBalancePolling();
      updateGates();
    }
  });

  function renderFinished() {
    const f = state.finish;
    if (!f) return;
    $('#finishResults').classList.remove('hidden');
    $('#finishResults').innerHTML = `<div class="msg ok pop"><strong>Done.</strong> ${f.transfers?.length ?? 0} locked position${f.transfers?.length === 1 ? '' : 's'} now sit in ${acctLink(f.destinationWallet)}. They earn fees forever and can never be withdrawn.${f.walletEmpty ? ' The launch wallet is empty and was removed from the recovery list.' : ' Some dust remains in the launch wallet; it stays in the recovery list.'}</div>`;
  }

  // ---------------------------------------------------------------------
  // Explore feed
  // ---------------------------------------------------------------------

  const tokenPageMint = (() => { const m = /^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(location.pathname); return m ? m[1] : null; })();

  let feedTimer = null;
  async function loadFeed() {
    if (tokenPageMint) return loadTokenPage();
    $('#feedSpin').classList.add('spin');
    $('#feedMsg').className = 'feedstat';
    $('#feedMsg').textContent = 'scanning the config…';
    try {
      const r = await api(`/api/orca/discover?config=${encodeURIComponent(state.config || '')}`);
      $('#feedMsg').textContent = r.launches.length === 0
        ? `no launches locked on this config since ${new Date(r.sinceUnix * 1000).toLocaleDateString()} yet · ${r.scannedPools} pool${r.scannedPools === 1 ? '' : 's'} scanned · yours could be first`
        : `${r.launches.length} launch${r.launches.length === 1 ? '' : 'es'} · ${r.scannedPools} pools on the config · updated ${new Date(r.fetchedAt * 1000).toLocaleTimeString()}`;
      $('#feed').innerHTML = r.launches.map((l, i) => renderLaunchCard(l, i)).join('');
    } catch (err) {
      $('#feedMsg').className = 'feedstat bad';
      $('#feedMsg').textContent = describeError(err);
    }
    $('#feedSpin').classList.remove('spin');
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => { if (tab === 'explore') loadFeed(); }, 60_000);
  }
  on('#btnRefreshFeed', 'click', loadFeed);

  async function loadTokenPage() {
    $('#tokenPageBar').classList.remove('hidden');
    $('#tokenPageNote').textContent = short(tokenPageMint, 6);
    $('#feedSpin').classList.add('spin');
    $('#feedMsg').className = 'feedstat';
    $('#feedMsg').textContent = 'loading token…';
    try {
      const { launch } = await api(`/api/orca/token/${encodeURIComponent(tokenPageMint)}`);
      document.title = `${launch.name || launch.symbol} · FireFun`;
      $('#feedMsg').textContent = `${launch.pools.length} locked pool${launch.pools.length === 1 ? '' : 's'} · launched ${new Date(launch.launchedAt * 1000).toLocaleString()}`;
      $('#feed').innerHTML = renderLaunchCard(launch, 0);
    } catch (err) {
      $('#feedMsg').className = 'feedstat bad';
      $('#feedMsg').textContent = err.status === 404 ? 'No locked pools for this token on our config.' : describeError(err);
      $('#feed').innerHTML = '';
    }
    $('#feedSpin').classList.remove('spin');
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => { if (tab === 'explore') loadFeed(); }, 60_000);
  }

  function renderLaunchCard(l, i) {
    const avatar = l.imageUrl ? `<img class="avatar" src="${esc(l.imageUrl)}" alt="">` : '<span class="avatar"></span>';
    const pools = l.pools.map((p) => `<div class="pool">
      <div class="n">${esc(p.quoteSymbol)} <span>· ${p.feePercent}% fee</span></div>
      <span class="lk"><i class="fas fa-lock"></i> ${p.lockedPositions} permanent</span>
      <div class="pr2">${p.priceInQuote ? `${fmtNum(p.priceInQuote, 6)} ${esc(p.quoteSymbol)}` : '—'} · ${fmtUsd(p.priceUsd)}</div>
      <div class="lnk"><a target="_blank" rel="noopener" href="${esc(p.jupUrl || jupUrl(p.quoteMint, l.tokenMint))}" style="font-weight:800">jup</a> · <a target="_blank" rel="noopener" href="${esc(p.orcaUrl)}">orca</a> · <a class="m" target="_blank" rel="noopener" href="${esc(p.solscanUrl)}">pool</a></div>
    </div>`).join('');
    const pageUrl = `${location.origin}/token/${l.tokenMint}`;
    return `<div class="lc pop" id="launch-${esc(l.tokenMint)}">
      <div class="head">${avatar}
        <div style="min-width:0;flex:1"><div class="t"><a class="nm" href="/token/${esc(l.tokenMint)}" style="color:inherit">${esc(l.name || l.symbol)}</a><span class="sy">${esc(l.symbol)}</span></div><div class="s">${acctLink(l.tokenMint, short(l.tokenMint, 5))} · ${ago(l.launchedAt)} · <a target="_blank" rel="noopener" href="${jupUrl(SOL_MINT, l.tokenMint)}" style="font-weight:800">buy on jup</a> · <a href="#" data-copylink="${esc(pageUrl)}" class="m" style="color:var(--muted)"><i class="far fa-copy"></i> link</a></div></div>
        <div class="mc"><div class="v${i === 0 ? ' gold' : ''}">${fmtUsd(l.marketCapUsd)}</div><div class="k sm">mcap</div></div>
      </div>
      <div class="stats c3">
        <div class="stat"><div class="k sm">Price</div><div class="v">${fmtUsd(l.priceUsd)}</div></div>
        <div class="stat"><div class="k sm">Pools</div><div class="v">${l.pools.length}</div></div>
        <div class="stat"><div class="k sm">Quotes</div><div class="v">${l.pools.map((p) => esc(p.quoteSymbol)).join(' · ')}</div></div>
      </div>
      <div class="pools">${pools}</div>
    </div>`;
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  (async function boot() {
    const saved = restore();
    if (saved) {
      state.wallet = saved.wallet || null;
      state.savedSecret = !!saved.savedSecret;
      state.token = saved.token || null;
      state.quotes = saved.quotes || {};
      state.customQuotes = saved.customQuotes || [];
      state.tickSpacing = saved.tickSpacing || null;
      state.ladderSteps = Math.max(10, Math.min(1000, Number(saved.ladderSteps) || 10));
      state.config = saved.config || null;
      state.launch = saved.launch || null;
      state.finish = saved.finish || null;
      state.destWallet = saved.destWallet || '';
      if (saved.form) {
        $('#tokName').value = saved.form.name || ''; $('#tokSymbol').value = saved.form.symbol || '';
        $('#tokSupply').value = saved.form.supply || '1000000000'; $('#tokDesc').value = saved.form.desc || '';
        $('#tokMcap').value = saved.form.mcap || '10000';
      }
      $('#destWallet').value = state.destWallet;
    }
    const ladderEl = $('#ladder'); if (ladderEl) ladderEl.value = String(state.ladderSteps);
    try {
      const stash = JSON.parse(sessionStorage.getItem(SESSION_SECRET_KEY) || 'null');
      if (stash && state.wallet && stash.publicKey === state.wallet.publicKey) state.wallet.secretKey = stash.secretKey;
    } catch (_) { /* no stash */ }
    renderImplied();
    try {
      await loadMeta(state.config);
    } catch (err) {
      setMsg('#quoteMsg', `Could not load the Orca config: ${esc(describeError(err))}`, 'bad');
    }
    renderWallet();
    renderTokenCreated();
    if (!tokenPageMint && (location.hash === '#launch' || (state.wallet && !state.finish))) showTab('launch');
    else showTab('explore');
    if (state.launch?.results?.length) {
      buildLaunchTree({ quotes: state.launch.results.map((r) => ({ mint: r.quoteMint, supplyPercent: r.supplyPercent })) });
      state.launch.results.forEach((res, i) => {
        const done = (res.positions || []).filter((p) => p.locked).length;
        progSet(`p-${i}`, res.locked ? 'done' : 'failed');
        progSet(`p-${i}-pool`, res.poolId ? 'done' : 'pending', acctLink(res.poolId));
        progSet(`p-${i}-pos`, res.locked ? 'done' : 'pending', `${done}/${res.bandCount || (res.positions || []).length || 1} locked`);
      });
      renderLaunchResults();
      setPill('#launchState', state.launch.partial ? 'partial · resume' : `${state.launch.results.length} pools locked`, state.launch.partial ? 'warn' : 'ok');
    }
    if (state.finish) { setPill('#finishState', 'done', 'ok'); renderFinished(); }
    updateGates();
  })();
})();
