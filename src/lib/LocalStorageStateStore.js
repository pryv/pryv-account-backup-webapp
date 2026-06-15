/**
 * Browser StateStore — persists kv state + per-category work refs under a
 * single `localStorage` key. Mirrors the `FolderStateStore` interface from
 * the @pryv/account-backup library so the orchestrator drives both flavors
 * uniformly.
 *
 * Cross-session incremental in the browser depends on `export()` /
 * `import()`: localStorage gets cleared on browser switch, private-mode
 * exit, or "clear site data" — so the run-end ZIP carries an exported
 * `sync-state.json` (kv only); the subject keeps it alongside the ZIPs and
 * uploads it back at the start of the next run to seed the store.
 *
 * The key is namespaced by the subject's API endpoint so a browser used for
 * multiple subjects doesn't cross-contaminate state.
 */
const FORMAT = 'pryv-account-backup-sync-state';
const FORMAT_VERSION = 1;

export class LocalStorageStateStore {
  constructor (apiEndpoint) {
    if (!apiEndpoint) throw new Error('LocalStorageStateStore requires an apiEndpoint');
    this.key = 'pryv-account-backup:state:' + apiEndpoint;
    this.state = this._load();
  }

  _load () {
    const empty = { kv: {}, refs: {} };
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return empty;
      const parsed = JSON.parse(raw);
      if (parsed == null || typeof parsed !== 'object') return empty;
      // Pre-v0.7.0 entries were flat kv objects. Hoist into `kv` on load.
      if (parsed.kv == null && parsed.refs == null) {
        return { kv: parsed, refs: {} };
      }
      return {
        kv: parsed.kv && typeof parsed.kv === 'object' ? parsed.kv : {},
        refs: parsed.refs && typeof parsed.refs === 'object' ? parsed.refs : {}
      };
    } catch (err) {
      // Corrupted or quota'd — start fresh; the backup will fall back to
      // the initial-fetch path.
      return empty;
    }
  }

  // ─── Key/value state ───

  async get (k) { return this.state.kv[k]; }

  async set (k, v) {
    this.state.kv[k] = v;
    await this.flush();
  }

  async getAll () { return { ...this.state.kv }; }

  async flush () {
    localStorage.setItem(this.key, JSON.stringify(this.state));
  }

  // ─── Per-category ref tracking ───

  async pushRef (category, ref) {
    if (ref == null || typeof ref.key !== 'string') {
      throw new Error('StateStore.pushRef requires ref.key (string)');
    }
    const list = this.state.refs[category] || (this.state.refs[category] = []);
    if (list.some((r) => r.key === ref.key)) return;
    list.push({ ...ref, done: false });
    await this.flush();
  }

  async listPending (category) {
    const list = this.state.refs[category] || [];
    return list.filter((r) => !r.done).map((r) => ({ ...r }));
  }

  async markDone (category, refKey) {
    const list = this.state.refs[category] || [];
    const found = list.find((r) => r.key === refKey);
    if (found) {
      found.done = true;
      await this.flush();
    }
  }

  async clearCategory (category) {
    if (this.state.refs[category]) {
      delete this.state.refs[category];
      await this.flush();
    }
  }

  // ─── Portable export / import ───

  async export () {
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      toolVersion: this.state.kv.toolVersion || null,
      createdAt: new Date().toISOString(),
      kv: { ...this.state.kv }
    };
  }

  async import (data) {
    if (data == null || data.format !== FORMAT) {
      throw new Error('StateStore.import: unrecognized format (expected ' + FORMAT + ')');
    }
    if (data.formatVersion !== FORMAT_VERSION) {
      throw new Error('StateStore.import: unsupported formatVersion ' +
        data.formatVersion + ' (expected ' + FORMAT_VERSION + ')');
    }
    this.state.kv = (data.kv && typeof data.kv === 'object') ? { ...data.kv } : {};
    await this.flush();
  }
}

LocalStorageStateStore.FORMAT = FORMAT;
LocalStorageStateStore.FORMAT_VERSION = FORMAT_VERSION;
