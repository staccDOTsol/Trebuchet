// serverMiddleware.js
//
// Express middleware extracted from server.js so each piece can be
// tested independently without driving route handlers. Imported by
// server.js at startup.
//
// Exports:
//   ALLOWED_HOSTS              — Set of hostnames allowed through the DNS-rebinding defense
//   hostCheckMiddleware        — rejects requests with untrusted Host headers
//   securityHeadersMiddleware  — sets CSP + frame/type-sniff headers
//   apiSessionMiddleware       — requires x-trebuchet-session for /api/* (except /session, /proxy-image)
//   upload                     — multer instance for logo uploads
//   resolvePublicDir           — resolves the public/ dir path through asar-unpacked when packaged

import crypto from 'crypto';
import fs from 'fs';
import multer from 'multer';
import path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Local dev hosts, the public FireFun domain, and anything listed in
// TREBUCHET_ALLOWED_HOSTS (comma-separated; e.g. the Fly.io app hostname).
export const ALLOWED_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  'firefun.xyz',
  'www.firefun.xyz',
  ...String(process.env.TREBUCHET_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
]);

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Generated once at module load, never rotates. Valid for the process
// lifetime. The threat model assumes same-origin only + no CORS, so
// cross-origin pages cannot exfiltrate the token from /api/session.
//
// Hosted deployments that run more than one process behind one hostname
// (or restart often) must pin it with TREBUCHET_API_SESSION_TOKEN, or a
// browser that fetched the token from one process gets "invalid API
// session" from the next. Fly: `fly secrets set TREBUCHET_API_SESSION_TOKEN=...`.
//
// Resolution order: TREBUCHET_API_SESSION_TOKEN env, then a secret file in
// the config directory (created once, so the token survives restarts and
// redeploys that keep the volume), then a fresh random token.
function resolveApiSessionToken() {
  if (process.env.TREBUCHET_API_SESSION_TOKEN) return process.env.TREBUCHET_API_SESSION_TOKEN;
  const dir = process.env.TREBUCHET_CONFIG_DIR;
  if (dir) {
    const file = path.join(dir, 'apiSession.secret');
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing.length >= 32) return existing;
    } catch (_) { /* first run */ }
    const fresh = crypto.randomBytes(32).toString('base64url');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, fresh, { mode: 0o600 });
      return fresh;
    } catch (err) {
      console.warn(`apiSession: could not persist token in ${dir}: ${err.message}`);
    }
  }
  return crypto.randomBytes(32).toString('base64url');
}
export const API_SESSION_TOKEN = resolveApiSessionToken();

// ---------------------------------------------------------------------------
// Multer
// ---------------------------------------------------------------------------

const storage = multer.memoryStorage();
export const upload = multer({
  storage,
  // The page downscales every logo to <=512px and ~<100KB before upload
  // (Arweave is priced per byte); this cap is only the safety net.
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') {
      cb(null, true);
      return;
    }
    cb(new Error('Logo must be a PNG or JPG image'));
  },
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * DNS-rebinding defense. Rejects any request whose Host header does not
 * claim to be 127.0.0.1 or localhost. Registered before the body parser
 * so a rejected request never has its body read into memory.
 */
export function hostCheckMiddleware(req, res, next) {
  const hostHeader = String(req.headers.host || ''); // String() guards against array Host headers
  // Host header format is 'hostname' or 'hostname:port'. Strip the port.
  // Hostnames are case-insensitive per RFC 3986 section 3.2.2.
  const hostname = hostHeader.split(':')[0].toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) {
    console.warn(
      `Rejected request with disallowed Host header: ${hostHeader} ` +
      `${req.method} ${req.url}`,
    );
    return res
      .status(403)
      .json({ success: false, error: 'invalid Host header' });
  }
  next();
}

/**
 * Sets Content-Security-Policy, X-Frame-Options, and X-Content-Type-Options
 * headers on every response.
 */
export function securityHeadersMiddleware(_req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

/**
 * Requires a valid x-trebuchet-session header on all /api/* routes except
 * /api/session (which hands out the token) and /api/proxy-image (which is
 * a read-only passthrough loaded via HTML elements that can't attach
 * custom headers).
 */
// NOTE: this middleware must be mounted at '/api' (app.use('/api', ...)).
// Express strips the mount prefix, so req.path is '/session', not '/api/session'.
// If the mount point changes, the exemption paths below must be updated.
export function apiSessionMiddleware(req, res, next) {
  if (req.path === '/session' || req.path === '/proxy-image' || req.path === '/generate-vanity-wallet-stream') return next();
  const token = req.get('x-trebuchet-session');
  const tokenBuf = Buffer.from(token || '');
  const expectedBuf = Buffer.from(API_SESSION_TOKEN);
  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    return res
      .status(403)
      .json({ success: false, error: 'invalid API session' });
  }
  next();
}

/**
 * Public API surface. FireFun is a public multi-user site now, so only the
 * endpoints the Orca launcher UI actually calls are reachable. Everything
 * else still mounted in server.js (legacy operator/desktop endpoints such as
 * pending-wallet reveal, secret-pin, rpc-config, server-logs, launch
 * journals, vanity grinding) is server-wide state and must never be exposed
 * to an arbitrary visitor, so it 404s here before any handler runs.
 *
 * Paths are as seen by a middleware mounted at '/api' (prefix stripped).
 */
export const PUBLIC_API_ROUTES = new Set([
  'GET /session',
  'POST /generate-wallet',
  'GET /wallet-qr',
  'POST /check-balance',
  'GET /lp-progress',
  'POST /create-token',
]);
export const PUBLIC_API_PREFIXES = ['/orca/'];

export function isPublicApiRoute(method, path) {
  const m = String(method || '').toUpperCase();
  if (PUBLIC_API_ROUTES.has(`${m} ${path}`)) return true;
  return PUBLIC_API_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// NOTE: mount at '/api' like apiSessionMiddleware.
export function publicApiAllowlistMiddleware(req, res, next) {
  if (isPublicApiRoute(req.method, req.path)) return next();
  res.status(404).json({ success: false, error: 'not found' });
}

// ---------------------------------------------------------------------------
// Static file resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the public/ directory's path on disk. In dev/web mode, joins
 * against __dirname. In packaged Electron, rewrites the path past
 * app.asar to app.asar.unpacked so Express's streaming static middleware
 * can find unpacked files.
 */
export function resolvePublicDir(serverDirname) {
  const marker = path.sep + 'app.asar';
  const idx = serverDirname.indexOf(marker);
  if (idx === -1) {
    return path.join(serverDirname, 'public');
  }
  // Only rewrite when app.asar is the last path component (nothing after it).
  // If app.asar is followed by any character (e.g. app.asarx, app.asar/subdir),
  // treat it as a regular directory name and do not rewrite.
  const after = serverDirname[idx + marker.length];
  if (after !== undefined) {
    return path.join(serverDirname, 'public');
  }
  const rewritten =
    serverDirname.slice(0, idx) +
    path.sep + 'app.asar.unpacked' +
    serverDirname.slice(idx + marker.length);
  return path.join(rewritten, 'public');
}
