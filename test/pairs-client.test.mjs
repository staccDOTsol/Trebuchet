// test/pairs-client.test.mjs
//
// pairsClient.js is a byte-exact mirror of programs/pairs. The fixtures here
// are the same bytes asserted by the Rust unit test `cross_language_fixture`
// in programs/pairs/src/instruction.rs, so the two encoders cannot drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  MARKET_LEN,
  OFFER_LEN,
  PRICE_SCALE,
  PAIRS_PROGRAM_ID,
  SettleKind,
  Side,
  authorityAddress,
  offerAddress,
  decodeMarket,
  decodeOffer,
  encodeInitMarket,
  encodePlaceOffer,
  encodeTrade,
  encodeClaim,
  encodeCancelOffer,
  encodeVoid,
  longShare,
  shortShare,
  payout,
  intrinsicPpm,
  settlementPayoutPpm,
  makerShare,
  whirlpoolPrice,
  effectiveLeverage,
  nextEpochArgs,
  placeOfferIx,
  tradeIx,
  createMarketInstructions,
  hasMarkWhirlpool,
} from '../pairsClient.js';

const hex = (b) => Buffer.from(b).toString('hex');

test('instruction bytes match the Rust cross-language fixture', () => {
  assert.equal(
    hex(encodePlaceOffer({ side: Side.Short, longPricePpm: 250_000n, size: 1_000_000n, expirySlot: 0n, nonce: 7n })),
    '0401' + '90d0030000000000' + '40420f0000000000' + '0000000000000000' + '0700000000000000',
  );
  assert.equal(
    hex(
      encodeInitMarket({
        settleKind: SettleKind.Whirlpool,
        invert: false,
        priceDecimals: 9,
        floorPrice: 900n,
        capPrice: 1100n,
        tradeEndSlot: 1000n,
        settleEndSlot: 2000n,
        fundingRatePpm: 1_000_000n,
        fundingPeriodSlots: 9000n,
        maxFundingPerPeriodPpm: 100_000n,
        takerFeePpm: 1000n,
      }),
    ),
    '00010009' +
      '8403000000000000' +
      '4c04000000000000' +
      'e803000000000000' +
      'd007000000000000' +
      '40420f0000000000' +
      '2823000000000000' +
      'a086010000000000' +
      'e803000000000000',
  );
  assert.equal(hex(encodeTrade(11n, 12n)), '03' + '0b00000000000000' + '0c00000000000000');
  assert.equal(hex(encodeClaim(19n, 20n)), '09' + '1300000000000000' + '1400000000000000');
  assert.equal(hex(encodeCancelOffer()), '06');
  assert.equal(hex(encodeVoid()), '08');
  assert.throws(() => encodeTrade(-1n, 1n), RangeError);
  assert.throws(() => encodeTrade(1n << 64n, 1n), RangeError);
});

test('math mirrors the on-chain program', () => {
  assert.equal(longShare(1_000_000n, 250_000n), 250_000n);
  assert.equal(longShare(3n, 500_000n), 2n);
  assert.equal(shortShare(3n, 500_000n), 1n);
  assert.equal(longShare(1n, 999_999n), 1n);
  assert.equal(payout(1_000_001n, 333_333n), 333_333n);
  assert.equal(intrinsicPpm(50n, 100n, 200n), 0n);
  assert.equal(intrinsicPpm(150n, 100n, 200n), 500_000n);
  assert.equal(intrinsicPpm(999n, 100n, 200n), PRICE_SCALE);
  assert.equal(settlementPayoutPpm(600_000n, 100_000n), 500_000n);
  assert.equal(settlementPayoutPpm(600_000n, -500_000n), PRICE_SCALE);
  assert.equal(settlementPayoutPpm(50_000n, 100_000n), 0n);
  // Escrow is consumed exactly across partial fills.
  let escrow = 750n;
  let remaining = 1000n;
  for (const fill of [1n, 333n, 100n, 566n]) {
    const m = makerShare(escrow, remaining, fill);
    escrow -= m;
    remaining -= fill;
  }
  assert.equal(remaining, 0n);
  assert.equal(escrow, 0n);
  const one = 1n << 64n;
  assert.equal(whirlpoolPrice(one, 6), 1_000_000n);
  assert.equal(whirlpoolPrice(one << 1n, 6), 4_000_000n);
  assert.equal(whirlpoolPrice(one << 1n, 6, true), 250_000n);
  // ±10% range at a 50% entry price -> 10x.
  assert.equal(Math.round(effectiveLeverage(1_000_000n, 900_000n, 1_100_000n, 500_000n)), 10);
});

