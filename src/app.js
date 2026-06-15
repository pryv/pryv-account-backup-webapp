/**
 * Pryv account backup — minimum sample webapp.
 *
 * Three screens: login → progress → done. Vanilla JS + the
 * `@pryv/account-backup` library's isomorphic per-method modules.
 *
 * Implementers are expected to fork + rebrand. Total LOC stays small on
 * purpose so the fork stays manageable.
 */
import * as pryv from 'pryv';
import apiResources from 'pryv-account-backup/src/methods/api-resources.js';
import * as eventsChunked from 'pryv-account-backup/src/methods/events-chunked.js';
import * as auditAsEvents from 'pryv-account-backup/src/methods/audit-as-events.js';
import * as accessesHistory from 'pryv-account-backup/src/methods/accesses-history.js';

import { LocalStorageStateStore } from './lib/LocalStorageStateStore.js';
import { BrowserBlobZipStorageWriter } from './lib/BrowserBlobZipStorageWriter.js';

const APP_ID = 'pryv-backup-webapp';
const RESOURCE_STEPS = [
  { id: 'metadata', label: 'Account, streams, profile, accesses' },
  { id: 'audit', label: 'Audit log' },
  { id: 'events', label: 'Events' },
  { id: 'app-profiles', label: 'Per-app profiles' },
  { id: 'access-history', label: 'Per-access version history' }
];

const $ = (id) => document.getElementById(id);

function show (screenId) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(screenId).classList.remove('hidden');
}

function fail (msg) {
  $('error-message').textContent = msg;
  show('screen-error');
}

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

async function runBackup (ctx) {
  $('progress-status').textContent = 'Connecting…';
  const service = new pryv.Service(ctx.serviceInfoUrl);
  await service.info();
  const connection = await service.login(ctx.username, ctx.password, APP_ID);
  // MFA challenge: lib-js's login throws an error with .challenge or similar
  // when MFA is enabled. The webapp explicitly does not handle MFA — direct
  // the subject to the CLI for that case.
  if (!connection || !connection.endpoint || !connection.token) {
    throw new Error('Login failed — if your account has MFA enabled, please use the CLI version.');
  }

  setupProgressUI();

  const apiEndpoint = connection.endpoint;
  const state = new LocalStorageStateStore(apiEndpoint);
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

  await fetchMetadata(connection, writer, ctx);
  markDone('metadata');

  await runStep('audit', () => callbackify(
    auditAsEvents.download,
    connection, writer,
    { includeTrashed: ctx.includeTrashed, modifiedSince: auditModifiedSince }
  ));

  await runStep('events', () => callbackify(
    eventsChunked.download,
    connection, writer,
    {
      includeTrashed: ctx.includeTrashed,
      modifiedSince: eventsModifiedSince,
      runStartedAt: runStartedAt
    }
  ));

  // app_profiles + per-access history both need the accesses snapshot —
  // re-read it from the per-resource fetch above by parsing the bundle's
  // accesses.json. The webapp keeps it in memory between steps.
  await fetchAppProfiles(connection, writer);
  markDone('app-profiles');

  if (ctx.includeAccessHistory) {
    await runStep('access-history', () => callbackify(
      accessesHistory.download,
      connection, writer,
      writer.__accessesArray || []
    ));
  } else {
    skipStep('access-history', 'opt-in: not requested');
  }

  await state.set('lastRunAt', runStartedAt);
  await state.set('events.lastModifiedSince', runStartedAt);
  await state.set('audit.lastModifiedSince', runStartedAt);

  await writer.finalizeBatch();

  $('progress-status').textContent = 'Done. ' + writer.downloads.length + ' ZIP file(s) downloaded.';
  show('screen-done');
}

async function fetchMetadata (connection, writer, ctx) {
  $('progress-status').textContent = 'Fetching account + streams + accesses + profile…';
  setActive('metadata');
  const streamsRes = ctx.includeTrashed ? 'streams?state=all' : 'streams';
  const accessesAll = 'accesses?includeDeletions=true&includeExpired=true';
  const resources = [
    { res: 'account' },
    { res: streamsRes },
    { res: 'accesses', captureAs: 'accesses' },
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
        connection: connection
      }, (err) => err ? reject(err) : resolve(), () => {});
    });
    // Capture the accesses array out of the writer's pending in-memory entry
    // (it hasn't been finalized into a ZIP yet — the buffer is still in
    // currentEntries). Used by Per-access history + app-profile steps.
    if (item.captureAs === 'accesses') {
      const buf = writer.currentEntries['accesses.json'];
      if (buf) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(buf));
          writer.__accessesArray = parsed.accesses || [];
        } catch (e) { /* leave undefined */ }
      }
    }
  }
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
