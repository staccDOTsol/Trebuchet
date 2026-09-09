// pairsClient.js
//
// Off-chain client for the Trebuchet Pairs program (programs/pairs): account
// layouts, PDA derivation, instruction encoders/builders and the pure math
// the program uses, mirrored 1:1 so a UI can quote what a trade will cost
// before sending it. No RPC calls live here; everything is pure so it can be
// unit tested (test/pairs-client.test.mjs) and reused by the server or the
// browser bundle alike.
//
// Wire formats are fixed little-endian layouts (no IDL / borsh). Offsets
// mirror programs/pairs/src/state.rs and instruction.rs exactly; the Rust
// unit test `cross_language_fixture` and the JS test share byte fixtures so
// the two encoders cannot drift apart unnoticed.

import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const PAIRS_PROGRAM_ID = new PublicKey(
  process.env.PAIRS_PROGRAM_ID || '46RKjEgeK2qNkDdBFnBnrSUJtrXmPcFwSa6xNzNfMums',
);
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

/** Prices are long-side fractions of one collateral unit, in parts per million. */
export const PRICE_SCALE = 1_000_000n;
export const MARKET_LEN = 464;
export const OFFER_LEN = 112;
export const MINT_LEN = 82;
export const MAX_TAKER_FEE_PPM = 100_000n;

export const SettleKind = Object.freeze({ Authority: 0, Whirlpool: 1 });
export const MarketStatus = Object.freeze({ Open: 0, Settled: 1, Void: 2 });
export const Side = Object.freeze({ Long: 0, Short: 1 });

// ---------------------------------------------------------------------------
// byte helpers
// ---------------------------------------------------------------------------

function u64(v, name = 'value') {
  const b = BigInt(v);
  if (b < 0n || b > 0xffff_ffff_ffff_ffffn) throw new RangeError(`${name} must fit in u64`);
  return b;
}

function writeU64(buf, off, v) {
  buf.writeBigUInt64LE(u64(v), off);
}

function readU64(buf, off) {
  return buf.readBigUInt64LE(off);
}

function readI64(buf, off) {
  return buf.readBigInt64LE(off);
}

function readU128(buf, off) {
  return (buf.readBigUInt64LE(off + 8) << 64n) | buf.readBigUInt64LE(off);
}

function readPk(buf, off) {
  return new PublicKey(buf.subarray(off, off + 32));
}

function pk(v) {
  return v instanceof PublicKey ? v : new PublicKey(v);
}

// ---------------------------------------------------------------------------
// account decoders
// ---------------------------------------------------------------------------

/** Decode a `Market` account. Throws on the zero (uninitialized) version. */
export function decodeMarket(data) {
  const buf = Buffer.from(data);
  if (buf.length < MARKET_LEN) throw new Error('Market: bad length');
  if (buf[0] !== 1) throw new Error('Market: uninitialized or unknown version');
  return {
    version: buf[0],
    bump: buf[1],
    settleKind: buf[2],
    invert: buf[3] !== 0,
    priceDecimals: buf[4],
    status: buf[5],
    creator: readPk(buf, 8),
    collateralMint: readPk(buf, 40),
    collateralTokenProgram: readPk(buf, 72),
    vault: readPk(buf, 104),
    longMint: readPk(buf, 136),
    shortMint: readPk(buf, 168),
    settler: readPk(buf, 200),
    underlying: readPk(buf, 232),
    floorPrice: readU64(buf, 264),
    capPrice: readU64(buf, 272),
    tradeEndSlot: readU64(buf, 280),
    settleEndSlot: readU64(buf, 288),
    settlementPrice: readU64(buf, 296),
    longPayoutPpm: readU64(buf, 304),
    settledSlot: readU64(buf, 312),
    fundingRatePpm: readU64(buf, 320),
    fundingPeriodSlots: readU64(buf, 328),
    maxFundingPerPeriodPpm: readU64(buf, 336),
    fundingOffsetPpm: readI64(buf, 344),
    lastCrankSlot: readU64(buf, 352),
    vwapNum: readU128(buf, 360),
    vwapDen: readU64(buf, 376),
    lastIndexPrice: readU64(buf, 384),
    takerFeePpm: readU64(buf, 392),
    markWhirlpool: readPk(buf, 400),
    markInvert: buf[432] !== 0,
  };
}

