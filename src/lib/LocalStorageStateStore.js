/**
 * Browser StateStore — persists incremental-backup state under a single
 * `localStorage` key. Implements the same interface as `FolderStateStore`
 * in the @pryv/account-backup CLI library.
 *
 * The key is namespaced by the subject's API endpoint so a browser that
 * answered DSARs for multiple subjects doesn't cross-contaminate state.
 */
export class LocalStorageStateStore {
  constructor (apiEndpoint) {
    if (!apiEndpoint) throw new Error('LocalStorageStateStore requires an apiEndpoint');
    this.key = 'pryv-account-backup:state:' + apiEndpoint;
    this.state = this._load();
  }

  _load () {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      // Corrupted or quota'd — start fresh; the backup will fall back to
      // the initial-fetch path.
      return {};
    }
  }

  async get (k) { return this.state[k]; }

  async set (k, v) {
    this.state[k] = v;
    await this.flush();
  }

  async getAll () { return { ...this.state }; }

  async flush () {
    localStorage.setItem(this.key, JSON.stringify(this.state));
  }
}
