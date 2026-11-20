// The one storage interface the app talks to. Each backend (R2 in production,
// memory in tests) extends StorageProvider and implements all seven methods, so
// nothing above this layer knows or cares which one it has.
//
// Rules every backend follows, enforced by the helpers below:
// - keys look like folder paths ("galleries/sofie/01.jpg"): no leading slash
//   and no empty, "." or ".." segments;
// - download() and getMetadata() resolve to null for a missing key, exists()
//   to false, and delete() succeeds whether or not the key is there - which is
//   also how R2 itself behaves;
// - metadata is always { key, size, contentType, etag, uploadedAt, customMetadata }.

export const LIST_MAX = 1000;                             // R2 returns at most 1000 keys per list
export const MAX_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;   // R2 presigned URLs last 1 s to 7 days
const SIGNABLE_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE'];

// Bad input from the caller (a malformed key, an out-of-range expiry). Named so
// a route can answer 400 without mistaking a real bug for bad input.
export class StorageInputError extends Error { name = 'StorageInputError'; }
// A provider is missing configuration it needs, e.g. R2 API keys for signing.
export class StorageConfigError extends Error { name = 'StorageConfigError'; }

export class StorageProvider {
  async list(options) { notImplemented(this, 'list'); }
  async upload(key, body, options) { notImplemented(this, 'upload'); }
  async download(key) { notImplemented(this, 'download'); }
  async exists(key) { notImplemented(this, 'exists'); }
  async delete(keys) { notImplemented(this, 'delete'); }
  async getMetadata(key) { notImplemented(this, 'getMetadata'); }
  async getSignedUrl(key, options) { notImplemented(this, 'getSignedUrl'); }
}

function notImplemented(provider, method) {
  throw new Error(`${provider.constructor.name} does not implement ${method}()`);
}

export function assertKey(key) {
  if (typeof key !== 'string' || key === '') {
    throw new StorageInputError(`Storage key must be a non-empty string, got ${JSON.stringify(key)}`);
  }
  if (key.startsWith('/')) throw new StorageInputError(`Storage key must not start with "/": ${key}`);
  if (key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new StorageInputError(`Storage key has an empty, "." or ".." segment: ${key}`);
  }
  if (new TextEncoder().encode(key).length > 1024) throw new StorageInputError('Storage key is longer than 1024 bytes');
  return key;
}

export function signedUrlOptions({ expiresIn = 3600, method = 'GET', contentType } = {}) {
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_SIGNED_URL_SECONDS) {
    throw new StorageInputError(`expiresIn must be whole seconds from 1 to ${MAX_SIGNED_URL_SECONDS}, got ${expiresIn}`);
  }
  const verb = String(method).toUpperCase();
  if (!SIGNABLE_METHODS.includes(verb)) {
    throw new StorageInputError(`method must be one of ${SIGNABLE_METHODS.join(', ')}, got ${method}`);
  }
  return { expiresIn, method: verb, contentType };
}

// Percent-encode each segment the RFC 3986 way. encodeURIComponent leaves
// !'()* bare, but SigV4 signs them escaped; escaping them here makes the URL we
// hand out byte-for-byte the path that was signed, rather than trusting the
// server to normalise "IMG (2).jpg" the same way.
export function encodeKeyPath(key) {
  return key.split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}
