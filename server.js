import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import {
  createTokenWithMetaplex,
  finishTokenCreation,
  generateTemporaryWallet,
  getWalletQRCode,
  checkWalletBalance,
  findFundingWallet,
  refreshConnection as refreshTokenServiceConnection,
} from './tokenService.js';

import { checkWalletBalanceMultiToken } from './walletHelpers.js';

import {
  getConfig as getRpcConfig,
  getRpcUrl,
  setActiveRpc,
  addSavedRpc,
  removeSavedRpc,
  testRpc,
} from './rpcConfig.js';

import * as pendingWallets from './pendingWallets.js';
import * as vanityCaStore from './vanityCaStore.js';
import * as secretStore from './secretStore.js';
import * as launchJournal from './launchJournal.js';
import * as userPrefs from './userPrefs.js';
import * as updateCheckBridge from './updateCheckBridge.js';
import {
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  normalizeTokenDescription,
  normalizeLogoImageMime,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeWholeTokenSupply,
} from './validators.js';
import { isWalletEffectivelyEmpty } from './walletRecovery.js';
import { registerOrcaRoutes } from './orcaRoutes.js';


// ---------------------------------------------------------------------------
// Per-wallet launch-operation mutex.
//
// Every chain-touching launch operation (token creation, quote-token
// acquisition, pool creation, resume, asset transfer) is long-running and
// mutates the same ephemeral wallet's balances. Running two of them
// concurrently for the same wallet is never correct:
//
//   - create-lp twice          -> duplicate pools, double-spent supply
//   - create-lp + transfer     -> sweep pulls tokens out from under the
//                                 launch mid-flight
//   - acquire twice            -> double swap, double the SOL spent
//   - create-lp + resume       -> two orchestrators fighting over the
//                                 same positions
//
// How would a double-submit even happen, given the frontend disables its
// buttons? The server runs in-process with Electron main, so a renderer
// crash/reload mid-launch reloads the UI while the launch KEEPS RUNNING
// in the background. The user then recovers the pending wallet and clicks
// Create Pools (or Resume) again — and without this guard, a second
// orchestrator starts against the same wallet while the first is still
// going. A slow network double-click is the other path.
//
// Guarded endpoints check this map after resolving the wallet public key
// and return HTTP 409 with code 'OP_IN_FLIGHT' if another operation is
// already running. The frontend translates that into "an operation is
// already running for this wallet — wait for it to finish" instead of
// letting the user double-fire.
//
// In-memory only, like airdropsInFlight: if the app restarts, any
// in-flight operation died with it, so a fresh map is the correct state.
// Entries are cleared in try/finally so even an uncaught throw releases
// the lock.
const launchOpsInFlight = new Map(); // walletPublicKey -> { op, startedAt }

function launchOpInFlight(walletPublicKey) {
  return launchOpsInFlight.get(walletPublicKey) || null;
}
function markLaunchOpInFlight(walletPublicKey, op) {
  launchOpsInFlight.set(walletPublicKey, { op, startedAt: Date.now() });
}
function clearLaunchOpInFlight(walletPublicKey) {
  launchOpsInFlight.delete(walletPublicKey);
}
// Shared 409 rejection. Returns true if the request was rejected (caller
// should return immediately); false if the wallet is free and the caller
// has been marked as the current operation.
function rejectOrClaimLaunchOp(res, walletPublicKey, op) {
  const current = launchOpInFlight(walletPublicKey);
  if (current) {
    const runningForSec = Math.round((Date.now() - current.startedAt) / 1000);
    console.warn(
      `Rejecting ${op} for wallet ${walletPublicKey} — '${current.op}' has been ` +
        `running for ${runningForSec}s on the same wallet.`,
    );
    res.status(409).json({
      success: false,
      code: 'OP_IN_FLIGHT',
      op: current.op,
      runningForSec,
      error:
        `Another launch operation ('${current.op}') is already running for this ` +
        `wallet (started ${runningForSec}s ago). Launches can take several ` +
        `minutes — wait for it to finish rather than retrying. Running two ` +
        `operations on the same wallet at once can create duplicate pools or ` +
        `sweep funds mid-launch. If you're certain the operation is dead ` +
        `(not just slow), restarting the app clears this lock.`,
    });
    return true;
  }
  markLaunchOpInFlight(walletPublicKey, op);
  return false;
}


// Per-launch LP progress event log. Demo mode and (eventually) real mode
// write into this Map as each step of pool/position creation completes;
// the frontend polls /api/lp-progress with a `since` cursor to learn
// about new events without re-streaming the whole log. Translates to row
// markings on the frontend's phase progress tree so individual rows
// tick from pending → done as the work progresses (instead of all
// flipping at once when the /api/create-lp response lands).
//
// Shape per wallet:
//   {
//     events: [{ stage, allocationIndex, sliceIndex?, bandIndex?, ... }, ...]
//     status: 'running' | 'done'
//     startedAt: epoch ms
//   }
//
// Same lifecycle as airdropProgress — in-memory, auto-cleared 30s after
// the run finishes so a slow last poll still picks up the terminal state.
const lpProgress = new Map();
function lpProgressBegin(walletPublicKey) {
  lpProgress.set(walletPublicKey, {
    events: [],
    status: 'running',
    startedAt: Date.now(),
  });
}
function lpProgressEvent(walletPublicKey, event) {
  const state = lpProgress.get(walletPublicKey);
  if (!state) return;
  state.events.push(event);
}
function lpProgressEnd(walletPublicKey) {
  const state = lpProgress.get(walletPublicKey);
  if (!state) return;
  state.status = 'done';
  setTimeout(() => {
    const cur = lpProgress.get(walletPublicKey);
    if (cur && cur.status === 'done') {
      lpProgress.delete(walletPublicKey);
    }
  }, 30_000);
}
function lpProgressGet(walletPublicKey, sinceIdx = 0) {
  const state = lpProgress.get(walletPublicKey);
  if (!state) return null;
  return {
    status: state.status,
    totalEvents: state.events.length,
    // Slice from `since` so a polling client only sees what it hasn't yet.
    events: state.events.slice(sinceIdx),
  };
}

// Lazy import to avoid crash on startup in packaged builds
let _generateVanityKeypair = null;
async function getVanityKeygen() {
  if (!_generateVanityKeypair) {
    const mod = await import('./vanityKeygen.js');
    _generateVanityKeypair = mod.generateVanityKeypair;
  }
  return _generateVanityKeypair;
}

// Cached vanity availability. Computed once at startup (see the log below
// the route table) and read by /api/demo/status + the vanity endpoints to
// short-circuit with a clean error when the binary isn't built. A Promise
// instead of a value because the import is async and we want a single
// settled result that everything can await.
let _vanityAvailabilityPromise = null;
function vanityAvailability() {
  if (!_vanityAvailabilityPromise) {
    _vanityAvailabilityPromise = import('./vanityKeygen.js').then(
      (mod) => mod.isVanityAvailable(),
      // If the import itself fails (file moved, syntax error, etc.) treat
      // vanity as unavailable rather than letting that error propagate
      // unrelated requests. The reason string surfaces in the UI so the
      // operator can see what's wrong.
      (err) => ({ available: false, reason: `vanity module load failed: ${err.message}` }),
    );
  }
  return _vanityAvailabilityPromise;
}

