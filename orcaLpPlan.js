// orcaLpPlan.js
//
// Pure planning + decoding logic for the Orca Whirlpools launch path. No
// network, no SDK — everything here is testable with plain node:test.
//
// The Orca launch is deliberately simpler than the Raydium CLMM flow in
// lpService.js: the launcher picks which quote tokens to pair against, we
// create one Whirlpool per quote on the operator's own WhirlpoolsConfig,
// open one single-sided position per pool holding that quote's share of the
// supply, and permanently lock every position with Orca's native
// lock_position instruction (LockType::Permanent). Locked positions keep
// earning fees; they can never be withdrawn.

import bs58 from 'bs58';
import { WSOL_MINT, USDC_MINT, USDT_MINT } from './lpConstants.js';

// ---------------------------------------------------------------------------
// Program + config identity
// ---------------------------------------------------------------------------

export const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// The wallet that owns (is fee authority of) the WhirlpoolsConfigs this app
// launches on. Every config whose fee_authority is this key is offered in
// the advanced picker; DEFAULT_WHIRLPOOLS_CONFIG is the one with the most
// live pools at the time this path shipped.
export const ORCA_CONFIG_AUTHORITY = 'WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb';
export const DEFAULT_WHIRLPOOLS_CONFIG =
  process.env.ORCA_WHIRLPOOLS_CONFIG || '12yTE48QR6bGK4EMcyY8XsARbX1TRTEbwHYSuuxR1Hp8';

// Snapshot of the fee tiers on DEFAULT_WHIRLPOOLS_CONFIG, used when the RPC
// refuses getProgramAccounts (public endpoints rate-limit it). Refreshed
// live whenever the RPC cooperates; see orcaLpService.getFeeTiers.
export const FALLBACK_ORCA_FEE_TIERS = [
  { tickSpacing: 32, feeRate: 666, address: 'FsUL58f5x8GkkvJkpSJu4LhRgkAnfF5WZ3RBxijmAwPF' },
  { tickSpacing: 128, feeRate: 10000, address: 'DNaoTVD9SC8p1Pqbr58ixENgVXoSEQnvc8txn363Dusr' },
];

// Orca caps a config's protocol fee at 25% of swap fees (2500 bps of the
// fee). Our config must sit at that cap: launches refuse anything lower.
export const ORCA_MAX_PROTOCOL_FEE_RATE = 2500;

// Whirlpools treats any tick spacing >= this as "full range only": positions
// on those pools must span the whole range, so single-sided launches are
// impossible there. Such tiers are shown but disabled.
export const FULL_RANGE_ONLY_TICK_SPACING_THRESHOLD = 32768;
export const MAX_TICK_INDEX = 443636;
export const MIN_TICK_INDEX = -443636;

// "Explore" cutoff: launches are things locked on our config after this
// feature went live. Anything older on the same config is pre-history and
// stays out of the feed.
export const DISCOVERY_SINCE_UNIX = Number(process.env.ORCA_DISCOVERY_SINCE || 1788904800); // 2026-09-08T22:00:00Z

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

// Every launch MUST pair against these two, each with at least
// FORCED_MIN_SUPPLY_PCT of the supply. Neither can be removed from the plan.
export const FORCED_MIN_SUPPLY_PCT = 1;
export const FORCED_QUOTES = Object.freeze([
  Object.freeze({
    mint: 'EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump',
    symbol: 'TOKEN',
    name: '$TOKEN',
    decimals: 6,
    programId: TOKEN_2022_PROGRAM,
    forced: true,
    minSupplyPercent: FORCED_MIN_SUPPLY_PCT,
  }),
  Object.freeze({
    mint: '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f',
    symbol: 'INFITY',
    name: '$INFITY (formerly stacsol)',
    decimals: 9,
    programId: TOKEN_2022_PROGRAM,
    transferFeeBps: 690,
    forced: true,
    minSupplyPercent: FORCED_MIN_SUPPLY_PCT,
  }),
  Object.freeze({
    mint: '5SyfywcaD8kiEGyrt7cg4FnVqxTcuut5KCcWgh44o3UG',
    symbol: 'FIREFUN',
    name: '$FIREFUN (firefun.xyz)',
    decimals: 9,
    programId: TOKEN_PROGRAM,
    forced: true,
    minSupplyPercent: FORCED_MIN_SUPPLY_PCT,
  }),
]);

