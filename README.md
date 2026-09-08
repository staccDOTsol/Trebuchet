# FireFun

**[firefun.xyz](https://firefun.xyz)** — a barebones Solana memecoin launcher
built on Orca Whirlpools. No frills, no extractive nonsense. A fork of
[Trebuchet](https://github.com/AnOversizedMooseWithSocks/Trebuchet) with the
Raydium path removed: the Orca launcher is the whole app.


## Multi-quote Orca pools, any market cap, locked forever

The launcher (`public/orca.html`, served at `/`) is one page. You pick the
quote tokens, type a **starting market cap** (any number works — positions
are single-sided so no quote tokens are needed to open the pool at that
price), fund a throwaway wallet, and press Launch:

1. mints the SPL token (Metaplex metadata; mint / freeze / update
   authorities renounced);
2. creates one **Orca Whirlpool per quote** on our WhirlpoolsConfig
   (`12yTE48QR6bGK4EMcyY8XsARbX1TRTEbwHYSuuxR1Hp8`, fee authority
   `WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb`; fee tiers are read live
   from the config, 1% by default) — cheap dynamic tick arrays, no
   per-pool dynamic-fee machinery;
3. opens one single-sided Token-2022 position per pool holding that
   quote's share of the supply;
4. **permanently locks** every position with Orca's native
   `lock_position` (`LockType::Permanent`) — the position keeps earning
   fees but its liquidity can never be withdrawn;
5. hands the locked positions to your wallet with
   `transfer_locked_position` and sweeps the un-pooled supply + SOL.

Three quotes are always in and cannot be removed, **min 1% of supply each**:
`EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump` ($TOKEN, Token-2022),
`6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f` ($INFITY, Token-2022 with a
6.9% transfer fee) and `5SyfywcaD8kiEGyrt7cg4FnVqxTcuut5KCcWgh44o3UG`
($FIREFUN). SOL / USDC / USDT / any other priced mint are optional. Every
launched token gets a page at `/token/<mint>` with Jupiter links per pool.

The **Explore** tab lists every token whose pools were locked on the config
since the feature shipped (`orcaLpPlan.js` → `DISCOVERY_SINCE_UNIX`), with
live price, market cap and per-pool lock status.

The config's protocol fee must be at Orca's 25% maximum; launches on a
config set lower are refused.

Server code: `orcaLpPlan.js` (pure planning + account decoders, unit
tested), `orcaLpService.js` (Whirlpools SDK), `orcaRoutes.js`
(`/api/orca/*`), `server.js` (wallets, token mint, recovery, RPC settings).
There is no demo mode: every launch is real.

### Running it

```
npm ci
npm run web          # http://127.0.0.1:3000/
```

The default RPC is a Triton One archival endpoint (see `rpcConfig.js`; the
explore feed needs `getProgramAccounts`, which public RPCs refuse). Override
with `TREBUCHET_RPC_URL` or in the in-app RPC settings.

### Deploying (Fly.io)

The server keeps launch-wallet secrets, journals and preferences on disk
and a launch is a single multi-minute HTTP request, so it wants a real
long-running box with a volume — `Dockerfile` + `fly.toml` are included:

```
flyctl launch --no-deploy            # picks up fly.toml
flyctl volumes create firefun_data --size 1
flyctl deploy
flyctl certs add firefun.xyz         # then point DNS at the app
```

`TREBUCHET_ALLOWED_HOSTS` (fly.toml) lists extra hostnames allowed through
the Host-header check; `firefun.xyz` and `www.firefun.xyz` are always
allowed. Back the volume up: it holds the keys of in-flight launch wallets.
Set a Recovery PIN in Settings so those keys are encrypted at rest.


## Recovery

Every launch wallet's secret is kept in the server's pending-wallet list
(`pendingWallets.json` under `TREBUCHET_CONFIG_DIR`) until the final
hand-off verifies the wallet empty, and every step is journaled
(`launchJournals.json`). A launch that dies mid-way is resumed by
pressing Launch again with the same wallet: pools, positions and locks
already on chain are detected and skipped. Set a Recovery PIN so the
stored keys are encrypted at rest.

## Development

```
npm ci
npm run check:syntax
npm run check:package
npm test
```

## License

MIT — see [LICENSE](LICENSE). Original work by AnOversizedMooseWithSocks.
