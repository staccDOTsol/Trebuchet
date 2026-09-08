// orcaLpService.js
//
// Orca Whirlpools launch path. One Whirlpool per chosen quote token on the
// operator's own WhirlpoolsConfig, one single-sided position per pool
// holding that quote's share of the supply, every position permanently
// locked with the program's native lock_position instruction, and the
// locked positions handed to the launcher's wallet at the end with
// transfer_locked_position.
//
// Compared with the Raydium CLMM path in lpService.js this is deliberately
// cheap: Orca dynamic tick arrays only pay rent for the ticks actually
// used, the fee tier is fixed on the config (no per-pool dynamic fee
// machinery), and the lock is a 241-byte account instead of a Fee Key NFT
// dance. A whole pool + position + lock lands in three transactions.
//
// Everything network-touching lives here; the pure planning/decoding logic
// is in orcaLpPlan.js so it can be unit-tested.

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import { Wallet } from '@coral-xyz/anchor';
import { Percentage, TransactionBuilder } from '@orca-so/common-sdk';
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil,
  PoolUtil,
  PriceMath,
  TickUtil,
  WhirlpoolIx,
  TokenExtensionUtil,
  IGNORE_CACHE,
  increaseLiquidityQuoteByInputTokenWithParams,
} from '@orca-so/whirlpools-sdk';
import BN from 'bn.js';
import Decimal from 'decimal.js';

import { getRpcUrl } from './rpcConfig.js';
import { landTxWithRetry } from './chainRetry.js';
import { getTokenInfo, getUsdPrice } from './tokenInfoService.js';
import { sweepAllTokensToDestination, sweepSolToDestination } from './walletHelpers.js';
import {
  ORCA_CONFIG_AUTHORITY,
  DEFAULT_WHIRLPOOLS_CONFIG,
  FALLBACK_ORCA_FEE_TIERS,
  FORCED_QUOTES,
  OPTIONAL_QUOTES,
  KNOWN_QUOTE_MINTS,
  DISCOVERY_SINCE_UNIX,
  WHIRLPOOLS_CONFIG_SIZE,
  FEE_TIER_SIZE,
  WHIRLPOOL_SIZE,
  LOCK_CONFIG_SIZE,
  decodeWhirlpoolsConfig,
  decodeFeeTier,
  decodeWhirlpool,
  decodeLockConfig,
  decodePosition,
  normalizeOrcaFeeTiers,
  normalizeOrcaQuotes,
  singleSidedTickRange,
  sqrtPriceX64ToPrice,
  classifyPoolSides,
  estimateOrcaLaunchSol,
  ORCA_MAX_PROTOCOL_FEE_RATE,
} from './orcaLpPlan.js';

Decimal.set({ precision: 60, toExpNeg: -40, toExpPos: 40 });

const PROGRAM_ID = ORCA_WHIRLPOOL_PROGRAM_ID;

// Priority fee per transaction. 20k lamports is ~$0.002 at $100 SOL and
// lands promptly outside of congestion spikes. The compute limit is set
// generously; unused CUs are not charged.
const PRIORITY_FEE_LAMPORTS = Number(process.env.ORCA_PRIORITY_FEE_LAMPORTS || 20_000);
const COMPUTE_UNIT_LIMIT = 600_000;

// Deposit slippage. Fresh pools have no one else in them, so 1% is only
// there to absorb rounding between the quote and the on-chain math.
const DEPOSIT_SLIPPAGE = Percentage.fromFraction(1, 100);

// ---------------------------------------------------------------------------
// Connection / context
// ---------------------------------------------------------------------------

let __connectionFactoryOverride = null;
export function setConnectionFactoryForTests(fn) { __connectionFactoryOverride = fn; }
export function resetTestFactories() { __connectionFactoryOverride = null; }

function makeConnection() {
  if (__connectionFactoryOverride) return __connectionFactoryOverride();
  return new Connection(getRpcUrl(), {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });
}

function makeContext(ownerKeypair, connection = makeConnection()) {
  return WhirlpoolContext.from(connection, new Wallet(ownerKeypair), undefined, undefined, {
    userDefaultBuildOptions: {
      computeBudgetOption: {
        type: 'fixed',
        priorityFeeLamports: PRIORITY_FEE_LAMPORTS,
        computeBudgetLimit: COMPUTE_UNIT_LIMIT,
      },
    },
    userDefaultConfirmCommitment: 'confirmed',
  });
}

function toPk(v) {
  return v instanceof PublicKey ? v : new PublicKey(v);
}

function programFor(mintInfo) {
  return mintInfo.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

// ---------------------------------------------------------------------------
// Small TTL cache for read-mostly chain data
// ---------------------------------------------------------------------------

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = fn().catch((err) => {
    // Never cache a failure.
    cache.delete(key);
    throw err;
  });
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}
export function clearOrcaCaches() { cache.clear(); }

// ---------------------------------------------------------------------------
// Configs + fee tiers
// ---------------------------------------------------------------------------

async function programAccounts(connection, filters, dataSlice) {
  const cfg = { commitment: 'confirmed', filters };
  if (dataSlice) cfg.dataSlice = dataSlice;
  return connection.getProgramAccounts(PROGRAM_ID, cfg);
}

