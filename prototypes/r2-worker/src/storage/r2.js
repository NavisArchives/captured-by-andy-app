import { AwsClient } from 'aws4fetch';
import { StorageProvider, StorageConfigError, LIST_MAX, assertKey, encodeKeyPath, signedUrlOptions } from './provider.js';

// Reads and writes go through the R2 bucket binding. Presigned URLs are the one
// thing the binding can't produce, so those are signed against R2's S3 endpoint
// with aws4fetch, using an R2 API token (access key id + secret). Keep those in
// Wrangler secrets, never in source or wrangler.jsonc. Presigned URLs only work
// on the *.r2.cloudflarestorage.com endpoint, not on a custom domain.
const DELETE_BATCH = 1000; // R2 deletes at most 1000 keys per call

export class R2StorageProvider extends StorageProvider {
  #bucket;
  #signer;
  #now;

  constructor(bucket, { accountId, bucketName, accessKeyId, secretAccessKey, now = () => new Date() } = {}) {
    super();
    if (!bucket) throw new StorageConfigError('R2StorageProvider needs an R2 bucket binding');
    this.#bucket = bucket;
    this.#now = now;
    const missing = Object.entries({ accountId, bucketName, accessKeyId, secretAccessKey })
      .filter(([, value]) => !value).map(([name]) => name);
    this.#signer = missing.length
      ? { missing }
      : { accountId, bucketName, client: new AwsClient({ service: 's3', region: 'auto', accessKeyId, secretAccessKey }) };
  }

  async list({ prefix = '', cursor, limit = LIST_MAX } = {}) {
    const res = await this.#bucket.list({ prefix, cursor, limit: Math.min(limit, LIST_MAX),
      include: ['httpMetadata', 'customMetadata'] });
    return { items: res.objects.map(toMetadata), cursor: res.truncated ? res.cursor : null };
  }

  async upload(key, body, { contentType = null, customMetadata = {} } = {}) {
    assertKey(key);
    const object = await this.#bucket.put(key, body, {
      httpMetadata: contentType ? { contentType } : {},
      customMetadata,
    });
    return toMetadata(object);
  }

  async download(key) {
    assertKey(key);
    const object = await this.#bucket.get(key);
    return object ? { ...toMetadata(object), body: object.body } : null;
  }

  async exists(key) {
    assertKey(key);
    return (await this.#bucket.head(key)) !== null;
  }

  async delete(keys) {
    const list = [keys].flat();
    list.forEach(assertKey);
    for (let i = 0; i < list.length; i += DELETE_BATCH) {
      await this.#bucket.delete(list.slice(i, i + DELETE_BATCH));
    }
  }

  async getMetadata(key) {
    assertKey(key);
    const object = await this.#bucket.head(key);
    return object ? toMetadata(object) : null;
  }

  async getSignedUrl(key, options) {
    assertKey(key);
    const { expiresIn, method, contentType } = signedUrlOptions(options);
    if (this.#signer.missing) {
      throw new StorageConfigError(`Signed URLs need R2 API credentials; missing: ${this.#signer.missing.join(', ')}`);
    }
    const { accountId, bucketName, client } = this.#signer;
    const url = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${encodeKeyPath(key)}?X-Amz-Expires=${expiresIn}`;
    // A content type on a PUT URL is signed, so the uploader must send exactly that type.
    const headers = contentType ? { 'content-type': contentType } : {};
    const datetime = this.#now().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const signed = await client.sign(new Request(url, { method, headers }),
      { aws: { signQuery: true, datetime, allHeaders: Boolean(contentType) } });
    return signed.url;
  }
}

function toMetadata(object) {
  return {
    key: object.key,
    size: object.size,
    contentType: object.httpMetadata?.contentType ?? null,
    etag: object.etag,
    uploadedAt: object.uploaded.toISOString(),
    customMetadata: { ...object.customMetadata },
  };
}
