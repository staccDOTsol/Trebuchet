// orcaRoutes.js
//
// HTTP surface for the Orca launch path (public/orca.html). Mounted from
// server.js via registerOrcaRoutes(app, deps) so the big server file only
// gains one import and one call; every helper it needs (signer resolution,
// the per-wallet launch mutex, live progress, the journal) is injected.
//
// Routes:
//   GET  /api/orca/meta       config + fee tiers + quote descriptions
//   GET  /api/orca/configs    every config owned by the config authority
//   GET  /api/orca/quote-info?mint=   describe an arbitrary quote mint
//   POST /api/orca/estimate   normalize the plan + SOL estimate
//   POST /api/orca/launch     create pools, seed, lock (progress via /api/lp-progress)
//   POST /api/orca/finish     hand locked positions + leftovers to the launcher
//   GET  /api/orca/discover   launches locked on the config since the cutoff
//   GET  /api/orca/claimable?owner=&mint=   pending fees on a creator's locked positions
//   POST /api/orca/claim/build   unsigned collect-fee txs for the creator's wallet to sign
//   POST /api/orca/claim/send    submit the signed txs over the server RPC
//
// There is no demo path. Every launch is real.

import {
  listWhirlpoolsConfigs,
  getFeeTiers,
  getConfigInfo,
  describeQuote,
  describeAllQuotes,
  createOrcaPoolsAndLock,
  finishOrcaLaunch,
  discoverLaunches,
  getLaunch,
  estimateOrcaLaunch,
} from './orcaLpService.js';
import { getClaimable, buildClaimTransactions, sendSignedClaims, DEFAULT_MAX_TXS_PER_ROUND } from './orcaClaimService.js';
import {
  DEFAULT_WHIRLPOOLS_CONFIG,
  ORCA_CONFIG_AUTHORITY,
  DISCOVERY_SINCE_UNIX,
  FORCED_MIN_SUPPLY_PCT,
  ORCA_MAX_PROTOCOL_FEE_RATE,
  normalizeOrcaQuotes,
  pickDefaultFeeTier,
} from './orcaLpPlan.js';
import { checkWalletBalanceMultiToken } from './walletHelpers.js';
import { isWalletEffectivelyEmpty } from './walletRecovery.js';