/** Every WhirlpoolsConfig whose fee authority is `authority`, with pool counts. */
export async function listWhirlpoolsConfigs(authority = ORCA_CONFIG_AUTHORITY) {
  return cached(`configs:${authority}`, 10 * 60_000, async () => {
    const connection = makeConnection();
    const rows = await programAccounts(connection, [
      { dataSize: WHIRLPOOLS_CONFIG_SIZE },
      { memcmp: { offset: 8, bytes: authority } },
    ]);
    const configs = rows.map((r) => ({
      address: r.pubkey.toBase58(),
      ...decodeWhirlpoolsConfig(r.account.data),
    }));
    return configs;
  });
}

/** Fee tiers on a config, live from chain with a snapshot fallback. */
export async function getFeeTiers(whirlpoolsConfig = DEFAULT_WHIRLPOOLS_CONFIG) {
  return cached(`tiers:${whirlpoolsConfig}`, 5 * 60_000, async () => {
    const connection = makeConnection();
    try {
      const rows = await programAccounts(connection, [
        { dataSize: FEE_TIER_SIZE },
        { memcmp: { offset: 8, bytes: whirlpoolsConfig } },
      ]);
      const tiers = rows.map((r) => ({
        address: r.pubkey.toBase58(),
        ...decodeFeeTier(r.account.data),
      }));
      if (tiers.length > 0) return { source: 'chain', tiers: normalizeOrcaFeeTiers(tiers) };
      if (whirlpoolsConfig !== DEFAULT_WHIRLPOOLS_CONFIG) return { source: 'chain', tiers: [] };
    } catch (err) {
      console.warn(`orca: fee tier fetch failed for ${whirlpoolsConfig}: ${err.message}`);
      if (whirlpoolsConfig !== DEFAULT_WHIRLPOOLS_CONFIG) throw err;
    }
    return { source: 'fallback', tiers: normalizeOrcaFeeTiers(FALLBACK_ORCA_FEE_TIERS) };
  });
}

/** Config summary (fee authority, protocol fee) for one config address. */
export async function getConfigInfo(whirlpoolsConfig = DEFAULT_WHIRLPOOLS_CONFIG) {
  return cached(`config:${whirlpoolsConfig}`, 10 * 60_000, async () => {
    const connection = makeConnection();
    const info = await connection.getAccountInfo(new PublicKey(whirlpoolsConfig));
    if (!info) throw new Error(`WhirlpoolsConfig ${whirlpoolsConfig} not found`);
    if (!info.owner.equals(PROGRAM_ID)) throw new Error(`${whirlpoolsConfig} is not a WhirlpoolsConfig`);
    return { address: whirlpoolsConfig, ...decodeWhirlpoolsConfig(info.data) };
  });
}

// ---------------------------------------------------------------------------
// Quote token descriptions (symbol, decimals, program, USD price)
// ---------------------------------------------------------------------------

export async function describeQuote(mint) {
  const known = [...FORCED_QUOTES, ...OPTIONAL_QUOTES].find((q) => q.mint === mint) || null;
  let info = null;
  try { info = await getTokenInfo(mint); } catch (err) {
    console.warn(`orca: token info failed for ${mint}: ${err.message}`);
  }
  const priceUsd = Number.isFinite(Number(info?.priceUsd)) && Number(info.priceUsd) > 0
    ? Number(info.priceUsd)
    : null;
  return {
    mint,
    symbol: known?.symbol || info?.symbol || mint.slice(0, 4),
    name: known?.name || info?.name || null,
    decimals: Number.isInteger(info?.decimals) ? info.decimals : (known?.decimals ?? null),
    programId: info?.programId || known?.programId || null,
    imageUrl: info?.imageUrl || null,
    priceUsd,
    forced: !!known?.forced,
    minSupplyPercent: known?.minSupplyPercent || 0,
    transferFeeBps: known?.transferFeeBps || 0,
  };
}

export async function describeAllQuotes() {
  const all = [...FORCED_QUOTES, ...OPTIONAL_QUOTES];
  const described = await Promise.all(all.map((q) => describeQuote(q.mint)));
  return {
    forced: described.filter((q) => q.forced),
    optional: described.filter((q) => !q.forced),
  };
}

// ---------------------------------------------------------------------------
// Tx helpers
// ---------------------------------------------------------------------------

async function execute(ctx, builder, { label, alreadyDone = null, onRetry = null }) {
  const res = await landTxWithRetry({
    label,
    alreadyDone,
    onRetry,
    maxAttempts: 3,
    settleMs: 2000,
    send: () => builder.buildAndExecute(undefined, { skipPreflight: false }, 'confirmed'),
  });
  return res.skipped ? null : res.value;
}

async function accountExists(connection, pubkey) {
  const info = await connection.getAccountInfo(pubkey, 'confirmed');
  return !!info;
}

async function tokenBalanceRaw(connection, ata, programId) {
  try {
    const acct = await getAccount(connection, ata, 'confirmed', programId);
    return acct.amount;
  } catch (_) {
    return 0n;
  }
}

