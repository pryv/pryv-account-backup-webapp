/**
 * Pryv account backup — minimum sample webapp.
 *
 * Four screens: status → login → progress → done. Vanilla JS + the
 * `@pryv/account-backup` library's isomorphic per-method modules. Backup
 * driven through the `LocalStorageStateStore`: every fetch tees parsed
 * refs into the store; per-resource drainers (attachments, hf-data,
 * webhooks-export) read pending refs from there.
 *
 * Cross-session incremental: the run-end exports a `sync-state.json` into
 * the final ZIP. The subject keeps it alongside the ZIPs and re-uploads
 * it on the next visit; the upload seeds the store with prior thresholds
 * so only modifiedSince events flow over the wire.
 *
 * Implementers are expected to fork + rebrand. LOC stays small on purpose
 * so the fork stays manageable.
 */
import * as pryv from 'pryv';
import apiResources from 'pryv-account-backup/src/methods/api-resources.js';
import * as eventsChunked from 'pryv-account-backup/src/methods/events-chunked.js';
import * as auditAsEvents from 'pryv-account-backup/src/methods/audit-as-events.js';
import * as accessesHistory from 'pryv-account-backup/src/methods/accesses-history.js';
import * as attachments from 'pryv-account-backup/src/methods/attachments.js';
import * as hfData from 'pryv-account-backup/src/methods/hf-data.js';
import * as webhooksExport from 'pryv-account-backup/src/methods/webhooks-export.js';

import { LocalStorageStateStore } from './lib/LocalStorageStateStore.js';
import { BrowserBlobZipStorageWriter } from './lib/BrowserBlobZipStorageWriter.js';

const APP_ID = 'pryv-backup-webapp';
const STATE_KEY_PREFIX = 'pryv-account-backup:state:';
const SYNC_STATE_FILE = 'sync-state.json';
const RESOURCE_STEPS = [
  { id: 'metadata', label: 'Account, streams, profile, accesses' },
  { id: 'audit', label: 'Audit log' },
  { id: 'events', label: 'Events' },
  { id: 'app-profiles', label: 'Per-app profiles' },
  { id: 'access-history', label: 'Per-access version history' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'hf-data', label: 'HFS series data points' },
  { id: 'webhooks', label: 'Webhooks' }
];

// Holds an uploaded sync-state.json (parsed) until login completes + the
// store knows its apiEndpoint. `null` if the subject didn't upload one.
let uploadedSyncState = null;
// Records the apiEndpoints the subject chose to FORGET pre-login; cleared
// at login time before the matching store is instantiated.
const forgottenEndpoints = new Set();

const $ = (id) => document.getElementById(id);

function show (screenId) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(screenId).classList.remove('hidden');
}

function fail (msg) {
  $('error-message').textContent = msg;
  show('screen-error');
}

// ─── Pre-login sync-state panel ──────────────────────────────────────────

function listLocalStorageStates () {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(STATE_KEY_PREFIX)) continue;
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed == null) continue;
      const kv = parsed.kv || parsed; // hoist pre-v0.7.0 flat layout
      entries.push({
        apiEndpoint: key.slice(STATE_KEY_PREFIX.length),
        kv: kv || {},
        refsPending: countPendingRefs(parsed.refs || {})
      });
    } catch (_) { /* skip unreadable */ }
  }
  return entries;
}

function countPendingRefs (refs) {
  let n = 0;
  for (const cat of Object.keys(refs)) {
    for (const r of refs[cat] || []) if (!r.done) n++;
  }
  return n;
}

function fmtTime (sec) {
  if (sec == null) return '—';
  try { return new Date(sec * 1000).toISOString(); } catch (_) { return '—'; }
}

