import { zipSync, strToU8 } from 'fflate';

/**
 * Browser StorageWriter — accumulates files into in-memory ZIP fragments,
 * triggering a per-ZIP `<a download>` once the accumulated size crosses
 * a configurable threshold. The final ZIP includes a `backup-index.json`
 * that lists every file across every ZIP (the lightweight cross-ZIP
 * directory mentioned in the v0.6.0 ship plan).
 *
 * Per the Phase D decision: each ZIP carries a complete sub-folder of the
 * backup tree; restore concats by file path. No file straddles ZIP
 * boundaries — when a file would push the ZIP over the threshold, the
 * current ZIP is finalized BEFORE the file is added, and the file goes
 * into the next ZIP.
 *
 * For per-resource streaming writes (JSON resources downloaded via the
 * `apiResources.toJSONFile` flow), this writer buffers the chunks in
 * memory until `end()` is called, then adds the resulting Uint8Array to
 * the current ZIP under the relative path.
 */
export class BrowserBlobZipStorageWriter {
  constructor (opts) {
    opts = opts || {};
    this.zipSizeBytes = (opts.zipSizeMb || 100) * 1024 * 1024;
    this.zipPrefix = opts.zipPrefix || 'backup';
    this.onZipReady = opts.onZipReady || null;

    this.currentEntries = {}; // path → Uint8Array (entries pending in the current ZIP)
    this.currentBytes = 0;
    this.zipIndex = 1;
    this.zipManifest = []; // [{ zip: 'backup-001.zip', files: [...] }]
    this.downloads = []; // Blobs + filenames for the "done" screen
  }

  /**
   * Per StorageWriter contract: open a writable shim that accumulates
   * chunks into memory; on end(), commit to the current ZIP.
   */
  openWriteStream (relPath) {
    const chunks = [];
    const self = this;
    return {
      write (chunk) {
        // chunk is a Uint8Array (from fetch body) or a string.
        if (typeof chunk === 'string') chunks.push(strToU8(chunk));
        else chunks.push(chunk);
      },
      end (cb) {
        const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        const buf = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
        self._addEntry(relPath, buf).then(() => cb && cb(), (err) => cb && cb(err));
      }
    };
  }

  exists () { return false; } // browser: no persistent state between runs at file level

  describeTarget () { return '(browser ZIP downloads)'; }

  async _addEntry (relPath, buf) {
    // Would this entry push us over the size threshold? If yes and the
    // current ZIP is non-empty, finalize the current ZIP first.
    const willOverflow = this.currentBytes > 0 &&
      this.currentBytes + buf.byteLength > this.zipSizeBytes;
    if (willOverflow) {
      await this._finalizeCurrentZip();
    }
    this.currentEntries[relPath] = buf;
    this.currentBytes += buf.byteLength;
  }

  async _finalizeCurrentZip (isLast) {
    if (Object.keys(this.currentEntries).length === 0 && !isLast) return;
    const zipName = this.zipPrefix + '-' + String(this.zipIndex).padStart(3, '0') + '.zip';
    this.zipManifest.push({
      zip: zipName,
      files: Object.keys(this.currentEntries)
    });
    if (isLast) {
      // Embed the cross-ZIP index in the last ZIP so restore can read it
      // upfront and learn which ZIP carries which file.
      const indexJson = JSON.stringify({
        format: 'pryv-account-backup-webapp/0.6.0',
        zips: this.zipManifest
      }, null, 2);
      this.currentEntries['backup-index.json'] = strToU8(indexJson);
    }
    const zipped = zipSync(this.currentEntries);
    const blob = new Blob([zipped], { type: 'application/zip' });
    this._triggerDownload(blob, zipName);
    this.downloads.push({ name: zipName, size: zipped.byteLength });
    if (this.onZipReady) this.onZipReady({ name: zipName, size: zipped.byteLength });
    this.currentEntries = {};
    this.currentBytes = 0;
    this.zipIndex += 1;
  }

  _triggerDownload (blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Give the browser a tick to start the download before we revoke.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /** Finalize any pending ZIP (called when the backup orchestration ends). */
  async finalizeBatch () {
    await this._finalizeCurrentZip(true);
  }
}