function bnFromBigInt(v) {
  return new BN(v.toString());
}

// ---------------------------------------------------------------------------
// The launch
// ---------------------------------------------------------------------------

/**
 * Create + seed + lock one Whirlpool per quote.
 *
 *   tempWalletSecretKey   64-byte array; the launch wallet (funder + owner)
 *   tokenMint             the launched token (already minted to this wallet)
 *   tokenDecimals         its decimals
 *   tokenTotalSupply      whole-token supply (used for price = mcap / supply)
 *   targetMarketCapUsd    the market cap to start at. Any number works: the
 *                         pool's initial sqrt price is derived from it, and
 *                         single-sided positions never need quote tokens.
 *   quotes                [{ mint, supplyPercent }] — forced quotes are
 *                         merged in by normalizeOrcaQuotes
 *   whirlpoolsConfig      WhirlpoolsConfig to create pools on
 *   tickSpacing           fee tier (tick spacing is the fee-tier index)
 *   priorResults          results from an earlier failed attempt; pools /
 *                         positions / locks already on chain are reused
 *   onProgress            ({ stage, quoteIndex, ... }) callback
 *
 * Returns { results: [...], config, tickSpacing, feeRate }.
 */
export async function createOrcaPoolsAndLock({
  tempWalletSecretKey,
  tokenMint,
  tokenDecimals = 9,
  tokenTotalSupply,
  targetMarketCapUsd,
  quotes,
  whirlpoolsConfig = DEFAULT_WHIRLPOOLS_CONFIG,
  tickSpacing,
  priorResults = [],
  onProgress = () => {},
}) {
  const progress = (event) => { try { onProgress(event); } catch (_) { /* best-effort */ } };
  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const owner = ownerKeypair.publicKey;
  const connection = makeConnection();
  const ctx = makeContext(ownerKeypair, connection);
  const client = buildWhirlpoolClient(ctx);
  const program = ctx.program;

  const supply = new Decimal(String(tokenTotalSupply));
  const mcap = new Decimal(String(targetMarketCapUsd));
  if (!supply.isFinite() || supply.lte(0)) failPreflight('tokenTotalSupply must be > 0');
  if (!mcap.isFinite() || mcap.lte(0)) failPreflight('targetMarketCapUsd must be > 0');
  const tokenUsd = mcap.div(supply);

  const plan = (() => {
    try { return normalizeOrcaQuotes(quotes); } catch (err) { failPreflight(err.message); }
  })();

  // The config must take the maximum protocol fee Orca allows (25% of swap
  // fees). New pools copy the config's default at creation time.
  const configInfo = await getConfigInfo(whirlpoolsConfig);
  if (configInfo.defaultProtocolFeeRate !== ORCA_MAX_PROTOCOL_FEE_RATE) {
    failPreflight(
      `config ${whirlpoolsConfig} has default protocol fee ${configInfo.defaultProtocolFeeRate / 100}% ` +
        `(need ${ORCA_MAX_PROTOCOL_FEE_RATE / 100}%). Set it with set_default_protocol_fee_rate from the fee authority first.`,
    );
  }

  // Fee tier: must exist on the config and must allow concentrated ranges.
  const { tiers } = await getFeeTiers(whirlpoolsConfig);
  const tier = tiers.find((t) => t.tickSpacing === Number(tickSpacing));
  if (!tier) failPreflight(`fee tier with tick spacing ${tickSpacing} does not exist on config ${whirlpoolsConfig}`);
  if (!tier.usable) failPreflight(`fee tier ${tier.feePercent}% (tick spacing ${tickSpacing}) cannot host single-sided positions`);
  const ts = tier.tickSpacing;
  const configPk = new PublicKey(whirlpoolsConfig);
  const tokenMintPk = new PublicKey(tokenMint);

  // Resolve every quote's mint + price up front so a bad quote fails before
  // anything touches the chain.
  const mintInfos = await ctx.fetcher.getMintInfos(
    [tokenMintPk, ...plan.quotes.map((q) => new PublicKey(q.mint))],
    IGNORE_CACHE,
  );
  const tokenMintInfo = mintInfos.get(tokenMintPk.toBase58());
  if (!tokenMintInfo) failPreflight(`token mint ${tokenMint} not found on chain`);
  const tokenProgram = programFor(tokenMintInfo);
  const tokenAta = getAssociatedTokenAddressSync(tokenMintPk, owner, false, tokenProgram);

  const quoteMeta = [];
  for (const q of plan.quotes) {
    const info = mintInfos.get(q.mint);
    if (!info) failPreflight(`quote mint ${q.mint} not found on chain`);
    const described = await describeQuote(q.mint);
    const priceUsd = Number.isFinite(Number(q.priceUsd)) && Number(q.priceUsd) > 0
      ? Number(q.priceUsd)
      : described.priceUsd;
    if (!priceUsd) {
      failPreflight(`no USD price available for quote ${described.symbol} (${q.mint}); cannot derive a launch price`);
    }
    quoteMeta.push({ ...q, ...described, priceUsd, decimals: info.decimals, program: programFor(info), mintInfo: info });
  }

  progress({ stage: 'orca_plan', quotes: quoteMeta.map((q) => ({ mint: q.mint, symbol: q.symbol, supplyPercent: q.supplyPercent })), tickSpacing: ts, feeRate: tier.feeRate });

  const results = [];
  let wsolAtaTouched = false;

  for (let i = 0; i < quoteMeta.length; i++) {
    const q = quoteMeta[i];
    const prior = (priorResults || []).find((r) => r && r.quoteMint === q.mint) || null;
    const quotePk = new PublicKey(q.mint);
    const [mintAAddr, mintBAddr] = PoolUtil.orderMints(tokenMintPk, quotePk);
    const mintA = toPk(mintAAddr);
    const mintB = toPk(mintBAddr);
    const tokenIsA = mintA.equals(tokenMintPk);
    const decA = tokenIsA ? tokenMintInfo.decimals : q.decimals;
    const decB = tokenIsA ? q.decimals : tokenMintInfo.decimals;

    // Whirlpool price is "B per A".
    const priceBPerA = tokenIsA
      ? tokenUsd.div(q.priceUsd)          // quote per token
      : new Decimal(q.priceUsd).div(tokenUsd); // token per quote
    const initialTick = PriceMath.priceToTickIndex(priceBPerA, decA, decB);
    if (!TickUtil.checkTickInBounds(initialTick)) {
      failPreflight(`launch price for ${q.symbol} is outside Whirlpool tick bounds (tick ${initialTick}); adjust the market cap`, i);
    }

    const result = {
      quoteIndex: i,
      quoteMint: q.mint,
      quoteSymbol: q.symbol,
      quoteDecimals: q.decimals,
      quotePriceUsd: q.priceUsd,
      supplyPercent: q.supplyPercent,
      forced: !!q.forced,
      tokenIsA,
      tokenMintA: mintA.toBase58(),
      tokenMintB: mintB.toBase58(),
      tickSpacing: ts,
      feeRate: tier.feeRate,
      whirlpoolsConfig,
      initialTick,
      launchPriceUsd: tokenUsd.toNumber(),
      launchPriceInQuote: tokenIsA ? priceBPerA.toNumber() : new Decimal(1).div(priceBPerA).toNumber(),
      poolId: prior?.poolId || null,
      createPoolTxId: prior?.createPoolTxId || null,
      positionMint: prior?.positionMint || null,
      position: prior?.position || null,
      positionTokenAccount: prior?.positionTokenAccount || null,
      tickLower: prior?.tickLower ?? null,
      tickUpper: prior?.tickUpper ?? null,
      tokenAmountRaw: prior?.tokenAmountRaw || null,
      liquidity: prior?.liquidity || null,
      openTxId: prior?.openTxId || null,
      depositTxId: prior?.depositTxId || null,
      lockTxId: prior?.lockTxId || null,
      lockConfig: prior?.lockConfig || null,
      locked: !!prior?.locked,
    };
    results.push(result);

    try {
      // ---- 1. Pool ------------------------------------------------------
      const poolPda = PDAUtil.getWhirlpool(PROGRAM_ID, configPk, mintA, mintB, ts);
      const poolKey = poolPda.publicKey;
      result.poolId = poolKey.toBase58();
      let poolData = await ctx.fetcher.getPool(poolKey, IGNORE_CACHE);
      if (poolData) {
        progress({ stage: 'pool_exists', quoteIndex: i, quoteSymbol: q.symbol, poolId: result.poolId });
      } else {
        progress({ stage: 'pool_create_start', quoteIndex: i, quoteSymbol: q.symbol, poolId: result.poolId });
        const { tx } = await client.createPool(configPk, mintA, mintB, ts, initialTick, owner);
        result.createPoolTxId = await execute(ctx, tx, {
          label: `orca create pool ${q.symbol}`,
          alreadyDone: () => accountExists(connection, poolKey),
        });
        poolData = await ctx.fetcher.getPool(poolKey, IGNORE_CACHE);
        if (!poolData) throw new Error(`pool ${result.poolId} missing after create`);
        progress({ stage: 'pool_create_done', quoteIndex: i, quoteSymbol: q.symbol, poolId: result.poolId, txId: result.createPoolTxId });
      }

      // ---- 2. Position range from the pool's ACTUAL current tick --------
      const range = singleSidedTickRange({ tokenIsA, currentTick: poolData.tickCurrentIndex, tickSpacing: ts });
      result.tickLower = range.tickLower;
      result.tickUpper = range.tickUpper;

      // ---- 3. How much of the token goes in -----------------------------
      const wantRaw = BigInt(
        supply.mul(q.supplyPercent).div(100).mul(new Decimal(10).pow(tokenMintInfo.decimals)).floor().toFixed(0),
      );
      const haveRaw = await tokenBalanceRaw(connection, tokenAta, tokenProgram);
      // A resumed launch may have already deposited some pools; never try
      // to deposit more than the wallet still holds.
      const amountRaw = haveRaw < wantRaw ? haveRaw : wantRaw;
      result.tokenAmountRaw = amountRaw.toString();

      const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
        ctx.fetcher, mintA, mintB, IGNORE_CACHE,
      );

      // ---- 4. Open the (Token-2022) position -----------------------------
      let positionMintPk;
      let positionPda;
      let positionTokenAccount;
      if (result.positionMint) {
        positionMintPk = new PublicKey(result.positionMint);
        positionPda = PDAUtil.getPosition(PROGRAM_ID, positionMintPk);
        positionTokenAccount = getAssociatedTokenAddressSync(positionMintPk, owner, false, TOKEN_2022_PROGRAM_ID);
      } else {
        const positionMintKeypair = Keypair.generate();
        positionMintPk = positionMintKeypair.publicKey;
        positionPda = PDAUtil.getPosition(PROGRAM_ID, positionMintPk);
        positionTokenAccount = getAssociatedTokenAddressSync(positionMintPk, owner, false, TOKEN_2022_PROGRAM_ID);

        const openTx = new TransactionBuilder(connection, ctx.wallet, ctx.txBuilderOpts);
        // Dynamic tick arrays: rent only for the ticks that get initialized.
        for (const tick of [range.tickLower, range.tickUpper]) {
          const startTick = TickUtil.getStartTickIndex(tick, ts);
          openTx.addInstruction(WhirlpoolIx.initDynamicTickArrayIx(program, {
            whirlpool: poolKey,
            tickArrayPda: PDAUtil.getTickArray(PROGRAM_ID, poolKey, startTick),
            startTick,
            funder: owner,
            idempotent: true,
          }));
        }
        // Owner token accounts for both sides (the quote side stays empty
        // but the instruction needs a real account).
        for (const [mint, prog] of [[mintA, tokenIsA ? tokenProgram : q.program], [mintB, tokenIsA ? q.program : tokenProgram]]) {
          const ata = getAssociatedTokenAddressSync(mint, owner, false, prog);
          openTx.addInstruction({
            instructions: [createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint, prog)],
            cleanupInstructions: [],
            signers: [],
          });
          if (mint.equals(NATIVE_MINT)) wsolAtaTouched = true;
        }
        openTx.addInstruction(WhirlpoolIx.openPositionWithTokenExtensionsIx(program, {
          whirlpool: poolKey,
          owner,
          positionPda,
          positionMint: positionMintPk,
          positionTokenAccount,
          funder: owner,
          tickLowerIndex: range.tickLower,
          tickUpperIndex: range.tickUpper,
          withTokenMetadataExtension: true,
        }));
        openTx.addSigner(positionMintKeypair);

        progress({ stage: 'position_open_start', quoteIndex: i, quoteSymbol: q.symbol, poolId: result.poolId, positionMint: positionMintPk.toBase58() });
        result.positionMint = positionMintPk.toBase58();
        result.position = positionPda.publicKey.toBase58();
        result.positionTokenAccount = positionTokenAccount.toBase58();
        result.openTxId = await execute(ctx, openTx, {
          label: `orca open position ${q.symbol}`,
          alreadyDone: () => accountExists(connection, positionPda.publicKey),
        });
        progress({ stage: 'position_open_done', quoteIndex: i, quoteSymbol: q.symbol, poolId: result.poolId, positionMint: result.positionMint, txId: result.openTxId, tickLower: range.tickLower, tickUpper: range.tickUpper });
      }
      result.position = positionPda.publicKey.toBase58();
      result.positionTokenAccount = positionTokenAccount.toBase58();

      // ---- 5. Deposit + lock in one transaction --------------------------
      const lockConfigPda = PDAUtil.getLockConfig(PROGRAM_ID, positionPda.publicKey);
      result.lockConfig = lockConfigPda.publicKey.toBase58();
      const alreadyLocked = await accountExists(connection, lockConfigPda.publicKey);
      if (alreadyLocked) {
        result.locked = true;
        progress({ stage: 'lock_exists', quoteIndex: i, quoteSymbol: q.symbol, poolId: result.poolId, positionMint: result.positionMint });
      } else {
        const posData = await ctx.fetcher.getPosition(positionPda.publicKey, IGNORE_CACHE);
        if (!posData) throw new Error(`position ${result.position} missing after open`);
        // Use the position's real range (a resumed position keeps the range
        // it was opened with, even if the pool tick moved since).
        const tickLower = posData.tickLowerIndex;
        const tickUpper = posData.tickUpperIndex;
        result.tickLower = tickLower;
        result.tickUpper = tickUpper;
        const freshPool = await ctx.fetcher.getPool(poolKey, IGNORE_CACHE);

        const depositLockTx = new TransactionBuilder(connection, ctx.wallet, ctx.txBuilderOpts);
        const needsDeposit = posData.liquidity.isZero();
        if (needsDeposit) {
          if (amountRaw <= 0n) {
            throw new Error(`launch wallet holds no ${tokenMint} to deposit for the ${q.symbol} pool`);
          }
          const quote = increaseLiquidityQuoteByInputTokenWithParams({
            inputTokenAmount: bnFromBigInt(amountRaw),
            inputTokenMint: tokenMintPk,
            tokenMintA: mintA,
            tokenMintB: mintB,
            tickCurrentIndex: freshPool.tickCurrentIndex,
            sqrtPrice: freshPool.sqrtPrice,
            tickLowerIndex: tickLower,
            tickUpperIndex: tickUpper,
            tokenExtensionCtx,
            slippageTolerance: DEPOSIT_SLIPPAGE,
          });
          const quoteSideMax = tokenIsA ? quote.tokenMaxB : quote.tokenMaxA;
          if (!quoteSideMax.isZero()) {
            throw new Error(
              `position for ${q.symbol} would need ${quoteSideMax.toString()} raw quote tokens — ` +
                'the pool price moved into the range. Retry the launch.',
            );
          }
          if (quote.liquidityAmount.isZero()) {
            throw new Error(`deposit for ${q.symbol} rounds to zero liquidity; increase the allocation`);
          }
          result.liquidity = quote.liquidityAmount.toString();
          depositLockTx.addInstruction(WhirlpoolIx.increaseLiquidityV2Ix(program, {
            whirlpool: poolKey,
            position: positionPda.publicKey,
            positionTokenAccount,
            positionAuthority: owner,
            tokenMintA: mintA,
            tokenMintB: mintB,
            tokenOwnerAccountA: getAssociatedTokenAddressSync(mintA, owner, false, tokenIsA ? tokenProgram : q.program),
            tokenOwnerAccountB: getAssociatedTokenAddressSync(mintB, owner, false, tokenIsA ? q.program : tokenProgram),
            tokenVaultA: freshPool.tokenVaultA,
            tokenVaultB: freshPool.tokenVaultB,
            tokenProgramA: tokenIsA ? tokenProgram : q.program,
            tokenProgramB: tokenIsA ? q.program : tokenProgram,
            tickArrayLower: PDAUtil.getTickArrayFromTickIndex(tickLower, ts, poolKey, PROGRAM_ID).publicKey,
            tickArrayUpper: PDAUtil.getTickArrayFromTickIndex(tickUpper, ts, poolKey, PROGRAM_ID).publicKey,
            liquidityAmount: quote.liquidityAmount,
            tokenMaxA: quote.tokenMaxA,
            tokenMaxB: quote.tokenMaxB,
          }));
        } else {
          result.liquidity = posData.liquidity.toString();
        }
        depositLockTx.addInstruction(WhirlpoolIx.lockPositionIx(program, {
          lockType: { permanent: {} },
          funder: owner,
          positionAuthority: owner,
          position: positionPda.publicKey,
          positionMint: positionMintPk,
          positionTokenAccount,
          lockConfigPda,
          whirlpool: poolKey,
        }));

        progress({ stage: needsDeposit ? 'deposit_lock_start' : 'lock_start', quoteIndex: i, quoteSymbol: q.symbol, poolId: result.poolId, positionMint: result.positionMint, tokenAmountRaw: result.tokenAmountRaw });
        result.lockTxId = await execute(ctx, depositLockTx, {
          label: `orca deposit+lock ${q.symbol}`,
          alreadyDone: () => accountExists(connection, lockConfigPda.publicKey),
        });
        result.depositTxId = needsDeposit ? result.lockTxId : result.depositTxId;
        result.locked = true;
        progress({ stage: 'lock_done', quoteIndex: i, quoteSymbol: q.symbol, poolId: result.poolId, positionMint: result.positionMint, txId: result.lockTxId, lockConfig: result.lockConfig });
      }
    } catch (err) {
      progress({ stage: 'pool_failed', quoteIndex: i, quoteSymbol: q.symbol, poolId: result.poolId, error: err.message });
      err.failedQuoteIndex = i;
      err.failedQuote = { mint: q.mint, symbol: q.symbol };
      err.partialResults = results;
      err.failedPhase = err.failedPhase || 'orca_pools';
      throw err;
    }
  }

  // The wSOL ATA (if SOL was a quote) never held anything; reclaim its rent.
  if (wsolAtaTouched) {
    try {
      const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);
      const bal = await tokenBalanceRaw(connection, wsolAta, TOKEN_PROGRAM_ID);
      if (bal === 0n && (await accountExists(connection, wsolAta))) {
        const closeTx = new TransactionBuilder(connection, ctx.wallet, ctx.txBuilderOpts);
        closeTx.addInstruction({
          instructions: [createCloseAccountInstruction(wsolAta, owner, owner, [], TOKEN_PROGRAM_ID)],
          cleanupInstructions: [],
          signers: [],
        });
        await execute(ctx, closeTx, { label: 'orca close empty wSOL account' });
      }
    } catch (err) {
      console.warn(`orca: could not close empty wSOL account: ${err.message}`);
    }
  }

  progress({ stage: 'orca_done', pools: results.length });
  return { results, whirlpoolsConfig, tickSpacing: ts, feeRate: tier.feeRate };
}

