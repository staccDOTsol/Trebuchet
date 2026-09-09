#!/usr/bin/env node
// scripts/orca-set-authorities.mjs
//
// Move every authority on every WhirlpoolsConfig the signer controls to a
// new wallet. Per config that is:
//   - fee_authority                    (set_fee_authority)
//   - collect_protocol_fees_authority  (set_collect_protocol_fees_authority)
//   - reward_emissions_super_authority (set_reward_emissions_super_authority)
// and, when the config has a WhirlpoolsConfigExtension:
//   - config_extension_authority       (set_config_extension_authority)
//   - token_badge_authority            (set_token_badge_authority)
//
// Each instruction must be signed by the *current* holder of that authority,
// so the signer can only move the authorities it holds; anything already
// held by someone else is reported and skipped. Several configs are packed
// into each transaction.
//
// Usage:
//   node scripts/orca-set-authorities.mjs --new <wallet> [--keypair <file.json> | --keypair-env <VAR>]
//                                         [--configs <a,b,...>] [--dry-run] [--verbose] [--rpc <url>]
//
// --keypair-env reads a JSON array or base58 secret from that environment
// variable. Without a keypair the script runs read-only (--dry-run implied)
// and can take --authority <pubkey> to plan for a signer it does not hold.
//
// Order matters: the fee-authority change is placed LAST in each
// transaction, because the script enumerates configs by fee authority and a
// re-run after a partial failure must still find them.

import fs from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil, WhirlpoolIx, IGNORE_CACHE } from '@orca-so/whirlpools-sdk';
import bs58 from 'bs58';

import { getRpcUrl } from '../rpcConfig.js';
import { ORCA_CONFIG_AUTHORITY, ORCA_CONFIG_AUTHORITIES, WHIRLPOOLS_CONFIG_SIZE, decodeWhirlpoolsConfig } from '../orcaLpPlan.js';

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
function has(name) { return process.argv.includes(name); }

function loadKeypair() {
  const file = arg('--keypair');
  const envName = arg('--keypair-env');
  let raw = null;
  if (typeof file === 'string') raw = fs.readFileSync(file, 'utf8').trim();
  else if (typeof envName === 'string') raw = (process.env[envName] || '').trim();
  if (!raw) return null;
  let bytes;
  if (raw.startsWith('[')) bytes = Uint8Array.from(JSON.parse(raw));
  else if (fs.existsSync(raw)) bytes = Uint8Array.from(JSON.parse(fs.readFileSync(raw, 'utf8')));
  else bytes = bs58.decode(raw);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  if (bytes.length !== 64) throw new Error(`keypair must be 64 bytes, got ${bytes.length}`);
  return Keypair.fromSecretKey(bytes);
}