export const OPTIONAL_QUOTES = Object.freeze([
  Object.freeze({ mint: WSOL_MINT, symbol: 'SOL', name: 'Solana', decimals: 9, programId: TOKEN_PROGRAM }),
  Object.freeze({ mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6, programId: TOKEN_PROGRAM }),
  Object.freeze({ mint: USDT_MINT, symbol: 'USDT', name: 'USDT', decimals: 6, programId: TOKEN_PROGRAM }),
]);

export const KNOWN_QUOTE_MINTS = new Set([
  ...FORCED_QUOTES.map((q) => q.mint),
  ...OPTIONAL_QUOTES.map((q) => q.mint),
]);

export function isForcedQuoteMint(mint) {
  return FORCED_QUOTES.some((q) => q.mint === mint);
}

function isBase58Pubkey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch (_) {
    return false;
  }
}

/**
 * Normalize the launcher's quote selection into the pool plan.
 *
 *   quotes: [{ mint, supplyPercent }]
 *
 * Rules:
 *   - Both FORCED_QUOTES are always present. If the caller omitted one it is
 *     added at FORCED_MIN_SUPPLY_PCT; if the caller gave it less than the
 *     minimum, that is an error (the UI enforces it, the server re-checks).
 *   - Every other quote must have supplyPercent > 0.
 *   - Duplicate mints are an error.
 *   - Total must be <= 100. Whatever is left stays in the launch wallet and
 *     is swept to the launcher at the end.
 *
 * Returns { quotes: [{ mint, supplyPercent, forced }], totalPercent,
 * remainderPercent }. Forced quotes come first, in FORCED_QUOTES order.
 */