function failPreflight(message, quoteIndex = null) {
  const err = new Error(message);
  err.failedPhase = 'pre_flight';
  if (quoteIndex !== null) err.failedQuoteIndex = quoteIndex;
  throw err;
}

// ---------------------------------------------------------------------------
// Hand-off: move locked positions to the launcher, then sweep the rest
// ---------------------------------------------------------------------------

/**
 * transfer_locked_position for every locked position, then sweep leftover
 * tokens (the un-pooled remainder of the supply) and SOL to `destinationWallet`.
 */
export async function finishOrcaLaunch({
  tempWalletSecretKey,
  destinationWallet,
  positions = [],
  onProgress = () => {},
}) {
  const progress = (event) => { try { onProgress(event); } catch (_) { /* best-effort */ } };
  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const owner = ownerKeypair.publicKey;
  const destination = new PublicKey(destinationWallet);
  const connection = makeConnection();
  const ctx = makeContext(ownerKeypair, connection);
  const program = ctx.program;

  const transfers = [];
  for (const p of positions) {
    const positionMint = new PublicKey(p.positionMint);
    const positionPda = PDAUtil.getPosition(PROGRAM_ID, positionMint);
    const sourceAta = getAssociatedTokenAddressSync(positionMint, owner, false, TOKEN_2022_PROGRAM_ID);
    const destAta = getAssociatedTokenAddressSync(positionMint, destination, false, TOKEN_2022_PROGRAM_ID);
    const lockConfig = PDAUtil.getLockConfig(PROGRAM_ID, positionPda.publicKey).publicKey;
    const row = { positionMint: p.positionMint, position: positionPda.publicKey.toBase58(), destinationTokenAccount: destAta.toBase58(), txId: null, skipped: false };
    transfers.push(row);
    try {
      const already = (await tokenBalanceRaw(connection, destAta, TOKEN_2022_PROGRAM_ID)) > 0n;
      if (already) { row.skipped = true; continue; }
      if (!(await accountExists(connection, lockConfig))) {
        throw new Error(`position ${p.positionMint} is not locked; refusing to hand off an unlocked position`);
      }
      const tx = new TransactionBuilder(connection, ctx.wallet, ctx.txBuilderOpts);
      tx.addInstruction({
        instructions: [createAssociatedTokenAccountIdempotentInstruction(owner, destAta, destination, positionMint, TOKEN_2022_PROGRAM_ID)],
        cleanupInstructions: [],
        signers: [],
      });
      tx.addInstruction(WhirlpoolIx.transferLockedPositionIx(program, {
        receiver: owner,
        position: positionPda.publicKey,
        positionMint,
        positionTokenAccount: sourceAta,
        destinationTokenAccount: destAta,
        positionAuthority: owner,
        lockConfig,
      }));
      progress({ stage: 'position_transfer_start', positionMint: p.positionMint });
      row.txId = await execute(ctx, tx, {
        label: `orca transfer locked position ${p.positionMint.slice(0, 6)}`,
        alreadyDone: async () => (await tokenBalanceRaw(connection, destAta, TOKEN_2022_PROGRAM_ID)) > 0n,
      });
      progress({ stage: 'position_transfer_done', positionMint: p.positionMint, txId: row.txId });
    } catch (err) {
      row.error = err.message;
      progress({ stage: 'position_transfer_failed', positionMint: p.positionMint, error: err.message });
    }
  }
  const failed = transfers.filter((t) => t.error);
  if (failed.length > 0) {
    const err = new Error(`${failed.length} locked position(s) could not be transferred: ${failed.map((f) => f.error).join('; ')}`);
    err.transfers = transfers;
    throw err;
  }

  progress({ stage: 'sweep_tokens_start' });
  const tokens = await sweepAllTokensToDestination({ tempWalletSecretKey, destinationWallet });
  progress({ stage: 'sweep_tokens_done', transferred: tokens.transferred.length, errors: tokens.errors.length });
  progress({ stage: 'sweep_sol_start' });
  const sol = await sweepSolToDestination({ tempWalletSecretKey, destinationWallet });
  progress({ stage: 'sweep_sol_done', sol });
  return { transfers, tokens, sol };
}

