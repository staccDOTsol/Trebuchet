# Trebuchet Pairs

Fully collateralized **leveraged long / short pools for any Solana token**,
with on-chain resting offers as the order book. Short a memecoin the moment
someone is willing to be long it; no lender, no liquidations, no oracle
needed until settlement.

Lineage: the deposit → PASS/FAIL pair → decide → redeem flow of SPL
[`binary-oracle-pair`](https://github.com/solana-labs/solana-program-library/tree/master/binary-oracle-pair/program)
and the priced two-party `Trade` of SPL
[`binary-option`](https://github.com/solana-labs/solana-program-library/tree/master/binary-option/program),
generalised from a yes/no outcome to a **capped price range** (which is what
makes a position leveraged), then extended with resting offers, taker fees,
funding, and permissionless settlement from an Orca Whirlpool.

## How a market works

A **market** ("pool") is one `(underlying, collateral, [floor, cap], expiry)`.
It owns two SPL Token mints, `LONG` and `SHORT`, and a collateral vault.

* **One LONG + one SHORT is always backed by exactly one base unit of
  collateral in the vault.** Pairs are minted only when a full unit comes in
  and are burned when it goes out, so the vault can never be short.
* At settlement with price `P`, one LONG pays
  `f = clamp((P - floor) / (cap - floor), 0, 1)` collateral units and one
  SHORT pays `1 - f`. Between `floor` and `cap` the payoff is linear.
* **Leverage is the range width.** A market on a memecoin at spot `S` with
  `floor = 0.9S`, `cap = 1.1S` moves its LONG from worthless to a full unit
  across a 20% spot move. Bought at the midpoint (`0.5`), a 1% spot move is a
  10% move in the position: ~10x, with the loss capped at what you paid.
  Widen the range for less leverage, narrow it for more.
* Prices are quoted as the long side's share of a unit, in **parts per
  million** (`PRICE_SCALE = 1_000_000`). Paying `250_000` for a LONG means you
  put up 25% of notional and your counterparty puts up 75%.

There are three ways to get a position:

1. **Mint a pair** (`MintPairs`): deposit `n` collateral, receive `n` LONG and
   `n` SHORT. Sell the side you don't want anywhere (an Orca pool, an OTC
   trade). This is how a market maker seeds a book.
2. **Trade** (`Trade`): a matched fill signed by both parties at an agreed
   price; the long pays `ceil(size * p)`, the short pays the rest, both get
   `size` position tokens. Off-chain matching, on-chain settlement.
3. **Offers** (`PlaceOffer` / `FillOffer` / `CancelOffer`): the on-chain order
   book. A maker escrows their side of `size` contracts at a price; any taker
   fills part or all of it by paying the other side. Partial fills consume the
   escrow proportionally and the account closes (rent back to the maker) on
   the last fill. Offers can carry an expiry; expired offers can be swept back
   to the maker by anyone.

To get out before settlement: hold both sides and `RedeemPairs` (burn `n` of
each, withdraw `n` collateral). A LONG holder exits by buying a SHORT (fill a
short offer, or trade) and redeeming the pair; the difference between what
they paid and what they receive is their realised P&L. There is no
single-sided withdrawal before settlement — that is what keeps the vault
fully collateralized without a liquidation engine.

### Settlement

| Mode | `settler` | Who settles | Price |
| --- | --- | --- | --- |
| `Authority` | any pubkey (multisig, oracle program PDA, ...) | that key signs `Settle { price }` | supplied |
| `Whirlpool` | an Orca Whirlpool address | anyone, permissionless | `sqrt_price^2 * 10^price_decimals / 2^128` read from the pool (inverted if `invert`) |

`Settle` is accepted from `trade_end_slot` through `settle_end_slot`. If
nobody settles in that window, anyone can `Void` the market and both sides
claim half a unit. After settlement or void, `Claim` burns any mix of LONG
and SHORT and pays their payout.

Whirlpool mode is what makes this "for anything launched here": every
FireFun token already has a Whirlpool, so a market can be created on it with
no oracle at all. The trade-off is that spot at a single slot is
manipulable by a large enough swap in the same block; keep the settlement
window a few slots wide, size the range so that a manipulated print costs
more than it wins, or use `Authority` mode with a keeper that reads a TWAP
for anything with real money in it.

## Funding: turning expiries into an "always-on" perpetual

Funding needs a *mark* (what the market pays for LONG) and an *index* (what
it is worth). Each `Crank` (permissionless in Whirlpool mode; signed by the
settler with an `index_price` in Authority mode) accrues

```
premium = mark_ppm - intrinsic_ppm(index)
funding = premium * funding_rate_ppm / SCALE * elapsed_slots / funding_period_slots
funding = clamp(funding, ±max_funding_per_period_ppm * elapsed / period)
funding_offset_ppm += funding            // positive: longs have paid shorts
```

and the settlement payout becomes `clamp(intrinsic - funding_offset, 0, 1)`.
Longs who overpay relative to the index bleed value to shorts every slot,
which is exactly the pressure that pins a perp to its index. The rate is
per-market: `funding_rate_ppm = 3_000_000` charges 300% of the premium per
period; with a one-hour `funding_period_slots` (~9000) that is the
"stupidly high" regime that makes crowded memecoin longs fund the shorts
hard. `max_funding_per_period_ppm` caps the bleed per period so a
manipulated mark cannot drain a side in one crank.

Two mark sources are supported:

* **VWAP of on-chain fills since the last crank** (default). Cheap, but
  wash trades are free (mint a pair, trade it with yourself, redeem), so use
  it together with a `taker_fee_ppm` (paid to the market creator; makers are
  fee-free) that makes moving the VWAP cost real money.
* **A LONG/collateral Whirlpool** set once by the creator with
  `SetMarkWhirlpool`. Moving that price costs real liquidity. This is the
  recommended mark for anything that matters.

**Why this is not a never-settling perp.** With fungible pair tokens and no
margin accounts, a value transfer between longs and shorts can only be
realised at a moment when everyone settles at the same payout: a single LONG
cashing out at today's `f` would leave its SHORT counterpart backed by
`1 - f` while that SHORT's future claim can still grow, which is exactly the
insolvency a liquidation engine exists to prevent. So funding here accrues
continuously but is *paid* at settlement, and "always on" is a **rolling
series of epochs**: when a market settles, the next one is created with the
same range width re-centred on the new spot (`nextEpochArgs` in
`pairsClient.js` computes it). Positions roll by claiming and re-entering,
which needs a counterparty again, the same way a dated future rolls. A true
open-ended perpetual on top of this would need per-account margin and a
liquidation path; the pair tokens are the honest primitive underneath that.

## Instructions

Data is a one-byte tag followed by little-endian fields; no IDL. Account
lists are documented in `src/instruction.rs`.

| Tag | Instruction | Signer | Notes |
| --- | --- | --- | --- |
| 0 | `InitMarket` | creator | validates client-created market / vault / LONG / SHORT accounts, writes state |
| 1 | `MintPairs { amount }` | user | `amount` collateral → `amount` LONG + `amount` SHORT (before `trade_end_slot`) |
| 2 | `RedeemPairs { amount }` | user | burn pair, withdraw collateral (while open) |
| 3 | `Trade { size, long_price_ppm }` | long, short | matched fill; both pay the taker fee |
| 4 | `PlaceOffer { side, long_price_ppm, size, expiry_slot, nonce }` | maker | escrows maker's side into the vault; offer PDA `["offer", market, maker, nonce_le]` |
| 5 | `FillOffer { size }` | taker | partial fills allowed; taker pays the fee; closes when filled |
| 6 | `CancelOffer` | maker (anyone if expired / market closed) | returns escrow and rent |
| 7 | `Settle { price }` | settler (Authority) / none (Whirlpool) | `trade_end_slot ≤ slot ≤ settle_end_slot`; final funding accrual |
| 8 | `Void` | none | after `settle_end_slot` on an open market; 50/50 |
| 9 | `Claim { long_amount, short_amount }` | user | burn positions, receive payout |
| 10 | `Crank { index_price }` | settler (Authority) / none (Whirlpool) | accrue funding; pass the mark whirlpool if set |
| 11 | `SetMarkWhirlpool` | creator | once, while open |

`Market` (464 bytes) and `Offer` (112 bytes) layouts are in `src/state.rs`
and mirrored by `decodeMarket` / `decodeOffer` in `pairsClient.js`.

Collateral can be an SPL Token **or Token-2022** mint (the vault is an
associated token account of the authority PDA). Mints with a transfer fee
are rejected at deposit time: the vault must receive exactly the amount
requested. LONG and SHORT are always classic SPL Token mints with the
collateral's decimals, so they trade on any DEX.

## Build, test, deploy

Requires the [Anza toolchain](https://docs.anza.xyz/cli/install)
(`cargo-build-sbf`, `cargo-test-sbf`).

```bash
cd programs
cargo test -p trebuchet-pairs --lib          # pure unit tests (layouts, math, encodings)
cargo test-sbf --manifest-path pairs/Cargo.toml   # builds the SBF program and runs tests/pairs.rs against it
cargo clippy -p trebuchet-pairs --all-targets
```

The integration tests must run against the compiled program: with current
`solana-*` crates the `Clock` / `Rent` sysvar syscalls are only served inside
the SBF virtual machine, not by the native processor path.

Deploying:

```bash
solana-keygen new -o programs/keys/pairs-program.json   # or reuse an existing program keypair
# put its pubkey in programs/pairs/src/lib.rs (declare_id!) and PAIRS_PROGRAM_ID in pairsClient.js
cargo build-sbf --manifest-path programs/pairs/Cargo.toml
solana program deploy programs/target/deploy/trebuchet_pairs.so --program-id programs/keys/pairs-program.json
```

`programs/keys/` is git-ignored. The id compiled in today
(`46RKjEgeK2qNkDdBFnBnrSUJtrXmPcFwSa6xNzNfMums`) is a placeholder generated
in a throwaway environment; generate your own before deploying.

## Security notes

* Every CPI to a token program is to the program that owns the mint, and the
  program id is checked against SPL Token / Token-2022. Position mints must
  have the authority PDA as mint authority, zero supply and no freeze
  authority at init, so nobody can pre-mint.
* All arithmetic is checked; long/short splits are exact (`ceil` + remainder)
  and settlement payouts round down, so the sum of claims never exceeds the
  vault. Dust from rounding stays in the vault.
* Whirlpool accounts are accepted only if owned by the Orca program and
  carrying the `Whirlpool` discriminator; the priced mint must match the
  market's underlying at init.
* Offers are PDAs the program creates itself, so an attacker cannot
  pre-seed one; closing zeroes the data and returns it to the system program.
* Not audited. Spot-at-settlement manipulation and mark manipulation are
  discussed above; the parameters that bound them are per-market.