export function normalizeOrcaQuotes(quotes) {
  const input = Array.isArray(quotes) ? quotes : [];
  const byMint = new Map();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new Error('each quote must be an object');
    const mint = String(raw.mint || '').trim();
    if (!isBase58Pubkey(mint)) throw new Error(`invalid quote mint: ${JSON.stringify(raw.mint)}`);
    if (byMint.has(mint)) throw new Error(`duplicate quote mint: ${mint}`);
    const pct = Number(raw.supplyPercent);
    if (!Number.isFinite(pct)) throw new Error(`supplyPercent for ${mint} must be a number`);
    byMint.set(mint, pct);
  }

  const out = [];
  for (const fq of FORCED_QUOTES) {
    const pct = byMint.has(fq.mint) ? byMint.get(fq.mint) : fq.minSupplyPercent;
    if (pct < fq.minSupplyPercent - 1e-9) {
      throw new Error(
        `${fq.symbol} (${fq.mint}) is a required quote and must get at least ` +
          `${fq.minSupplyPercent}% of supply (got ${pct}%)`,
      );
    }
    out.push({ mint: fq.mint, supplyPercent: pct, forced: true, symbol: fq.symbol });
    byMint.delete(fq.mint);
  }
  for (const [mint, pct] of byMint.entries()) {
    if (pct <= 0) throw new Error(`supplyPercent for ${mint} must be > 0`);
    const known = OPTIONAL_QUOTES.find((q) => q.mint === mint);
    out.push({ mint, supplyPercent: pct, forced: false, symbol: known ? known.symbol : null });
  }

  const totalPercent = out.reduce((s, q) => s + q.supplyPercent, 0);
  if (totalPercent > 100 + 1e-9) {
    throw new Error(`quote allocations sum to ${round2(totalPercent)}%, must be <= 100%`);
  }
  return {
    quotes: out,
    totalPercent: round2(totalPercent),
    remainderPercent: round2(100 - totalPercent),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Default split for the UI: forced quotes take FORCED_MIN_SUPPLY_PCT each
 * unless there is nothing else selected, and the rest of `totalPercent` is
 * shared evenly across the launcher's own picks. With no optional quotes
 * the forced pair shares the whole budget.
 */
export function defaultQuoteSplit(optionalMints, totalPercent = 100) {
  const opts = Array.from(new Set((optionalMints || []).filter((m) => !isForcedQuoteMint(m))));
  const total = Math.max(0, Math.min(100, Number(totalPercent) || 0));
  const plan = [];
  if (opts.length === 0) {
    const each = round2(total / FORCED_QUOTES.length);
    for (const fq of FORCED_QUOTES) {
      plan.push({ mint: fq.mint, supplyPercent: Math.max(fq.minSupplyPercent, each) });
    }
    return plan;
  }
  let forcedTotal = 0;
  for (const fq of FORCED_QUOTES) {
    plan.push({ mint: fq.mint, supplyPercent: fq.minSupplyPercent });
    forcedTotal += fq.minSupplyPercent;
  }
  const rest = Math.max(0, total - forcedTotal);
  const each = Math.floor((rest / opts.length) * 100) / 100;
  let assigned = 0;
  opts.forEach((mint, i) => {
    let pct = each;
    if (i === opts.length - 1) pct = round2(rest - assigned);
    assigned += pct;
    plan.push({ mint, supplyPercent: pct });
  });
  return plan;
}

// ---------------------------------------------------------------------------
// Account decoders (raw Buffer -> plain object). Offsets follow the
// Whirlpool program IDL; the discriminator is the first 8 bytes.
// ---------------------------------------------------------------------------

export const WHIRLPOOLS_CONFIG_SIZE = 108;
export const FEE_TIER_SIZE = 44;
export const WHIRLPOOL_SIZE = 653;
export const LOCK_CONFIG_SIZE = 241;
export const POSITION_SIZE = 216;

const pk = (buf, off) => bs58.encode(buf.subarray(off, off + 32));
const u16 = (buf, off) => buf.readUInt16LE(off);
const i32 = (buf, off) => buf.readInt32LE(off);
const u64 = (buf, off) => buf.readBigUInt64LE(off);
const u128 = (buf, off) => (buf.readBigUInt64LE(off + 8) << 64n) | buf.readBigUInt64LE(off);

export function decodeWhirlpoolsConfig(buf) {
  if (!buf || buf.length < WHIRLPOOLS_CONFIG_SIZE) throw new Error('WhirlpoolsConfig: bad length');
  return {
    feeAuthority: pk(buf, 8),
    collectProtocolFeesAuthority: pk(buf, 40),
    rewardEmissionsSuperAuthority: pk(buf, 72),
    defaultProtocolFeeRate: u16(buf, 104),
  };
}

export function decodeFeeTier(buf) {
  if (!buf || buf.length < FEE_TIER_SIZE) throw new Error('FeeTier: bad length');
  return {
    whirlpoolsConfig: pk(buf, 8),
    tickSpacing: u16(buf, 40),
    feeRate: u16(buf, 42),
  };
}

export function decodeWhirlpool(buf) {
  if (!buf || buf.length < 261) throw new Error('Whirlpool: bad length');
  return {
    whirlpoolsConfig: pk(buf, 8),
    tickSpacing: u16(buf, 41),
    feeTierIndexSeed: u16(buf, 43),
    feeRate: u16(buf, 45),
    protocolFeeRate: u16(buf, 47),
    liquidity: u128(buf, 49),
    sqrtPrice: u128(buf, 65),
    tickCurrentIndex: i32(buf, 81),
    tokenMintA: pk(buf, 101),
    tokenVaultA: pk(buf, 133),
    tokenMintB: pk(buf, 181),
    tokenVaultB: pk(buf, 213),
  };
}

export function decodeLockConfig(buf) {
  if (!buf || buf.length < 113) throw new Error('LockConfig: bad length');
  return {
    position: pk(buf, 8),
    positionOwner: pk(buf, 40),
    whirlpool: pk(buf, 72),
    lockedTimestamp: Number(u64(buf, 104)),
    lockType: buf[112] === 0 ? 'Permanent' : `Unknown(${buf[112]})`,
  };
}

export function decodePosition(buf) {
  if (!buf || buf.length < 96) throw new Error('Position: bad length');
  return {
    whirlpool: pk(buf, 8),
    positionMint: pk(buf, 40),
    liquidity: u128(buf, 72),
    tickLowerIndex: i32(buf, 88),
    tickUpperIndex: i32(buf, 92),
  };
}

// ---------------------------------------------------------------------------
// Fee tiers
// ---------------------------------------------------------------------------

export function isFullRangeOnlyTickSpacing(tickSpacing) {
  return Number(tickSpacing) >= FULL_RANGE_ONLY_TICK_SPACING_THRESHOLD;
}

/** Sort by fee rate ascending and annotate each tier for the UI. */
export function normalizeOrcaFeeTiers(list) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((t) => t && Number.isInteger(t.tickSpacing) && Number.isInteger(t.feeRate))
    .map((t) => ({
      tickSpacing: t.tickSpacing,
      feeRate: t.feeRate,
      feePercent: t.feeRate / 10000,
      address: t.address || null,
      fullRangeOnly: isFullRangeOnlyTickSpacing(t.tickSpacing),
      usable: t.feeRate > 0 && !isFullRangeOnlyTickSpacing(t.tickSpacing),
    }));
  rows.sort((a, b) => a.feeRate - b.feeRate || a.tickSpacing - b.tickSpacing);
  return rows;
}

