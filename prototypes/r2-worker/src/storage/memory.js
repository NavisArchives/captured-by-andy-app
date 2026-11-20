import { StorageProvider, LIST_MAX, assertKey, encodeKeyPath, signedUrlOptions } from './provider.js';

// Keeps objects in a Map and follows the same contract as R2, for tests and for
// running the app without a bucket. Its signed URLs are not fetchable - nothing
// serves memory:// - but they carry the method and expiry so callers can be tested.
export class MemoryStorageProvider extends StorageProvider {
  #objects = new Map();
  #now;

  constructor({ now = () => new Date() } = {}) {
    super();
    this.#now = now;
  }

  async list({ prefix = '', cursor, limit = LIST_MAX } = {}) {
    const max = Math.min(limit, LIST_MAX);
    const keys = [...this.#objects.keys()].filter((k) => k.startsWith(prefix) && (!cursor || k > cursor)).sort();
    const page = keys.slice(0, max);
    return { items: page.map((k) => this.#metadata(k)), cursor: keys.length > max ? page.at(-1) : null };
  }

  async upload(key, body, { contentType = null, customMetadata = {} } = {}) {
    assertKey(key);
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const etag = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.#objects.set(key, { bytes, contentType, etag, customMetadata: { ...customMetadata },
      uploadedAt: this.#now().toISOString() });
    return this.#metadata(key);
  }

  async download(key) {
    assertKey(key);
    const o = this.#objects.get(key);
    return o ? { ...this.#metadata(key), body: new Response(o.bytes).body } : null;
  }

  async exists(key) {
    assertKey(key);
    return this.#objects.has(key);
  }

  async delete(keys) {
    const list = [keys].flat();
    list.forEach(assertKey);
    for (const k of list) this.#objects.delete(k);
  }

  async getMetadata(key) {
    assertKey(key);
    return this.#objects.has(key) ? this.#metadata(key) : null;
  }

  async getSignedUrl(key, options) {
    assertKey(key);
    const { expiresIn, method } = signedUrlOptions(options);
    const expires = new Date(this.#now().getTime() + expiresIn * 1000).toISOString();
    return `memory://${encodeKeyPath(key)}?method=${method}&expires=${encodeURIComponent(expires)}`;
  }

  #metadata(key) {
    const o = this.#objects.get(key);
    return { key, size: o.bytes.length, contentType: o.contentType, etag: o.etag, uploadedAt: o.uploadedAt,
      customMetadata: { ...o.customMetadata } };
  }
}