import {
  hostCheckMiddleware,
  securityHeadersMiddleware,
  apiSessionMiddleware,
  resolvePublicDir,
  upload,
  API_SESSION_TOKEN,
} from './serverMiddleware.js';


// Configuration constants are defined below in the "Configuration" section
// (just after __dirname is computed). Internal env vars (PORT,
// TREBUCHET_CONFIG_DIR) are still used — those are set by main.js at
// launch time and are how the Electron main process tells this embedded
// server which port to bind on and where to persist config. They're not
// user-facing config; users never set them.

// ===========================================================================
// Server-side log capture
// ===========================================================================
//
// The packaged Electron app hides the Node main process's console output —
// the user only sees browser DevTools (renderer console) and the in-app
// activity log. That makes it impossible to see anything server.js logs,
// which is exactly the information we need when debugging the auto-swap
// flow ("[acquire][jobId][w1] picked up xlrt", "concurrency=1", etc).
//
// Fix: capture console.log/warn/error into an in-memory ring buffer, and
// expose a /api/server-logs endpoint. The frontend polls this and mixes
// new entries into the activity log with a [server] prefix. The user sees
// everything the backend is doing without needing a terminal.
//
// We use a monotonic sequence number (not timestamp) for filtering on the
// frontend side, so ties in the same millisecond don't lose entries.

const _serverLogBuffer = [];
const SERVER_LOG_BUFFER_MAX = 1000;
let _serverLogSeq = 0;

function _captureLog(level, args) {
  let msg = '';
  try {
    msg = args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(' ');
  } catch (_) {
    msg = '[unable to format log entry]';
  }
  // Cap each entry to keep the buffer's memory footprint bounded even
  // when a single log entry is unusually large (e.g. a stringified
  // object with deep structure).
  if (msg.length > 4000) msg = msg.slice(0, 4000) + '…[truncated]';

  _serverLogBuffer.push({
    seq: ++_serverLogSeq,
    ts: Date.now(),
    level,
    msg,
  });
  // Trim to max size. shift() is O(N) but with N=1000 and trim happening
  // at most once per push, this is fine.
  if (_serverLogBuffer.length > SERVER_LOG_BUFFER_MAX) {
    _serverLogBuffer.shift();
  }
}

// Monkey-patch the global console. Save the originals so we can still
// write to the real stdout/stderr (useful when running from a terminal
// in dev mode). _captureLog is wrapped in try/catch so a capture failure
// can't break the original log emission.
const _origConsoleLog = console.log.bind(console);
const _origConsoleWarn = console.warn.bind(console);
const _origConsoleError = console.error.bind(console);
console.log = (...args) => {
  try { _captureLog('info', args); } catch (_) { /* ignore */ }
  _origConsoleLog(...args);
};
console.warn = (...args) => {
  try { _captureLog('warn', args); } catch (_) { /* ignore */ }
  _origConsoleWarn(...args);
};
console.error = (...args) => {
  try { _captureLog('error', args); } catch (_) { /* ignore */ }
  _origConsoleError(...args);
};

// __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===========================================================================
// Configuration
// ===========================================================================
//
// User-facing configuration was previously loaded from a .env file via
// dotenv. That approach was removed for two reasons:
//
//   1. It didn't work reliably with electron-builder's "portable" target.
//      Portable builds extract the .exe to a random temp directory on each
//      launch, so process.cwd() / process.execPath / process.resourcesPath
//      all point inside that temp directory — not next to the actual .exe
//      the user double-clicked. Users had no way to drop a .env file where
//      the app would reliably find it.
//
//   2. The only setting that really varies per user is the RPC endpoint,
//      which is already fully manageable through the in-app RPC settings
//      UI (rpcConfig.js: addSavedRpc / setActiveRpc / removeSavedRpc /
//      testRpc). Choices are persisted to the user's config directory and
//      survive restarts.
//
// To change the values below, edit this file and rebuild. They're at the
// top of the file so they're easy to find.
//
// Internal env vars (PORT, TREBUCHET_CONFIG_DIR) are set by main.js at
// launch time — those aren't user-facing config, they're how the Electron
// main process talks to this embedded server. They stay.

/**
 * Number of parallel workers in the auto-swap pool. Each worker handles
 * one swap at a time; the queue of pending swaps drains as workers finish.
 * Higher = faster overall, but more parallel RPC load (which can trigger
 * rate limits on free-tier endpoints). 4 is a good balance for most users;
 * drop to 1 for sequential debugging or if your RPC has tight rate limits.
 */
const AUTOSWAP_CONCURRENCY = 1;

const app = express();
const PORT = process.env.PORT || 3000;

// Boot-time log: confirms which config values the server is actually
// using on this launch. Streams to the in-app activity log via the
// console-capture wiring above.
console.log(`[boot] AUTOSWAP_CONCURRENCY = ${AUTOSWAP_CONCURRENCY}`);
console.log(`[boot] PORT = ${PORT}`);
console.log('[boot] RPC endpoint: configured via in-app RPC settings');


function secretPinLockedError(action = 'use saved recovery secrets') {
  const error = new Error(`Unlock your Recovery PIN before ${action}.`);
  error.statusCode = 423;
  error.code = 'SECRET_PIN_LOCKED';
  return error;
}

function sendErrorResponse(res, error, fallbackStatus = 500) {
  const status = error?.statusCode || error?.status || fallbackStatus;
  const body = {
    success: false,
    error: launchJournal.errorMessage(error),
  };
  if (error?.code) body.code = error.code;
  if (error?.code === 'SECRET_PIN_LOCKED') body.secretPinLocked = true;
  res.status(status).json(body);
}

function launchFailureDetails(error, context = {}) {
  return launchJournal.errorDetails(error, context);
}

function rejectIfSecretPinLocked(res, action) {
  if (!secretStore.isSecretPinLocked()) return false;
  sendErrorResponse(res, secretPinLockedError(action), 423);
  return true;
}

function migrateSecretsToUnlockedPin() {
  // These loads opportunistically rewrite legacy/plain/safeStorage tokens
  // into pin: tokens when the PIN key is currently unlocked.
  pendingWallets.list();
  vanityCaStore.list();
}


// ---------------------------------------------------------------------------
// Middleware pipeline
// ---------------------------------------------------------------------------
// The middleware functions are defined in serverMiddleware.js so they can
// be unit-tested independently. Registration order matters:
//   1. hostCheckMiddleware — DNS rebinding defense (before body parser so
//      a rejected request never has its body read into memory).
//   2. securityHeadersMiddleware — CSP + frame/type-sniff headers.
//   3. /api/session route — hands out the session token. Registered
//      BEFORE apiSessionMiddleware so it doesn't get gated by itself.
//      (The middleware has a safety exemption for /session anyway, but
//      relying on route-ordering keeps the intent clear.)
//   4. apiSessionMiddleware — gates all /api/* mutating routes behind
//      the session token. /proxy-image and /generate-vanity-wallet-stream
//      are exempted inside the middleware.
//   5. express.json — body parser. Registered AFTER the host check and
//      session gate so we don't waste memory parsing rejected requests.
app.use(hostCheckMiddleware);
app.use(securityHeadersMiddleware);

