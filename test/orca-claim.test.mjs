import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, TransactionInstruction, Transaction } from '@solana/web3.js';

import { packClaimTransactions, MAX_TX_BYTES } from '../orcaClaimService.js';

const PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

function fakeGroup(accounts = 4) {
  // One "position": an update ix and a collect ix, each with fresh accounts
  // so the packer's byte accounting resembles real claims.
  const keys = Array.from({ length: accounts }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }));
  const update = new TransactionInstruction({ programId: PROGRAM, keys: keys.slice(0, 2), data: Buffer.alloc(8, 1) });
  const collect = new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.alloc(8, 2) });
  return [update, collect];
}

test('packClaimTransactions fills transactions under the byte limit, in order', () => {
  const feePayer = Keypair.generate().publicKey;
  const groups = Array.from({ length: 23 }, () => fakeGroup(6));
  const { txs, remaining } = packClaimTransactions({ feePayer, recentBlockhash: BLOCKHASH, groups, maxTxs: 100 });
  assert.equal(remaining.length, 0);
  assert.ok(txs.length >= 3, `expected several transactions, got ${txs.length}`);
  let seen = 0;
  for (const { tx, groups: g } of txs) {
    assert.ok(g.length >= 1);
    const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    assert.ok(size <= MAX_TX_BYTES, `tx is ${size} bytes`);
    // compute budget (2) + groups*2 instructions
    assert.equal(tx.instructions.length, 2 + g.length * 2);
    for (const grp of g) assert.equal(grp, groups[seen++]);
  }
  assert.equal(seen, groups.length);
});

test('packClaimTransactions honours maxTxs and reports the remainder', () => {
  const feePayer = Keypair.generate().publicKey;
  const groups = Array.from({ length: 40 }, () => fakeGroup(6));
  const { txs, remaining } = packClaimTransactions({ feePayer, recentBlockhash: BLOCKHASH, groups, maxTxs: 2 });
  assert.equal(txs.length, 2);
  const packed = txs.reduce((s, t) => s + t.groups.length, 0);
  assert.equal(remaining.length, 40 - packed);
  assert.equal(remaining[0], groups[packed]);
});

test('packClaimTransactions wraps every transaction with prelude and epilogue', () => {
  const feePayer = Keypair.generate().publicKey;
  const pre = new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([9]) });
  const post = new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([7]) });
  const groups = Array.from({ length: 12 }, () => fakeGroup(6));
  const { txs } = packClaimTransactions({ feePayer, recentBlockhash: BLOCKHASH, prelude: [pre], epilogue: [post], groups, maxTxs: 10 });
  for (const { tx } of txs) {
    assert.equal(tx.instructions[2].data[0], 9);
    assert.equal(tx.instructions[tx.instructions.length - 1].data[0], 7);
    assert.ok(tx instanceof Transaction);
    assert.equal(tx.feePayer.toBase58(), feePayer.toBase58());
  }
});

test('packClaimTransactions refuses a single group that cannot fit', () => {
  const feePayer = Keypair.generate().publicKey;
  assert.throws(
    () => packClaimTransactions({ feePayer, recentBlockhash: BLOCKHASH, groups: [fakeGroup(40)], maxTxs: 1 }),
    /does not fit/,
  );
});
