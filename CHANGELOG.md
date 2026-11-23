# Changelog

## 0.8.1

- README: "Verify it first. Earn on every reuse." `TERENO_QUESTS` is listed, and a new "No USDC yet? Work a quest" section explains the zero-USDC path.
- `TERENO_QUESTS` description states the real quest rewards: $0.07 credit on the first verified quest (first 20 wallets per UTC day, $0.005 past the cap), then $0.005 per quest. It used to say only $0.005.
- No change to actions, inputs or payment flow.

## 0.8.0

- Prices are read from the live catalog at startup (`GET /api/v1/capabilities`) and the action descriptions are rebuilt from them. The built-in table is only the offline fallback.
- Startup update check (`GET /api/v1/clients`): logs a warning when a newer plugin-tereno exists; `TERENO_PREVIEW` and `TERENO_RULES` show it with platform news (Launch Hunt, the free launches feed). Opt out with `TERENO_UPDATE_CHECK=false`.
- `TERENO_PREVIEW` lists all six checks, including the launch and holders guards.
- `TERENO_RULES` offline fallback no longer carries prices that can go stale.
- `PLUGIN_VERSION` reports the real version (it was stuck at 0.6.2); a test keeps it equal to package.json.

## 0.7.1

- Repository moved to the official organization: https://github.com/tereno-xyz/plugin-tereno.
- Require `tereno-client@^0.6.2` (Base mainnet default, actionable budget and network errors).
- Reuse dividend figures now match the live catalog: 20% of the reuse price ($0.002-0.008 per reuse), capped at the capability's cold price in credit (tripled with an ERC-8004 publisher attestation). The old $0.10-$0.25 lifetime caps were out of date.
- `npmPackage` metadata corrected to `plugin-tereno`.

## 0.6.2

- Require `tereno-client@^0.5.2` for public quote authentication, V2 price-offer support and same-authorization timeout recovery.
- Retain pending payment recovery closures and daily budget reservations; repeated identical actions resume the original payment instead of signing another. Concurrent identical calls share one attempt and are accounted once.
- Report uncertain payment status explicitly and preserve fail-closed financial verdicts.
- Align contract.guard ($0.01–$0.03) and chain.snapshot ($0.01–$0.02) advertised prices with the current catalog.


## 0.6.1

- Bumped `tereno-client` dependency to `^0.5.1` to pick up the EIP-712 `publishContractFingerprint` resource fix and default 15s HTTP request timeout for cold Base simulations + x402 settlement.
- Updated `PLUGIN_VERSION` to `0.6.1`.

## 0.6.0

Expanded plugin-tereno to support the 6 canonical Tereno capabilities and the ERC-8183 Agent Escrow (ACP) evaluator standard.

### Added

- `TERENO_TOKEN_LAUNCH_GUARD` — `token.launch.guard` (`$0.02–$0.07` USDC over x402). Simulates sell/exit via `eth_call`, checks DEX LP reserves depth and burn/lock status, and inspects owner powers (honeypot, mint, fee traps).
- `TERENO_TOKEN_HOLDERS_GUARD` — `token.holders.guard` (`$0.01–$0.04` USDC over x402). Analyzes top 10 holder concentration (excluding LP & burn) and traces ETH funding origins to uncover deployer-funded cabal Sybil clusters.
- `TERENO_ACP_EVALUATE` — Evaluates ERC-8183 Agent Escrow tasks via Tereno's Evaluator adapter (`POST /api/acp/evaluate`). Returns EIP-712 `SignedVerdictProof`, score (0-100), `escrowReleaseEligible` flag, and permanent ERC-8004 validation document link.

### Changed

- Updated `CAPABILITY_PRICE_USD` to cover all 6 canonical capabilities.
- Compiled `dist/` with updated TypeScript types and actions.

## 0.5.1

Aligned the ElizaOS plugin with Tereno's focused 4-capability catalog (`contract.guard`, `token.metadata`, `chain.snapshot`, `prediction.evidence`), cooperative rules of engagement (`/agent.md`), and seeder reuse dividend economics.

### Added

- `TERENO_PREDICTION_EVIDENCE` — `prediction.evidence` (`$0.01–$0.05` USDC over x402). Gathers structured, reproducible on-chain and Polymarket evidence for a prediction market question.
- `TERENO_RULES` — Reads Tereno's cooperative rules of engagement (`/agent.md`): how cache sharing saves up to 80% on compute and how seeders earn 20% reuse dividends on open bounties.

