import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let importCounter = 0;

function makeTempConfigDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-rpc-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function importFreshRpcConfig(configDir) {
  process.env.TREBUCHET_CONFIG_DIR = configDir;
  return import(new URL(`../rpcConfig.js?case=${++importCounter}`, import.meta.url));
}

test('seeds default RPC config in the configured directory', async (t) => {
  const configDir = makeTempConfigDir(t);
  const rpcConfig = await importFreshRpcConfig(configDir);

  const config = rpcConfig.getConfig();
  assert.deepEqual(config.saved, rpcConfig.DEFAULT_SAVED_RPCS);
  assert.equal(config.active, rpcConfig.DEFAULT_SAVED_RPCS[0].url);
  // Public mainnet stays available as the last-resort fallback.
  assert.ok(config.saved.some((r) => r.url === 'https://api.mainnet-beta.solana.com'));

  const saved = JSON.parse(readFileSync(path.join(configDir, 'rpcConfig.json'), 'utf8'));
  assert.equal(saved.active, config.active);
});

test('adds, updates, selects, and removes saved RPC endpoints', async (t) => {
  const configDir = makeTempConfigDir(t);
  const rpcConfig = await importFreshRpcConfig(configDir);

  const heliusUrl = 'https://mainnet.helius-rpc.com/?api-key=test';
  rpcConfig.addSavedRpc('Helius', heliusUrl);
  rpcConfig.setActiveRpc(heliusUrl);

  const defaults = rpcConfig.DEFAULT_SAVED_RPCS;
  assert.equal(rpcConfig.getRpcUrl(), heliusUrl);
  assert.equal(rpcConfig.getConfig().saved.length, defaults.length + 1);

  rpcConfig.addSavedRpc('Helius renamed', heliusUrl);
  assert.equal(rpcConfig.getConfig().saved.length, defaults.length + 1);
  assert.equal(
    rpcConfig.getConfig().saved.find((entry) => entry.url === heliusUrl).name,
    'Helius renamed',
  );

  rpcConfig.removeSavedRpc(heliusUrl);
  assert.equal(rpcConfig.getRpcUrl(), defaults[0].url);
  // Strip the seeded list down to one entry; the last one can't be removed.
  for (const entry of defaults.slice(1)) rpcConfig.removeSavedRpc(entry.url);
  assert.equal(rpcConfig.getConfig().saved.length, 1);
  assert.throws(
    () => rpcConfig.removeSavedRpc(defaults[0].url),
    /Cannot remove the last saved RPC/,
  );
});

test('rejects invalid RPC config operations', async (t) => {
  const configDir = makeTempConfigDir(t);
  const rpcConfig = await importFreshRpcConfig(configDir);

  assert.throws(() => rpcConfig.addSavedRpc('', 'https://example.test'), /Name is required/);
  assert.throws(() => rpcConfig.addSavedRpc('Bad', 'not a url'), /valid URL/);
  assert.throws(() => rpcConfig.setActiveRpc('https://missing.example'), /Add it first/);
});

test('testRpc sends getVersion and reports success', async (t) => {
  const configDir = makeTempConfigDir(t);
  const rpcConfig = await importFreshRpcConfig(configDir);
  const originalFetch = globalThis.fetch;
  let captured = null;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      json: async () => ({
        result: { 'solana-core': '1.18.26' },
      }),
    };
  };
  const result = await rpcConfig.testRpc('https://rpc.example.test');

  assert.equal(result.ok, true);
  assert.equal(result.version, '1.18.26');
  assert.equal(captured.url, 'https://rpc.example.test');
  assert.equal(captured.options.method, 'POST');
  assert.deepEqual(JSON.parse(captured.options.body), {
    jsonrpc: '2.0',
    id: 1,
    method: 'getVersion',
    params: [],
  });
});

test('testRpc never throws for validation, HTTP, RPC, or network failures', async (t) => {
  const configDir = makeTempConfigDir(t);
  const rpcConfig = await importFreshRpcConfig(configDir);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await rpcConfig.testRpc('not a url'), {
    ok: false,
    error: 'Invalid URL',
  });

  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
  });
  assert.deepEqual(await rpcConfig.testRpc('https://rpc.example.test'), {
    ok: false,
    error: 'HTTP 500 Internal Server Error',
  });

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ error: { message: 'bad method' } }),
  });
  assert.deepEqual(await rpcConfig.testRpc('https://rpc.example.test'), {
    ok: false,
    error: 'bad method',
  });

  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  assert.deepEqual(await rpcConfig.testRpc('https://rpc.example.test'), {
    ok: false,
    error: 'network down',
  });

});