/** Decode an `Offer` account. */
export function decodeOffer(data) {
  const buf = Buffer.from(data);
  if (buf.length < OFFER_LEN) throw new Error('Offer: bad length');
  if (buf[0] !== 1) throw new Error('Offer: uninitialized or unknown version');
  return {
    version: buf[0],
    bump: buf[1],
    side: buf[2],
    market: readPk(buf, 8),
    maker: readPk(buf, 40),
    nonce: readU64(buf, 72),
    longPricePpm: readU64(buf, 80),
    remaining: readU64(buf, 88),
    escrowed: readU64(buf, 96),
    expirySlot: readU64(buf, 104),
  };
}

/** Whether a market has a LONG/collateral whirlpool set as its funding mark. */
export function hasMarkWhirlpool(market) {
  return !market.markWhirlpool.equals(PublicKey.default);
}

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

export function authorityAddress(market, programId = PAIRS_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from('authority'), pk(market).toBuffer()], programId);
}

export function offerAddress(market, maker, nonce, programId = PAIRS_PROGRAM_ID) {
  const n = Buffer.alloc(8);
  writeU64(n, 0, nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('offer'), pk(market).toBuffer(), pk(maker).toBuffer(), n],
    programId,
  );
}

export function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [pk(owner).toBuffer(), pk(tokenProgram).toBuffer(), pk(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

// ---------------------------------------------------------------------------
// pure math (mirrors programs/pairs/src/math.rs)
// ---------------------------------------------------------------------------

/** Long side's contribution for `size` contracts: ceil(size * p / SCALE). */
export function longShare(size, longPricePpm) {
  const s = u64(size, 'size');
  const p = u64(longPricePpm, 'price');
  return (s * p + PRICE_SCALE - 1n) / PRICE_SCALE;
}

/** Short side's contribution: size - longShare. */
export function shortShare(size, longPricePpm) {
  return u64(size) - longShare(size, longPricePpm);
}

/** floor(amount * ppm / SCALE) */
export function payout(amount, ppm) {
  return (u64(amount) * u64(ppm)) / PRICE_SCALE;
}

/** Fee on notional: ceil(amount * ppm / SCALE). */
export function fee(amount, ppm) {
  return longShare(amount, ppm);
}

/** Long payout fraction implied by `price` on [floor, cap], clamped to [0, SCALE]. */
export function intrinsicPpm(price, floor, cap) {
  const p = u64(price);
  const f = u64(floor);
  const c = u64(cap);
  if (c <= f) throw new RangeError('floor must be below cap');
  if (p <= f) return 0n;
  if (p >= c) return PRICE_SCALE;
  return ((p - f) * PRICE_SCALE) / (c - f);
}

/** Long payout at settlement: clamp(intrinsic - fundingOffset, 0, SCALE). */
export function settlementPayoutPpm(intrinsic, fundingOffsetPpm) {
  const v = BigInt(intrinsic) - BigInt(fundingOffsetPpm);
  return v < 0n ? 0n : v > PRICE_SCALE ? PRICE_SCALE : v;
}

/** Portion of a maker's escrow consumed by a fill of `fill` out of `remaining`. */
export function makerShare(escrowed, remaining, fill) {
  if (BigInt(fill) === BigInt(remaining)) return u64(escrowed);
  return (u64(escrowed) * u64(fill)) / u64(remaining);
}

/**
 * Price of token A in token B from an Orca sqrt_price (Q64.64), scaled by
 * 10^priceDecimals in raw base units: sqrt^2 * 10^d / 2^128 (or the inverse).
 */
export function whirlpoolPrice(sqrtPriceX64, priceDecimals, invert = false) {
  const sq = BigInt(sqrtPriceX64) ** 2n;
  if (sq === 0n) throw new RangeError('sqrt_price is zero');
  const scale = 10n ** BigInt(priceDecimals);
  const one = 1n << 128n;
  return invert ? (one * scale) / sq : (sq * scale) >> 128n;
}

/**
 * Effective leverage of a LONG bought at `longPricePpm` on [floor, cap] at
 * `spot`: percentage payout change per percentage spot move.
 */
export function effectiveLeverage(spot, floor, cap, longPricePpm) {
  const s = Number(spot);
  const width = Number(cap) - Number(floor);
  return (s / width) * (Number(PRICE_SCALE) / Number(longPricePpm));
}

/**
 * Parameters for the next epoch of an "always-on" market: the same range
 * width re-centred on `spot`, with the schedule shifted by one epoch.
 */
export function nextEpochArgs(market, spot, { epochSlots, settleWindowSlots, nowSlot } = {}) {
  const s = u64(spot, 'spot');
  const width = market.capPrice - market.floorPrice;
  const half = width / 2n;
  const epoch = BigInt(epochSlots ?? market.tradeEndSlot - market.lastCrankSlot);
  const window = BigInt(settleWindowSlots ?? market.settleEndSlot - market.tradeEndSlot);
  const start = BigInt(nowSlot ?? market.settleEndSlot);
  return {
    settleKind: market.settleKind,
    invert: market.invert,
    priceDecimals: market.priceDecimals,
    floorPrice: s > half ? s - half : 0n,
    capPrice: s + (width - half),
    tradeEndSlot: start + epoch,
    settleEndSlot: start + epoch + window,
    fundingRatePpm: market.fundingRatePpm,
    fundingPeriodSlots: market.fundingPeriodSlots,
    maxFundingPerPeriodPpm: market.maxFundingPerPeriodPpm,
    takerFeePpm: market.takerFeePpm,
  };
}

// ---------------------------------------------------------------------------
// instruction data encoders
// ---------------------------------------------------------------------------

export function encodeInitMarket(a) {
  const buf = Buffer.alloc(1 + 3 + 8 * 8);
  buf[0] = 0;
  buf[1] = a.settleKind & 0xff;
  buf[2] = a.invert ? 1 : 0;
  buf[3] = a.priceDecimals & 0xff;
  const fields = [
    a.floorPrice,
    a.capPrice,
    a.tradeEndSlot,
    a.settleEndSlot,
    a.fundingRatePpm ?? 0n,
    a.fundingPeriodSlots ?? 0n,
    a.maxFundingPerPeriodPpm ?? 0n,
    a.takerFeePpm ?? 0n,
  ];
  fields.forEach((v, i) => writeU64(buf, 4 + 8 * i, v));
  return buf;
}

function tagU64(tag, v) {
  const buf = Buffer.alloc(9);
  buf[0] = tag;
  writeU64(buf, 1, v);
  return buf;
}

export const encodeMintPairs = (amount) => tagU64(1, amount);
export const encodeRedeemPairs = (amount) => tagU64(2, amount);
export function encodeTrade(size, longPricePpm) {
  const buf = Buffer.alloc(17);
  buf[0] = 3;
  writeU64(buf, 1, size);
  writeU64(buf, 9, longPricePpm);
  return buf;
}
export function encodePlaceOffer({ side, longPricePpm, size, expirySlot = 0n, nonce }) {
  const buf = Buffer.alloc(34);
  buf[0] = 4;
  buf[1] = side & 0xff;
  writeU64(buf, 2, longPricePpm);
  writeU64(buf, 10, size);
  writeU64(buf, 18, expirySlot);
  writeU64(buf, 26, nonce);
  return buf;
}
export const encodeFillOffer = (size) => tagU64(5, size);
export const encodeCancelOffer = () => Buffer.from([6]);
export const encodeSettle = (price) => tagU64(7, price);
export const encodeVoid = () => Buffer.from([8]);
export function encodeClaim(longAmount, shortAmount) {
  const buf = Buffer.alloc(17);
  buf[0] = 9;
  writeU64(buf, 1, longAmount);
  writeU64(buf, 9, shortAmount);
  return buf;
}
export const encodeCrank = (indexPrice) => tagU64(10, indexPrice);
export const encodeSetMarkWhirlpool = () => Buffer.from([11]);

// ---------------------------------------------------------------------------
// instruction builders (account orders mirror instruction.rs)
// ---------------------------------------------------------------------------

const w = (pubkey, isSigner = false) => ({ pubkey: pk(pubkey), isSigner, isWritable: true });
const r = (pubkey, isSigner = false) => ({ pubkey: pk(pubkey), isSigner, isWritable: false });

function ix(programId, keys, data) {
  return new TransactionInstruction({ programId, keys, data });
}

export function initMarketIx(
  { market, creator, collateralMint, vault, longMint, shortMint, settler, underlying, collateralTokenProgram },
  args,
  programId = PAIRS_PROGRAM_ID,
) {
  const [authority] = authorityAddress(market, programId);
  return ix(
    programId,
    [
      w(market),
      r(authority),
      r(creator, true),
      r(collateralMint),
      r(vault),
      r(longMint),
      r(shortMint),
      r(settler),
      r(underlying),
      r(collateralTokenProgram),
      r(TOKEN_PROGRAM_ID),
    ],
    encodeInitMarket(args),
  );
}

function pairKeys(a, programId) {
  const [authority] = authorityAddress(a.market, programId);
  return [
    r(a.market),
    r(authority),
    r(a.user, true),
    w(a.userCollateral),
    w(a.vault),
    w(a.longMint),
    w(a.shortMint),
    w(a.userLong),
    w(a.userShort),
    r(a.collateralMint),
    r(a.collateralTokenProgram),
    r(TOKEN_PROGRAM_ID),
  ];
}

export const mintPairsIx = (a, amount, programId = PAIRS_PROGRAM_ID) =>
  ix(programId, pairKeys(a, programId), encodeMintPairs(amount));
export const redeemPairsIx = (a, amount, programId = PAIRS_PROGRAM_ID) =>
  ix(programId, pairKeys(a, programId), encodeRedeemPairs(amount));

export function claimIx(a, longAmount, shortAmount, programId = PAIRS_PROGRAM_ID) {
  const [authority] = authorityAddress(a.market, programId);
  return ix(
    programId,
    [
      r(a.market),
      r(authority),
      r(a.user, true),
      w(a.userLong),
      w(a.userShort),
      w(a.longMint),
      w(a.shortMint),
      w(a.vault),
      w(a.userCollateral),
      r(a.collateralMint),
      r(a.collateralTokenProgram),
      r(TOKEN_PROGRAM_ID),
    ],
    encodeClaim(longAmount, shortAmount),
  );
}

export function tradeIx(a, size, longPricePpm, programId = PAIRS_PROGRAM_ID) {
  const [authority] = authorityAddress(a.market, programId);
  return ix(
    programId,
    [
      w(a.market),
      r(authority),
      r(a.longUser, true),
      r(a.shortUser, true),
      w(a.longUserCollateral),
      w(a.shortUserCollateral),
      w(a.vault),
      w(a.longMint),
      w(a.shortMint),
      w(a.longUserLong),
      w(a.shortUserShort),
      r(a.collateralMint),
      r(a.collateralTokenProgram),
      r(TOKEN_PROGRAM_ID),
      w(a.feeAccount),
    ],
    encodeTrade(size, longPricePpm),
  );
}

export function placeOfferIx(a, params, programId = PAIRS_PROGRAM_ID) {
  const [authority] = authorityAddress(a.market, programId);
  const [offer] = offerAddress(a.market, a.maker, params.nonce, programId);
  return ix(
    programId,
    [
      r(a.market),
      r(authority),
      w(a.maker, true),
      w(a.makerCollateral),
      w(a.vault),
      w(offer),
      r(a.collateralMint),
      r(a.collateralTokenProgram),
      r(SystemProgram.programId),
    ],
    encodePlaceOffer(params),
  );
}

export function fillOfferIx(a, size, programId = PAIRS_PROGRAM_ID) {
  const [authority] = authorityAddress(a.market, programId);
  return ix(
    programId,
    [
      w(a.market),
      r(authority),
      w(a.offer),
      w(a.maker),
      r(a.taker, true),
      w(a.takerCollateral),
      w(a.vault),
      w(a.longMint),
      w(a.shortMint),
      w(a.makerPosition),
      w(a.takerPosition),
      r(a.collateralMint),
      r(a.collateralTokenProgram),
      r(TOKEN_PROGRAM_ID),
      w(a.feeAccount),
    ],
    encodeFillOffer(size),
  );
}

export function cancelOfferIx(a, programId = PAIRS_PROGRAM_ID) {
  const [authority] = authorityAddress(a.market, programId);
  return ix(
    programId,
    [
      r(a.market),
      r(authority),
      w(a.offer),
      w(a.maker),
      r(a.signer, true),
      w(a.makerCollateral),
      w(a.vault),
      r(a.collateralMint),
      r(a.collateralTokenProgram),
    ],
    encodeCancelOffer(),
  );
}

function settlerKeys(market, settler, settlerSigns, markWhirlpool) {
  const keys = [w(market), r(settler, settlerSigns)];
  if (markWhirlpool) keys.push(r(markWhirlpool));
  return keys;
}

export const settleIx = ({ market, settler, settlerSigns, markWhirlpool }, price = 0n, programId = PAIRS_PROGRAM_ID) =>
  ix(programId, settlerKeys(market, settler, settlerSigns, markWhirlpool), encodeSettle(price));
export const crankIx = ({ market, settler, settlerSigns, markWhirlpool }, indexPrice = 0n, programId = PAIRS_PROGRAM_ID) =>
  ix(programId, settlerKeys(market, settler, settlerSigns, markWhirlpool), encodeCrank(indexPrice));
export const voidIx = (market, programId = PAIRS_PROGRAM_ID) => ix(programId, [w(market)], encodeVoid());
export const setMarkWhirlpoolIx = ({ market, creator, whirlpool }, programId = PAIRS_PROGRAM_ID) =>
  ix(programId, [w(market), r(creator, true), r(whirlpool)], encodeSetMarkWhirlpool());

// ---------------------------------------------------------------------------
// SPL helpers needed around the program (kept dependency-free)
// ---------------------------------------------------------------------------

/** SPL Token `InitializeMint2`. */
export function initializeMint2Ix(tokenProgram, mint, mintAuthority, decimals, freezeAuthority = null) {
  const data = Buffer.alloc(1 + 1 + 32 + 1 + (freezeAuthority ? 32 : 0));
  data[0] = 20;
  data[1] = decimals & 0xff;
  pk(mintAuthority).toBuffer().copy(data, 2);
  data[34] = freezeAuthority ? 1 : 0;
  if (freezeAuthority) pk(freezeAuthority).toBuffer().copy(data, 35);
  return new TransactionInstruction({ programId: pk(tokenProgram), keys: [w(mint)], data });
}

/** Associated Token Account program `CreateIdempotent`. */
export function createAtaIdempotentIx(payer, owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
  const ata = associatedTokenAddress(owner, mint, tokenProgram);
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [w(payer, true), w(ata), r(owner), r(mint), r(SystemProgram.programId), r(tokenProgram)],
    data: Buffer.from([1]),
  });
}

