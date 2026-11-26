#!/usr/bin/env node
/**
 * Login-form smoke test: runs the built bundle (`dist/app.js`, from
 * `npm run build`) in a Node `vm` with a minimal fake DOM and a mocked
 * `fetch` (no network, no platform), and drives the sign-in through the
 * multi-factor (MFA) step. Run with `npm test`.
 *
 * The fake DOM covers only what the login form uses; it does not lay out or
 * enforce `disabled` on clicks (the tests check the flags instead).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const BUNDLE = fs.readFileSync(path.resolve(__dirname, '../dist/app.js'), 'utf8');
const PASSWORD = 'pw-secret-smoke';
const MFA_TOKEN = 'mfa-token-secret-smoke';
const GOOD_CODE = '123456';
const BAD_CODE = '000000';

// As in src/index.html: `hidden` attributes, and the `hidden` class on screens.
const INITIALLY_HIDDEN = ['mfa-step', 'login-message', 'mfa-resend'];
const INITIALLY_HIDDEN_SCREENS = ['screen-progress', 'screen-done', 'screen-error'];

/** One page load: fake DOM + mocked platform + the bundle. */
function loadPage (platform) {
  const els = {};
  const el = (id) => {
    if (!els[id]) {
      const listeners = {};
      els[id] = {
        id,
        value: '',
        hidden: INITIALLY_HIDDEN.includes(id),
        textContent: '',
        innerHTML: '',
        readOnly: false,
        required: false,
        disabled: false,
        checked: false,
        className: '',
        dataset: {},
        files: null,
        classList: {
          s: new Set(),
          add (c) { this.s.add(c); },
          remove (c) { this.s.delete(c); },
          contains (c) { return this.s.has(c); }
        },
        addEventListener (t, f) { (listeners[t] = listeners[t] || []).push(f); },
        fire (t, ev) {
          return Promise.all((listeners[t] || []).map((f) => f(ev || { preventDefault () {}, target: els[id] })));
        },
        focus () {},
        after () {},
        appendChild () {}
      };
      if (INITIALLY_HIDDEN_SCREENS.includes(id)) els[id].classList.add('hidden');
    }
    return els[id];
  };
  el('zipSizeMb').value = '100';
  el('serviceInfoUrl').value = 'https://reg.example.test/service/info';
  el('username').value = 'alice';
  el('password').value = PASSWORD;

  const logged = [];
  const capture = (...a) => logged.push(a.map((x) => (x && x.stack) ? x.stack + ' ' + JSON.stringify(x) : String(x)).join(' '));
  const ctx = {
    document: {
      getElementById: el,
      querySelectorAll: (q) => q === '.screen' ? ['screen-login', 'screen-progress', 'screen-done', 'screen-error'].map(el) : [],
      createElement: () => el('tmp-' + Math.random())
    },
    localStorage: { length: 0, key: () => null, getItem: () => null, setItem () {}, removeItem () {} },
    location: { search: '', origin: 'https://backup.example.test', reload () {} },
    navigator: { userAgent: 'smoke' },
    fetch: platform.fetch,
    console: { log: capture, info: capture, warn: capture, error: capture },
    alert () { throw new Error('native alert used'); },
    confirm () { throw new Error('native confirm used'); },
    prompt () { throw new Error('native prompt used'); },
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Response,
    Headers,
    Request,
    AbortController,
    Blob
  };
  for (const name of ['Uint8Array', 'ArrayBuffer', 'DataView', 'Promise', 'Error', 'TypeError', 'RangeError',
    'Symbol', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Map', 'Set',
    'WeakMap', 'WeakSet', 'BigInt']) {
    ctx[name] = globalThis[name];
  }
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(BUNDLE, ctx);
  const submit = () => el('login-form').fire('submit');
  return { el, submit, logged };
}

/**
 * Mocked platform. `verify(code)` returns { status, body } or a Promise of it.
 */
function fakePlatform (opts) {
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return {
    calls,
    async fetch (url, init) {
      url = String(url);
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push(url.replace(/^https:\/\/[^/]+/, ''));
      if (url.includes('service/info')) {
        return json(200, { name: 'Test', api: 'https://{username}.example.test/', register: 'https://reg.example.test/', access: 'https://access.example.test/' });
      }
      if (url.endsWith('/auth/login')) {
        const answer = { mfaToken: MFA_TOKEN };
        if (opts.method !== undefined) answer.mfaMethod = opts.method;
        return json(200, answer);
      }
      if (url.endsWith('/mfa/challenge')) {
        const r = await (opts.challenge ? opts.challenge() : { status: 200, body: {} });
        return json(r.status, r.body);
      }
      if (url.endsWith('/mfa/verify')) {
        const r = await (opts.verify ? opts.verify(body.code) : defaultVerify(body.code));
        if (r.networkError) throw new TypeError('Failed to fetch');
        return json(r.status, r.body);
      }
      return json(404, { error: { id: 'unknown-resource', message: 'mock: no such resource' } });
    }
  };
}