function renderStatePanel () {
  const panel = $('state-panel');
  panel.innerHTML = '';
  const states = listLocalStorageStates();
  if (states.length === 0 && uploadedSyncState == null) {
    panel.innerHTML = '<p class="muted">No prior sync state found in this browser. ' +
      'A full backup will run. To resume from a prior run, upload a <code>sync-state.json</code> below.</p>';
    return;
  }
  if (uploadedSyncState != null) {
    const card = document.createElement('div');
    card.className = 'state-card uploaded';
    card.innerHTML = '<h3>Uploaded sync state</h3>' +
      '<dl>' +
      '<dt>Tool version</dt><dd>' + escape(uploadedSyncState.toolVersion || '—') + '</dd>' +
      '<dt>Created at</dt><dd>' + escape(uploadedSyncState.createdAt || '—') + '</dd>' +
      '<dt>Last run at</dt><dd>' + fmtTime(uploadedSyncState.kv && uploadedSyncState.kv.lastRunAt) + '</dd>' +
      '<dt>Events fetched up to</dt><dd>' + fmtTime(uploadedSyncState.kv && uploadedSyncState.kv['events.lastModifiedSince']) + '</dd>' +
      '<dt>Audit fetched up to</dt><dd>' + fmtTime(uploadedSyncState.kv && uploadedSyncState.kv['audit.lastModifiedSince']) + '</dd>' +
      '</dl>' +
      '<p>This will seed the store at login and supersede any matching browser state.</p>' +
      '<button type="button" data-action="clear-upload">Discard upload</button>';
    panel.appendChild(card);
  }
  for (const s of states) {
    const isForgotten = forgottenEndpoints.has(s.apiEndpoint);
    const card = document.createElement('div');
    card.className = 'state-card' + (isForgotten ? ' forgotten' : '');
    card.innerHTML = '<h3>Saved state — ' + escape(s.apiEndpoint) + '</h3>' +
      (isForgotten
        ? '<p class="muted">Will be cleared at login.</p>'
        : '<dl>' +
          '<dt>Tool version</dt><dd>' + escape(s.kv.toolVersion || '—') + '</dd>' +
          '<dt>Last run at</dt><dd>' + fmtTime(s.kv.lastRunAt) + '</dd>' +
          '<dt>Events fetched up to</dt><dd>' + fmtTime(s.kv['events.lastModifiedSince']) + '</dd>' +
          '<dt>Audit fetched up to</dt><dd>' + fmtTime(s.kv['audit.lastModifiedSince']) + '</dd>' +
          '<dt>Pending refs</dt><dd>' + s.refsPending + ' (will be re-discovered)</dd>' +
          '</dl>'
      ) +
      '<button type="button" data-endpoint="' + escape(s.apiEndpoint) + '" data-action="' +
        (isForgotten ? 'unforget' : 'forget') + '">' +
        (isForgotten ? 'Keep' : 'Reset (clear this state)') +
      '</button>';
    panel.appendChild(card);
  }
}

function escape (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// File-picker for prior sync-state.json
$('sync-state-upload').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (parsed.format !== 'pryv-account-backup-sync-state') {
      throw new Error('Unrecognized file format (expected pryv-account-backup-sync-state).');
    }
    uploadedSyncState = parsed;
    renderStatePanel();
  } catch (err) {
    alert('Could not read sync-state.json: ' + (err.message || err));
    e.target.value = '';
  }
});

// Pre-login actions: Reset / Forget / Discard upload
$('state-panel').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'forget') {
    forgottenEndpoints.add(btn.dataset.endpoint);
  } else if (action === 'unforget') {
    forgottenEndpoints.delete(btn.dataset.endpoint);
  } else if (action === 'clear-upload') {
    uploadedSyncState = null;
    $('sync-state-upload').value = '';
  }
  renderStatePanel();
});

// ─── Login form ──────────────────────────────────────────────────────────

// Sync the ZIP-size slider's <output>.
const zipSlider = $('zipSizeMb');
const zipOut = $('zipSizeMbValue');
zipSlider.addEventListener('input', () => { zipOut.textContent = zipSlider.value; });

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ctx = {
    serviceInfoUrl: $('serviceInfoUrl').value.trim(),
    username: $('username').value.trim(),
    password: $('password').value,
    zipSizeMb: parseInt(zipSlider.value, 10),
    includeTrashed: $('includeTrashed').checked,
    includeAttachments: $('includeAttachments').checked,
    includeHfData: $('includeHfData').checked,
    includeWebhooks: $('includeWebhooks').checked,
    includeAccessHistory: $('includeAccessHistory').checked
  };
  show('screen-progress');
  try {
    await runBackup(ctx);
  } catch (err) {
    console.error(err);
    fail(err.message || String(err));
  }
});

$('reset-button').addEventListener('click', () => { location.reload(); });
$('error-reset-button').addEventListener('click', () => { location.reload(); });

// ─── Orchestration ───────────────────────────────────────────────────────

