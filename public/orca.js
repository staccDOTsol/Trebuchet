// public/orca.js
//
// The Orca launch page. Plain browser JS (no bundler); talks to the
// /api/orca/* routes plus the existing wallet / token / balance endpoints.
// api.js (loaded first) attaches the session header to every /api call.
//
// State survives reloads in localStorage so a launch interrupted mid-way can
// be resumed with the same wallet: /api/orca/launch skips pools, positions
// and locks that already exist on chain.

(function () {
  'use strict';

  const STORE_KEY = 'trebuchet.orca.v1';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  const state = {
    meta: null,
    wallet: null,          // { publicKey, secretKeyB58, qrCode }
    savedSecret: false,
    token: null,           // { mint, name, symbol, totalSupply, decimals, imageUri }
    quotes: {},            // mint -> { on, pct, info }
    customQuotes: [],      // [mint]
    tickSpacing: null,
    config: null,
    launch: null,          // { results, plan, feeRate, tickSpacing }
    finish: null,
    destWallet: '',
  };

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
      if (!raw) return null;
      return JSON.parse(raw);
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
  function txLink(sig) { return sig ? `<a class="lnk mono" target="_blank" rel="noopener" href="https://solscan.io/tx/${esc(sig)}">${short(sig, 5)}</a>` : ''; }
  function acctLink(pk, label) { return pk ? `<a class="mono" target="_blank" rel="noopener" href="https://solscan.io/account/${esc(pk)}">${esc(label || short(pk))}</a>` : ''; }
  function setMsg(sel, text, kind) {
    const el = $(sel);
    el.innerHTML = text ? `<div class="msg ${kind || ''}">${text}</div>` : '';
  }
  function setBadge(sel, text, kind) {
    const el = $(sel);
    if (!text) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.className = `badge ${kind || ''}`;
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Signer fields for launch-wallet requests: the server resolves the key
  // from its pending-wallet (recovery) store by public key.
  function signerFields() {
    return { walletPublicKey: state.wallet.publicKey };
  }

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-copy]');
    if (!b) return;
    const el = $(b.getAttribute('data-copy'));
    const text = el?.dataset.full || el?.textContent || '';
    navigator.clipboard?.writeText(text).then(() => {
      b.innerHTML = '<i class="fas fa-check"></i>';
      setTimeout(() => { b.innerHTML = '<i class="far fa-copy"></i>'; }, 1200);
    });
  });

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------

  $$('.tabbtn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tabbtn[data-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
      const tab = btn.getAttribute('data-tab');
      $('#tab-launch').classList.toggle('hidden', tab !== 'launch');
      $('#tab-explore').classList.toggle('hidden', tab !== 'explore');
      if (tab === 'explore') loadFeed();
    });
  });

  // ---------------------------------------------------------------------
  // Meta (config, fee tiers, quotes)
  // ---------------------------------------------------------------------

  async function loadMeta(configAddr) {
    const q = configAddr ? `?config=${encodeURIComponent(configAddr)}` : '';
    const meta = await api(`/api/orca/meta${q}`);
    state.meta = meta;
    state.config = meta.config?.address || meta.defaultConfig;
    const pf = meta.config?.defaultProtocolFeeRate;
    $('#feeBadge').textContent = Number.isInteger(pf) ? `protocol fee ${pf / 100}%` : 'protocol fee ?';
    $('#feeBadge').className = `badge ${pf === meta.requiredProtocolFeeRate ? 'ok' : 'bad'}`;
    if (Number.isInteger(pf) && pf !== meta.requiredProtocolFeeRate) {
      setMsg('#quoteMsg', `This config's protocol fee is ${pf / 100}%, not the required ${meta.requiredProtocolFeeRate / 100}%. Launches on it are refused.`, 'bad');
    }
    $('#forcedNames').textContent = meta.forcedQuotes.map((q) => q.symbol).join(' + ');
    $('#configAddr').value = state.config;
    $('#exploreConfig').textContent = state.config;
    $('#exploreSince').textContent = new Date(meta.discoverySinceUnix * 1000).toLocaleString();
    $('#configNote').textContent = meta.config?.error
      ? `Could not read config: ${meta.config.error}`
      : `fee authority ${short(meta.config.feeAuthority)} · protocol fee ${meta.config.defaultProtocolFeeRate / 100}% of swap fees`;

    // Quote table: forced first (always on), then optional, then customs.
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
        } catch (_) { /* dropped below */ }
      } else {
        state.quotes[mint].custom = true;
      }
    }
    if (!Object.values(state.quotes).some((q) => q.on && !q.forced)) {
      // Nothing optional selected (fresh page): default SOL on.
      const sol = meta.optionalQuotes.find((q) => q.symbol === 'SOL');
      if (sol) state.quotes[sol.mint].on = true;
    }
    if (!hasExplicitSplit()) applyDefaultSplit();

    // Fee tiers
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
      ? state.tickSpacing
      : meta.defaultFeeTier?.tickSpacing;
    if (wanted) sel.value = String(wanted);
    state.tickSpacing = Number(sel.value) || null;
    $('#feeTierNote').textContent = meta.feeTierSource === 'fallback'
      ? 'RPC refused the fee tier scan; showing the last known tiers for this config.'
      : `${meta.feeTiers.length} tier(s) live on the config.`;
    $('#rpcBadge').textContent = 'mainnet';
    renderQuotes();
  }

  function hasExplicitSplit() {
    return Object.values(state.quotes).some((q) => q.on && !q.forced && q.pct > 0);
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
      row.className = `quote-row${q.on ? '' : ' is-off'}`;
      const img = q.info.imageUrl ? `<img src="${esc(q.info.imageUrl)}" alt="">` : '<span style="width:26px;height:26px;border-radius:50%;background:#333;display:inline-block"></span>';
      const t22 = q.info.programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? ' · Token-2022' : '';
      const fee = q.info.transferFeeBps ? ` · ${q.info.transferFeeBps / 100}% transfer fee` : '';
      row.innerHTML = `
        <input type="checkbox" ${q.on ? 'checked' : ''} ${q.forced ? 'disabled checked' : ''} data-toggle="${esc(q.mint)}" title="${q.forced ? 'required' : 'include'}">
        <div>
          <div class="qname">${img} ${esc(q.info.symbol)} ${q.forced ? '<span class="lockchip"><i class="fas fa-lock"></i> required · min ' + q.info.minSupplyPercent + '%</span>' : ''}</div>
          <div class="qmeta">${esc(q.info.name || '')} · ${fmtUsd(q.info.priceUsd)}${t22}${fee} · ${acctLink(q.mint)}</div>
        </div>
        <div class="field has-addons" style="margin:0"><div class="control"><input class="input pct" type="number" step="0.01" min="${q.forced ? q.info.minSupplyPercent : 0.01}" max="100" value="${q.pct}" data-pct="${esc(q.mint)}" ${q.on ? '' : 'disabled'}></div><div class="control"><span class="button is-static" style="background:var(--panel);border-color:var(--line);color:var(--muted)">%</span></div></div>
        <div>${q.custom ? `<button class="button is-ghost is-small" data-remove="${esc(q.mint)}" title="remove"><i class="fas fa-times"></i></button>` : ''}</div>`;
      host.appendChild(row);
    }
    host.querySelectorAll('[data-toggle]').forEach((cb) => cb.addEventListener('change', () => {
      state.quotes[cb.dataset.toggle].on = cb.checked;
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
        const { plan, cost } = await api('/api/orca/estimate', { body: { quotes: currentPlan() } });
        state.estimate = { plan, cost };
        $('#sumPools').textContent = plan.quotes.length;
        $('#sumPct').textContent = fmtPct(plan.totalPercent);
        $('#sumRem').textContent = fmtPct(plan.remainderPercent);
        $('#sumSol').textContent = cost.totalSol;
        $('#fundNeed').textContent = cost.totalSol;
        setMsg('#quoteMsg', '');
        renderPoolPreview(plan);
      } catch (err) {
        state.estimate = null;
        $('#sumPools').textContent = '—';
        $('#sumSol').textContent = '—';
        setMsg('#quoteMsg', esc(err.message), 'bad');
        $('#poolPreview').innerHTML = '';
      }
      updateGates();
    }, 250);
  }

  function launchPriceUsd() {
    const supply = Number($('#tokSupply').value);
    const mcap = Number($('#tokMcap').value);
    if (!(supply > 0) || !(mcap > 0)) return null;
    return mcap / supply;
  }

  function renderImplied() {
    const p = launchPriceUsd();
    $('#impliedPrice').innerHTML = p
      ? `Opens at <strong>${fmtUsd(p)}</strong> per token — ${fmtNum(1 / p, 0)} tokens per dollar.`
      : 'Enter a supply and a starting market cap.';
    $$('#mcapPresets button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.mcap) === Number($('#tokMcap').value)));
  }

  function renderPoolPreview(plan) {
    const p = launchPriceUsd();
    const supply = Number($('#tokSupply').value);
    const rows = plan.quotes.map((q) => {
      const info = state.quotes[q.mint]?.info || {};
      const inQuote = p && info.priceUsd ? p / info.priceUsd : null;
      const tokens = supply * q.supplyPercent / 100;
      return `<tr><td>${esc(info.symbol || short(q.mint))}${q.forced ? ' <i class="fas fa-lock muted"></i>' : ''}</td><td>${fmtPct(q.supplyPercent)}</td><td>${fmtNum(tokens, 0)}</td><td>${inQuote ? fmtNum(inQuote, 6) + ' ' + esc(info.symbol) : '<span class="muted">no price</span>'}</td><td>${fmtUsd(p)}</td></tr>`;
    }).join('');
    $('#poolPreview').innerHTML = `<table class="pools-table"><thead><tr><th>Pool</th><th>Supply share</th><th>Tokens locked</th><th>Opening price</th><th>USD</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  $('#btnAddQuote').addEventListener('click', async () => {
    const mint = $('#customQuote').value.trim();
    if (!isPubkey(mint)) return setMsg('#quoteMsg', 'That is not a valid mint address.', 'bad');
    if (state.quotes[mint]) return setMsg('#quoteMsg', 'Already in the list.', 'warn');
    setMsg('#quoteMsg', '<span class="spin"><i class="fas fa-circle-notch"></i></span> looking up mint…');
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

  $('#feeTier').addEventListener('change', () => { state.tickSpacing = Number($('#feeTier').value); persist(); updateGates(); });

  $('#btnLoadConfig').addEventListener('click', async () => {
    const addr = $('#configAddr').value.trim();
    if (!isPubkey(addr)) return;
    $('#configNote').textContent = 'loading…';
    try { await loadMeta(addr); } catch (err) { $('#configNote').textContent = err.message; }
  });

  $('#btnListConfigs').addEventListener('click', async () => {
    const host = $('#configList');
    host.classList.remove('hidden');
    host.innerHTML = '<span class="muted">scanning configs…</span>';
    try {
      const { configs } = await api('/api/orca/configs');
      host.innerHTML = configs.map((c) => `<div><button class="button is-ghost is-small mono" data-cfg="${esc(c.address)}">${esc(c.address)}</button> <span class="muted">protocol fee ${c.defaultProtocolFeeRate / 100}%</span></div>`).join('');
      host.querySelectorAll('[data-cfg]').forEach((b) => b.addEventListener('click', () => { $('#configAddr').value = b.dataset.cfg; $('#btnLoadConfig').click(); }));
    } catch (err) {
      host.innerHTML = `<span class="muted">${esc(err.message)}</span>`;
    }
  });

  // ---------------------------------------------------------------------
  // Token form
  // ---------------------------------------------------------------------

  ['#tokName', '#tokSymbol', '#tokSupply', '#tokDesc', '#tokMcap'].forEach((sel) => {
    $(sel).addEventListener('input', () => { renderImplied(); refreshEstimate(); });
  });
  $$('#mcapPresets button').forEach((b) => b.addEventListener('click', () => {
    $('#tokMcap').value = b.dataset.mcap;
    renderImplied();
    refreshEstimate();
  }));

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
      $('#fundQr').src = state.wallet.qrCode || '';
      $('#fundQr').classList.toggle('hidden', !state.wallet.qrCode);
      $('#fundAddr').textContent = state.wallet.publicKey;
      $('#savedSecret').checked = state.savedSecret;
      const sec = $('#walletSecret');
      if (state.wallet.secretKeyB58) { sec.dataset.full = state.wallet.secretKeyB58; }
      else { sec.textContent = 'stored on this machine (recovery list) — not shown again'; sec.dataset.full = ''; }
      setBadge('#walletState', short(state.wallet.publicKey), 'ok');
      startBalancePolling();
    } else {
      setBadge('#walletState', '');
      stopBalancePolling();
    }
    updateGates();
  }

  $('#btnGenWallet').addEventListener('click', async () => {
    $('#btnGenWallet').disabled = true;
    try {
      const { wallet } = await api('/api/generate-wallet', { body: {} });
      state.wallet = { publicKey: wallet.publicKey, secretKeyB58: wallet.secretKeyB58, qrCode: wallet.qrCode };
      state.savedSecret = false;
      state.token = null; state.launch = null; state.finish = null;
      $('#walletSecret').textContent = '••••••••••••••••••••••••';
      renderWallet();
      persist();
    } catch (err) {
      alert(err.message);
    } finally {
      $('#btnGenWallet').disabled = false;
    }
  });

  $('#btnUseWallet').addEventListener('click', async () => {
    const pk = $('#existingWallet').value.trim();
    if (!isPubkey(pk)) return alert('Enter a wallet public key.');
    // The secret lives in the server's recovery list; we only need the key.
    let qrCode = null;
    try { const r = await api(`/api/wallet-qr?publicKey=${encodeURIComponent(pk)}`); qrCode = r.qrCode || null; } catch (_) { /* optional */ }
    state.wallet = { publicKey: pk, secretKeyB58: null, qrCode };
    state.savedSecret = true;
    renderWallet();
    persist();
  });

  $('#btnRevealSecret').addEventListener('click', () => {
    const sec = $('#walletSecret');
    if (!state.wallet?.secretKeyB58) return;
    sec.textContent = sec.textContent.startsWith('•') ? state.wallet.secretKeyB58 : '••••••••••••••••••••••••';
  });
  $('#savedSecret').addEventListener('change', () => { state.savedSecret = $('#savedSecret').checked; persist(); updateGates(); });
  $('#btnForgetWallet').addEventListener('click', () => {
    if (state.launch && !state.finish) {
      if (!confirm('This wallet has pools launched but not yet handed off. Start over anyway? (The wallet stays in the recovery list.)')) return;
    }
    state.wallet = null; state.token = null; state.launch = null; state.finish = null; state.savedSecret = false;
    $('#launchProg').innerHTML = ''; $('#launchResults').classList.add('hidden'); $('#finishProg').innerHTML = ''; $('#finishResults').classList.add('hidden');
    $('#tokenCreated').classList.add('hidden');
    setBadge('#tokenState', ''); setBadge('#launchState', ''); setBadge('#finishState', ''); setBadge('#fundState', '');
    renderWallet();
    persist();
  });

  // ---------------------------------------------------------------------
  // Funding
  // ---------------------------------------------------------------------

  let balanceTimer = null;
  let lastBalance = null;
  async function pollBalance() {
    if (!state.wallet) return;
    try {
      const { balance } = await api('/api/check-balance', { body: { publicKey: state.wallet.publicKey } });
      lastBalance = Number(balance) || 0;
      $('#fundBal').textContent = lastBalance.toFixed(4);
      const need = state.estimate?.cost?.totalSol || 0;
      setBadge('#fundState', lastBalance >= need && need > 0 ? 'funded' : (lastBalance > 0 ? `${lastBalance.toFixed(3)} SOL` : 'waiting'), lastBalance >= need && need > 0 ? 'ok' : 'warn');
      updateGates();
    } catch (_) { /* transient */ }
  }
  function startBalancePolling() { stopBalancePolling(); pollBalance(); balanceTimer = setInterval(pollBalance, 6000); }
  function stopBalancePolling() { clearInterval(balanceTimer); balanceTimer = null; }

  // ---------------------------------------------------------------------
  // Gates
  // ---------------------------------------------------------------------

  function tokenFormValid() {
    return $('#tokName').value.trim().length > 0 && $('#tokSymbol').value.trim().length > 0
      && Number($('#tokSupply').value) > 0 && Number($('#tokMcap').value) > 0;
  }

  function updateGates() {
    const haveWallet = !!state.wallet && state.savedSecret;
    const planOk = !!state.estimate;
    const need = state.estimate?.cost?.totalSol || 0;
    const funded = (lastBalance || 0) >= need && need > 0;
    const launched = !!state.launch;
    $('#btnLaunch').disabled = !(haveWallet && (state.token || tokenFormValid()) && planOk && state.tickSpacing && (funded || launched));
    $('#btnFinish').disabled = !(launched && isPubkey($('#destWallet').value) && !state.finish);
    $('#card-launch').classList.toggle('is-done', launched);
    $('#card-finish').classList.toggle('is-done', !!state.finish);
    $('#card-token').classList.toggle('is-done', !!state.token);
    $('#card-wallet').classList.toggle('is-done', haveWallet);
    $('#card-fund').classList.toggle('is-done', funded || launched);
    if (state.token) {
      ['#tokName', '#tokSymbol', '#tokSupply', '#tokDesc', '#tokLogo'].forEach((s) => { $(s).disabled = true; });
    }
  }

  // ---------------------------------------------------------------------
  // Launch: token create + orca pools, with progress
  // ---------------------------------------------------------------------

  function progRow(id, label, sub) {
    return `<li id="${id}" class="${sub ? 'sub' : ''}"><span class="st pending"><i class="far fa-circle"></i></span><span>${label}</span><span class="extra"></span></li>`;
  }
  function progSet(id, status, extra) {
    const li = document.getElementById(id);
    if (!li) return;
    const st = li.querySelector('.st');
    st.className = `st ${status}`;
    st.innerHTML = status === 'done' ? '<i class="fas fa-check-circle"></i>'
      : status === 'running' ? '<span class="spin"><i class="fas fa-circle-notch"></i></span>'
      : status === 'failed' ? '<i class="fas fa-times-circle"></i>'
      : '<i class="far fa-circle"></i>';
    if (extra !== undefined) li.querySelector('.extra').innerHTML = extra;
  }

  function buildLaunchTree(plan) {
    const rows = [progRow('p-token', state.token ? `Token ${esc(state.token.symbol)} (already minted)` : 'Mint token + metadata, renounce authorities')];
    plan.quotes.forEach((q, i) => {
      const sym = esc(state.quotes[q.mint]?.info?.symbol || short(q.mint));
      rows.push(progRow(`p-${i}`, `Pool vs ${sym} — ${fmtPct(q.supplyPercent)} of supply`));
      rows.push(progRow(`p-${i}-pool`, 'create Whirlpool', true));
      rows.push(progRow(`p-${i}-pos`, 'open single-sided position', true));
      rows.push(progRow(`p-${i}-lock`, 'deposit + permanent lock', true));
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
      case 'position_open_start': progSet(`p-${i}-pos`, 'running'); break;
      case 'position_open_done': progSet(`p-${i}-pos`, 'done', txLink(ev.txId)); break;
      case 'deposit_lock_start': case 'lock_start': progSet(`p-${i}-pos`, 'done'); progSet(`p-${i}-lock`, 'running'); break;
      case 'lock_exists': progSet(`p-${i}-pos`, 'done'); progSet(`p-${i}-lock`, 'done', 'already locked'); progSet(`p-${i}`, 'done'); break;
      case 'lock_done': progSet(`p-${i}-lock`, 'done', txLink(ev.txId)); progSet(`p-${i}`, 'done'); break;
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
    const logo = $('#tokLogo').files[0];
    if (logo) fd.append('logo', logo);
    const r = await api('/api/create-token', { body: fd });
    state.token = {
      mint: r.tokenMint, name: r.name, symbol: r.symbol, totalSupply: Number(r.totalSupply),
      decimals: r.decimals || 9, imageUri: r.imageUri || null, metadataUri: r.metadataUri || null,
    };
    persist();
    progSet('p-token', 'done', acctLink(state.token.mint, short(state.token.mint)));
    $('#tokenCreated').classList.remove('hidden');
    $('#tokenCreated').innerHTML = `Minted <strong>${esc(state.token.symbol)}</strong> · ${acctLink(state.token.mint, state.token.mint)} · mint &amp; freeze authorities renounced.`;
    setBadge('#tokenState', 'minted', 'ok');
    updateGates();
    return state.token;
  }

  $('#btnLaunch').addEventListener('click', async () => {
    if (!state.estimate) return;
    const btn = $('#btnLaunch');
    btn.disabled = true;
    setMsg('#launchMsg', '');
    setBadge('#launchState', 'running', 'warn');
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
          priorResults: state.launch?.results || [],
          tokenMeta: { name: token.name, symbol: token.symbol, imageUrl: token.imageUri },
        },
      });
      await sleep(1500); // let the last progress events land
      stopProgressPolling();
      state.launch = { results: r.results, plan: r.plan, feeRate: r.feeRate, tickSpacing: r.tickSpacing, whirlpoolsConfig: r.whirlpoolsConfig, mcap };
      persist();
      r.results.forEach((res, i) => { progSet(`p-${i}`, 'done'); progSet(`p-${i}-pool`, 'done', acctLink(res.poolId)); progSet(`p-${i}-pos`, 'done', acctLink(res.positionMint)); progSet(`p-${i}-lock`, 'done', txLink(res.lockTxId)); });
      renderLaunchResults();
      setBadge('#launchState', `${r.results.length} pools locked`, 'ok');
      setMsg('#launchMsg', 'Every position is permanently locked. Enter your wallet below to receive the locked positions, the un-pooled supply and the leftover SOL.', 'ok');
    } catch (err) {
      stopProgressPolling();
      if (Array.isArray(err.partialResults) && err.partialResults.length) {
        state.launch = { ...(state.launch || {}), results: err.partialResults, partial: true };
        persist();
      }
      setBadge('#launchState', 'failed', 'bad');
      setMsg('#launchMsg', `${esc(describeError(err))}${err.failedPhase === 'pre_flight' || err.code === 'OP_IN_FLIGHT' ? '' : '<br><span class="muted">Nothing is lost: fix the cause (usually funding) and press Launch again with this wallet — finished pools are skipped.</span>'}`, 'bad');
    } finally {
      startBalancePolling();
      updateGates();
      if (!state.launch || state.launch.partial) btn.disabled = false;
    }
  });

  function renderLaunchResults() {
    const L = state.launch;
    if (!L?.results?.length) return;
    const rows = L.results.map((r) => `<tr>
      <td>${esc(r.quoteSymbol)}${r.forced ? ' <i class="fas fa-lock muted"></i>' : ''}</td>
      <td>${fmtPct(r.supplyPercent)}</td>
      <td>${fmtUsd(r.launchPriceUsd)}</td>
      <td>${acctLink(r.poolId)} · <a target="_blank" rel="noopener" href="https://www.orca.so/pools/${esc(r.poolId)}">orca</a></td>
      <td>${acctLink(r.positionMint)}</td>
      <td>${r.locked ? `<span class="badge ok">locked</span> ${txLink(r.lockTxId)}` : '<span class="badge bad">not locked</span>'}</td>
    </tr>`).join('');
    $('#launchResults').classList.remove('hidden');
    $('#launchResults').innerHTML = `<table class="pools-table"><thead><tr><th>Quote</th><th>Share</th><th>Opened at</th><th>Pool</th><th>Position</th><th>Lock</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ---------------------------------------------------------------------
  // Finish
  // ---------------------------------------------------------------------

  $('#destWallet').addEventListener('input', () => { state.destWallet = $('#destWallet').value.trim(); persist(); updateGates(); });

  function onFinishEvent(ev) {
    switch (ev.stage) {
      case 'position_transfer_start': progSet(`f-${ev.positionMint}`, 'running'); break;
      case 'position_transfer_done': progSet(`f-${ev.positionMint}`, 'done', txLink(ev.txId)); break;
      case 'position_transfer_failed': progSet(`f-${ev.positionMint}`, 'failed', esc(ev.error || '')); break;
      case 'sweep_tokens_start': progSet('f-tokens', 'running'); break;
      case 'sweep_tokens_done': progSet('f-tokens', 'done', `${ev.transferred} transfer(s)`); break;
      case 'sweep_sol_start': progSet('f-sol', 'running'); break;
      case 'sweep_sol_done': progSet('f-sol', 'done', `${fmtNum(Number(ev.sol) || 0, 4)} SOL`); break;
      default: break;
    }
  }

  $('#btnFinish').addEventListener('click', async () => {
    const dest = $('#destWallet').value.trim();
    if (!isPubkey(dest)) return;
    if (!confirm(`Send every locked position, the un-pooled tokens and the leftover SOL to\n\n${dest}\n\nThis cannot be undone. Double-check the address.`)) return;
    const btn = $('#btnFinish');
    btn.disabled = true;
    setMsg('#finishMsg', '');
    setBadge('#finishState', 'running', 'warn');
    const positions = state.launch.results.filter((r) => r.locked && r.positionMint).map((r) => ({ positionMint: r.positionMint, quoteSymbol: r.quoteSymbol }));
    $('#finishProg').innerHTML = positions.map((p) => progRow(`f-${p.positionMint}`, `locked position (${esc(p.quoteSymbol)}) → your wallet`)).join('')
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
      setBadge('#finishState', 'done', 'ok');
      $('#finishResults').classList.remove('hidden');
      $('#finishResults').innerHTML = `<div class="msg ok">Done. ${r.transfers.length} locked position(s) now sit in ${acctLink(dest)}. They earn fees forever and can never be withdrawn.${r.walletEmpty ? ' The launch wallet is empty and was removed from the recovery list.' : ' Some dust remains in the launch wallet; it stays in the recovery list.'}</div>`;
    } catch (err) {
      stopProgressPolling();
      setBadge('#finishState', 'failed', 'bad');
      setMsg('#finishMsg', `${esc(describeError(err))}<br><span class="muted">Press Send again; completed transfers are skipped.</span>`, 'bad');
      btn.disabled = false;
    } finally {
      startBalancePolling();
      updateGates();
    }
  });

  // ---------------------------------------------------------------------
  // Explore feed
  // ---------------------------------------------------------------------

  let feedTimer = null;
  async function loadFeed() {
    $('#feedMsg').innerHTML = '<div class="msg"><span class="spin"><i class="fas fa-circle-notch"></i></span> scanning the config…</div>';
    try {
      const r = await api(`/api/orca/discover?config=${encodeURIComponent(state.config || '')}`);
      $('#feedMsg').innerHTML = r.launches.length === 0
        ? `<div class="msg">No launches locked on this config since ${new Date(r.sinceUnix * 1000).toLocaleString()} yet — ${r.scannedPools} pool(s) scanned. Yours could be first.</div>`
        : `<div class="msg">${r.launches.length} launch(es) · ${r.scannedPools} pool(s) on the config · updated ${new Date(r.fetchedAt * 1000).toLocaleTimeString()}${r.error ? ' · ' + esc(r.error) : ''}</div>`;
      $('#feed').innerHTML = r.launches.map(renderLaunchCard).join('');
    } catch (err) {
      $('#feedMsg').innerHTML = `<div class="msg bad">${esc(err.message)}</div>`;
    }
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => { if (!$('#tab-explore').classList.contains('hidden')) loadFeed(); }, 60_000);
  }
  $('#btnRefreshFeed').addEventListener('click', loadFeed);

  function renderLaunchCard(l) {
    const img = l.imageUrl ? `<img src="${esc(l.imageUrl)}" alt="">` : '<span style="width:44px;height:44px;border-radius:50%;background:#333;display:inline-block"></span>';
    const pools = l.pools.map((p) => `<tr>
      <td>${esc(p.quoteSymbol)}</td>
      <td>${p.feePercent}%</td>
      <td>${p.priceInQuote ? fmtNum(p.priceInQuote, 6) + ' ' + esc(p.quoteSymbol) : '—'}</td>
      <td>${fmtUsd(p.priceUsd)}</td>
      <td><span class="badge ok"><i class="fas fa-lock"></i> ${p.lockedPositions} permanent</span></td>
      <td><a target="_blank" rel="noopener" href="${esc(p.orcaUrl)}">trade</a> · ${acctLink(p.poolId, 'pool')}</td>
    </tr>`).join('');
    return `<div class="launch-card">
      <div class="head">${img}<div><div class="t">${esc(l.name || l.symbol)} <span class="muted">${esc(l.symbol)}</span></div><div class="s">${acctLink(l.tokenMint, l.tokenMint)} · launched ${new Date(l.launchedAt * 1000).toLocaleString()}</div></div></div>
      <div class="stats">
        <div><div class="k">Price</div><div class="v">${fmtUsd(l.priceUsd)}</div></div>
        <div><div class="k">Market cap</div><div class="v">${fmtUsd(l.marketCapUsd)}</div></div>
        <div><div class="k">Pools</div><div class="v">${l.pools.length}</div></div>
        <div><div class="k">Quotes</div><div class="v">${l.pools.map((p) => esc(p.quoteSymbol)).join(' · ')}</div></div>
      </div>
      <table class="pools-table"><thead><tr><th>Quote</th><th>Fee</th><th>Price</th><th>USD</th><th>Liquidity</th><th></th></tr></thead><tbody>${pools}</tbody></table>
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
    renderImplied();
    try {
      await loadMeta(state.config);
    } catch (err) {
      setMsg('#quoteMsg', `Could not load the Orca config: ${esc(err.message)}`, 'bad');
    }
    renderWallet();
    if (state.token) {
      $('#tokenCreated').classList.remove('hidden');
      $('#tokenCreated').innerHTML = `Minted <strong>${esc(state.token.symbol)}</strong> · ${acctLink(state.token.mint, state.token.mint)}`;
      setBadge('#tokenState', 'minted', 'ok');
    }
    if (state.launch?.results?.length) {
      buildLaunchTree({ quotes: state.launch.results.map((r) => ({ mint: r.quoteMint, supplyPercent: r.supplyPercent })) });
      state.launch.results.forEach((res, i) => {
        progSet(`p-${i}`, res.locked ? 'done' : 'failed');
        progSet(`p-${i}-pool`, res.poolId ? 'done' : 'pending', acctLink(res.poolId));
        progSet(`p-${i}-pos`, res.positionMint ? 'done' : 'pending', acctLink(res.positionMint));
        progSet(`p-${i}-lock`, res.locked ? 'done' : 'pending', txLink(res.lockTxId));
      });
      renderLaunchResults();
      setBadge('#launchState', state.launch.partial ? 'partial — press Launch to resume' : `${state.launch.results.length} pools locked`, state.launch.partial ? 'warn' : 'ok');
    }
    if (state.finish) {
      setBadge('#finishState', 'done', 'ok');
      $('#finishResults').classList.remove('hidden');
      $('#finishResults').innerHTML = `<div class="msg ok">Handed off to ${acctLink(state.finish.destinationWallet)}.</div>`;
    }
    updateGates();
  })();
})();
