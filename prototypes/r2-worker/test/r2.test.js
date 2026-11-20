import { describe, it, expect } from 'vitest';
import { AwsClient } from 'aws4fetch';
import { R2StorageProvider } from '../src/storage/r2.js';
import { createStorage } from '../src/storage/index.js';
import { fakeR2 } from './fake-r2.js';

const SIGNING = { accountId: 'acc123', bucketName: 'photos', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };
const at = (iso) => () => new Date(iso);

describe('R2StorageProvider', () => {
  it('asks R2 for HTTP and custom metadata when listing', async () => {
    const bucket = fakeR2();
    await new R2StorageProvider(bucket).list({ prefix: 'g/' });
    const [, opts] = bucket.calls.find(([op]) => op === 'list');
    expect(opts.include).toEqual(['httpMetadata', 'customMetadata']);
  });

  it('caps a single list call at R2’s maximum of 1000', async () => {
    const bucket = fakeR2();
    await new R2StorageProvider(bucket).list({ limit: 5000 });
    expect(bucket.calls.find(([op]) => op === 'list')[1].limit).toBe(1000);
  });

  it('splits large deletes into batches R2 accepts', async () => {
    const bucket = fakeR2();
    const keys = Array.from({ length: 2500 }, (_, i) => `k/${i}`);
    await new R2StorageProvider(bucket).delete(keys);
    const batches = bucket.calls.filter(([op]) => op === 'delete').map(([, list]) => list.length);
    expect(batches).toEqual([1000, 1000, 500]);
  });

  it('refuses to sign without R2 API credentials, and says what is missing', async () => {
    const s = new R2StorageProvider(fakeR2());
    await expect(s.getSignedUrl('a.jpg')).rejects.toThrow(/accessKeyId/);
  });

  it('signs a path-style URL on the R2 S3 endpoint, escaping awkward filenames', async () => {
    const s = new R2StorageProvider(fakeR2(), { ...SIGNING, now: at('2026-09-24T10:00:00Z') });
    const url = new URL(await s.getSignedUrl('weddings/Sofie & Jan/IMG (2)+final.jpg', { expiresIn: 900 }));
    expect(url.origin).toBe('https://acc123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/photos/weddings/Sofie%20%26%20Jan/IMG%20%282%29%2Bfinal.jpg');
    const q = url.searchParams;
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(q.get('X-Amz-Expires')).toBe('900');
    expect(q.get('X-Amz-Date')).toBe('20260924T100000Z');
    expect(q.get('X-Amz-Credential')).toBe('AKIDEXAMPLE/20260924/auto/s3/aws4_request');
    expect(q.get('X-Amz-SignedHeaders')).toBe('host');
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same key and moment', async () => {
    const make = () => new R2StorageProvider(fakeR2(), { ...SIGNING, now: at('2026-09-24T10:00:00Z') });
    expect(await make().getSignedUrl('a.jpg')).toBe(await make().getSignedUrl('a.jpg'));
  });

  it('binds a PUT URL to its content type so uploads cannot swap file types', async () => {
    const s = new R2StorageProvider(fakeR2(), { ...SIGNING, now: at('2026-09-24T10:00:00Z') });
    const put = new URL(await s.getSignedUrl('in/raw.CR3', { method: 'PUT', contentType: 'image/x-canon-cr3' }));
    const get = new URL(await s.getSignedUrl('in/raw.CR3'));
    expect(put.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(put.searchParams.get('X-Amz-Signature')).not.toBe(get.searchParams.get('X-Amz-Signature'));
  });

  it('relies on a signer that reproduces AWS’s published presigned-URL example', async () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const client = new AwsClient({ service: 's3', region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
    const signed = await client.sign(new Request('https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Expires=86400'),
      { aws: { signQuery: true, datetime: '20130524T000000Z' } });
    expect(new URL(signed.url).searchParams.get('X-Amz-Signature'))
      .toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });
});

describe('createStorage', () => {
  it('builds an R2 provider from Worker bindings and secrets', async () => {
    const env = { PHOTOS: fakeR2(), R2_ACCOUNT_ID: 'acc123', R2_BUCKET_NAME: 'photos',
      R2_ACCESS_KEY_ID: 'AKIDEXAMPLE', R2_SECRET_ACCESS_KEY: 'secret' };
    const s = createStorage(env);
    expect(s).toBeInstanceOf(R2StorageProvider);
    expect(new URL(await s.getSignedUrl('a.jpg')).host).toBe('acc123.r2.cloudflarestorage.com');
  });

  it('fails loudly when the bucket binding is missing', () => {
    expect(() => createStorage({})).toThrow(/PHOTOS/);
  });
});