async function runBackup (ctx) {
  $('progress-status').textContent = 'Connecting…';
  const service = new pryv.Service(ctx.serviceInfoUrl);
  await service.info();
  const connection = await service.login(ctx.username, ctx.password, APP_ID);
  if (!connection || !connection.endpoint || !connection.token) {
    throw new Error('Login failed — if your account has MFA enabled, please use the CLI version.');
  }

  setupProgressUI();

  const apiEndpoint = connection.endpoint;

  // Apply pre-login choices: forget-then-import-then-default.
  if (forgottenEndpoints.has(apiEndpoint)) {
    localStorage.removeItem(STATE_KEY_PREFIX + apiEndpoint);
  }
  const state = new LocalStorageStateStore(apiEndpoint);
  if (uploadedSyncState != null) {
    await state.import(uploadedSyncState);
    $('progress-status').textContent = 'Seeded store from uploaded sync-state.json.';
  }

  const writer = new BrowserBlobZipStorageWriter({
    zipSizeMb: ctx.zipSizeMb,
    onZipReady: (info) => {
      const li = document.createElement('li');
      li.textContent = info.name + ' (' + prettyBytes(info.size) + ')';
      $('downloads-list').appendChild(li);
    }
  });

  const runStartedAt = Math.floor(Date.now() / 1000);
  const priorRunAt = await state.get('lastRunAt');
  const eventsModifiedSince = priorRunAt ? await state.get('events.lastModifiedSince') : null;
  const auditModifiedSince = priorRunAt ? await state.get('audit.lastModifiedSince') : null;

  // Carry-over refs from a prior interrupted run get re-discovered via
  // the streams below; clear them so phantom pending refs don't linger.
  await Promise.all([
    state.clearCategory('attachment'),
    state.clearCategory('series-event'),
    state.clearCategory('webhook')
  ]);

  // Step 1 — metadata + ref tee
  await fetchMetadata(connection, writer, state, ctx);
  markDone('metadata');

  // Step 2 — audit
  await runStep('audit', () => callbackify(
    auditAsEvents.download,
    connection, writer,
    { includeTrashed: ctx.includeTrashed, modifiedSince: auditModifiedSince }
  ));

  // Step 3 — events with onEvents tee for attachment + series-event refs
  await runStep('events', () => callbackify(
    eventsChunked.download,
    connection, writer,
    {
      includeTrashed: ctx.includeTrashed,
      modifiedSince: eventsModifiedSince,
      runStartedAt: runStartedAt,
      onEvents: (events) => pushEventRefs(state, events)
    }
  ));

  // Step 4 — per-app profiles (uses accesses array captured during fetchMetadata)
  await fetchAppProfiles(connection, writer);
  markDone('app-profiles');

  // Step 5 — per-access history (opt-in)
  if (ctx.includeAccessHistory) {
    await runStep('access-history', () => callbackify(
      accessesHistory.download,
      connection, writer,
      writer.__accessesArray || []
    ));
  } else {
    skipStep('access-history', 'opt-in: not requested');
  }

  // Step 6 — attachments drain (opt-in)
  if (ctx.includeAttachments) {
    await runStep('attachments', () => callbackify(
      attachments.download,
      connection, writer, state, {}
    ));
  } else {
    skipStep('attachments', 'opt-in: not requested');
  }

  // Step 7 — HFS series drain
  if (ctx.includeHfData) {
    await runStep('hf-data', () => callbackify(
      hfData.download,
      connection, writer, state, {}
    ));
  } else {
    skipStep('hf-data', 'opt-out: skipped');
  }

  // Step 8 — webhooks drain
  if (ctx.includeWebhooks) {
    await runStep('webhooks', () => callbackify(
      webhooksExport.download,
      connection, writer, state, {}
    ));
  } else {
    skipStep('webhooks', 'opt-out: skipped');
  }

  // Persist thresholds for the next run
  await state.set('formatVersion', LocalStorageStateStore.FORMAT_VERSION);
  await state.set('toolVersion', '0.7.0');
  await state.set('lastRunAt', runStartedAt);
  await state.set('events.lastModifiedSince', runStartedAt);
  await state.set('audit.lastModifiedSince', runStartedAt);

  // Export the portable sync-state.json into the final ZIP
  const snapshot = await state.export();
  await new Promise((resolve, reject) => {
    const ws = writer.openWriteStream(SYNC_STATE_FILE);
    ws.write(JSON.stringify(snapshot, null, 2));
    ws.end((err) => err ? reject(err) : resolve());
  });

  await writer.finalizeBatch();

  $('progress-status').textContent = 'Done. ' + writer.downloads.length + ' ZIP file(s) downloaded.';
  show('screen-done');
}