/**
 * Pick the tier a memecoin launch wants by default: 1% if the config has
 * it, otherwise the highest usable fee. Full-range-only and 0% tiers never
 * win. Returns null when nothing is usable.
 */
export function pickDefaultFeeTier(tiers) {
  const usable = normalizeOrcaFeeTiers(tiers).filter((t) => t.usable);
  if (usable.length === 0) return null;
  const onePct = usable.find((t) => t.feeRate === 10000);
  if (onePct) return onePct;
  return usable[usable.length - 1];
}

// ---------------------------------------------------------------------------
// Tick math for single-sided positions
// ---------------------------------------------------------------------------

export function initializableTickBelow(tick, tickSpacing) {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

export function fullRangeTicks(tickSpacing) {
  return [
    Math.ceil(MIN_TICK_INDEX / tickSpacing) * tickSpacing,
    Math.floor(MAX_TICK_INDEX / tickSpacing) * tickSpacing,
  ];
}

/**
 * Tick bounds for a position that holds ONLY the launched token.
 *
 * Whirlpool prices are "B per A". A position entirely above the current
 * tick holds only token A; entirely at/below it holds only token B. So:
 *
 *   launched token is A -> [next initializable tick above current, max]
 *   launched token is B -> [min, initializable tick at/below current]
 *
 * Either way the position covers the whole upside for the launched token:
 * as buyers push the price through the range, the locked liquidity sells
 * the launched token into the quote and the fees accrue to the position.
 */
export function singleSidedTickRange({ tokenIsA, currentTick, tickSpacing }) {
  if (!Number.isInteger(currentTick)) throw new Error('currentTick must be an integer');
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error('bad tickSpacing');
  if (isFullRangeOnlyTickSpacing(tickSpacing)) {
    throw new Error(`tick spacing ${tickSpacing} is full-range only; single-sided positions are impossible`);
  }
  const [minTick, maxTick] = fullRangeTicks(tickSpacing);
  const below = initializableTickBelow(currentTick, tickSpacing);
  if (tokenIsA) {
    const tickLower = below + tickSpacing;
    if (tickLower >= maxTick) throw new Error('price too high for a single-sided position');
    return { tickLower, tickUpper: maxTick };
  }
  const tickUpper = below;
  if (tickUpper <= minTick) throw new Error('price too low for a single-sided position');
  return { tickLower: minTick, tickUpper };
}

/** Which side of the pool the launched token sits on. */
export function launchedTokenIsA(tokenMint, mintA) {
  return tokenMint === mintA;
}

/**
 * sqrt_price (Q64.64, as BigInt) -> price of A in units of B, adjusted for
 * decimals, as a JS number. Precision is fine for display; the SDK's
 * PriceMath does the exact version for tx building.
 */
export function sqrtPriceX64ToPrice(sqrtPriceX64, decimalsA, decimalsB) {
  const sqrt = Number(sqrtPriceX64) / 2 ** 64;
  return sqrt * sqrt * 10 ** (decimalsA - decimalsB);
}

/** Pick the launched-token side of a pool given the known quote set. */
export function classifyPoolSides(mintA, mintB, quoteMints = KNOWN_QUOTE_MINTS) {
  const aIsQuote = quoteMints.has(mintA);
  const bIsQuote = quoteMints.has(mintB);
  if (aIsQuote && !bIsQuote) return { tokenMint: mintB, quoteMint: mintA, tokenIsA: false };
  if (bIsQuote && !aIsQuote) return { tokenMint: mintA, quoteMint: mintB, tokenIsA: true };
  // Both or neither known: treat B as the quote (SOL/USDC usually sort
  // there) so the feed still renders something sensible.
  return { tokenMint: mintA, quoteMint: mintB, tokenIsA: true, ambiguous: true };
}

/** Jupiter swap link: sell `sellMint` for `buyMint`. */
export function jupiterSwapUrl(sellMint, buyMint) {
  return `https://jup.ag/?sell=${encodeURIComponent(sellMint)}&buy=${encodeURIComponent(buyMint)}`;
}

// ---------------------------------------------------------------------------
// Cost estimate
// ---------------------------------------------------------------------------
//
// Measured on mainnet (rent at 6960 lamports/byte):
//   Whirlpool account (653 B)              0.00544 SOL
//   two token vaults (165 B each)          0.00408 SOL
//   dynamic tick arrays x3 (~150 B + growth per tick)  ~0.006 SOL
//   Token-2022 position mint + metadata    ~0.0035 SOL
//   position account (216 B) + token acct  ~0.0045 SOL
//   LockConfig (241 B)                     0.00234 SOL
//   quote-side ATA (never funded, rent)    ~0.0021 SOL
//   tx fees + priority                     ~0.0015 SOL
// Rounded up to 0.035 per pool, plus the token mint itself and a buffer.
export const ORCA_COST_PER_POOL_SOL = 0.035;
export const ORCA_COST_BASE_SOL = 0.01;
export const ORCA_SAFETY_BUFFER_PCT = 0.2;

export function estimateOrcaLaunchSol({ poolCount, tokenCreateSol = 0.05 }) {
  const pools = Math.max(0, Number(poolCount) || 0);
  const raw = ORCA_COST_BASE_SOL + tokenCreateSol + pools * ORCA_COST_PER_POOL_SOL;
  // Round away float noise before the ceil so 0.045 * 1.2 is 0.054, not 0.055.
  const withBuffer = Math.round(raw * (1 + ORCA_SAFETY_BUFFER_PCT) * 1e9) / 1e9;
  return {
    poolCount: pools,
    perPoolSol: ORCA_COST_PER_POOL_SOL,
    tokenCreateSol,
    baseSol: ORCA_COST_BASE_SOL,
    rawSol: Math.round(raw * 1e6) / 1e6,
    bufferPct: ORCA_SAFETY_BUFFER_PCT,
    totalSol: Math.ceil(withBuffer * 1000) / 1000,
  };
}
