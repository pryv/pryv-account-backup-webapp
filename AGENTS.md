# Agent orientation — `pryv-account-backup-webapp`

This repo is a **sample webapp** consumed by implementers who fork + rebrand. It is not the source of truth for backup logic — that lives in [`pryv-account-backup`](https://github.com/pryv/pryv-account-backup) (the CLI + library). Agents touching this repo should preserve the small-codebase aesthetic: every dependency added increases the implementer's fork-and-customize cost.

## What this is

A static site (HTML + CSS + JS) bundled by esbuild. Three screens: login → progress → done. Vanilla JS — no framework. The orchestrator in `src/app.js` is ~250 LOC; the two adapters in `src/lib/` are <100 LOC each.

The webapp consumes the **browser-isomorphic** per-method modules from `@pryv/account-backup` v0.6.0+:

- `api-resources` — generic JSON resource → writer pipeline
- `events-chunked` — events with monthly chunks OR incremental `modifiedSince`
- `audit-as-events` — audit fetched via `events.get` on `:_audit:*` streams (the dedicated `/audit/logs` endpoint is being removed from open-pryv.io)
- `accesses-history` — opt-in per-access version history

It does NOT consume `attachments`, `hf-data`, `webhooks-export`, `manifest` from the library — those stay Node-only in v0.6.0. The webapp's coverage is the **read-side text resources** + their incremental story.

## Hot-path data flow

1. Subject submits username + password to the login form.
2. `pryv.Service.login` returns a personal token + apiEndpoint.
3. Orchestrator constructs `LocalStorageStateStore` (key namespaced by apiEndpoint) + `BrowserBlobZipStorageWriter` (configurable ZIP size, default 100 MB).
4. Orchestrator reads prior state's `lastRunAt` / `events.lastModifiedSince` / `audit.lastModifiedSince`. Falls back to initial-fetch mode when state is absent.
5. Per-resource sequence (metadata → audit → events → app-profiles → access-history) — each step calls the library module with `connection + writer + options`.
6. After all steps, `writer.finalizeBatch()` emits the last ZIP (which includes `backup-index.json` cross-ZIP file directory).
7. State store flushes `lastRunAt` etc. for the next incremental run.

## Phases I should NOT cross without operator approval

- **Adding backend code.** This is a static site by design. If the orchestration needs server-side help (job queue, signed URL, etc.), open an issue or escalate to the operator — do not add an Express/Node server.
- **Pulling in a UI framework.** Vanilla JS + vanilla CSS is intentional. Vue / React / Alpine etc. add fork cost.
- **Adding attachments / HFS / webhooks / sha256 manifest.** These are Node-only in `pryv-account-backup` v0.6.0. The webapp's "use the CLI for these" narrative is load-bearing.
- **Touching MFA handling beyond the current "use the CLI" error.** The independent-MFA-webpage direction is a separate plan; do not improvise it here.

## Build + test cadence

- `npm install && npm run build` should always succeed (verified by hand; CI not wired yet).
- `npm run serve` opens an esbuild dev server at `http://127.0.0.1:8080`.
- No unit tests in this repo. Integration verification happens against a real Pryv lab instance — operator drives the lab smoke test.

## Dependency hygiene

- Three runtime dependencies: `pryv` (lib-js), `pryv-account-backup` (CLI + library), `fflate` (ZIP). The bundle is ~54 KB minified.
- One dev dependency: `esbuild`.
- `pryv-account-backup` is consumed via a `github:` URL because it is not on the npm registry (and is not planned to be). Pin the exact branch / tag in `package.json` when you bump it.

## Operator security note

The bundle the webapp produces carries `profile_private.json`, which includes `profile.mfa.recoveryCodes` verbatim when MFA is enabled — these are SMS-bypass tokens. Document this clearly in any operator-facing customisation guide; consider advising the subject to rotate recovery codes after the disclosure.

## Distribution

- License: BSD-3-Clause.
- Released as git tags; no npm publish.
- Fork-friendly: implementers can rebrand by editing CSS custom properties + the HTML headline. The orchestrator is intentionally a single file.

## Companion repos

- [`pryv-account-backup`](https://github.com/pryv/pryv-account-backup) — the CLI + library.
- [`lib-js`](https://github.com/pryv/lib-js) (npm `pryv`) — Pryv API client; `Service.login` + `Connection`.

Previous-generation operator-hosted backup service: [`pryv/example-service-bluebutton`](https://github.com/pryv/example-service-bluebutton) (archived; superseded by this repo).