// ---------------------------------------------------------------------------
// Explore: launches locked on a config since the cutoff
// ---------------------------------------------------------------------------

/**
 * Every pool on `whirlpoolsConfig` that has at least one permanently locked
 * position locked at or after `sinceUnix`, grouped by launched token.
 */
export async function discoverLaunches({
  whirlpoolsConfig = DEFAULT_WHIRLPOOLS_CONFIG,
  sinceUnix = DISCOVERY_SINCE_UNIX,
} = {}) {
  return cached(`discover:${whirlpoolsConfig}:${sinceUnix}`, 60_000, async () => {
    const connection = makeConnection();
    const [poolRows, lockRows] = await Promise.all([
      programAccounts(connection, [
        { dataSize: WHIRLPOOL_SIZE },
        { memcmp: { offset: 8, bytes: whirlpoolsConfig } },
      ]),
      programAccounts(connection, [{ dataSize: LOCK_CONFIG_SIZE }]),
    ]);
    const pools = new Map();
    for (const r of poolRows) pools.set(r.pubkey.toBase58(), decodeWhirlpool(r.account.data));

    const locksByPool = new Map();
    for (const r of lockRows) {
      const lock = decodeLockConfig(r.account.data);
      if (!pools.has(lock.whirlpool)) continue;
      if (!locksByPool.has(lock.whirlpool)) locksByPool.set(lock.whirlpool, []);
      locksByPool.get(lock.whirlpool).push({ address: r.pubkey.toBase58(), ...lock });
    }

    // Position liquidity for every lock, in one batched read.
    const lockPositions = [...locksByPool.values()].flat().map((l) => new PublicKey(l.position));
    const positionInfos = new Map();
    for (let i = 0; i < lockPositions.length; i += 100) {
      const chunk = lockPositions.slice(i, i + 100);
      const infos = await connection.getMultipleAccountsInfo(chunk);
      infos.forEach((info, j) => {
        if (info) positionInfos.set(chunk[j].toBase58(), decodePosition(info.data));
      });
    }

    const launches = new Map(); // tokenMint -> launch
    for (const [poolId, locks] of locksByPool.entries()) {
      const firstLock = Math.min(...locks.map((l) => l.lockedTimestamp));
      if (firstLock < sinceUnix) continue;
      const pool = pools.get(poolId);
      const sides = classifyPoolSides(pool.tokenMintA, pool.tokenMintB, KNOWN_QUOTE_MINTS);
      const [tokenInfo, quoteInfo] = await Promise.all([
        describeQuote(sides.tokenMint),
        describeQuote(sides.quoteMint),
      ]);
      const decA = sides.tokenIsA ? tokenInfo.decimals : quoteInfo.decimals;
      const decB = sides.tokenIsA ? quoteInfo.decimals : tokenInfo.decimals;
      let priceInQuote = null;
      let priceUsd = null;
      if (Number.isInteger(decA) && Number.isInteger(decB)) {
        const bPerA = sqrtPriceX64ToPrice(pool.sqrtPrice, decA, decB);
        priceInQuote = sides.tokenIsA ? bPerA : (bPerA > 0 ? 1 / bPerA : null);
        if (priceInQuote && quoteInfo.priceUsd) priceUsd = priceInQuote * quoteInfo.priceUsd;
      }
      const lockedLiquidity = locks.reduce((s, l) => s + (positionInfos.get(l.position)?.liquidity ?? 0n), 0n);

      if (!launches.has(sides.tokenMint)) {
        launches.set(sides.tokenMint, {
          tokenMint: sides.tokenMint,
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          imageUrl: tokenInfo.imageUrl,
          decimals: tokenInfo.decimals,
          priceUsd: null,
          marketCapUsd: null,
          launchedAt: firstLock,
          pools: [],
        });
      }
      const launch = launches.get(sides.tokenMint);
      launch.launchedAt = Math.min(launch.launchedAt, firstLock);
      launch.pools.push({
        poolId,
        quoteMint: sides.quoteMint,
        quoteSymbol: quoteInfo.symbol,
        quoteImageUrl: quoteInfo.imageUrl,
        feeRate: pool.feeRate,
        feePercent: pool.feeRate / 10000,
        tickSpacing: pool.tickSpacing,
        tickCurrentIndex: pool.tickCurrentIndex,
        activeLiquidity: pool.liquidity.toString(),
        lockedLiquidity: lockedLiquidity.toString(),
        lockedPositions: locks.length,
        lockedAt: firstLock,
        priceInQuote,
        priceUsd,
        ambiguousSides: !!sides.ambiguous,
        orcaUrl: `https://www.orca.so/pools/${poolId}`,
        solscanUrl: `https://solscan.io/account/${poolId}`,
      });
    }

    const out = [];
    for (const launch of launches.values()) {
      const priced = launch.pools.filter((p) => p.priceUsd);
      if (priced.length > 0) {
        // Median across pools: robust to a single dead quote.
        const sorted = priced.map((p) => p.priceUsd).sort((a, b) => a - b);
        launch.priceUsd = sorted[Math.floor(sorted.length / 2)];
        try {
          const supply = await connection.getTokenSupply(new PublicKey(launch.tokenMint));
          launch.supply = supply.value.uiAmount;
          if (launch.supply) launch.marketCapUsd = launch.priceUsd * launch.supply;
        } catch (_) { /* supply is decoration */ }
      }
      launch.pools.sort((a, b) => a.lockedAt - b.lockedAt);
      out.push(launch);
    }
    out.sort((a, b) => b.launchedAt - a.launchedAt);
    return { whirlpoolsConfig, sinceUnix, scannedPools: pools.size, launches: out, fetchedAt: Math.floor(Date.now() / 1000) };
  });
}

// ---------------------------------------------------------------------------
// Estimate (re-exported so routes only import this module)
// ---------------------------------------------------------------------------

export function estimateOrcaLaunch({ quotes }) {
  const plan = normalizeOrcaQuotes(quotes);
  const cost = estimateOrcaLaunchSol({ poolCount: plan.quotes.length });
  return { plan, cost };
}

export { DEFAULT_WHIRLPOOLS_CONFIG, ORCA_CONFIG_AUTHORITY, DISCOVERY_SINCE_UNIX };