// CORS is intentionally not configured. The Trebuchet frontend loads from
// http://127.0.0.1:<port> and the API serves from the same origin, so no
// CORS headers are needed for legitimate use. The previous wildcard
// `app.use(cors())` set Access-Control-Allow-Origin: * — appropriate only
// for genuinely public APIs, and it would weaken the Host-header defense
// above by giving cross-origin preflights a free pass.
// Same-origin API session token. Host-header checks block DNS rebinding, and
// this header blocks browser form posts or other tokenless local requests from
// mutating the launcher API. The frontend gets the token through /api/session;
// cross-origin pages can make that request, but cannot read the response
// without CORS, so they cannot attach the required header.
app.get('/api/session', (_req, res) => {
  res
    .set('Cache-Control', 'no-store')
    .json({ success: true, token: API_SESSION_TOKEN });
});

app.use('/api', apiSessionMiddleware);

app.use(express.json({ limit: '5mb' }));

const publicDir = resolvePublicDir(__dirname);

app.use(express.static(publicDir));

// Routes
// The launcher: pick quotes, start at any market cap, lock forever.
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'orca.html'));
});
app.get('/orca', (_req, res) => res.redirect('/'));
// Token deeplink: the same page, opened on that token's card.
app.get('/token/:mint', (_req, res) => {
  res.sendFile(path.join(publicDir, 'orca.html'));
});

// Opt-in diagnostic endpoint for splash-video 404 debugging. It reports local
// filesystem/process paths, so keep it unavailable in normal desktop/web runs.
// Enable only for targeted troubleshooting:
//
//   TREBUCHET_ENABLE_SPLASH_DEBUG=1 npm run web
//   fetch('/api/_splash-debug').then(r => r.json()).then(console.log)
if (process.env.TREBUCHET_ENABLE_SPLASH_DEBUG === '1') {
  app.get('/api/_splash-debug', (_req, res) => {
    const introPath = path.join(publicDir, 'intro.mp4');
    let publicListing = null;
    let publicListingError = null;
    try {
      publicListing = fs.readdirSync(publicDir);
    } catch (e) {
      publicListingError = e.message;
    }
    let introStat = null;
    let introStatError = null;
    try {
      const s = fs.statSync(introPath);
      introStat = { size: s.size, isFile: s.isFile(), mtime: s.mtime };
    } catch (e) {
      introStatError = e.message;
    }
    res.json({
      __dirname,
      publicDir,
      publicDirExists: fs.existsSync(publicDir),
      publicListing,
      publicListingError,
      introPath,
      introExists: fs.existsSync(introPath),
      introStat,
      introStatError,
      cwd: process.cwd(),
      execPath: process.execPath,
    });
  });
}

// ---------------------------------------------------------------------------
// Server log streaming
// ---------------------------------------------------------------------------
//
// Returns server-side console output. Frontend polls this endpoint
// continuously and mixes new entries into the in-app activity log so the
// user can see what the backend is doing without needing terminal access.
//
// Query params:
//   since=<seq>   — return only entries with seq > this value (default: 0)
//   limit=<n>     — cap the number of entries returned (default: 200, max: 500)
//
// Response shape:
//   { entries: [ { seq, ts, level, msg } ] }
//
// The seq value is a monotonically increasing integer assigned at log time.
// Frontend tracks the highest seq it's seen and passes it as `since` on
// the next poll, so each entry is delivered exactly once.
app.get('/api/server-logs', (req, res) => {
  const sinceSeq = req.query.since ? Number(req.query.since) : 0;
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  // Buffer is already in chronological order (push at tail). Filter to
  // entries newer than `since`, then take the last `limit` entries —
  // if the user falls behind by more than `limit` they lose the oldest
  // missed entries but stay current with recent activity.
  const filtered = _serverLogBuffer.filter((e) => e.seq > sinceSeq);
  const entries = filtered.length > limit ? filtered.slice(-limit) : filtered;
  res.json({ entries });
});

// ---------------------------------------------------------------------------
// Recovery PIN endpoints
// ---------------------------------------------------------------------------

app.get('/api/secret-pin/status', (_req, res) => {
  res.json({ success: true, status: secretStore.secretPinStatus() });
});