function defaultVerify (code) {
  return code === GOOD_CODE
    ? { status: 200, body: { token: 'tok-ok' } }
    : { status: 400, body: { error: { id: 'invalid-mfa-code', message: 'The MFA code is invalid' } } };
}

function assertNoSecretLogged (page) {
  const out = page.logged.join('\n');
  for (const s of [MFA_TOKEN, PASSWORD, GOOD_CODE, BAD_CODE]) assert.ok(!out.includes(s), 'secret in console: ' + s);
}

const loginShown = (page) => !page.el('screen-login').classList.contains('hidden');

const tests = {
  async 'SMS: step, resend, wrong code, right code, password cleared' () {
    const platform = fakePlatform({ method: 'sms' });
    const page = loadPage(platform);
    const { el } = page;
    await page.submit();
    assert.deepStrictEqual(platform.calls.slice(-1), ['/auth/login']);
    assert.strictEqual(el('mfa-step').hidden, false);
    assert.strictEqual(el('mfa-label').textContent, 'Code sent by SMS');
    assert.strictEqual(el('mfa-resend').hidden, false);
    assert.strictEqual(el('username').readOnly, true);
    assert.strictEqual(el('mfaCode').required, true);

    await el('mfa-resend').fire('click');
    assert.strictEqual(platform.calls.slice(-1)[0], '/mfa/challenge');
    assert.strictEqual(el('login-message').textContent, 'A new code was sent by SMS.');

    el('mfaCode').value = BAD_CODE;
    await page.submit();
    assert.match(el('login-message').textContent, /Code not accepted \(The MFA code is invalid\)/);
    assert.strictEqual(el('mfa-step').hidden, false);
    assert.strictEqual(el('mfaCode').value, '');

    el('mfaCode').value = GOOD_CODE;
    await page.submit();
    assert.strictEqual(el('mfa-step').hidden, true);
    assert.strictEqual(loginShown(page), false, 'login screen left');
    assert.strictEqual(el('password').value, '', 'password cleared once signed in');
    assertNoSecretLogged(page);
  },

  async 'TOTP: authenticator wording, no resend button' () {
    const page = loadPage(fakePlatform({ method: 'totp' }));
    await page.submit();
    assert.strictEqual(page.el('mfa-label').textContent, 'Code from your authenticator app');
    assert.strictEqual(page.el('mfa-resend').hidden, true);
  },

  async 'no method (older core): SMS wording; unknown method: neutral wording, no resend' () {
    const older = loadPage(fakePlatform({ method: undefined }));
    await older.submit();
    assert.strictEqual(older.el('mfa-label').textContent, 'Code sent by SMS');
    const other = loadPage(fakePlatform({ method: 'push' }));
    await other.submit();
    assert.strictEqual(other.el('mfa-label').textContent, 'Verification code');
    assert.strictEqual(other.el('mfa-resend').hidden, true);
  },

  async 'refused resend is shown inline' () {
    const page = loadPage(fakePlatform({
      method: 'sms',
      challenge: () => ({ status: 429, body: { error: { id: 'too-many-attempts', message: 'Wait 30 seconds' } } })
    }));
    await page.submit();
    await page.el('mfa-resend').fire('click');
    assert.strictEqual(page.el('login-message').textContent, 'Could not send a new code: Wait 30 seconds');
    assert.strictEqual(page.el('mfa-step').hidden, false);
  },

  async 'three wrong codes: back to the password step' () {
    const page = loadPage(fakePlatform({ method: 'sms' }));
    await page.submit();
    for (let i = 0; i < 3; i++) { page.el('mfaCode').value = BAD_CODE; await page.submit(); }
    assert.strictEqual(page.el('mfa-step').hidden, true);
    assert.strictEqual(page.el('username').readOnly, false);
    assert.strictEqual(page.el('login-message').textContent, 'The code was not accepted 3 times. Sign in again.');
  },

  async 'blank code is not sent' () {
    const platform = fakePlatform({ method: 'sms' });
    const page = loadPage(platform);
    await page.submit();
    page.el('mfaCode').value = '   ';
    await page.submit();
    assert.ok(!platform.calls.some((c) => c.endsWith('/mfa/verify')), 'no verify call');
    assert.strictEqual(page.el('login-message').textContent, 'Enter the code.');
  },

  async 'cancel while the check runs: buttons disabled, answer ignored, no backup' () {
    let release;
    const platform = fakePlatform({
      method: 'sms',
      verify: () => new Promise((resolve) => { release = () => resolve({ status: 200, body: { token: 'tok-ok' } }); })
    });
    const page = loadPage(platform);
    await page.submit();
    page.el('mfaCode').value = GOOD_CODE;
    const inFlight = page.submit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(page.el('mfa-cancel').disabled, true, 'cancel disabled during the check');
    assert.strictEqual(page.el('mfa-resend').disabled, true, 'resend disabled during the check');
    assert.strictEqual(page.el('login-submit').disabled, true);
    await page.el('mfa-cancel').fire('click'); // the fake DOM does not block clicks on disabled buttons
    release();
    await inFlight;
    assert.strictEqual(loginShown(page), true, 'still on the login screen');
    assert.strictEqual(page.el('screen-progress').classList.contains('hidden'), true, 'backup not started');
    assert.ok(!platform.calls.some((c) => c.includes('access-info') || c.includes('/account')), 'no backup call');
    assert.strictEqual(page.el('mfa-cancel').disabled, false);
  },

  async 'cancel while a wrong code is checked: no crash' () {
    let release;
    const page = loadPage(fakePlatform({
      method: 'sms',
      verify: () => new Promise((resolve) => { release = () => resolve(defaultVerify(BAD_CODE)); })
    }));
    await page.submit();
    page.el('mfaCode').value = BAD_CODE;
    const inFlight = page.submit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await page.el('mfa-cancel').fire('click');
    release();
    await inFlight;
    assert.strictEqual(loginShown(page), true);
    assert.strictEqual(page.el('error-message').textContent, '', 'no error screen');
    assert.strictEqual(page.el('login-message').textContent, '', 'the cancelled check leaves no message');
  },

  async 'cancel while a resend runs: its answer is not shown' () {
    let release;
    const page = loadPage(fakePlatform({
      method: 'sms',
      challenge: () => new Promise((resolve) => { release = () => resolve({ status: 200, body: {} }); })
    }));
    await page.submit();
    const inFlight = page.el('mfa-resend').fire('click');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await page.el('mfa-cancel').fire('click');
    release();
    await inFlight;
    assert.strictEqual(page.el('login-message').textContent, '');
  },

  async 'expired sign-in: back to the password step, inline message' () {
    const page = loadPage(fakePlatform({
      method: 'sms',
      verify: () => ({ status: 403, body: { error: { id: 'invalid-access-token', message: 'Cannot find access' } } })
    }));
    await page.submit();
    page.el('mfaCode').value = GOOD_CODE;
    await page.submit();
    assert.strictEqual(page.el('mfa-step').hidden, true);
    assert.strictEqual(page.el('login-message').textContent, 'Your sign-in expired. Sign in again.');
    assert.strictEqual(loginShown(page), true);
  },

  async 'network failure or temporary refusal: the step stays' () {
    for (const r of [{ networkError: true }, { status: 429, body: { error: { id: 'too-many-attempts', message: 'Too many attempts' } } }]) {
      const page = loadPage(fakePlatform({ method: 'sms', verify: () => r }));
      await page.submit();
      page.el('mfaCode').value = GOOD_CODE;
      await page.submit();
      assert.strictEqual(page.el('mfa-step').hidden, false);
      assert.match(page.el('login-message').textContent, /^The code could not be checked \(.+\)\. Try again in a moment\.$/);
      assert.strictEqual(loginShown(page), true);
    }
  },

  async 'other verify error: error screen' () {
    const page = loadPage(fakePlatform({
      method: 'sms',
      verify: () => ({ status: 500, body: { error: { id: 'unexpected-error', message: 'Boom' } } })
    }));
    await page.submit();
    page.el('mfaCode').value = GOOD_CODE;
    await page.submit();
    assert.strictEqual(page.el('error-message').textContent, 'Boom');
    assertNoSecretLogged(page);
  },

  async 'unreadable sync-state upload: inline message, no native alert' () {
    const page = loadPage(fakePlatform({ method: 'sms' }));
    const input = page.el('sync-state-upload');
    await input.fire('change', { target: { files: [{ text: async () => '{not json' }], value: 'x' } });
    assert.match(page.el('login-message').textContent, /^Could not read sync-state\.json: /);
    assert.strictEqual(page.el('login-message').hidden, false);
  }
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log('ok   ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL ' + name + '\n     ' + (err && err.message));
    }
  }
  console.log(failed ? failed + ' failing' : Object.keys(tests).length + ' passing');
  process.exitCode = failed ? 1 : 0;
})();
