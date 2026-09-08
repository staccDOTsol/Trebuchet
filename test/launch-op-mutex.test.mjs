import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const serverSrc = readFileSync(path.join(REPO, 'server.js'), 'utf8')
  + '\n' + readFileSync(path.join(REPO, 'orcaRoutes.js'), 'utf8');

// ---------------------------------------------------------------------------
// Per-wallet launch-operation mutex regression tests.
//
// Background: every chain-touching launch endpoint (token creation, quote
// acquisition, pool creation, resume, asset transfer) is long-running and
// mutates the same ephemeral wallet. The server runs in-process with
// Electron main, so a renderer reload mid-launch leaves the operation
// running invisibly — and a recovered UI could fire a second orchestrator
// (duplicate pools), a sweep (pulls funds out from under the launch), or a
// duplicate acquire (double SOL spend) against the same wallet.
//
// The fix is a per-wallet mutex: rejectOrClaimLaunchOp() returns HTTP 409
// with code 'OP_IN_FLIGHT' when any other operation holds the wallet, and
// each handler releases the lock in a finally guarded by claimedLaunchOp
// (so a 409-rejected duplicate never releases the running operation's
// lock). These tests are source-level (same pattern as the
// security-regressions suite) because server.js boots Express on import.
// ---------------------------------------------------------------------------

// Extract a single route handler's source by locating its app.post(...) and
// slicing to the next app.<verb>( registration (or EOF). Coarse, but enough
// to assert "this guard call lives inside this handler".
function handlerSource(route) {
  const start = serverSrc.indexOf(`app.post('${route}'`);
  assert.ok(start >= 0, `route ${route} must exist in server.js`);
  const rest = serverSrc.slice(start + 1);
  const next = rest.search(/app\.(get|post|put|delete)\(/);
  return serverSrc.slice(start, next >= 0 ? start + 1 + next : undefined);
}

test('mutex infrastructure exists', () => {
  assert.ok(
    /const launchOpsInFlight = new Map\(\)/.test(serverSrc),
    'launchOpsInFlight map must exist',
  );
  assert.ok(
    /function rejectOrClaimLaunchOp\(/.test(serverSrc),
    'rejectOrClaimLaunchOp must exist',
  );
  assert.ok(
    /function clearLaunchOpInFlight\(/.test(serverSrc),
    'clearLaunchOpInFlight must exist',
  );
  // The 409 body must carry the machine-readable code the frontend keys on.
  assert.ok(
    /code:\s*'OP_IN_FLIGHT'/.test(serverSrc),
    "409 response must include code: 'OP_IN_FLIGHT'",
  );
  assert.ok(
    /status\(409\)/.test(serverSrc),
    'rejection must use HTTP 409',
  );
});

// Endpoints that claim the lock for the duration of the request and
// release it in a finally. Each must: (a) call the guard with its own op
// name, (b) release conditionally on claimedLaunchOp so a rejected
// duplicate never frees the running op's lock.
for (const [route, op] of [
  ['/api/create-token', 'create-token'],
  ['/api/orca/launch', 'orca-launch'],
  ['/api/orca/finish', 'orca-finish'],
]) {
  test(`${route} claims and releases the per-wallet mutex`, () => {
    const src = handlerSource(route);
    assert.ok(
      src.includes(`rejectOrClaimLaunchOp(res, walletPublicKey, '${op}')`),
      `${route} must guard with op name '${op}'`,
    );
    assert.ok(
      /claimedLaunchOp = true/.test(src),
      `${route} must record that it claimed the lock`,
    );
    assert.ok(
      /if \(claimedLaunchOp && walletPublicKey\)\s*\{\s*\r?\n\s*clearLaunchOpInFlight\(walletPublicKey\);/.test(src),
      `${route} must release the lock only when it was the claimer`,
    );
    assert.ok(
      /\} finally \{/.test(src),
      `${route} must release in a finally so errors still free the lock`,
    );
  });
}

// The 409 rejection path must NOT claim/release: a rejected duplicate that
// nulls walletPublicKey before returning (orca launch / finish) guarantees
// the finally can't tear down the running op's progress tracker either.
test('orca launch and finish null walletPublicKey on rejection to protect the running op', () => {
  for (const route of ['/api/orca/launch', '/api/orca/finish']) {
    const src = handlerSource(route);
    const guardIdx = src.indexOf('rejectOrClaimLaunchOp(');
    const slice = src.slice(guardIdx, guardIdx + 400);
    assert.ok(
      /walletPublicKey = null/.test(slice),
      `${route} must null walletPublicKey before returning on 409`,
    );
  }
});

// Frontend contract: the page that calls these endpoints must recognize
// the OP_IN_FLIGHT code and explain it instead of showing a raw error.
test('frontend handles 409 OP_IN_FLIGHT', () => {
  const src = readFileSync(path.join(REPO, 'public/orca.js'), 'utf8');
  assert.ok(src.includes("'OP_IN_FLIGHT'"), 'public/orca.js must key on OP_IN_FLIGHT');
  assert.ok(/runningForSec/.test(src), 'public/orca.js must surface how long the running op has been going');
});