function isPubkeyish(s) {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

export function registerOrcaRoutes(app, deps) {
  const {
    resolveSigner,
    rejectOrClaimLaunchOp,
    clearLaunchOpInFlight,
    rejectIfSecretPinLocked,
    lpProgressBegin,
    lpProgressEvent,
    lpProgressEnd,
    launchJournal,
    pendingWallets,
  } = deps;

  // A wallet whose key arrived inline (pasted into the page because this
  // server never had it, or lost it) goes into the recovery list so the rest
  // of the launch can resolve it by public key and a crash is recoverable.
  function rememberInlineSigner(signer) {
    if (signer.source !== 'body') return;
    try {
      if (!pendingWallets.get(signer.walletPublicKey)) {
        pendingWallets.add(signer.walletPublicKey, signer.secretKeyArr, null);
      }
    } catch (err) {
      console.warn(`orca: could not store inline signer in the recovery list: ${err.message}`);
    }
  }

  // ---- read-only -----------------------------------------------------------

  app.get('/api/orca/meta', async (req, res) => {
    try {
      const whirlpoolsConfig = isPubkeyish(req.query.config) ? req.query.config : DEFAULT_WHIRLPOOLS_CONFIG;
      const [config, tiers, quotes] = await Promise.all([
        getConfigInfo(whirlpoolsConfig).catch((err) => ({ address: whirlpoolsConfig, error: err.message })),
        getFeeTiers(whirlpoolsConfig),
        describeAllQuotes(),
      ]);
      res.json({
        success: true,
        configAuthority: ORCA_CONFIG_AUTHORITY,
        defaultConfig: DEFAULT_WHIRLPOOLS_CONFIG,
        config,
        feeTiers: tiers.tiers,
        feeTierSource: tiers.source,
        defaultFeeTier: pickDefaultFeeTier(tiers.tiers),
        forcedQuotes: quotes.forced,
        optionalQuotes: quotes.optional,
        forcedMinSupplyPercent: FORCED_MIN_SUPPLY_PCT,
        discoverySinceUnix: DISCOVERY_SINCE_UNIX,
        requiredProtocolFeeRate: ORCA_MAX_PROTOCOL_FEE_RATE,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/orca/configs', async (req, res) => {
    try {
      const authority = isPubkeyish(req.query.authority) ? req.query.authority : ORCA_CONFIG_AUTHORITY;
      const configs = await listWhirlpoolsConfigs(authority);
      res.json({ success: true, authority, configs });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/orca/quote-info', async (req, res) => {
    try {
      const mint = String(req.query.mint || '').trim();
      if (!isPubkeyish(mint)) return res.status(400).json({ success: false, error: 'mint query param required' });
      const info = await describeQuote(mint);
      res.json({ success: true, quote: info });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/orca/discover', async (req, res) => {
    try {
      const whirlpoolsConfig = isPubkeyish(req.query.config) ? req.query.config : DEFAULT_WHIRLPOOLS_CONFIG;
      const since = Number.isFinite(Number(req.query.since)) && req.query.since !== ''
        ? Number(req.query.since)
        : DISCOVERY_SINCE_UNIX;
      const feed = await discoverLaunches({ whirlpoolsConfig, sinceUnix: since });
      res.json({ success: true, ...feed });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/orca/token/:mint', async (req, res) => {
    try {
      const mint = String(req.params.mint || '');
      if (!isPubkeyish(mint)) return res.status(400).json({ success: false, error: 'bad mint' });
      const whirlpoolsConfig = isPubkeyish(req.query.config) ? req.query.config : DEFAULT_WHIRLPOOLS_CONFIG;
      const launch = await getLaunch(mint, { whirlpoolsConfig, sinceUnix: 0 });
      if (!launch) return res.status(404).json({ success: false, error: 'no locked pools for this token on the config' });
      res.json({ success: true, launch });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---- creator fee claims --------------------------------------------------

  function claimScope(src) {
    const owner = String(src?.owner || '');
    if (!isPubkeyish(owner)) return { error: 'owner wallet address required' };
    const mint = src?.mint ? String(src.mint) : null;
    if (mint && !isPubkeyish(mint)) return { error: 'bad mint' };
    let poolIds = null;
    if (Array.isArray(src?.poolIds) && src.poolIds.length) {
      poolIds = src.poolIds.map(String);
      if (poolIds.length > 64 || !poolIds.every(isPubkeyish)) return { error: 'bad poolIds' };
    } else if (typeof src?.poolIds === 'string' && src.poolIds) {
      poolIds = src.poolIds.split(',').map((x) => x.trim()).filter(Boolean);
      if (poolIds.length > 64 || !poolIds.every(isPubkeyish)) return { error: 'bad poolIds' };
    }
    return { owner, mint, poolIds };
  }

  app.get('/api/orca/claimable', async (req, res) => {
    const scope = claimScope(req.query);
    if (scope.error) return res.status(400).json({ success: false, error: scope.error });
    try {
      const data = await getClaimable(scope);
      res.json({ success: true, ...data });
    } catch (error) {
      res.status(error.status || 500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/orca/claim/build', async (req, res) => {
    const scope = claimScope(req.body);
    if (scope.error) return res.status(400).json({ success: false, error: scope.error });
    const maxTxs = Math.min(16, Math.max(1, Number(req.body?.maxTxs) || DEFAULT_MAX_TXS_PER_ROUND));
    try {
      const data = await buildClaimTransactions({ ...scope, maxTxs });
      res.json({ success: true, ...data });
    } catch (error) {
      res.status(error.status || 500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/orca/claim/send', async (req, res) => {
    try {
      const signedTxs = Array.isArray(req.body?.signedTxs) ? req.body.signedTxs.map(String) : [];
      const lastValidBlockHeight = Number.isFinite(Number(req.body?.lastValidBlockHeight)) ? Number(req.body.lastValidBlockHeight) : null;
      const data = await sendSignedClaims({ signedTxs, lastValidBlockHeight });
      res.json({ success: true, ...data });
    } catch (error) {
      res.status(error.status || 500).json({ success: false, error: error.message });
    }
  });

  // ---- planning ------------------------------------------------------------

  app.post('/api/orca/estimate', (req, res) => {
    try {
      const { plan, cost, ladderSteps } = estimateOrcaLaunch({ quotes: req.body?.quotes, ladderSteps: req.body?.ladderSteps });
      res.json({ success: true, plan, cost, ladderSteps });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ---- the launch ----------------------------------------------------------

  app.post('/api/orca/launch', async (req, res) => {
    let walletPublicKey = null;
    let claimedLaunchOp = false;
    try {
      const {
        tempWalletSecretKey,
        tokenMint,
        tokenDecimals,
        tokenTotalSupply,
        targetMarketCapUsd,
        quotes,
        whirlpoolsConfig,
        tickSpacing,
        ladderSteps,
        priorResults,
      } = req.body || {};

      if (!isPubkeyish(tokenMint)) throw badRequest('tokenMint required');
      if (!(Number(tokenTotalSupply) > 0)) throw badRequest('tokenTotalSupply must be > 0');
      if (!(Number(targetMarketCapUsd) > 0)) throw badRequest('targetMarketCapUsd must be > 0');
      if (!Number.isInteger(Number(tickSpacing))) throw badRequest('tickSpacing required');
      // Validate the plan before touching the wallet so a bad request never
      // claims the launch mutex.
      const plan = normalizeOrcaQuotes(quotes);
      const config = isPubkeyish(whirlpoolsConfig) ? whirlpoolsConfig : DEFAULT_WHIRLPOOLS_CONFIG;

      if (req.body.walletPublicKey && rejectIfSecretPinLocked(res, 'launching Orca pools with a saved launch wallet')) {
        return;
      }
      const signer = resolveSigner({ tempWalletSecretKey, walletPublicKey: req.body.walletPublicKey });
      walletPublicKey = signer.walletPublicKey;
      rememberInlineSigner(signer);
      if (rejectOrClaimLaunchOp(res, walletPublicKey, 'orca-launch')) {
        walletPublicKey = null;
        return;
      }
      claimedLaunchOp = true;

      const poolPlan = {
        venue: 'orca',
        tokenMint,
        tokenDecimals: tokenDecimals || 9,
        tokenTotalSupply,
        targetMarketCapUsd,
        whirlpoolsConfig: config,
        tickSpacing: Number(tickSpacing),
        ladderSteps: Number(ladderSteps) || 1,
        quotes: plan.quotes,
      };
      launchJournal.upsertForWallet(
        walletPublicKey,
        { status: 'active', stage: 'orca_lp_started', poolPlan, error: null, errorDetails: null },
        { stage: 'orca_lp_started', tokenMint, poolCount: plan.quotes.length },
      );
      lpProgressBegin(walletPublicKey);
      const onProgress = (event) => {
        try { lpProgressEvent(walletPublicKey, event); } catch (_) { /* best-effort */ }
        try { launchJournal.recordEvent(walletPublicKey, { stage: `orca:${event.stage}`, ...event }); } catch (_) { /* ditto */ }
      };

      const outcome = await createOrcaPoolsAndLock({
        tempWalletSecretKey: signer.secretKeyArr,
        tokenMint,
        tokenDecimals: tokenDecimals || 9,
        tokenTotalSupply,
        targetMarketCapUsd,
        quotes: plan.quotes,
        whirlpoolsConfig: config,
        tickSpacing: Number(tickSpacing),
        ladderSteps: Number(ladderSteps) || 1,
        priorResults: Array.isArray(priorResults) ? priorResults : [],
        onProgress,
      });

      launchJournal.upsertForWallet(
        walletPublicKey,
        { status: 'active', stage: 'orca_lp_done', lp: { venue: 'orca', results: outcome.results, whirlpoolsConfig: outcome.whirlpoolsConfig, tickSpacing: outcome.tickSpacing, feeRate: outcome.feeRate } },
        { stage: 'orca_lp_done', poolCount: outcome.results.length },
      );
      res.json({ success: true, ...outcome, plan });
    } catch (error) {
      console.error('Orca launch failed:', error.message);
      if (walletPublicKey) {
        try {
          launchJournal.upsertForWallet(
            walletPublicKey,
            {
              status: 'failed',
              stage: 'orca_lp_failed',
              error: error.message,
              errorDetails: launchJournal.errorDetails(error, { route: 'orca-launch', failedPhase: error.failedPhase || 'orca_pools' }),
              lp: { venue: 'orca', results: error.partialResults || [] },
            },
            { stage: 'orca_lp_failed', error: error.message },
          );
        } catch (_) { /* never mask the real error */ }
      }
      res.status(error.statusCode || (error.failedPhase === 'pre_flight' ? 400 : 500)).json({
        success: false,
        error: error.message,
        failedPhase: error.failedPhase || 'orca_pools',
        failedQuoteIndex: error.failedQuoteIndex ?? null,
        failedQuote: error.failedQuote || null,
        partialResults: error.partialResults || [],
      });
    } finally {
      if (walletPublicKey) lpProgressEnd(walletPublicKey);
      if (claimedLaunchOp && walletPublicKey) {
        clearLaunchOpInFlight(walletPublicKey);
      }
    }
  });

  // ---- hand-off ------------------------------------------------------------

  app.post('/api/orca/finish', async (req, res) => {
    let walletPublicKey = null;
    let claimedLaunchOp = false;
    try {
      const { tempWalletSecretKey, destinationWallet, positions } = req.body || {};
      if (!isPubkeyish(destinationWallet)) throw badRequest('destinationWallet must be a valid address');
      const list = Array.isArray(positions) ? positions.filter((p) => p && isPubkeyish(p.positionMint)) : [];

      if (req.body.walletPublicKey && rejectIfSecretPinLocked(res, 'finishing an Orca launch with a saved launch wallet')) {
        return;
      }
      const signer = resolveSigner({ tempWalletSecretKey, walletPublicKey: req.body.walletPublicKey });
      walletPublicKey = signer.walletPublicKey;
      rememberInlineSigner(signer);
      if (walletPublicKey === destinationWallet) throw badRequest('destination must differ from the launch wallet');
      if (rejectOrClaimLaunchOp(res, walletPublicKey, 'orca-finish')) {
        walletPublicKey = null;
        return;
      }
      claimedLaunchOp = true;

      lpProgressBegin(walletPublicKey);
      const onProgress = (event) => { try { lpProgressEvent(walletPublicKey, event); } catch (_) { /* best-effort */ } };
      launchJournal.upsertForWallet(walletPublicKey, { stage: 'orca_finish_started', transfer: { destinationWallet } }, { stage: 'orca_finish_started', destinationWallet });

      const outcome = await finishOrcaLaunch({
        tempWalletSecretKey: signer.secretKeyArr,
        destinationWallet,
        positions: list,
        onProgress,
      });
      let walletEmpty = false;
      try {
        const balance = await checkWalletBalanceMultiToken(walletPublicKey);
        walletEmpty = isWalletEffectivelyEmpty(balance);
      } catch (_) { walletEmpty = false; }

      launchJournal.upsertForWallet(
        walletPublicKey,
        { status: 'completed', stage: 'orca_finished', transfer: { destinationWallet, ...outcome, walletEmpty } },
        { stage: 'orca_finished', destinationWallet },
      );
      if (walletEmpty) {
        try { pendingWallets.remove(walletPublicKey); } catch (_) { /* recovery entry is best-effort */ }
      }
      res.json({ success: true, ...outcome, walletEmpty });
    } catch (error) {
      console.error('Orca finish failed:', error.message);
      if (walletPublicKey) {
        try {
          launchJournal.upsertForWallet(
            walletPublicKey,
            { status: 'failed', stage: 'orca_finish_failed', error: error.message, transfer: { transfers: error.transfers || null } },
            { stage: 'orca_finish_failed', error: error.message },
          );
        } catch (_) { /* never mask the real error */ }
      }
      res.status(error.statusCode || 500).json({ success: false, error: error.message, transfers: error.transfers || null });
    } finally {
      if (walletPublicKey) lpProgressEnd(walletPublicKey);
      if (claimedLaunchOp && walletPublicKey) {
        clearLaunchOpInFlight(walletPublicKey);
      }
    }
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.failedPhase = 'pre_flight';
  return err;
}