### Changed

- Updated `CAPABILITY_PRICE_USD` and `DEFAULT_MAX_PRICE_USD` (`0.1`) to match the live 4-capability catalog (`contract.guard` `$0.02–$0.10`, `token.metadata` `$0.01–$0.03`, `chain.snapshot` `$0.002–$0.005`, `prediction.evidence` `$0.01–$0.05`).
- `TERENO_SEED` now fulfills payable bounties across `token.metadata`, `chain.snapshot` and `prediction.evidence` in addition to free signed fingerprint publishing for `contract.guard`.
- Action descriptions and `TERENO_PREVIEW` now explicitly state seeder reuse dividend economics (`20%` / `$0.002` per cross-wallet reuse).

### Removed

- Removed actions for capabilities retired in the 2026-09-20 catalog prune (`TERENO_CHECK_TRANSACTION`, `TERENO_CHECK_SWAP`, `TERENO_CONTRACT_CHANGED`, `TERENO_CONTRACT_INTERFACE`, `TERENO_COMPILE_WEB_PAGE`, `TERENO_OBLIGATION_VERDICT`, `TERENO_CHECK_X402_ENDPOINT`), which now return `410 capability_retired` on the network.

## 0.4.0

Two independent outages, both silent: the plugin compiled, every test passed and
`dist/` was in sync with `src/`. What had rotted was everything outside it.

### Fixed — the plugin could not buy anything

`TERENO_MAX_PRICE_USD` defaulted to `0.005` while the network moved to
`$0.01–0.05`. `tereno-client` refuses a quote above the cap *before* paying, so
every paid action threw, landed in the catch and returned a fail-verdict. With
the default fail-closed mode that meant the flagship action answered
**`⛔ BLOCK · abort · guard unavailable` to every transaction**, while never
spending a cent.

- `TERENO_MAX_PRICE_USD` default `0.005` → `0.05`
- `TERENO_DAILY_BUDGET_USD` default `0.05` → `0.5` (it was exactly one call)
- `TERENO_PREVIEW` now warns when the configured cap sits below the dearest
  check, instead of letting the agent discover it one failed verdict at a time

### Fixed — four actions returned 401

`tereno-client` was pinned to `0.2.0`, which signed the EIP-712 domain without
the `salt` the server has always required. Every signed route failed with a
plain "Invalid EIP-712 signature", indistinguishable from a real bad signature.
That covered `TERENO_PLEDGE_DEMAND`, `TERENO_SEED`, `TERENO_REPORT_OUTCOME`,
plus `lookup` and `feedback`.

- `tereno-client` `^0.2.0` → `^0.3.0`

### Fixed — advertised prices were 10× behind

Prices were inlined in a dozen description strings, the README and
`TERENO_PREVIEW`. They now come from one exported table, `CAPABILITY_PRICE_USD`,
which `bun test` asserts against `GET /api/v1/capabilities` on the live network.
A price change that is not mirrored here fails CI.

This is the second time this defect shipped (see `fix: reserve the real seed
price and correct stale capability prices`). The test is the stop.

- `TERENO_SEED` reserved `seederEconomics.lifetimeCapUsd` — the ceiling on what
  a seeder can *earn*, not what the call *costs*. It now reserves the
  capability's miss price.

### Added

- `TERENO_CHECK_SWAP` — `aerodrome.swap.guard`. Will this prepared Aerodrome
  swap still satisfy its own encoded limit? Refuses empty calldata locally, so
  the caller is told for free instead of paying to be told.
- `TERENO_CHECK_X402_ENDPOINT` — `x402.endpoint.assurance`. Is another x402
  endpoint callable, well-formed and unchanged since the last observation?
- `TERENO_OBLIGATION_VERDICT` — `obligation.verdict`. Was a published economic
  condition satisfied? Surfaces `decisionGrade: false` rather than hiding it.
- `TERENO_PLEDGE_DEMAND` now lists the capability names Tereno actually
  proposes, read from the catalog. The endpoint accepts any string, so a guessed
  name recorded demand for something that will never be built.

### Changed

- `viem` `^2.52.0` → `^2.56.0`
- The unsigned-transaction parser is shared between the two signing guards, so
  they cannot disagree about what a caller has to send.

### Upgrade note

`tereno-client@0.3.0` must be published before this release installs. The
lockfile still resolves `0.2.1`; run `npm install` once `0.3.0` is on the
registry to regenerate it.
