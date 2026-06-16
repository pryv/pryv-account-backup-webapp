# Changelog

## 0.2.0 — UNRELEASED — Attachments / HFS / webhooks + portable `sync-state.json` + backloop.dev dev server

Closes the v0.1.0 coverage gap. The webapp now offers feature parity with the CLI for read-side resources and ships a true cross-session incremental story.

### Added

- **Attachments / HFS / webhooks toggles** in the Advanced section of the login form. Attachments is opt-in (binary streams are larger than text resources, so the default keeps the ZIP small). HFS series data + webhooks default ON (text-only payloads, small).
- **Pre-login state panel** — on page load the UI scans `localStorage` for prior sync states keyed by apiEndpoint and renders a status card per entry: tool version, last run timestamp, events / audit `modifiedSince` thresholds, pending refs (carry-over from interrupted prior runs; re-discovered automatically), and a **Reset (clear this state)** button. Subjects who switch devices or clear browser data can also upload a previously downloaded `sync-state.json` via a file picker — the orchestrator imports the kv state on login so the next run goes incremental.
- **Portable `sync-state.json` export** — every successful backup run writes a `sync-state.json` into the final ZIP (kv state only: `lastRunAt` + per-resource `lastModifiedSince` + tool/format version). Schema lives at [`pryv-account-backup/docs/sync-state.md`](https://github.com/pryv/pryv-account-backup/blob/master/docs/sync-state.md). The subject keeps it alongside the ZIPs and re-uploads it on the next visit.
- **Per-category ref tracking via `LocalStorageStateStore`** — the store mirrors the `FolderStateStore` extension shipped in `@pryv/account-backup` v0.7.0: `pushRef` / `listPending` / `markDone` / `clearCategory` for the `attachment`, `series-event`, `webhook` categories, plus `export()` / `import()` for portability. Refs are populated by `api-resources.onParsed` / `events-chunked.onEvents` hooks during the streaming fetch and drained by the per-method modules.
- **`backloop.dev` HTTPS dev server** by default — `npm run serve` now spawns [`backloop.dev`](https://npm.im/backloop.dev) as a static-file front-end at `https://backup.backloop.dev:4443/`. Required because the webapp talks to remote HTTPS Pryv APIs (`reg.pryv.me`, operator-hosted cores); browsers block mixed-content from an `http://localhost` page and CORS preflight from a non-HTTPS origin fails. Override via `BACKLOOP_SUBDOMAIN` + `BACKLOOP_PORT` env vars.

### Fixed

- **`async` was being stubbed by the esbuild alias list**, which silently broke any call to `async.mapLimit` in the bundled `pryv-account-backup` modules — symptoms ranged from a clean skip (when `refs.length === 0` short-circuited before the call site) to a silent hang with an `Uncaught (in promise)` console error (when refs were present). Surfaced during the v0.2.0 webhooks-drain smoke; fixed by dropping `async` from `esbuild.config.js` `alias`. The bundle grows by ~23 KB (54 → 89 KB minified), which is the cost of bundling the actual `async` npm package alongside the rest of the code. `async` is pure JS — bundles fine; the original stub assumed the browser code path never touched `async.mapLimit`, which became false in v0.2.0.

### Changed

- **`pryv-account-backup` dep pinned to v0.7.0** (was `master`). The new ref-tracking + portable export/import contract requires the library-side extension.
- **`package.json` `version` bumped to `0.2.0`**.

### Compatibility

- A v0.1.0 ZIP bundle is still readable as a backup — it's a sequence of standard ZIPs containing JSON files. The cross-ZIP `backup-index.json` format is unchanged.
- `localStorage` state from a v0.1.0 install (which only carried kv state, no refs) is auto-hoisted into the v0.2.0 `{ kv, refs }` shape on load.

## 0.1.0 — Initial release

- Vanilla JS + esbuild bundle (~54 KB minified) + fflate for ZIPs.
- Three-screen UX: login → progress → done.
- Coverage: account, streams, accesses + accesses-all, profile/private + profile/public, audit-as-events, events (chunked initial + incremental), per-app profiles, opt-in per-access version history.
- `LocalStorageStateStore` for incremental thresholds, namespaced by apiEndpoint.
- `BrowserBlobZipStorageWriter` accumulates entries into in-memory ZIPs, triggers `<a download>` at the configured threshold.
- Not in v0.1.0: attachments, HFS series data points, webhooks, sha256 manifest. Subjects who needed those used the CLI flavor.