test('market and offer decoders read the documented offsets', () => {
  const buf = Buffer.alloc(MARKET_LEN);
  const keys = Array.from({ length: 9 }, () => Keypair.generate().publicKey);
  buf[0] = 1;
  buf[1] = 254;
  buf[2] = SettleKind.Whirlpool;
  buf[3] = 1;
  buf[4] = 9;
  buf[5] = 1;
  keys.slice(0, 8).forEach((k, i) => k.toBuffer().copy(buf, 8 + 32 * i));
  const u64s = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n];
  u64s.forEach((v, i) => buf.writeBigUInt64LE(v, 264 + 8 * i));
  buf.writeBigInt64LE(-11n, 344);
  buf.writeBigUInt64LE(12n, 352);
  buf.writeBigUInt64LE(0xffff_ffff_ffff_fff2n, 360); // vwap_num low
  buf.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 368); // vwap_num high
  buf.writeBigUInt64LE(14n, 376);
  buf.writeBigUInt64LE(15n, 384);
  buf.writeBigUInt64LE(16n, 392);
  keys[8].toBuffer().copy(buf, 400);
  buf[432] = 1;
  const m = decodeMarket(buf);
  assert.equal(m.bump, 254);
  assert.equal(m.settleKind, SettleKind.Whirlpool);
  assert.equal(m.invert, true);
  assert.equal(m.priceDecimals, 9);
  assert.equal(m.status, 1);
  assert.ok(m.creator.equals(keys[0]));
  assert.ok(m.underlying.equals(keys[7]));
  assert.equal(m.floorPrice, 1n);
  assert.equal(m.maxFundingPerPeriodPpm, 10n);
  assert.equal(m.fundingOffsetPpm, -11n);
  assert.equal(m.lastCrankSlot, 12n);
  assert.equal(m.vwapNum, (1n << 128n) - 14n);
  assert.equal(m.vwapDen, 14n);
  assert.equal(m.lastIndexPrice, 15n);
  assert.equal(m.takerFeePpm, 16n);
  assert.ok(m.markWhirlpool.equals(keys[8]));
  assert.equal(m.markInvert, true);
  assert.ok(hasMarkWhirlpool(m));
  assert.throws(() => decodeMarket(Buffer.alloc(MARKET_LEN)), /uninitialized/);

  const ob = Buffer.alloc(OFFER_LEN);
  ob[0] = 1;
  ob[1] = 3;
  ob[2] = Side.Short;
  keys[0].toBuffer().copy(ob, 8);
  keys[1].toBuffer().copy(ob, 40);
  [42n, 250_000n, 1000n, 750n, 99n].forEach((v, i) => ob.writeBigUInt64LE(v, 72 + 8 * i));
  const o = decodeOffer(ob);
  assert.equal(o.side, Side.Short);
  assert.ok(o.market.equals(keys[0]));
  assert.ok(o.maker.equals(keys[1]));
  assert.equal(o.nonce, 42n);
  assert.equal(o.longPricePpm, 250_000n);
  assert.equal(o.remaining, 1000n);
  assert.equal(o.escrowed, 750n);
  assert.equal(o.expirySlot, 99n);
});

