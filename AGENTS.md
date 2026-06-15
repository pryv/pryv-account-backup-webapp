# Agent orientation — `pryv-account-backup-webapp`

This repo is a **sample webapp** consumed by implementers who fork + rebrand. It is not the source of truth for backup logic — that lives in [`pryv-account-backup`](https://github.com/pryv/pryv-account-backup) (the CLI + library). Agents touching this repo should preserve the small-codebase aesthetic: every dependency added increases the implementer's fork-and-customize cost.

## What this is

A static site (HTML + CSS + JS) bundled by esbuild. Four screens: login (+ pre-login state panel) → progress → done → error. Vanilla JS — no framework. The orchestrator in `src/app.js` is ~350 LOC; the two adapters in `src/lib/` are <150 LOC each.

The webapp consumes the **browser-isomorphic** per-method modules from `@pryv/account-backup` v0.7.0+:

- `api-resources` — generic JSON resource → writer pipeline; supports an opt-in `onParsed(doc)` tee for ref extraction
- `events-chunked` — events with monthly chunks OR incremental `modifiedSince`; supports an `onEvents(events[])` lift wired to push attachment + series-event refs into the StateStore
- `audit-as-events` — audit fetched via `events.get` on `:_audit:*` streams (the dedicated `/audit/logs` endpoint was **removed** from open-pryv.io on 2026-06-15 at commit `19d1c11f`; v0.5.0 and earlier of `pryv-account-backup` are now production-broken for the audit-log section against any deployment running that build)
- `accesses-history` — opt-in per-access version history (in-memory accesses array)
- `attachments` — drains the `attachment` category from the StateStore; binary stream pipe to the writer
- `hf-data` — drains the `series-event` category; per-event data-points fetch
- `webhooks-export` — drains the `webhook` category; per-access `/webhooks` fetch + aggregated `webhooks.json`

It does NOT consume `manifest` from the library — sha256 tamper-evidence stays CLI-only.

## Hot-path data flow

1. **Pre-login** — UI scans `localStorage` for any `pryv-account-backup:state:<apiEndpoint>` entries and renders a status panel per entry (toolVersion, lastRunAt, events / audit thresholds, pending refs, **Reset** action per saved state). Also exposes a file picker for "Resume from a prior `sync-state.json`" — uploaded files are parsed and held in memory until login completes.
2. Subject submits username + password to the login form.
3. `pryv.Service.login` returns a personal token + apiEndpoint.
4. Orchestrator applies pre-login choices in order: forget → upload-import → defaults. Constructs `LocalStorageStateStore` (key namespaced by apiEndpoint) + `BrowserBlobZipStorageWriter` (configurable ZIP size, default 100 MB).
5. Orchestrator reads prior state's `lastRunAt` / `events.lastModifiedSince` / `audit.lastModifiedSince`. Falls back to initial-fetch mode when state is absent.
6. **Stale-refs clear** — at run-start, all three ref categories (`attachment`, `series-event`, `webhook`) are cleared from the store; the streams below re-discover anything still relevant via `modifiedSince`.
7. Per-resource sequence — each step calls the library module with `connection + writer + state + options`:
   - **metadata** — `account`, `streams`, `accesses` (with `onParsed` tee → pushes `webhook` refs), `accesses-all`, `profile/private`, `profile/public`
   - **audit-as-events** — single incremental call
   - **events** — chunked (initial) or single incremental call; `onEvents` lift pushes `attachment` + `series-event` refs as parsed
   - **app-profiles** — per `app`-type access from the captured accesses array
   - **access-history** — opt-in; one fetch per access
   - **attachments drain** — `attachments.download(connection, writer, state, ...)` drains the `attachment` category
   - **hf-data drain** — `hf-data.download(...)` drains `series-event`
   - **webhooks drain** — `webhooks-export.download(...)` drains `webhook`
8. State store flushes `lastRunAt` + per-resource thresholds + tool/format version.
9. Orchestrator calls `state.export()` and writes the result to `sync-state.json` via the writer — this is the portable artefact the subject keeps to drive the next cross-session incremental.
10. `writer.finalizeBatch()` emits the last ZIP (which includes both `backup-index.json` and `sync-state.json`).

## Phases I should NOT cross without operator approval

- **Adding backend code.** This is a static site by design. If the orchestration needs server-side help (job queue, signed URL, etc.), open an issue or escalate to the operator — do not add an Express/Node server.
- **Pulling in a UI framework.** Vanilla JS + vanilla CSS is intentional. Vue / React / Alpine etc. add fork cost.
- **Adding the sha256 manifest.** `manifest.js` stays Node-only — the webapp's lack of a manifest is a deliberate trade-off (the subject answering their own DSAR doesn't need third-party-auditor tamper-evidence; the ZIPs are signed by the operator's TLS already).
- **Touching MFA handling beyond the current "use the CLI" error.** The independent-MFA-webpage direction is a separate effort; do not improvise it here.
- **Dropping `backloop.dev` from the dev server.** Bare `localhost` breaks the moment the webapp talks to remote HTTPS APIs (mixed-content + CORS preflight). Keep the `backloop.dev` front-end in `esbuild.config.js`.

## Build + test cadence

- `npm install && npm run build` should always succeed (verified by hand; CI not wired yet).
- `npm run serve` opens a `backloop.dev` static server at `https://backup.backloop.dev:4443/` (HTTPS, signed cert, proxies to localhost).
- No unit tests in this repo; the contract is enforced by the `[PALI]` suite in `pryv-account-backup`. Integration verification happens against a real Pryv lab instance — operator drives the lab smoke test.

## Dependency hygiene

- Three runtime dependencies: `pryv` (lib-js), `pryv-account-backup` (CLI + library), `fflate` (ZIP). The bundle is ~89 KB minified (v0.2.0; up from ~54 KB in v0.1.0 because `async` is now bundled rather than stubbed — required by the binary-attachment / HFS / webhooks drainers which call `async.mapLimit`).
- Two dev dependencies: `esbuild`, `backloop.dev`.
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