async function main() {
  const newAuthorityArg = arg('--new', ORCA_CONFIG_AUTHORITY);
  const newAuthority = new PublicKey(newAuthorityArg);
  const signer = loadKeypair();
  const dryRun = has('--dry-run') || !signer;
  const authority = signer ? signer.publicKey : new PublicKey(arg('--authority', ORCA_CONFIG_AUTHORITIES[1]));
  const rpc = typeof arg('--rpc') === 'string' ? arg('--rpc') : getRpcUrl();
  const connection = new Connection(rpc, 'confirmed');
  const ctx = WhirlpoolContext.from(connection, new Wallet(signer || Keypair.generate()));
  const program = ctx.program;

  console.log(`signer     ${authority.toBase58()}${signer ? '' : ' (read-only: no keypair given)'}`);
  console.log(`new owner  ${newAuthority.toBase58()}`);
  console.log(`rpc        ${rpc.replace(/(\?|\/)[A-Za-z0-9-]{20,}.*$/, '$1…')}`);
  console.log(dryRun ? 'mode       DRY RUN — nothing is sent' : 'mode       LIVE');

  // Enumerate configs: by fee authority (the signer's, plus the app's known
  // authorities) so a half-moved config is still visited, or an explicit list.
  const explicit = typeof arg('--configs') === 'string' ? arg('--configs').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const found = new Map();
  if (explicit) {
    for (const a of explicit) {
      const info = await connection.getAccountInfo(new PublicKey(a));
      if (!info) { console.log(`config ${a}: not found`); continue; }
      found.set(a, decodeWhirlpoolsConfig(info.data));
    }
  } else {
    const feeAuths = [...new Set([authority.toBase58(), ...ORCA_CONFIG_AUTHORITIES])];
    for (const fa of feeAuths) {
      const rows = await connection.getProgramAccounts(ORCA_WHIRLPOOL_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [{ dataSize: WHIRLPOOLS_CONFIG_SIZE }, { memcmp: { offset: 8, bytes: fa } }],
      });
      for (const r of rows) found.set(r.pubkey.toBase58(), decodeWhirlpoolsConfig(r.account.data));
    }
  }
  console.log(`configs    ${found.size}`);

  const me = authority.toBase58();
  const target = newAuthority.toBase58();
  const verbose = has('--verbose');
  const plan = [];
  const tally = new Map();
  let sent = 0;
  for (const [address, cfg] of found.entries()) {
    const configPk = new PublicKey(address);
    const ixs = [];
    const notes = [];
    const consider = (label, current, build) => {
      if (current === target) { notes.push(`${label}: already ${target.slice(0, 6)}…`); return; }
      if (current !== me) { notes.push(`${label}: held by ${current.slice(0, 6)}… (not the signer) — skipped`); return; }
      notes.push(`${label}: ${current.slice(0, 6)}… → ${target.slice(0, 6)}…`);
      ixs.push(build());
    };

    consider('collect_protocol_fees_authority', cfg.collectProtocolFeesAuthority, () =>
      WhirlpoolIx.setCollectProtocolFeesAuthorityIx(program, {
        whirlpoolsConfig: configPk, collectProtocolFeesAuthority: authority, newCollectProtocolFeesAuthority: newAuthority,
      }));
    consider('reward_emissions_super_authority', cfg.rewardEmissionsSuperAuthority, () =>
      WhirlpoolIx.setRewardEmissionsSuperAuthorityIx(program, {
        whirlpoolsConfig: configPk, rewardEmissionsSuperAuthority: authority, newRewardEmissionsSuperAuthority: newAuthority,
      }));

    // Config extension (token badges for Token-2022 mints) if it exists.
    const extPda = PDAUtil.getConfigExtension(ORCA_WHIRLPOOL_PROGRAM_ID, configPk);
    let ext = null;
    try { ext = await ctx.fetcher.getConfigExtension(extPda.publicKey, IGNORE_CACHE); } catch (_) { ext = null; }
    if (ext) {
      const extAuth = ext.configExtensionAuthority.toBase58();
      const badgeAuth = ext.tokenBadgeAuthority.toBase58();
      // token_badge_authority is changed by the config-extension authority,
      // so do it before handing that authority over.
      if (badgeAuth !== target) {
        if (extAuth === me) {
          notes.push(`token_badge_authority: ${badgeAuth.slice(0, 6)}… → ${target.slice(0, 6)}…`);
          ixs.push(WhirlpoolIx.setTokenBadgeAuthorityIx(program, {
            whirlpoolsConfig: configPk, whirlpoolsConfigExtension: extPda.publicKey, configExtensionAuthority: authority, newTokenBadgeAuthority: newAuthority,
          }));
        } else notes.push(`token_badge_authority: extension authority is ${extAuth.slice(0, 6)}… (not the signer) — skipped`);
      } else notes.push(`token_badge_authority: already ${target.slice(0, 6)}…`);
      consider('config_extension_authority', extAuth, () =>
        WhirlpoolIx.setConfigExtensionAuthorityIx(program, {
          whirlpoolsConfig: configPk, whirlpoolsConfigExtension: extPda.publicKey, configExtensionAuthority: authority, newConfigExtensionAuthority: newAuthority,
        }));
    } else notes.push('config extension: none');

    // Last: fee authority (see header).
    consider('fee_authority', cfg.feeAuthority, () =>
      WhirlpoolIx.setFeeAuthorityIx(program, { whirlpoolsConfig: configPk, feeAuthority: authority, newFeeAuthority: newAuthority }));

    if (verbose || ixs.length === 0) {
      console.log(`\n${address}  (default protocol fee ${cfg.defaultProtocolFeeRate / 100}%)`);
      for (const n of notes) console.log(`  ${n}`);
      if (ixs.length === 0) console.log('  nothing to do');
    }
    if (ixs.length > 0) plan.push({ address, ixs: ixs.flatMap((ix) => [...ix.instructions, ...ix.cleanupInstructions]) });
    for (const n of notes) {
      const k = n.replace(/[A-Za-z0-9]{6}…/g, '…');
      tally.set(k, (tally.get(k) || 0) + 1);
    }
  }

  console.log('\nsummary');
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log(`  configs needing changes: ${plan.length} of ${found.size}`);

  // Pack several configs per transaction (each authority change is a tiny
  // 3-4 account instruction); a config's instructions never split.
  const batches = [];
  let cur = [];
  const fits = (items) => {
    const tx = new Transaction({ feePayer: authority, recentBlockhash: '11111111111111111111111111111111' });
    for (const it of items) tx.add(...it.ixs);
    try { return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1150; } catch (_) { return false; }
  };
  for (const item of plan) {
    if (cur.length && !fits([...cur, item])) { batches.push(cur); cur = []; }
    if (!fits([item])) throw new Error(`config ${item.address} does not fit in one transaction`);
    cur.push(item);
  }
  if (cur.length) batches.push(cur);
  console.log(`  transactions: ${batches.length}`);
  if (dryRun) { console.log('\ndry run — nothing sent'); return; }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash });
    for (const it of batch) tx.add(...it.ixs);
    tx.sign(signer);
    let sig;
    try {
      sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    } catch (err) {
      console.error(`batch ${i + 1}/${batches.length} (${batch.map((b) => b.address).join(', ')}) failed to send: ${err.message}`);
      throw err;
    }
    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (conf.value.err) throw new Error(`batch ${i + 1} ${sig} failed on-chain: ${JSON.stringify(conf.value.err)}`);
    sent++;
    console.log(`  ${i + 1}/${batches.length}  ${batch.length} config${batch.length === 1 ? '' : 's'}  ${sig}`);
  }
  console.log(`\ndone: ${sent} transaction${sent === 1 ? '' : 's'} sent. Re-run to verify: every line should read "already".`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
