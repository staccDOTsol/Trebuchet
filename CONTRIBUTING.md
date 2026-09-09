# Contributing

## CI checks

Every pull request runs two jobs:

- **Test** (required) — syntax check, full test suite, critical npm
  audit. This job MUST pass before merge. If branch protection is
  configured, it is enforced automatically; otherwise, reviewers
  confirm a green run before approving.

- **Build** (advisory) — smoke package builds for macOS arm64, macOS
  x64, Windows, and Linux. Confirms the app packages without errors
  but is not required for merge. A failing Build job is a signal to
  investigate, not a blocker.

## Branch protection (maintainers)

To enforce required checks automatically:

1. Go to **Settings → Rules → Rulesets**.
2. Create a ruleset targeting the default branch.
3. Under **Required checks**, add `Test`.
4. Optionally require at least one approving review.

## Running tests locally

```bash
npm ci
npm test                 # full test suite
npm run check:syntax     # syntax-only
npm audit --audit-level=critical  # dependency audit
```

The on-chain program under `programs/` has its own job
(`pairs.yml`): rustfmt, clippy, unit tests and the SBF integration tests.
Locally, with the Anza toolchain installed:

```bash
cd programs
cargo test -p trebuchet-pairs --lib
cargo test-sbf --manifest-path pairs/Cargo.toml
```

Opt-in mainnet smoke tests:

```bash
TREBUCHET_SMOKE_TEST_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY \
  node --test test/smoke-launch.test.mjs
```

## Release process

Merges to `main` trigger `auto-release.yml`, which reads merged PR
labels to compute the next semver tag. Tagged releases trigger
`release.yml`, which builds, signs, notarizes (macOS), and publishes
desktop artifacts plus the GitHub Package. See
[docs/releasing.md](docs/releasing.md) for details.
