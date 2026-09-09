// orcaClaimService.js
//
// Creator fee claims. Every FireFun position is permanently locked, but a
// locked Orca position still earns swap fees and its owner can collect them
// (lock_position freezes liquidity, not fees). The creator holds the position
// NFTs in their own wallet after transfer_locked_position, so the claim is
// signed in the browser: this module quotes what is owed and builds unsigned
// transactions (fee payer = creator) that the frontend hands to a
// wallet-standard wallet (Phantom, Solflare, Backpack…) and then sends back
// here for submission over the good RPC.
//
// Ladder launches have up to 1000 positions per pool; fees accrue only in the
// bands price has traded through, so the builder skips positions with nothing
// owed and packs as many collect instructions per transaction as fit.

import { PublicKey, Keypair, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import { Wallet } from '@coral-xyz/anchor';
import {
  WhirlpoolContext,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil,
  TickArrayUtil,
  WhirlpoolIx,
  TokenExtensionUtil,
  IGNORE_CACHE,
  collectFeesQuote,
} from '@orca-so/whirlpools-sdk';

import { classifyChainError } from './chainRetry.js';
import { LOCK_CONFIG_SIZE, decodeLockConfig } from './orcaLpPlan.js';
import {
  getOrcaConnection,
  getWhirlpoolProgramAccounts,
  discoverLaunches,
  describeQuote,
} from './orcaLpService.js';

const PROGRAM_ID = ORCA_WHIRLPOOL_PROGRAM_ID;
// Legacy transactions: the widest wallet support. Leave headroom under the
// 1232-byte packet limit for the wallet's signature.
export const MAX_TX_BYTES = 1200;
export const DEFAULT_MAX_TXS_PER_ROUND = 8;
const CLAIM_PRIORITY_MICROLAMPORTS = Number(process.env.ORCA_CLAIM_PRIORITY_MICROLAMPORTS || 20_000);
const CU_BASE = 60_000;
const CU_PER_POSITION = 80_000;

function toPk(v) { return v instanceof PublicKey ? v : new PublicKey(v); }

function readOnlyContext(connection) {
  // The wallet here is never used to sign; the fee payer of every built
  // transaction is the creator's wallet.
  return WhirlpoolContext.from(connection, new Wallet(Keypair.generate()));
}

function ui(raw, decimals) {
  if (raw == null) return null;
  const n = typeof raw === 'bigint' ? raw : BigInt(raw.toString());
  if (!Number.isInteger(decimals)) return Number(n);
  return Number(n) / 10 ** decimals;
}

function assertOwner(owner) {
  let pk;
  try { pk = new PublicKey(owner); } catch (_) { throw Object.assign(new Error('owner must be a base58 wallet address'), { status: 400 }); }
  if (!PublicKey.isOnCurve(pk.toBytes())) throw Object.assign(new Error('owner must be a wallet address, not a program account'), { status: 400 });
  return pk;
}

/** Every LockConfig whose position_owner is `owner` (any pool). */
export async function listOwnedLocks(owner) {
  const connection = getOrcaConnection();
  const rows = await getWhirlpoolProgramAccounts(connection, [
    { dataSize: LOCK_CONFIG_SIZE },
    { memcmp: { offset: 40, bytes: toPk(owner).toBase58() } },
  ]);
  return rows.map((r) => ({ address: r.pubkey.toBase58(), ...decodeLockConfig(r.account.data) }));
}

/**
 * Pending fees for every locked position `owner` holds on FireFun launches.
 * Optional `mint` narrows to one launch, `poolIds` to specific pools.
 */
export async function getClaimable({ owner, mint = null, poolIds = null }) {
  const ownerPk = assertOwner(owner);
  const connection = getOrcaConnection();
  const ctx = readOnlyContext(connection);
  const feed = await discoverLaunches({ sinceUnix: 0 });
  const poolIndex = new Map();
  for (const launch of feed.launches) {
    for (const pool of launch.pools) poolIndex.set(pool.poolId, { launch, pool });
  }
  const wanted = poolIds ? new Set(poolIds) : null;

  const locks = (await listOwnedLocks(ownerPk)).filter((l) => {
    const hit = poolIndex.get(l.whirlpool);
    if (!hit) return false;
    if (mint && hit.launch.tokenMint !== mint) return false;
    if (wanted && !wanted.has(l.whirlpool)) return false;
    return true;
  });

  const byPool = new Map();
  for (const l of locks) {
    if (!byPool.has(l.whirlpool)) byPool.set(l.whirlpool, []);
    byPool.get(l.whirlpool).push(l);
  }

  const quoteInfo = new Map();
  async function quoteMeta(m) {
    if (!quoteInfo.has(m)) quoteInfo.set(m, await describeQuote(m));
    return quoteInfo.get(m);
  }

  const launches = new Map();
  for (const [poolId, poolLocks] of byPool.entries()) {
    const { launch, pool } = poolIndex.get(poolId);
    const poolPk = new PublicKey(poolId);
    const poolData = await ctx.fetcher.getPool(poolPk, IGNORE_CACHE);
    if (!poolData) continue;
    const tokenIsA = poolData.tokenMintA.toBase58() === launch.tokenMint;
    const qMeta = await quoteMeta(pool.quoteMint);
    const decA = tokenIsA ? launch.decimals : qMeta.decimals;
    const decB = tokenIsA ? qMeta.decimals : launch.decimals;

    const positionPks = poolLocks.map((l) => new PublicKey(l.position));
    const positions = await ctx.fetcher.getPositions(positionPks, IGNORE_CACHE);
    const ts = poolData.tickSpacing;
    const tickArrayAddrs = new Map();
    for (const l of poolLocks) {
      const pos = positions.get(l.position);
      if (!pos) continue;
      for (const t of [pos.tickLowerIndex, pos.tickUpperIndex]) {
        const pda = PDAUtil.getTickArrayFromTickIndex(t, ts, poolPk, PROGRAM_ID);
        tickArrayAddrs.set(pda.publicKey.toBase58(), pda.publicKey);
      }
    }
    const tickArrayKeys = [...tickArrayAddrs.keys()];
    const tickArrayList = await ctx.fetcher.getTickArrays(tickArrayKeys.map((k) => tickArrayAddrs.get(k)), IGNORE_CACHE);
    const tickArrays = new Map(tickArrayKeys.map((k, i) => [k, tickArrayList[i]]));
    const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
      ctx.fetcher, poolData.tokenMintA, poolData.tokenMintB, IGNORE_CACHE,
    );

    const rows = [];
    let feeA = 0n;
    let feeB = 0n;
    for (const l of poolLocks) {
      const pos = positions.get(l.position);
      if (!pos) continue;
      const lowerPda = PDAUtil.getTickArrayFromTickIndex(pos.tickLowerIndex, ts, poolPk, PROGRAM_ID).publicKey.toBase58();
      const upperPda = PDAUtil.getTickArrayFromTickIndex(pos.tickUpperIndex, ts, poolPk, PROGRAM_ID).publicKey.toBase58();
      const lowerArr = tickArrays.get(lowerPda);
      const upperArr = tickArrays.get(upperPda);
      if (!lowerArr || !upperArr) continue;
      const q = collectFeesQuote({
        whirlpool: poolData,
        position: pos,
        tickLower: TickArrayUtil.getTickFromArray(lowerArr, pos.tickLowerIndex, ts),
        tickUpper: TickArrayUtil.getTickFromArray(upperArr, pos.tickUpperIndex, ts),
        tokenExtensionCtx,
      });
      const a = BigInt(q.feeOwedA.toString());
      const b = BigInt(q.feeOwedB.toString());
      feeA += a;
      feeB += b;
      rows.push({
        position: l.position,
        positionMint: pos.positionMint.toBase58(),
        lockConfig: l.address,
        tickLowerIndex: pos.tickLowerIndex,
        tickUpperIndex: pos.tickUpperIndex,
        tickArrayLower: lowerPda,
        tickArrayUpper: upperPda,
        liquidity: pos.liquidity.toString(),
        feeOwedARaw: a.toString(),
        feeOwedBRaw: b.toString(),
        claimable: a > 0n || b > 0n,
      });
    }
    rows.sort((x, y) => x.tickLowerIndex - y.tickLowerIndex);

    const feeToken = tokenIsA ? feeA : feeB;
    const feeQuote = tokenIsA ? feeB : feeA;
    const feeTokenUi = ui(feeToken, launch.decimals);
    const feeQuoteUi = ui(feeQuote, qMeta.decimals);
    const usd = (launch.priceUsd ? feeTokenUi * launch.priceUsd : 0) + (qMeta.priceUsd ? feeQuoteUi * qMeta.priceUsd : 0);

    if (!launches.has(launch.tokenMint)) {
      launches.set(launch.tokenMint, {
        tokenMint: launch.tokenMint,
        symbol: launch.symbol,
        name: launch.name,
        imageUrl: launch.imageUrl,
        decimals: launch.decimals,
        priceUsd: launch.priceUsd,
        url: launch.url,
        pools: [],
        totals: { usd: 0, feeTokenUi: 0, positions: 0, claimablePositions: 0 },
      });
    }
    const L = launches.get(launch.tokenMint);
    L.pools.push({
      poolId,
      quoteMint: pool.quoteMint,
      quoteSymbol: qMeta.symbol || pool.quoteSymbol,
      quoteDecimals: qMeta.decimals,
      quotePriceUsd: qMeta.priceUsd || null,
      tokenIsA,
      tickSpacing: ts,
      tickCurrentIndex: poolData.tickCurrentIndex,
      mintA: poolData.tokenMintA.toBase58(),
      mintB: poolData.tokenMintB.toBase58(),
      vaultA: poolData.tokenVaultA.toBase58(),
      vaultB: poolData.tokenVaultB.toBase58(),
      decA,
      decB,
      positions: rows,
      claimablePositions: rows.filter((r) => r.claimable).length,
      feeTokenRaw: feeToken.toString(),
      feeQuoteRaw: feeQuote.toString(),
      feeTokenUi,
      feeQuoteUi,
      usd,
      orcaUrl: pool.orcaUrl,
    });
    L.totals.usd += usd;
    L.totals.feeTokenUi += feeTokenUi;
    L.totals.positions += rows.length;
    L.totals.claimablePositions += rows.filter((r) => r.claimable).length;
  }

  const out = [...launches.values()];
  for (const L of out) L.pools.sort((a, b) => b.usd - a.usd);
  out.sort((a, b) => b.totals.usd - a.totals.usd);
  return {
    owner: ownerPk.toBase58(),
    launches: out,
    totals: {
      usd: out.reduce((s, l) => s + l.totals.usd, 0),
      positions: out.reduce((s, l) => s + l.totals.positions, 0),
      claimablePositions: out.reduce((s, l) => s + l.totals.claimablePositions, 0),
    },
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

// web3.js throws instead of returning an oversized serialization.
function txSize(tx) {
  try { return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length; }
  catch (err) { if (/too large/i.test(String(err?.message))) return Infinity; throw err; }
}

/**
 * Pure packer: given per-position instruction groups (each an array of
 * TransactionInstructions), fill legacy transactions up to MAX_TX_BYTES.
 * `prelude`/`epilogue` wrap every transaction (ATA creation, wSOL close).
 * Returns { txs: [{ tx, groups }], remaining } where remaining are the
 * groups that did not fit in `maxTxs` transactions.
 */
export function packClaimTransactions({ feePayer, recentBlockhash, prelude = [], epilogue = [], groups, maxTxs = DEFAULT_MAX_TXS_PER_ROUND, maxBytes = MAX_TX_BYTES, computeUnits = null }) {
  const txs = [];
  let i = 0;
  while (i < groups.length && txs.length < maxTxs) {
    let taken = [];
    let built = null;
    for (let j = i; j < groups.length; j++) {
      const candidate = [...taken, groups[j]];
      const tx = new Transaction({ feePayer, recentBlockhash });
      const cu = computeUnits ? computeUnits(candidate.length) : Math.min(1_400_000, CU_BASE + CU_PER_POSITION * candidate.length);
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CLAIM_PRIORITY_MICROLAMPORTS }),
        ...prelude,
        ...candidate.flat(),
        ...epilogue,
      );
      const size = txSize(tx);
      if (size > maxBytes) {
        if (taken.length === 0) throw new Error(`a single claim does not fit in one transaction (${size} bytes)`);
        break;
      }
      taken = candidate;
      built = tx;
    }
    txs.push({ tx: built, groups: taken });
    i += taken.length;
  }
  return { txs, remaining: groups.slice(i) };
}

