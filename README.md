# pryv-account-backup-webapp

Sample browser-based Pryv account backup web app — companion to [`@pryv/account-backup`](https://github.com/pryv/pryv-account-backup) (the CLI + library). Operator-hosted; subjects log in, click **Start backup**, and download a series of ZIP files containing their portable account dump.

## What this is

A minimal reference UI for the subject side of a Pryv DSAR (Data Subject Access Request) flow. The webapp does not implement the backup logic itself — it uses the browser-isomorphic resource fetchers exported by [`@pryv/account-backup`](https://github.com/pryv/pryv-account-backup) (`api-resources`, `events-chunked`, `audit-as-events`, `accesses-history`).

Implementers are expected to fork and rebrand. Total runtime size is ~150 LOC of vanilla JS + one CSS file; no framework, no build templating beyond esbuild's bundle step.

## What's in the bundle

Each backup run produces a series of ZIP files (default 100 MB each; configurable in the UI). The ZIPs together contain:

- `account.json`, `streams.json`, `accesses.json`, `accesses-all.json` (deletions + expired), `profile_private.json`, `profile_public.json`
- `events-YYYY-MM.json` (monthly chunks, initial run) OR `events-incremental-<TS>.json` (subsequent runs, only events `modified > lastRun`)
- `audit_logs.json` (fetched via the standard events API on the `:_audit:*` store streams)
- `app_profiles/profile_app_<accessId>.json` (one per `app`-type access)
- `accesses-history/<accessId>.json` (opt-in via the Advanced section)
- `backup-index.json` (in the **last** ZIP — cross-ZIP file directory; restore reads this to learn which ZIP carries which file)

**Not included by the webapp** (use the CLI flavor for these):

- File attachments (binary streams)
- High-frequency series data points (`hf-data/`)
- Webhooks per access
- Per-file sha256 integrity manifest

The webapp focuses on the read-side text resources; CLI handles binary streaming.

## Deploy

Prerequisites: Node 18+.

```bash
git clone https://github.com/pryv/pryv-account-backup-webapp.git
cd pryv-account-backup-webapp
npm install
npm run build       # produces dist/
```

Serve `dist/` from any static HTTP server **on the same origin as the Pryv API** (or with CORS configured). For local development:

```bash
npm run serve       # esbuild dev server at http://127.0.0.1:8080
```

For production, copy `dist/` to your web server's document root. The webapp is fully static; no backend required.

## Security model

The subject's username + password are submitted via the form. `Service.login` (from [`pryv`](https://www.npmjs.com/package/pryv) lib-js) calls the Pryv API on the same origin, returns a personal token, and the webapp uses that token for every subsequent fetch. **Operator hosts the webapp on a domain the subject already trusts** (same-origin as the Pryv API endpoint) so the address bar shows the subject's normal Pryv hostname.

The webapp does **not** handle MFA challenges. If a subject has MFA enabled, point them at the CLI version of the backup tool — the CLI inherits MFA handling from lib-js's `Service.login` SMS-challenge flow.

**Operator security note:** the backup bundle includes `profile_private.json`, which carries `profile.mfa.recoveryCodes` (10 SMS-bypass tokens) when MFA is enabled. Treat the downloaded files as sensitive — transport over a secure channel; consider rotating MFA recovery codes after the disclosure is complete. This is by-design (the subject is entitled to their full MFA state) but worth flagging in your subject-facing documentation.

## Customising

The whole UI is in `src/`:

- `index.html` — three screens (login / progress / done) + an error screen
- `style.css` — minimal styling; rebrand by editing the CSS custom properties at the top
- `src/app.js` — orchestrator + UI controller (~250 LOC)
- `src/lib/LocalStorageStateStore.js` — incremental-state adapter (matches `FolderStateStore` in the CLI library)
- `src/lib/BrowserBlobZipStorageWriter.js` — accumulates files into in-memory ZIPs, downloads via `<a download>`

## License

BSD-3-Clause. See `LICENSE`.