test('PDAs and instruction account lists follow the program layout', () => {
  const market = Keypair.generate().publicKey;
  const maker = Keypair.generate().publicKey;
  const [authority, bump] = authorityAddress(market);
  assert.ok(authority instanceof PublicKey);
  assert.ok(bump <= 255);
  const [offer] = offerAddress(market, maker, 7n);
  const [again] = offerAddress(market, maker, 7n);
  assert.ok(offer.equals(again));
  assert.ok(!offer.equals(offerAddress(market, maker, 8n)[0]));

  const a = {
    market,
    maker,
    makerCollateral: Keypair.generate().publicKey,
    vault: Keypair.generate().publicKey,
    collateralMint: Keypair.generate().publicKey,
    collateralTokenProgram: Keypair.generate().publicKey,
  };
  const ix = placeOfferIx(a, { side: Side.Long, longPricePpm: 400_000n, size: 5n, nonce: 7n });
  assert.ok(ix.programId.equals(PAIRS_PROGRAM_ID));
  assert.equal(ix.keys.length, 9);
  assert.ok(ix.keys[1].pubkey.equals(authority));
  assert.ok(ix.keys[2].isSigner && ix.keys[2].isWritable);
  assert.ok(ix.keys[5].pubkey.equals(offer));
  assert.equal(ix.data[0], 4);

  const t = tradeIx(
    {
      market,
      longUser: maker,
      shortUser: Keypair.generate().publicKey,
      longUserCollateral: a.makerCollateral,
      shortUserCollateral: a.makerCollateral,
      vault: a.vault,
      longMint: a.collateralMint,
      shortMint: a.collateralMint,
      longUserLong: a.vault,
      shortUserShort: a.vault,
      collateralMint: a.collateralMint,
      collateralTokenProgram: a.collateralTokenProgram,
      feeAccount: a.vault,
    },
    10n,
    500_000n,
  );
  assert.equal(t.keys.length, 15);
  assert.ok(t.keys[2].isSigner && t.keys[3].isSigner);
  assert.ok(t.keys[0].isWritable);
});

test('createMarketInstructions wires accounts and signers', () => {
  const payer = Keypair.generate();
  const creator = Keypair.generate();
  const marketKeypair = Keypair.generate();
  const longMintKeypair = Keypair.generate();
  const shortMintKeypair = Keypair.generate();
  const { instructions, market, vault, authority } = createMarketInstructions({
    payer: payer.publicKey,
    creator: creator.publicKey,
    marketKeypair,
    longMintKeypair,
    shortMintKeypair,
    collateralMint: Keypair.generate().publicKey,
    collateralDecimals: 6,
    settler: creator.publicKey,
    underlying: Keypair.generate().publicKey,
    args: {
      settleKind: SettleKind.Authority,
      invert: false,
      priceDecimals: 6,
      floorPrice: 900_000n,
      capPrice: 1_100_000n,
      tradeEndSlot: 1000n,
      settleEndSlot: 2000n,
    },
    rent: { market: 4_000_000n, mint: 1_500_000n },
  });
  assert.equal(instructions.length, 8);
  assert.ok(market.equals(marketKeypair.publicKey));
  assert.ok(authority.equals(authorityAddress(market)[0]));
  const init = instructions[7];
  assert.ok(init.keys[4].pubkey.equals(vault));
  assert.ok(init.keys[5].pubkey.equals(longMintKeypair.publicKey));
  assert.equal(init.data[0], 0);
});

test('nextEpochArgs re-centres the range and shifts the schedule', () => {
  const m = decodeMarket(
    (() => {
      const b = Buffer.alloc(MARKET_LEN);
      b[0] = 1;
      b.writeBigUInt64LE(900_000n, 264);
      b.writeBigUInt64LE(1_100_000n, 272);
      b.writeBigUInt64LE(1000n, 280);
      b.writeBigUInt64LE(2000n, 288);
      b.writeBigUInt64LE(50n, 352); // last_crank_slot (creation)
      b.writeBigUInt64LE(777n, 320);
      return b;
    })(),
  );
  const next = nextEpochArgs(m, 1_200_000n);
  assert.equal(next.floorPrice, 1_100_000n);
  assert.equal(next.capPrice, 1_300_000n);
  assert.equal(next.tradeEndSlot, 2000n + 950n);
  assert.equal(next.settleEndSlot, 2000n + 950n + 1000n);
  assert.equal(next.fundingRatePpm, 777n);
  const explicit = nextEpochArgs(m, 10n, { epochSlots: 100, settleWindowSlots: 10, nowSlot: 5 });
  assert.equal(explicit.floorPrice, 0n);
  assert.equal(explicit.tradeEndSlot, 105n);
  assert.equal(explicit.settleEndSlot, 115n);
});