/**
 * Build unsigned claim transactions for `owner`. Returns base64 legacy
 * transactions plus what each one collects, and how many claimable
 * positions were left for the next round (the frontend loops).
 */
export async function buildClaimTransactions({ owner, mint = null, poolIds = null, maxTxs = DEFAULT_MAX_TXS_PER_ROUND }) {
  const ownerPk = assertOwner(owner);
  const connection = getOrcaConnection();
  const ctx = readOnlyContext(connection);
  const program = ctx.program;
  const claimable = await getClaimable({ owner: ownerPk.toBase58(), mint, poolIds });

  const plan = [];
  let remaining = 0;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  for (const L of claimable.launches) {
    for (const pool of L.pools) {
      const todo = pool.positions.filter((p) => p.claimable);
      if (todo.length === 0) continue;
      if (plan.length >= maxTxs) { remaining += todo.length; continue; }

      const poolPk = new PublicKey(pool.poolId);
      const mintA = new PublicKey(pool.mintA);
      const mintB = new PublicKey(pool.mintB);
      const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(ctx.fetcher, mintA, mintB, IGNORE_CACHE);
      const programA = tokenExtensionCtx.tokenMintWithProgramA.tokenProgram;
      const programB = tokenExtensionCtx.tokenMintWithProgramB.tokenProgram;
      const ataA = getAssociatedTokenAddressSync(mintA, ownerPk, false, programA);
      const ataB = getAssociatedTokenAddressSync(mintB, ownerPk, false, programB);
      const [infoA, infoB] = await connection.getMultipleAccountsInfo([ataA, ataB]);

      const prelude = [];
      const epilogue = [];
      if (!infoA) prelude.push(createAssociatedTokenAccountIdempotentInstruction(ownerPk, ataA, ownerPk, mintA, programA));
      if (!infoB) prelude.push(createAssociatedTokenAccountIdempotentInstruction(ownerPk, ataB, ownerPk, mintB, programB));
      // Fees paid in SOL arrive as wSOL; unwrap unless the wallet already
      // keeps a wSOL account (then it is their balance to manage).
      if (mintA.equals(NATIVE_MINT) && !infoA) epilogue.push(createCloseAccountInstruction(ataA, ownerPk, ownerPk, [], TOKEN_PROGRAM_ID));
      if (mintB.equals(NATIVE_MINT) && !infoB) epilogue.push(createCloseAccountInstruction(ataB, ownerPk, ownerPk, [], TOKEN_PROGRAM_ID));

      const hooks = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(
        connection, tokenExtensionCtx,
        new PublicKey(pool.vaultA), ataA, poolPk,
        new PublicKey(pool.vaultB), ataB, poolPk,
      );

      const groups = todo.map((p) => {
        const positionPk = new PublicKey(p.position);
        const positionMint = new PublicKey(p.positionMint);
        const positionTokenAccount = getAssociatedTokenAddressSync(positionMint, ownerPk, false, TOKEN_2022_PROGRAM_ID);
        const update = WhirlpoolIx.updateFeesAndRewardsIx(program, {
          whirlpool: poolPk,
          position: positionPk,
          tickArrayLower: new PublicKey(p.tickArrayLower),
          tickArrayUpper: new PublicKey(p.tickArrayUpper),
        });
        const collect = WhirlpoolIx.collectFeesV2Ix(program, {
          whirlpool: poolPk,
          position: positionPk,
          positionTokenAccount,
          positionAuthority: ownerPk,
          tokenMintA: mintA,
          tokenMintB: mintB,
          tokenOwnerAccountA: ataA,
          tokenOwnerAccountB: ataB,
          tokenVaultA: new PublicKey(pool.vaultA),
          tokenVaultB: new PublicKey(pool.vaultB),
          tokenTransferHookAccountsA: hooks.tokenTransferHookAccountsA,
          tokenTransferHookAccountsB: hooks.tokenTransferHookAccountsB,
          tokenProgramA: programA,
          tokenProgramB: programB,
        });
        const ixs = [...update.instructions, ...update.cleanupInstructions, ...collect.instructions, ...collect.cleanupInstructions];
        return Object.assign(ixs, { meta: p });
      });

      const packed = packClaimTransactions({
        feePayer: ownerPk,
        recentBlockhash: blockhash,
        prelude,
        epilogue,
        groups,
        maxTxs: maxTxs - plan.length,
      });
      remaining += packed.remaining.length;
      for (const { tx, groups: g } of packed.txs) {
        const feeToken = g.reduce((s, x) => s + BigInt(pool.tokenIsA ? x.meta.feeOwedARaw : x.meta.feeOwedBRaw), 0n);
        const feeQuote = g.reduce((s, x) => s + BigInt(pool.tokenIsA ? x.meta.feeOwedBRaw : x.meta.feeOwedARaw), 0n);
        plan.push({
          tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
          tokenMint: L.tokenMint,
          symbol: L.symbol,
          poolId: pool.poolId,
          quoteSymbol: pool.quoteSymbol,
          positions: g.length,
          positionAddresses: g.map((x) => x.meta.position),
          feeTokenUi: ui(feeToken, L.decimals),
          feeQuoteUi: ui(feeQuote, pool.quoteDecimals),
        });
      }
    }
  }

  return {
    owner: ownerPk.toBase58(),
    blockhash,
    lastValidBlockHeight,
    txs: plan,
    remainingPositions: remaining,
    totals: claimable.totals,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Submit wallet-signed claim transactions and wait for confirmation.
 * Each entry reports its signature and outcome; an expired blockhash asks
 * the frontend to rebuild (the fees are still there).
 */
export async function sendSignedClaims({ signedTxs, lastValidBlockHeight = null }) {
  if (!Array.isArray(signedTxs) || signedTxs.length === 0) throw Object.assign(new Error('signedTxs required'), { status: 400 });
  if (signedTxs.length > 32) throw Object.assign(new Error('too many transactions in one call'), { status: 400 });
  const connection = getOrcaConnection();
  const results = [];
  for (const b64 of signedTxs) {
    const raw = Buffer.from(String(b64), 'base64');
    let tx;
    try { tx = Transaction.from(raw); } catch (_) { results.push({ ok: false, error: 'malformed transaction' }); continue; }
    if (!tx.signatures.some((s) => s.signature)) { results.push({ ok: false, error: 'transaction is not signed' }); continue; }
    if (!tx.instructions.some((ix) => ix.programId.equals(PROGRAM_ID))) { results.push({ ok: false, error: 'not a Whirlpool transaction' }); continue; }
    const row = { ok: false, signature: null, error: null, expired: false };
    try {
      let sig = null;
      // Preflight stays on: a claim that fails simulation is a real error
      // (wrong owner, bad signature), never something to force through.
      for (let attempt = 1; attempt <= 4 && !sig; attempt++) {
        try {
          sig = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' });
        } catch (err) {
          if (/blockhash not found|block height exceeded|expired/i.test(err.message)) { row.expired = true; throw err; }
          if (/signature verification|invalid signature|custom program error|instruction error/i.test(err.message)) throw err;
          if (attempt === 4 || classifyChainError(err) !== 'transient') throw err;
          await sleep(1500 * attempt);
        }
      }
      row.signature = sig;
      const deadline = Date.now() + 75_000;
      while (Date.now() < deadline) {
        const st = await connection.getSignatureStatuses([sig]);
        const v = st.value[0];
        if (v?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(v.err)}`);
        if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) { row.ok = true; break; }
        if (lastValidBlockHeight) {
          const h = await connection.getBlockHeight('confirmed');
          if (h > lastValidBlockHeight + 10) { row.expired = true; throw new Error('blockhash expired before the transaction landed'); }
        }
        await sleep(2000);
      }
      if (!row.ok) throw new Error('confirmation timed out; check the signature on Solscan');
    } catch (err) {
      row.error = err.message;
    }
    results.push(row);
  }
  return { results, landed: results.filter((r) => r.ok).length };
}
