# Changelog

## 0.3.0 - 2026-11-27 - Multi-factor sign-in + hand-off parameters + library v0.8.1

### Added

- **Hand-off parameters.** A calling app (for example an account app's data-rights page) can open
  the webapp with `?pryvServiceInfoUrl=…` to pre-fill the platform, and with `backUrl` /
  `backLabel` to show a back link (http/https only). No token is passed: the subject signs in on
  the page.

### Fixed

- **Accounts with multi-factor authentication can be backed up.** Before, the sign-in stopped
  and the page said to use the CLI. After the password, the login form now asks for the code from
  the authenticator app (TOTP) or the code sent by SMS, with a **Send a new code** button for SMS.
  A wrong code shows the error and can be typed again, up to 3 times, after which the person signs
  in again. Recovery codes are not accepted, since on the platform a recovery code turns
  multi-factor authentication off on the account; the form points a person who lost their second
  factor to the recovery in their account app. The footer note sending MFA accounts to the CLI is
  replaced. The MFA token and the code are never logged. An expired sign-in goes back to the
  password step with a message; a network failure or a temporary refusal keeps the code step
  open; a blank code is not sent. While a code is checked, Cancel and **Send a new code** are
  disabled, and an answer arriving after a cancel is ignored. The password field is cleared once
  signed in.
- Development: `npm test` builds the bundle and runs `test/mfa-smoke.js`, a login-form test with a
  fake DOM and a mocked platform (no network).
- Elements carrying the `hidden` attribute stay hidden even when a stylesheet rule gives them a
  `display` (the hand-off back link was laid out while hidden).
- An unreadable `sync-state.json` upload is reported in the login form instead of a native browser
  alert.
- The browser bundle no longer crashes on load: `Buffer` is polyfilled for a dependency of the
  `pryv` library.
- The attachments / HFS / webhooks steps no longer crash in the browser: the lockfile resolved the
  moving `#v0.7.0` pin to a commit from before the library's browser-isomorphic drainers. The
  dependency is pinned to the isomorphic commit, then to the immutable tag v0.7.1.

### Changed

- **`pryv-account-backup` dep pinned to v0.8.0** (was v0.7.1), to stay on the current library tag.
  No functional change for the webapp: the modules it imports (`src/methods/*`) only gained license
  headers; the library's other changes are in restore, the CLI scripts and Node-side directory
  handling, none of which the webapp uses.
- **`pryv-account-backup` dep pinned to v0.8.1** (was v0.8.0). The library's fixes reach the
  webapp through the modules it calls: incremental runs collect every changed event (trashed ones
  included) and every deletion instead of stopping at 20, and the audit log is read in full instead
  of stopping at 20 rows. An incremental run writes its audit rows to
  `audit_logs-incremental-<TS>.json` instead of `audit_logs.json`.
- **The incremental threshold comes from the server clock.** The run's timestamp (`lastRunAt`, the
  next run's `modifiedSince`, and the `<TS>` in the incremental file names) is `meta.serverTime` of
  an `access-info` call made before any data is read, instead of the device clock: a device clock
  ahead of the server made the next run skip changes made during the run. When the server time
  cannot be read, the device clock is used and a note says so on the progress screen. The audit step
  now gets the same timestamp as the events step, so both incremental files carry the same `<TS>`.
- The tool version recorded in the sync state is read from the library's package.
- `pryv` updated to 3.20.0; the `backloop.dev` dev dependency is installed from its GitHub tag.
- README, AGENTS.md and footer: the bundle holds no usable MFA secret or recovery codes (since
  open-pryv.io 2.0.0-rc.27).

## 0.2.0 - 2026-06-16 - Attachments / HFS / webhooks + portable `sync-state.json` + backloop.dev dev server

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

## 0.1.0 - 2026-06-15 - Initial release

- Vanilla JS + esbuild bundle (~54 KB minified) + fflate for ZIPs.
- Three-screen UX: login → progress → done.
- Coverage: account, streams, accesses + accesses-all, profile/private + profile/public, audit-as-events, events (chunked initial + incremental), per-app profiles, opt-in per-access version history.
- `LocalStorageStateStore` for incremental thresholds, namespaced by apiEndpoint.
- `BrowserBlobZipStorageWriter` accumulates entries into in-memory ZIPs, triggers `<a download>` at the configured threshold.
- Not in v0.1.0: attachments, HFS series data points, webhooks, sha256 manifest. Subjects who needed those used the CLI flavor.
