import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORCED_QUOTES,
  FORCED_MIN_SUPPLY_PCT,
  DEFAULT_WHIRLPOOLS_CONFIG,
  normalizeOrcaQuotes,
  defaultQuoteSplit,
  decodeWhirlpoolsConfig,
  decodeFeeTier,
  decodeWhirlpool,
  decodeLockConfig,
  normalizeOrcaFeeTiers,
  pickDefaultFeeTier,
  singleSidedTickRange,
  fullRangeTicks,
  sqrtPriceX64ToPrice,
  classifyPoolSides,
  estimateOrcaLaunchSol,
  isFullRangeOnlyTickSpacing,
  ladderTickRanges,
  normalizeLadderSteps,
} from '../orcaLpPlan.js';

const EVUL = 'EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump';
const INFITY = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f';
const FIREFUN = '5SyfywcaD8kiEGyrt7cg4FnVqxTcuut5KCcWgh44o3UG';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ---------------------------------------------------------------------------
// Forced quotes
// ---------------------------------------------------------------------------

test('the three forced quotes are TOKEN, INFITY and FIREFUN, min 1% each', () => {
  assert.deepEqual(FORCED_QUOTES.map((q) => q.mint), [EVUL, INFITY, FIREFUN]);
  assert.equal(FORCED_MIN_SUPPLY_PCT, 1);
  for (const q of FORCED_QUOTES) {
    assert.equal(q.forced, true);
    assert.equal(q.minSupplyPercent, 1);
  }
  assert.equal(FORCED_QUOTES[0].programId, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  assert.equal(FORCED_QUOTES[1].transferFeeBps, 690);
  assert.equal(FORCED_QUOTES[2].programId, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
});

test('normalizeOrcaQuotes always injects the forced quotes at the minimum', () => {
  const plan = normalizeOrcaQuotes([{ mint: SOL, supplyPercent: 50 }]);
  assert.deepEqual(plan.quotes.map((q) => [q.mint, q.supplyPercent, q.forced]), [
    [EVUL, 1, true],
    [INFITY, 1, true],
    [FIREFUN, 1, true],
    [SOL, 50, false],
  ]);
  assert.equal(plan.totalPercent, 53);
  assert.equal(plan.remainderPercent, 47);
});

test('normalizeOrcaQuotes keeps a larger explicit forced allocation', () => {
  const plan = normalizeOrcaQuotes([
    { mint: INFITY, supplyPercent: 10 },
    { mint: EVUL, supplyPercent: 5 },
    { mint: USDC, supplyPercent: 20 },
  ]);
  assert.deepEqual(plan.quotes.map((q) => [q.mint, q.supplyPercent]), [[EVUL, 5], [INFITY, 10], [FIREFUN, 1], [USDC, 20]]);
});

test('normalizeOrcaQuotes rejects a forced quote under 1%', () => {
  assert.throws(
    () => normalizeOrcaQuotes([{ mint: EVUL, supplyPercent: 0.5 }]),
    /required quote and must get at least 1%/,
  );
  assert.throws(() => normalizeOrcaQuotes([{ mint: INFITY, supplyPercent: 0 }]), /at least 1%/);
});

test('normalizeOrcaQuotes rejects >100%, duplicates, zero optional shares, bad mints', () => {
  assert.throws(() => normalizeOrcaQuotes([{ mint: SOL, supplyPercent: 99 }]), /must be <= 100%/);
  assert.throws(() => normalizeOrcaQuotes([{ mint: SOL, supplyPercent: 1 }, { mint: SOL, supplyPercent: 1 }]), /duplicate/);
  assert.throws(() => normalizeOrcaQuotes([{ mint: SOL, supplyPercent: 0 }]), /must be > 0/);
  assert.throws(() => normalizeOrcaQuotes([{ mint: 'nope', supplyPercent: 1 }]), /invalid quote mint/);
  assert.throws(() => normalizeOrcaQuotes([{ mint: SOL, supplyPercent: 'x' }]), /must be a number/);
});

test('normalizeOrcaQuotes with no input is just the forced trio at 1% each', () => {
  const plan = normalizeOrcaQuotes(undefined);
  assert.equal(plan.quotes.length, 3);
  assert.equal(plan.totalPercent, 3);
  assert.equal(plan.remainderPercent, 97);
});

test('defaultQuoteSplit gives the remainder to the optional picks evenly', () => {
  assert.deepEqual(defaultQuoteSplit([SOL]), [
    { mint: EVUL, supplyPercent: 1 },
    { mint: INFITY, supplyPercent: 1 },
    { mint: FIREFUN, supplyPercent: 1 },
    { mint: SOL, supplyPercent: 97 },
  ]);
  const three = defaultQuoteSplit([SOL, USDC, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
  const total = three.reduce((s, q) => s + q.supplyPercent, 0);
  assert.equal(Math.round(total * 100) / 100, 100);
  assert.deepEqual(defaultQuoteSplit([]), [
    { mint: EVUL, supplyPercent: 33.33 },
    { mint: INFITY, supplyPercent: 33.33 },
    { mint: FIREFUN, supplyPercent: 33.33 },
  ]);
  // Forced mints passed as "optional" are ignored, not doubled.
  assert.equal(defaultQuoteSplit([EVUL, SOL]).length, 4);
});

// ---------------------------------------------------------------------------
// Decoders — fixtures captured from mainnet
// ---------------------------------------------------------------------------

test('decodeWhirlpoolsConfig reads the default config', () => {
  const buf = Buffer.from(
    'nRQx4NlXwf4HrrHV1T2SGy+/GNvwogpUu4qJt4OnQ5YQy0e93XDgkAeusdXVPZIbL78Y2/CiClS7iom3g6dDlhDLR73dcOCQB66x1dU9khsvvxjb8KIKVLuKibeDp0OWEMtHvd1w4JDECQAA',
    'base64',
  );
  const cfg = decodeWhirlpoolsConfig(buf);
  assert.equal(cfg.feeAuthority, 'WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb');
  assert.equal(cfg.collectProtocolFeesAuthority, 'WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb');
  assert.equal(cfg.defaultProtocolFeeRate, 2500);
  assert.equal(DEFAULT_WHIRLPOOLS_CONFIG, '12yTE48QR6bGK4EMcyY8XsARbX1TRTEbwHYSuuxR1Hp8');
});

test('decodeFeeTier reads tick spacing and fee rate', () => {
  const buf = Buffer.alloc(44);
  Buffer.from('816955d1a68a11c78cdf15d276796d1ebfeca5151bb41ba036ab6bf7b6f1cd00', 'hex').copy(buf, 8);
  buf.writeUInt16LE(128, 40);
  buf.writeUInt16LE(10000, 42);
  const tier = decodeFeeTier(buf);
  assert.equal(tier.tickSpacing, 128);
  assert.equal(tier.feeRate, 10000);
});

test('decodeWhirlpool / decodeLockConfig follow the program layout', () => {
  const pool = Buffer.alloc(653);
  pool.writeUInt16LE(128, 41);
  pool.writeUInt16LE(10000, 45);
  pool.writeUInt16LE(1300, 47);
  pool.writeBigUInt64LE(1n << 64n >> 0n & 0xffffffffffffffffn, 65); // low half of sqrt price = 0
  pool.writeBigUInt64LE(1n, 73); // high half = 1 -> sqrtPrice = 2^64 -> price 1.0
  pool.writeInt32LE(-123, 81);
  const d = decodeWhirlpool(pool);
  assert.equal(d.tickSpacing, 128);
  assert.equal(d.feeRate, 10000);
  assert.equal(d.protocolFeeRate, 1300);
  assert.equal(d.tickCurrentIndex, -123);
  assert.equal(d.sqrtPrice, 1n << 64n);
  assert.equal(sqrtPriceX64ToPrice(d.sqrtPrice, 6, 6), 1);
  assert.equal(sqrtPriceX64ToPrice(d.sqrtPrice, 9, 6), 1000);

  const lock = Buffer.alloc(241);
  lock.writeBigUInt64LE(1788902978n, 104);
  lock[112] = 0;
  const l = decodeLockConfig(lock);
  assert.equal(l.lockedTimestamp, 1788902978);
  assert.equal(l.lockType, 'Permanent');
});

// ---------------------------------------------------------------------------
// Fee tiers
// ---------------------------------------------------------------------------

test('fee tiers: 1% wins by default, full-range-only and 0% tiers are unusable', () => {
  const tiers = normalizeOrcaFeeTiers([
    { tickSpacing: 32896, feeRate: 3000 },
    { tickSpacing: 128, feeRate: 10000 },
    { tickSpacing: 32, feeRate: 666 },
    { tickSpacing: 32, feeRate: 0 },
    { tickSpacing: 'x', feeRate: 1 },
  ]);
  assert.deepEqual(tiers.map((t) => [t.tickSpacing, t.feeRate, t.usable]), [
    [32, 0, false],
    [32, 666, true],
    [32896, 3000, false],
    [128, 10000, true],
  ]);
  assert.equal(pickDefaultFeeTier(tiers).tickSpacing, 128);
  assert.equal(pickDefaultFeeTier([{ tickSpacing: 32, feeRate: 666 }, { tickSpacing: 64, feeRate: 3000 }]).feeRate, 3000);
  assert.equal(pickDefaultFeeTier([{ tickSpacing: 32896, feeRate: 3000 }]), null);
  assert.equal(isFullRangeOnlyTickSpacing(32768), true);
  assert.equal(isFullRangeOnlyTickSpacing(128), false);
});

// ---------------------------------------------------------------------------
// Tick math
// ---------------------------------------------------------------------------

test('fullRangeTicks matches the SDK for common spacings', () => {
  assert.deepEqual(fullRangeTicks(128), [-443520, 443520]);
  assert.deepEqual(fullRangeTicks(64), [-443584, 443584]);
  assert.deepEqual(fullRangeTicks(1), [-443636, 443636]);
});

test('singleSidedTickRange keeps the launched token out of range on the correct side', () => {
  // Token is A: range strictly above the current tick, up to the max.
  assert.deepEqual(singleSidedTickRange({ tokenIsA: true, currentTick: -123457, tickSpacing: 128 }), { tickLower: -123392, tickUpper: 443520 });
  assert.deepEqual(singleSidedTickRange({ tokenIsA: true, currentTick: 0, tickSpacing: 128 }), { tickLower: 128, tickUpper: 443520 });
  assert.deepEqual(singleSidedTickRange({ tokenIsA: true, currentTick: 128, tickSpacing: 128 }), { tickLower: 256, tickUpper: 443520 });
  // Token is B: range at/below the current tick, down to the min.
  assert.deepEqual(singleSidedTickRange({ tokenIsA: false, currentTick: 123457, tickSpacing: 128 }), { tickLower: -443520, tickUpper: 123392 });
  assert.deepEqual(singleSidedTickRange({ tokenIsA: false, currentTick: 128, tickSpacing: 128 }), { tickLower: -443520, tickUpper: 128 });
  assert.deepEqual(singleSidedTickRange({ tokenIsA: false, currentTick: -5, tickSpacing: 32 }), { tickLower: -443616, tickUpper: -32 });
  assert.throws(() => singleSidedTickRange({ tokenIsA: true, currentTick: 0, tickSpacing: 32896 }), /full-range only/);
  assert.throws(() => singleSidedTickRange({ tokenIsA: true, currentTick: 443520, tickSpacing: 128 }), /too high/);
});

test('classifyPoolSides picks the non-quote mint as the launched token', () => {
  const s = classifyPoolSides('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', SOL);
  assert.deepEqual(s, { tokenMint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', quoteMint: SOL, tokenIsA: true });
  const t = classifyPoolSides(EVUL, 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
  assert.equal(t.tokenIsA, false);
  assert.equal(t.quoteMint, EVUL);
  assert.equal(classifyPoolSides(SOL, USDC).ambiguous, true);
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('estimateOrcaLaunchSol scales per pool with a safety buffer', () => {
  const three = estimateOrcaLaunchSol({ poolCount: 3 });
  assert.equal(three.poolCount, 3);
  assert.equal(three.rawSol, 0.165);
  assert.equal(three.totalSol, 0.198);
  assert.equal(estimateOrcaLaunchSol({ poolCount: 4 }).totalSol, 0.24);
  const one = estimateOrcaLaunchSol({ poolCount: 1, tokenCreateSol: 0 });
  assert.equal(one.totalSol, 0.054);
});

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

test('ladder: equal-share bands stacked above the price, folding at the tick bounds', () => {
  assert.equal(normalizeLadderSteps(0), 1);
  assert.equal(normalizeLadderSteps(5000), 1000);
  assert.equal(normalizeLadderSteps('40'), 40);
  const one = ladderTickRanges({ tokenIsA: true, currentTick: 13933, tickSpacing: 128, steps: 1 });
  assert.deepEqual(one.map((b) => [b.tickLower, b.tickUpper, b.sharePercent]), [[13952, 443520, 100]]);
  const ten = ladderTickRanges({ tokenIsA: true, currentTick: 13933, tickSpacing: 128, steps: 10 });
  assert.equal(ten.length, 10);
  assert.equal(ten[0].tickLower, 13952);
  for (let i = 1; i < 10; i++) assert.equal(ten[i].tickLower, ten[i - 1].tickUpper);
  assert.equal(ten[9].tickUpper, 443520);
  assert.ok(ten.every((b) => b.tickLower % 128 === 0 && b.tickUpper % 128 === 0));
  assert.equal(Math.round(ten.reduce((a, b) => a + b.sharePercent, 0) * 1e6) / 1e6, 100);
  assert.ok(ten[0].multipleTo > 1.9 && ten[0].multipleTo < 2.1, 'first band spans ~2x');
  // Token on the B side: bands go DOWN in tick from the current price.
  const b = ladderTickRanges({ tokenIsA: false, currentTick: -58647, tickSpacing: 128, steps: 10 });
  assert.equal(b[0].tickUpper, -58752);
  assert.ok(b[0].tickLower < b[0].tickUpper);
  assert.equal(b[9].tickLower, -443520);
  // A thousand steps never go narrower than one tick spacing.
  const k = ladderTickRanges({ tokenIsA: true, currentTick: 0, tickSpacing: 128, steps: 1000 });
  assert.equal(k.length, 1000);
  assert.ok(k.every((x) => x.tickUpper - x.tickLower >= 128));
  // Near the top of the range the remaining steps fold into the last band.
  const top = ladderTickRanges({ tokenIsA: true, currentTick: 440000, tickSpacing: 128, steps: 10 });
  assert.ok(top.length < 10);
  assert.equal(Math.round(top.reduce((a, x) => a + x.sharePercent, 0)), 100);
  assert.throws(() => ladderTickRanges({ tokenIsA: true, currentTick: 0, tickSpacing: 32896, steps: 10 }), /full-range/);
});

test('estimate scales with positions per pool', () => {
  const e = estimateOrcaLaunchSol({ poolCount: 7, positionsPerPool: 10 });
  assert.equal(e.positionCount, 70);
  assert.equal(e.txCount, 4 + 7 + 140);
  assert.ok(e.totalSol > estimateOrcaLaunchSol({ poolCount: 7 }).totalSol);
});