function pushEventRefs (state, events) {
  return Promise.all(events.map(async (e) => {
    if (e && Array.isArray(e.attachments)) {
      for (const att of e.attachments) {
        if (!att || !att.id) continue;
        await state.pushRef('attachment', {
          key: e.id + ':' + att.id,
          eventId: e.id,
          attId: att.id,
          fileName: att.fileName || att.id,
          readToken: att.readToken
        });
      }
    }
    if (e && typeof e.type === 'string' && e.type.indexOf('series:') === 0) {
      await state.pushRef('series-event', { key: e.id, eventId: e.id, type: e.type });
    }
  }));
}

async function fetchMetadata (connection, writer, state, ctx) {
  $('progress-status').textContent = 'Fetching account + streams + accesses + profile…';
  setActive('metadata');
  const streamsRes = ctx.includeTrashed ? 'streams?state=all' : 'streams';
  const accessesAll = 'accesses?includeDeletions=true&includeExpired=true';
  const resources = [
    { res: 'account' },
    { res: streamsRes },
    { res: 'accesses', captureAs: 'accesses', onParsed: (doc) => pushWebhookRefs(state, doc) },
    { res: accessesAll, extra: '-all' },
    { res: 'profile/private' },
    { res: 'profile/public' }
  ];
  for (const item of resources) {
    await new Promise((resolve, reject) => {
      apiResources.toJSONFile({
        writer: writer,
        resource: item.res,
        extraFileName: item.extra || '',
        connection: connection,
        onParsed: item.onParsed
      }, (err) => err ? reject(err) : resolve(), () => {});
    });
    if (item.captureAs === 'accesses') {
      const buf = writer.currentEntries['accesses.json'];
      if (buf) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(buf));
          writer.__accessesArray = parsed.accesses || [];
        } catch (_) { /* leave undefined */ }
      }
    }
  }
}

function pushWebhookRefs (state, doc) {
  const accesses = Array.isArray(doc.accesses) ? doc.accesses : [];
  return Promise.all(accesses.map(async (a) => {
    if (!a || typeof a.token !== 'string' || a.token.length === 0) return;
    await state.pushRef('webhook', { key: a.id, accessId: a.id, token: a.token, type: a.type });
  }));
}

async function fetchAppProfiles (connection, writer) {
  $('progress-status').textContent = 'Fetching per-app profiles…';
  setActive('app-profiles');
  const accesses = writer.__accessesArray || [];
  for (const access of accesses) {
    if (access.type !== 'app') continue;
    await new Promise((resolve, reject) => {
      apiResources.toJSONFile({
        writer: writer,
        resource: 'profile/app',
        filename: 'app_profiles/profile_app_' + access.id + '.json',
        connection: { endpoint: connection.endpoint, token: access.token }
      }, (err) => err ? reject(err) : resolve(), () => {});
    });
  }
}

function setupProgressUI () {
  const ul = $('progress-resources');
  ul.innerHTML = '';
  for (const step of RESOURCE_STEPS) {
    const li = document.createElement('li');
    li.id = 'step-' + step.id;
    li.textContent = step.label;
    ul.appendChild(li);
  }
}

function setActive (id) { $('step-' + id).classList.add('active'); }
function markDone (id) {
  const li = $('step-' + id);
  li.classList.remove('active');
  li.classList.add('done');
}
function skipStep (id, reason) {
  const li = $('step-' + id);
  li.textContent += ' — skipped (' + reason + ')';
}

async function runStep (id, fn) {
  setActive(id);
  $('progress-status').textContent = 'Fetching ' + id + '…';
  await fn();
  markDone(id);
}

function callbackify (fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err) => err ? reject(err) : resolve(), () => {});
  });
}

function prettyBytes (n) {
  if (n > 1000000) return Math.round(n / 1000000) + ' MB';
  if (n > 1000) return Math.round(n / 1000) + ' KB';
  return n + ' bytes';
}

// Initial render — show whatever state is in localStorage.
renderStatePanel();