/**
 * Everything one transaction needs to create a market: system account
 * creation for the market and both position mints, mint initialisation with
 * the authority PDA, the vault ATA, and `InitMarket`. `rent` carries the
 * lamports for a `MARKET_LEN` and a `MINT_LEN` account (fetch them with
 * `connection.getMinimumBalanceForRentExemption`). Signers: payer, creator,
 * marketKeypair, longMintKeypair, shortMintKeypair.
 */
export function createMarketInstructions({
  payer,
  creator,
  marketKeypair,
  longMintKeypair,
  shortMintKeypair,
  collateralMint,
  collateralDecimals,
  collateralTokenProgram = TOKEN_PROGRAM_ID,
  settler,
  underlying,
  args,
  rent,
  programId = PAIRS_PROGRAM_ID,
}) {
  const market = marketKeypair.publicKey;
  const longMint = longMintKeypair.publicKey;
  const shortMint = shortMintKeypair.publicKey;
  const [authority] = authorityAddress(market, programId);
  const vault = associatedTokenAddress(authority, collateralMint, collateralTokenProgram);
  const instructions = [
    SystemProgram.createAccount({
      fromPubkey: pk(payer),
      newAccountPubkey: market,
      lamports: Number(rent.market),
      space: MARKET_LEN,
      programId,
    }),
    SystemProgram.createAccount({
      fromPubkey: pk(payer),
      newAccountPubkey: longMint,
      lamports: Number(rent.mint),
      space: MINT_LEN,
      programId: TOKEN_PROGRAM_ID,
    }),
    initializeMint2Ix(TOKEN_PROGRAM_ID, longMint, authority, collateralDecimals),
    SystemProgram.createAccount({
      fromPubkey: pk(payer),
      newAccountPubkey: shortMint,
      lamports: Number(rent.mint),
      space: MINT_LEN,
      programId: TOKEN_PROGRAM_ID,
    }),
    initializeMint2Ix(TOKEN_PROGRAM_ID, shortMint, authority, collateralDecimals),
    createAtaIdempotentIx(payer, authority, collateralMint, collateralTokenProgram),
    createAtaIdempotentIx(payer, creator, collateralMint, collateralTokenProgram),
    initMarketIx(
      { market, creator, collateralMint, vault, longMint, shortMint, settler, underlying, collateralTokenProgram },
      args,
      programId,
    ),
  ];
  return { instructions, market, authority, vault, longMint, shortMint };
}

/** Account bundle for mint / redeem / claim from a decoded market. */
export function userPairAccounts(marketKey, market, user) {
  const tp = market.collateralTokenProgram;
  return {
    market: pk(marketKey),
    user: pk(user),
    userCollateral: associatedTokenAddress(user, market.collateralMint, tp),
    vault: market.vault,
    longMint: market.longMint,
    shortMint: market.shortMint,
    userLong: associatedTokenAddress(user, market.longMint),
    userShort: associatedTokenAddress(user, market.shortMint),
    collateralMint: market.collateralMint,
    collateralTokenProgram: tp,
  };
}