app.post('/api/secret-pin/setup', (req, res) => {
  try {
    secretStore.setupSecretPin(req.body?.pin);
    migrateSecretsToUnlockedPin();
    res.json({ success: true, status: secretStore.secretPinStatus() });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/secret-pin/unlock', (req, res) => {
  try {
    const ok = secretStore.unlockSecretPin(req.body?.pin);
    if (!ok) {
      return res.status(401).json({
        success: false,
        code: 'BAD_SECRET_PIN',
        error: 'Recovery PIN is incorrect',
      });
    }
    migrateSecretsToUnlockedPin();
    res.json({ success: true, status: secretStore.secretPinStatus() });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
});

app.post('/api/secret-pin/lock', (_req, res) => {
  res.json({ success: true, status: secretStore.lockSecretPin() });
});

// ---------------------------------------------------------------------------
// Wallet endpoints
// ---------------------------------------------------------------------------

app.post('/api/generate-wallet', async (req, res) => {
  try {
    if (rejectIfSecretPinLocked(res, 'generating a recoverable launch wallet')) {
      return;
    }
    console.log('Generating temporary wallet...');
    const walletInfo = await generateTemporaryWallet();
    const qrCode = await getWalletQRCode(walletInfo.publicKey);

    // Stash the key on disk so the user can recover the wallet if the
    // app crashes or is closed mid-launch. The entry is removed by
    // /api/orca/finish once the wallet is verified on-chain empty.
    pendingWallets.add(walletInfo.publicKey, walletInfo.secretKey, walletInfo.mnemonic);
    launchJournal.start({ walletPublicKey: walletInfo.publicKey });

    res.json({
      success: true,
      wallet: {
        publicKey: walletInfo.publicKey,
        secretKey: walletInfo.secretKey,
        secretKeyB58: secretKeyToBase58(walletInfo.secretKey),
        mnemonic: walletInfo.mnemonic,
        qrCode,
      },
    });
  } catch (error) {
    console.error('Error generating wallet:', error);
    sendErrorResponse(res, error);
  }
});

app.get('/api/wallet-qr', async (req, res) => {
  try {
    const publicKey = String(req.query.publicKey || '').trim();
    if (!publicKey) {
      return res.status(400).json({ success: false, error: 'publicKey required' });
    }
    // Validate before rendering so typos fail with a useful message instead
    // of producing a QR that scans to nonsense.
    new PublicKey(publicKey);
    const qrCode = await getWalletQRCode(publicKey);
    res.json({ success: true, publicKey, qrCode });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// SOL-only balance (kept for backwards compatibility / Step 1 display)
// ---------------------------------------------------------------------------

app.get('/api/vanity-ca-candidates', (req, res) => {
  try {
    const secretPinLocked = secretStore.isSecretPinLocked();
    const candidates = vanityCaStore.listMetadata().map((candidate) => ({
      ...candidate,
      ...(candidate.decryptionFailed && secretPinLocked ? { secretPinLocked: true } : {}),
    }));
    res.json({ success: true, candidates, secretPinLocked });
  } catch (error) {
    console.error('Error listing vanity CA candidates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/vanity-ca-candidates/remove', (req, res) => {
  try {
    const { publicKey } = req.body || {};
    if (!publicKey) {
      return res.status(400).json({ success: false, error: 'publicKey required' });
    }
    vanityCaStore.remove(publicKey);
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing vanity CA candidate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// SSE streaming endpoint for vanity CA grind progress
app.get('/api/generate-vanity-wallet-stream', async (req, res) => {
  let { prefix, suffix, threads, blockhash, token } = req.query;
  prefix = typeof prefix === 'string' ? prefix.trim() : '';
  suffix = typeof suffix === 'string' ? suffix.trim() : '';

  // Validate session token inline.  This endpoint is exempt from the
  // middleware so EventSource can connect, but we still gate on the
  // session token delivered as a query parameter.
  if (!token) {
    return res.status(403).json({ success: false, error: 'session token required' });
  }
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(API_SESSION_TOKEN);
  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    return res.status(403).json({ success: false, error: 'invalid session token' });
  }

  if (rejectIfSecretPinLocked(res, 'saving a Vanity CA candidate')) {
    return;
  }

  if (!prefix && !suffix) {
    return res.status(400).json({ success: false, error: 'prefix or suffix required' });
  }

  // Refuse cleanly if the binary isn't available. The frontend disables
  // the UI based on /api/demo/status, but a stale frontend or direct
  // API call still gets a clear 503 instead of crashing mid-spawn.
  const vanity = await vanityAvailability();
  if (!vanity.available) {
    return res.status(503).json({
      success: false,
      error: 'Vanity address generation is not available in this build. '
        + 'The vanity_keygen binary is not built — run `npm run build:c` '
        + '(requires gcc or clang). End-user release builds include the binary.',
    });
  }

  // Clamp threads to a consumer-reasonable maximum
  if (threads) {
    threads = Math.min(Math.max(1, Number(threads)), 32);
  }

  // Auto-fetch a recent Solana blockhash for VRF seed binding.
  // The VRF proves the seed was bound to a known-past blockhash,
  // preventing the grinder from cherry-picking seeds across re-rolls.
  //
  // This is an OPTIONAL auditability feature. If we can't reach the
  // RPC or the response is unusable, we proceed without VRF — the
  // keypair is still cryptographically secure via the system CSPRNG;
  // only the proof-of-non-precomputation feature is skipped.
  if (!blockhash) {
    let fetchFailReason = null;
    try {
      const blockhashResp = await fetch(getRpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getLatestBlockhash',
          params: [{ commitment: 'confirmed' }],
        }),
      });
      if (!blockhashResp.ok) {
        fetchFailReason = `RPC returned HTTP ${blockhashResp.status}`;
      } else {
        const bhJson = await blockhashResp.json();
        if (bhJson?.result?.value?.blockhash) {
          blockhash = Buffer.from(bs58.decode(bhJson.result.value.blockhash)).toString('hex');
        } else {
          // RPC succeeded at the HTTP level but didn't return what we
          // expected — most often a JSON-RPC error body (rate-limit,
          // malformed request, etc.). Previously this path was silent;
          // the user would lose VRF with no indication.
          fetchFailReason = bhJson?.error?.message
            ? `RPC error: ${bhJson.error.message}`
            : 'RPC response did not include a blockhash';
        }
      }
    } catch (e) {
      // Network-level failure (DNS, connection refused, timeout).
      fetchFailReason = e?.message || 'network error';
    }
    if (fetchFailReason) {
      console.warn(
        '[vanity] Skipping optional VRF audit proof — couldn\'t fetch a recent blockhash '
        + `(${fetchFailReason}). The generated keypair is still cryptographically secure; `
        + 'only the proof-of-non-precomputation feature is unavailable for this grind. '
        + 'Configure a dedicated RPC endpoint in settings if you want VRF every time '
        + '(the default public RPC frequently rate-limits this kind of request).',
      );
    }
  }

  const target = prefix && suffix ? `${prefix}...${suffix}` : (prefix || suffix);
  const targetLen = prefix.length + suffix.length;
  const expected = Math.pow(58, targetLen);
  const vanityMode = prefix && suffix ? 'both' : (prefix ? 'prefix' : 'suffix');

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Detect client disconnect (browser tab closed, network drop, manual
  // EventSource.close()) and cancel the in-flight child so we don't
  // leave a zombie vanity_keygen.exe pegging CPU on the user's machine
  // until it stumbles into a match. cancelVanityGrind() is a no-op if
  // the grind has already finished or never started, so this is safe
  // to fire on every disconnect.
  res.on('close', () => {
    import('./vanityKeygen.js').then((mod) => {
      mod.cancelVanityGrind();
    }).catch(() => { /* module load shouldn't fail this late, but be quiet about it if it does */ });
  });

  // Send initial metadata
  res.write(`data: ${JSON.stringify({
    type: 'start',
    target,
    targetLen,
    expected,
    prefix: prefix || null,
    suffix: suffix || null,
    mode: vanityMode,
  })}\n\n`);

  let lastAttempts = 0;
  let lastSend = Date.now();

  try {
    const vanityMod = await import('./vanityKeygen.js');
    const result = await vanityMod.generateVanityKeypair({
      prefix, suffix, threads, blockhash,
      onProgress: ({ attempts, key }) => {
        // Throttle to ~4 updates/sec
        const now = Date.now();
        if (now - lastSend < 100) return;
        lastSend = now;
        lastAttempts = attempts;
        const epoch = attempts / expected;
        res.write(`data: ${JSON.stringify({ type: 'progress', attempts, epoch, key })}\n\n`);
      },
    });

    const walletInfo = {
      publicKey: result.publicKey,
      secretKey: result.secretKey,
      mnemonic: null,
    };

    {
      vanityCaStore.add({
        publicKey: result.publicKey,
        secretKey: result.secretKey,
        rarity: result.rarity,
        epochs: result.epochs,
        attempts: result.attempts,
        expectedAttempts: result.expectedAttempts,
        target,
        prefix: prefix || null,
        suffix: suffix || null,
        mode: vanityMode,
      });
    }

    const qrCode = await getWalletQRCode(walletInfo.publicKey);

    res.write(`data: ${JSON.stringify({
      type: 'done',
      success: true,
      wallet: {
        publicKey: walletInfo.publicKey,
        secretKey: walletInfo.secretKey,
        secretKeyB58: secretKeyToBase58(walletInfo.secretKey),
        mnemonic: null,
        vanity: true,
        qrCode,
        attempts: result.attempts,
        rarity: result.rarity,
        epochs: result.epochs,
        expectedAttempts: result.expectedAttempts,
        target,
        prefix: prefix || null,
        suffix: suffix || null,
        mode: vanityMode,
        persisted: true,
        ...(result.vrfProof ? {
          vrfProof: result.vrfProof,
          vrfPk: result.vrfPk,
          vrfBlockhash: result.vrfBlockhash,
        } : {}),
      },
    })}\n\n`);

    res.end();
  } catch (error) {
    // CANCELLED is a structured error code surfaced by vanityKeygen.js
    // when cancelVanityGrind() was called. It's an expected event — the
    // user clicked Cancel — so emit a dedicated {type:'cancelled'}
    // frame rather than the generic error path, and log it at info
    // level (not error) so we don't red-flag a routine user action.
    if (error.code === 'CANCELLED') {
      console.log('Vanity grind cancelled by user');
      res.write(`data: ${JSON.stringify({ type: 'cancelled' })}\n\n`);
      res.end();
      return;
    }
    console.error('Error generating vanity wallet:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// Cancel any in-flight vanity grind. POST so the apiSessionMiddleware
// gates it (the same auth that protects other state-changing endpoints).
// Idempotent: if nothing is running, returns success with cancelled:false
// so the frontend can treat repeated clicks as harmless. The actual SSE
// stream from /api/generate-vanity-wallet-stream emits a {type:'cancelled'}
// event when the child finishes terminating — usually within milliseconds.
app.post('/api/cancel-vanity-grind', async (req, res) => {
  try {
    const mod = await import('./vanityKeygen.js');
    const cancelled = mod.cancelVanityGrind();
    res.json({ success: true, cancelled });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/generate-vanity-wallet', async (req, res) => {
  try {
    if (rejectIfSecretPinLocked(res, 'generating a recoverable vanity wallet')) {
      return;
    }
    let { prefix, suffix, threads } = req.body;
    prefix = typeof prefix === 'string' ? prefix.trim() : '';
    suffix = typeof suffix === 'string' ? suffix.trim() : '';
    if (!prefix && !suffix) {
      return res.status(400).json({ success: false, error: 'prefix or suffix required' });
    }

    // Mirror the stream endpoint's availability gate so both vanity routes
    // fail with the same shape and message when the binary isn't built.
    const vanity = await vanityAvailability();
    if (!vanity.available) {
      return res.status(503).json({
        success: false,
        error: 'Vanity address generation is not available in this build. '
          + 'The vanity_keygen binary is not built — run `npm run build:c` '
          + '(requires gcc or clang). End-user release builds include the binary.',
      });
    }

    const target = prefix && suffix ? `${prefix}...${suffix}` : (prefix || suffix);
    const vanityMode = prefix && suffix ? 'both' : (prefix ? 'prefix' : 'suffix');
    console.log(`Generating vanity wallet (${vanityMode}: "${target}")...`);

    const generateVanityKeypair = await getVanityKeygen();
    const result = await generateVanityKeypair({ prefix, suffix, threads });

    // Vanity keypairs don't have a BIP39 mnemonic (they're generated from
    // random seeds, not from a mnemonic phrase). The user can still export
    // the raw secret key.
    const walletInfo = {
      publicKey: result.publicKey,
      secretKey: result.secretKey,
      mnemonic: null, // no mnemonic for vanity keypairs
    };

    const qrCode = await getWalletQRCode(walletInfo.publicKey);
    pendingWallets.add(walletInfo.publicKey, walletInfo.secretKey, null);
    launchJournal.start({ walletPublicKey: walletInfo.publicKey });

    res.json({
      success: true,
      wallet: {
        publicKey: walletInfo.publicKey,
        secretKey: walletInfo.secretKey,
        secretKeyB58: secretKeyToBase58(walletInfo.secretKey),
        mnemonic: null,
        vanity: true,
        qrCode,
        attempts: result.attempts,
        rarity: result.rarity,
        epochs: result.epochs,
        expectedAttempts: result.expectedAttempts,
        target,
        prefix: prefix || null,
        suffix: suffix || null,
        mode: vanityMode,
      },
    });
  } catch (error) {
    console.error('Error generating vanity wallet:', error);
    sendErrorResponse(res, error);
  }
});
app.post('/api/check-balance', async (req, res) => {
  try {
    const { publicKey } = req.body;
    const balance = await checkWalletBalance(publicKey);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Error checking balance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Multi-token balance for the funding step (SOL + every SPL token)
app.post('/api/check-balance-detailed', async (req, res) => {
  try {
    const { publicKey } = req.body;
    const balance = await checkWalletBalanceMultiToken(publicKey);
    res.json({ success: true, balance });
  } catch (error) {
    console.error('Error checking detailed balance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// RPC config endpoints
// ---------------------------------------------------------------------------

// Get the current RPC config (active URL + saved list) for the settings UI
app.get('/api/rpc-config', (req, res) => {
  try {
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Switch to a different saved RPC. After this returns, all subsequent Solana
// operations will use the new endpoint (we refresh the cached connection in
// tokenService; lpService and walletHelpers read fresh per call already).
app.post('/api/rpc-config/select', (req, res) => {
  try {
    setActiveRpc(req.body.url);
    refreshTokenServiceConnection();
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Add a new RPC to the saved list. If setActive=true, also switch to it.
app.post('/api/rpc-config/add', (req, res) => {
  try {
    const { name, url, setActive } = req.body;
    addSavedRpc(name, url);
    if (setActive) {
      setActiveRpc(url);
      refreshTokenServiceConnection();
    }
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Remove a saved RPC. If it was active, the active selection falls back to
// the first remaining saved entry.
app.post('/api/rpc-config/remove', (req, res) => {
  try {
    removeSavedRpc(req.body.url);
    refreshTokenServiceConnection();
    res.json({ success: true, config: getRpcConfig() });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// User preferences.
//
// Small key/value store for user-toggleable settings. Currently only one
// knob: checkForUpdatesOnStartup. The "don't check automatically" checkbox
// on the update-check modal in public/app.js POSTs here to flip it.
//
// Backed by userPrefs.json in TREBUCHET_CONFIG_DIR — same persistence
// pattern as rpcConfig.json. See userPrefs.js for the schema and defaults.
// ---------------------------------------------------------------------------
app.get('/api/user-prefs', (_req, res) => {
  try {
    res.json({ success: true, prefs: userPrefs.get() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/user-prefs', (req, res) => {
  try {
    // userPrefs.set ignores unknown keys and type-mismatched values,
    // so a malformed request body can't corrupt the file — it'll just
    // silently drop the bad fields and persist whatever was valid.
    const updated = userPrefs.set(req.body || {});
    res.json({ success: true, prefs: updated });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Permanent launch report (Arweave). Publishes the rendered HTML report plus a
// machine-readable JSON record, signed by the launch wallet, tagged so the
// report is discoverable from the token mint WITHOUT touching token metadata.
// Called by the frontend at step 5 — while the launch wallet still exists in
// the recovery store (it's swept at step 6). Opt-out via userPrefs; the launch
// is already complete and safe before this runs, so it is never fatal.
// ---------------------------------------------------------------------------
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || null;
  } catch (_) {
    return null;
  }
})();


// ---------------------------------------------------------------------------
// Demo-mode endpoints (demo-only).
//
// /api/demo/status      — the frontend calls this on app load to learn
//                         whether to show the demo banner and the "Pretend
//                         funding arrived" button. Also reports
//                         vanity-binary availability so the UI can disable
//                         the Vanity CA section gracefully on dev
//                         environments without a C toolchain (CI handles
//                         release builds, so end-user installs always
//                         include the binary).
// /api/demo/inject-funds — backs the "Pretend funding arrived (DEMO)"
//                         button; writes the funding amounts the frontend
//                         already computed into the demo ledger. Returns
//                         403 when demo mode is off so it can never affect
//                         a real launch.
// ---------------------------------------------------------------------------


// Renderer POSTs here after its splash video and first-run disclaimer
// have both been dismissed, signalling "now is a safe time to show
// an update-available modal — the main UI is visible underneath".
//
// The bridge module forwards the signal to main.js, which runs the
// silent update check. The bridge fires the handler at most once
// per process, so repeated POSTs (e.g. dev-mode page reloads) are
// harmless. In web mode (npm run web, no Electron) the bridge has
// no handler registered and the endpoint just returns ran:false —
// the renderer doesn't care about the response either way.
app.post('/api/trigger-startup-update-check', (_req, res) => {
  const result = updateCheckBridge.trigger();
  res.json({ success: true, ...result });
});

// Live LP progress poll. Returns events that have occurred since the
// client-provided cursor index, plus the current run status. The frontend
// polls this during /api/create-lp and translates each event into a row
// marking on the phase progress tree so rows transition pending → done
// one at a time instead of all flipping when the response lands.
//
// Read-only. Pure in-memory lookup. Currently driven by demo mode (the
// only code path that writes lp progress events) — real mode could plug
// into the same infrastructure later by wiring its onProgress callback
// through.
app.get('/api/lp-progress', (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet || typeof wallet !== 'string') {
    return res.status(400).json({ success: false, error: 'wallet query param required' });
  }
  const since = Number.isFinite(Number(req.query.since)) ? Number(req.query.since) : 0;
  const state = lpProgressGet(wallet, since);
  res.json({ success: true, state });
});

// Lightweight RPC health check — sends a getVersion JSON-RPC call and
// reports back the version + latency. Used by the "Test" button in the UI
// before saving a new endpoint.
app.post('/api/rpc-config/test', async (req, res) => {
  const result = await testRpc(req.body.url);
  res.json({ success: true, result });
});

// RPC health polling endpoint — called every 30s by the frontend to drive
// the health indicator dot. Sends a lightweight getHealth JSON-RPC call
// (lighter than getVersion — no blockhash fetch) against the currently
// active RPC and reports latency + health status. getHealth is a Solana
// JSON-RPC method that returns "ok" when the node is healthy — it's
// universally supported and costs essentially nothing.
app.get('/api/rpc-health', async (_req, res) => {
  const url = getRpcConfig().active;
  try {
    const start = Date.now();
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }),
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return res.json({ success: true, health: 'error', latencyMs, error: `HTTP ${resp.status}` });
    }
    const json = await resp.json();
    if (json.error) {
      return res.json({ success: true, health: 'error', latencyMs, error: json.error.message });
    }
    const healthy = json.result === 'ok';
    res.json({
      success: true,
      health: healthy ? (latencyMs < 400 ? 'good' : 'slow') : 'error',
      latencyMs,
    });
  } catch (e) {
    res.json({ success: true, health: 'error', latencyMs: null, error: e.message });
  }
});


// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------

function uploadLogo(req, res, next) {
  upload.single('logo')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Logo is over 2MB after compression — pick a smaller image.'
        : err.message;
      return res.status(400).json({ success: false, error: message });
    }
    if (req.file) {
      try {
        req.file.detectedMime = normalizeLogoImageMime(req.file.buffer);
      } catch (logoError) {
        return res.status(400).json({ success: false, error: logoError.message });
      }
    }
    next();
  });
}

function recordTokenJournalProgress(walletPublicKey, event) {
  if (!walletPublicKey || !event) return;
  const token = {};
  if (event.tokenMint) token.mint = event.tokenMint;
  if (event.metadataUri) token.metadataUri = event.metadataUri;
  if (event.imageUri) token.imageUri = event.imageUri;
  if (typeof event.mintAuthorityRenounced === 'boolean') {
    token.mintAuthorityRenounced = event.mintAuthorityRenounced;
  }
  if (typeof event.freezeAuthorityDisabled === 'boolean') {
    token.freezeAuthorityDisabled = event.freezeAuthorityDisabled;
  }
  if (typeof event.metadataUpdateAuthorityRevoked === 'boolean') {
    token.metadataUpdateAuthorityRevoked = event.metadataUpdateAuthorityRevoked;
  }
  if (typeof event.metadataImmutable === 'boolean') {
    token.metadataImmutable = event.metadataImmutable;
  }

  launchJournal.upsertForWallet(
    walletPublicKey,
    {
      stage: event.stage || 'token_progress',
      token: Object.keys(token).length > 0 ? token : undefined,
    },
    event,
  );
}

app.post('/api/finish-token-creation', async (req, res) => {
  try {
    const { secretKeyArr, walletPublicKey } = resolveSigner({
      tempWalletSecretKey: req.body.tempWalletSecretKey,
      walletPublicKey: req.body.walletPublicKey,
    });
    if (!walletPublicKey) {
      return res.status(400).json({ success: false, error: 'walletPublicKey or tempWalletSecretKey required' });
    }

    const journal = launchJournal.activeForWallet(walletPublicKey);
    if (!journal || !journal.token || !journal.token.mint) {
      return res.status(409).json({
        success: false,
        error: 'No interrupted token creation found for this wallet (no recorded mint).',
      });
    }
    const { mint, name, symbol, totalSupply, metadataUri } = journal.token;
    if (totalSupply == null) {
      return res.status(409).json({
        success: false,
        error: 'The recorded token entry is missing its supply; cannot safely finish it.',
      });
    }

    const status = await finishTokenCreation({
      tempWalletSecretKey: secretKeyArr,
      tokenMint: mint,
      name,
      symbol,
      totalSupply,
      metadataUri,
      journalEvents: journal.events || [],
      onProgress: (event) => recordTokenJournalProgress(walletPublicKey, event),
    });

    // Reflect the finished state back into the journal. Merge onto the existing
    // token record so the name/symbol/uri already there are preserved. Once the
    // mint authority is renounced the token is usable, so we move the stage back
    // to 'token_created' and let the normal flow continue.
    launchJournal.upsertForWallet(
      walletPublicKey,
      {
        status: 'active',
        stage: status.mintAuthorityRenounced ? 'token_created' : 'token_create_finished',
        error: null,
        token: {
          ...journal.token,
          mintAuthorityRenounced: status.mintAuthorityRenounced,
          metadataUpdateAuthorityRevoked: status.updateAuthorityRevoked,
          isSafe: status.isSafe,
        },
      },
      {
        stage: 'token_create_finished',
        isSafe: status.isSafe,
        steps: status.steps,
        sanity: status.sanity,
      },
    );

    res.json({ success: true, ...status });
  } catch (error) {
    console.error('Error finishing token creation:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/create-token', uploadLogo, async (req, res) => {
  // uploadLogo (multer) has already parsed req.body / req.file by the time
  // we reach here, so the demo handler can read the same fields.
  let walletPublicKey = null;
  let claimedLaunchOp = false;
  try {
    const {
      tempWalletSecretKey,
      name,
      symbol,
      description,
      totalSupply,
      vanityPrefix,
      vanitySuffix,
      vanityCAKeypair: vanityCAKeypairRaw,
      vanityCAPublicKey,
    } = req.body;

    if ((req.body.walletPublicKey || vanityCAPublicKey)
        && rejectIfSecretPinLocked(res, 'creating a token with saved recovery secrets')) {
      return;
    }

    // If the caller asked for a fresh vanity grind (prefix/suffix) but the
    // binary isn't built, reject up front with the same 503 the dedicated
    // vanity endpoints use. Pre-ground vanity keypairs (vanityCAKeypair)
    // are fine without the binary — they were ground elsewhere and we're
    // just consuming the keypair, not running the grinder again here.
    if (vanityPrefix || vanitySuffix) {
      const vanity = await vanityAvailability();
      if (!vanity.available) {
        return res.status(503).json({
          success: false,
          error: 'Vanity address generation is not available in this build. '
            + 'The vanity_keygen binary is not built — run `npm run build:c` '
            + '(requires gcc or clang). End-user release builds include the binary.',
        });
      }
    }

    const normalizedName = normalizeTokenName(name);
    const normalizedSymbol = normalizeTokenSymbol(symbol);
    const normalizedDescription = normalizeTokenDescription(description);
    const normalizedTotalSupply = normalizeWholeTokenSupply(totalSupply, 9);
    console.log('Creating token:', {
      name: normalizedName,
      symbol: normalizedSymbol,
      totalSupply: normalizedTotalSupply,
    });

    let logoBase64 = null;
    if (req.file) {
      const logoMime = req.file.detectedMime;
      logoBase64 = `data:${logoMime};base64,${req.file.buffer.toString('base64')}`;
    }

    const { secretKeyArr: tempWalletSecretKeyArr, walletPublicKey: resolvedWalletPublicKey } =
      resolveSigner({ tempWalletSecretKey, walletPublicKey: req.body.walletPublicKey });
    walletPublicKey = resolvedWalletPublicKey;
    // Per-wallet mutex — token creation runs several transactions over
    // 30-60s. A duplicate submit would mint a second, orphaned token and
    // double-spend the wallet's rent SOL.
    if (rejectOrClaimLaunchOp(res, walletPublicKey, 'create-token')) {
      return;
    }
    claimedLaunchOp = true;
    launchJournal.upsertForWallet(
      walletPublicKey,
      {
        status: 'active',
        stage: 'token_create_started',
        token: {
          name: normalizedName,
          symbol: normalizedSymbol,
          totalSupply: normalizedTotalSupply,
          decimals: 9,
        },
      },
      {
        stage: 'token_create_started',
        name: normalizedName,
        symbol: normalizedSymbol,
        totalSupply: normalizedTotalSupply,
      },
    );

    let vanityCAKeypair = vanityCAKeypairRaw ? JSON.parse(vanityCAKeypairRaw) : null;
    if (!vanityCAKeypair && vanityCAPublicKey) {
      const candidate = vanityCaStore.get(vanityCAPublicKey);
      if (!candidate) {
        return res.status(404).json({ success: false, error: 'Saved Vanity CA not found' });
      }
      if (!Array.isArray(candidate.secretKey)) {
        return res.status(409).json({
          success: false,
          error: 'Saved Vanity CA secret could not be decrypted',
        });
      }
      vanityCAKeypair = candidate.secretKey;
    }

    const result = await createTokenWithMetaplex({
      tempWalletSecretKey: tempWalletSecretKeyArr,
      name: normalizedName,
      symbol: normalizedSymbol,
      description: normalizedDescription,
      totalSupply: normalizedTotalSupply,
      logoBase64,
      vanityPrefix,
      vanitySuffix,
      vanityCAKeypair,
      onProgress: (event) => recordTokenJournalProgress(walletPublicKey, event),
    });
    if (vanityCAPublicKey) {
      vanityCaStore.remove(vanityCAPublicKey);
    }

    launchJournal.upsertForWallet(
      walletPublicKey,
      {
        status: 'active',
        stage: 'token_created',
        error: null,
        token: {
          mint: result.tokenMint,
          name: normalizedName,
          symbol: normalizedSymbol,
          totalSupply: normalizedTotalSupply,
          decimals: 9,
          metadataUri: result.metadataUri,
          imageUri: result.imageUri || null,
          isSafe: result.isSafe,
          mintAuthorityRenounced: result.mintAuthorityRenounced,
          freezeAuthorityDisabled: result.freezeAuthorityDisabled,
          metadataUpdateAuthorityRevoked: result.metadataUpdateAuthorityRevoked,
          metadataImmutable: result.metadataImmutable,
        },
      },
      { stage: 'token_created', tokenMint: result.tokenMint, metadataUri: result.metadataUri },
    );

    res.json({
      success: true,
      name: normalizedName,
      symbol: normalizedSymbol,
      totalSupply: normalizedTotalSupply,
      ...result,
    });
  } catch (error) {
    console.error('Error creating token:', error);
    if (walletPublicKey) {
      launchJournal.upsertForWallet(
        walletPublicKey,
        {
          status: 'failed',
          stage: 'token_create_failed',
          error: error.message,
        },
        { stage: 'token_create_failed', error: error.message },
      );
    }
    sendErrorResponse(res, error);
  } finally {
    // Release the per-wallet operation lock if we claimed it.
    if (claimedLaunchOp && walletPublicKey) {
      clearLaunchOpInFlight(walletPublicKey);
    }
  }
});

// ---------------------------------------------------------------------------
// Recovery cache for temporary wallets.
//
// /api/launch-journals returns non-secret per-launch journals. These are
// separate from pending wallets: journals explain what happened on-chain,
// while pending wallets provide the secret material needed for manual
// recovery.
//
// /api/pending-wallets returns any wallet keys that were generated for a
// launch but never confirmed-cleaned-up — typically because the app
// crashed or the user closed it before reaching Step 6. The frontend
// shows these at the top of the page so the user can copy the secret
// key out and recover any funds manually.
//
// /api/pending-wallets/dismiss is the manual "Discard" action. It
// removes a cache entry without doing any on-chain verification — it's
// the user's explicit acknowledgement that they don't need recovery.
// ---------------------------------------------------------------------------

app.get('/api/launch-journals', (req, res) => {
  try {
    const includeCompleted = req.query.includeCompleted === '1';
    const includeArchived = req.query.includeArchived === '1';
    const journals = launchJournal.list({ includeCompleted, includeArchived });
    res.json({ success: true, journals });
  } catch (error) {
    console.error('Error listing launch journals:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post('/api/launch-journals/dismiss', (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, error: 'id required' });
    }
    const archived = launchJournal.archive(id);
    res.json({ success: true, archived });
  } catch (error) {
    console.error('Error dismissing launch journal:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pending-wallets', (req, res) => {
  try {
    const secretPinLocked = secretStore.isSecretPinLocked();
    // Return metadata only. Secret material is available through the explicit
    // per-wallet reveal endpoint below, so loading the recovery panel no longer
    // decrypts and ships every pending mnemonic/private key to the renderer.
    //
    // Tolerate entries whose decryption failed (e.g. the file was copied from
    // another machine, or the OS keychain rotated): one bad entry must not break
    // the whole panel, so we surface a `decryptionFailed` flag.
    const wallets = pendingWallets.list().map((w) => {
      const hasSecretKey = Array.isArray(w.secretKey);
      const hasMnemonic = typeof w.mnemonic === 'string';
      const out = {
        publicKey: w.publicKey,
        createdAt: w.createdAt,
        hasSecretKey,
        hasMnemonic,
      };
      if (!hasSecretKey && !hasMnemonic) {
        out.decryptionFailed = true;
        if (secretPinLocked) out.secretPinLocked = true;
      }
      return out;
    });
    res.json({ success: true, wallets, secretPinLocked });
  } catch (error) {
    console.error('Error listing pending wallets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pending-wallets/reveal', (req, res) => {
  try {
    if (rejectIfSecretPinLocked(res, 'revealing a recovery secret')) {
      return;
    }
    const { publicKey } = req.body;
    if (!publicKey) {
      return res.status(400).json({ success: false, error: 'publicKey required' });
    }

    const wallet = pendingWallets.get(publicKey);
    if (!wallet) {
      return res.status(404).json({ success: false, error: 'pending wallet not found' });
    }

    const out = {
      publicKey: wallet.publicKey,
      createdAt: wallet.createdAt,
    };
    if (Array.isArray(wallet.secretKey)) {
      out.secretKey = wallet.secretKey;
      out.secretKeyB58 = secretKeyToBase58(wallet.secretKey);
    }
    if (typeof wallet.mnemonic === 'string') {
      out.mnemonic = wallet.mnemonic;
    }
    if (!out.secretKey && !out.mnemonic) {
      return res.status(409).json({
        success: false,
        error: 'pending wallet secret could not be decrypted',
        decryptionFailed: true,
      });
    }

    res.json({ success: true, wallet: out });
  } catch (error) {
    console.error('Error revealing pending wallet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pending-wallets/dismiss', (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) {
      return res.status(400).json({ success: false, error: 'publicKey required' });
    }
    pendingWallets.remove(publicKey);
    res.json({ success: true });
  } catch (error) {
    console.error('Error dismissing pending wallet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers for the transfer-assets verification step.
// ---------------------------------------------------------------------------

// Derive a base58 public key from the secret-key array the frontend sends.
// We do this here (rather than asking the frontend to send the public key
// separately) because the secret key is the source of truth — pairing it
// with a stale or wrong publicKey would be a recipe for clearing the
// wrong recovery entry.
function walletPubkeyFromSecretArray(secretKeyArr) {
  return Keypair.fromSecretKey(Uint8Array.from(secretKeyArr)).publicKey.toBase58();
}

// F7/F5: single, validated entry point for turning a request into a signer.
// Replaces five hand-rolled copies of the secret-key parse (F7) and is the
// place F5 lands: prefer resolving the wallet's secret SERVER-SIDE from its
// public key, so the ephemeral secret no longer has to round-trip back
// through the renderer on every launch step.
//
// Resolution order:
//   1. walletPublicKey present and found in pendingWallets → use the stored
//      (encrypted-at-rest) secret. This is the real-launch path: the secret
//      was persisted at /api/generate-wallet and never leaves the server.
//   2. otherwise, a secret supplied inline in the request body. This is the
//      demo path: demo wallets live on an in-memory ledger and are
//      deliberately NOT written to the disk-backed recovery store, so the
//      demo client still sends its throwaway secret inline. It's also a
//      back-compat fallback for any caller that hasn't migrated.
//
// A malformed input yields a clear Error (caught by the route try/catch).
// When both a public key and an inline secret arrive, the derived public key
// must match the claimed one — a mismatch means a confused or tampered
// request, so we refuse rather than sign with the wrong key.
function resolveSigner({ tempWalletSecretKey, walletPublicKey } = {}) {
  let secretKeyArr = null;
  let source = null;

  // (1) Prefer the server-side stored secret, keyed by public key.
  if (walletPublicKey) {
    if (secretStore.isSecretPinLocked()) {
      throw secretPinLockedError('using a saved launch wallet');
    }
    const stored = pendingWallets.get(walletPublicKey);
    if (stored && Array.isArray(stored.secretKey)) {
      secretKeyArr = stored.secretKey;
      source = 'store';
    }
  }

  // (2) Fall back to an inline secret (demo / unmigrated caller).
  if (!secretKeyArr && tempWalletSecretKey != null) {
    try {
      secretKeyArr = typeof tempWalletSecretKey === 'string'
        ? JSON.parse(tempWalletSecretKey)
        : tempWalletSecretKey;
      source = 'body';
    } catch (e) {
      throw new Error('tempWalletSecretKey is not valid JSON');
    }
  }

  if (!secretKeyArr) {
    throw new Error(
      'could not resolve a signer: send walletPublicKey for a recoverable '
      + 'wallet, or tempWalletSecretKey inline',
    );
  }
  if (!Array.isArray(secretKeyArr) || secretKeyArr.length !== 64) {
    throw new Error('resolved secret key must be a 64-byte array');
  }
  let keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArr));
  } catch (e) {
    throw new Error('resolved secret key is not a valid ed25519 secret key');
  }
  const derivedPubkey = keypair.publicKey.toBase58();
  if (walletPublicKey && derivedPubkey !== walletPublicKey) {
    throw new Error('walletPublicKey does not match the resolved signer');
  }
  // Surface a one-line warning if a real (store-backed) launch still sent an
  // inline secret — that means a client path hasn't been migrated off the
  // round-trip yet. Demo wallets won't be in the store, so they stay quiet.
  if (source === 'body' && tempWalletSecretKey != null && walletPublicKey
      && pendingWallets.get(walletPublicKey)) {
    console.warn(
      'resolveSigner: inline secret received for a stored wallet; '
      + 'a client path may not be migrated off the secret round-trip (F5).',
    );
  }
  return { secretKeyArr, walletPublicKey: derivedPubkey, keypair };
}

// Encode a secret-key byte array as a base58 string — the format wallet
// apps (Phantom, Solflare, Backpack) display and accept on import.
// We keep the byte-array form as the internal/storage representation
// (it's what @solana/web3.js wants for signing) but expose this form on
// API boundaries where a human might end up looking at or copying it.
function secretKeyToBase58(secretKeyArr) {
  return bs58.encode(Uint8Array.from(secretKeyArr));
}

// ---------------------------------------------------------------------------
// Misc / safety endpoints (unchanged from original)
// ---------------------------------------------------------------------------

// Identify the wallet that funded this temp wallet. Returns the funder's
// address by looking at the OLDEST transaction in the wallet's history (which,
// for our freshly-generated wallets, is necessarily the funding tx). This is
// shown to the user as a SUGGESTION for the destination wallet, not a source
// of truth — the user must always confirm the full address before transfer.
app.post('/api/find-funder', async (req, res) => {
  try {
    const { publicKey } = req.body;
    const result = await findFundingWallet(publicKey);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error finding funder:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

// Bind explicitly to 127.0.0.1 rather than all interfaces. Without the
// host argument, Node binds to 0.0.0.0 and the API would be reachable
// from anything on the local network (other machines on the LAN, a
// guest device on the same wifi, etc). This is a desktop app — only
// the Electron renderer on this machine should ever reach the API.
//
// Note: this loopback bind plus the Host header allowlist above are
// the two together. The bind kills network-reachable access; the
// Host check kills the DNS-rebinding-through-the-user's-browser path
// that survives a loopback bind.
// Orca Whirlpools launch routes (/api/orca/*). See orcaRoutes.js.
registerOrcaRoutes(app, {
  resolveSigner,
  rejectOrClaimLaunchOp,
  clearLaunchOpInFlight,
  rejectIfSecretPinLocked,
  lpProgressBegin,
  lpProgressEvent,
  lpProgressEnd,
  launchJournal,
  pendingWallets,
});

const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  const cfg = getRpcConfig();
  const active = cfg.saved.find((r) => r.url === cfg.active);
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Active RPC: ${active ? active.name : '(unnamed)'} — ${cfg.active}`);
  console.log(`Saved RPCs: ${cfg.saved.length} (manage in the UI)`);
  console.log('\nIMPORTANT: For pool creation, use a dedicated RPC (Helius, Triton, QuickNode — free tier is plenty).');
  console.log('Free public RPC endpoints will rate-limit you out of CLMM creation.\n');

  // Probe vanity availability and warm the cache so the first
  // /api/demo/status call doesn't pay the cold-import latency. Async
  // because the module import is dynamic; logs land a few ms after
  // the startup banner above.
  vanityAvailability().then((v) => {
    if (v.available) {
      console.log(`Vanity address generation: available (${v.path})`);
    } else {
      console.log('Vanity address generation: DISABLED');
      console.log('  Reason: vanity_keygen binary not built.');
      console.log('  To enable: run `npm run build:c` (requires gcc or clang).');
      console.log('  End-user release builds include this binary; this only affects dev environments.\n');
    }
  });
});
