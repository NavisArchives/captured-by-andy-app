import { describe, it, expect } from 'vitest';
import worker from '../src/worker/index.js';
import { fakeR2 } from './fake-r2.js';

const call = (env, method, path, body, headers) =>
  worker.fetch(new Request(`http://localhost${path}`, { method, body, headers }), env);

describe('worker', () => {
  it('serves the storage page', async () => {
    const res = await call({ PHOTOS: fakeR2() }, 'GET', '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('CapturedByAndy');
  });

  it('round-trips a file through every route', async () => {
    const env = { PHOTOS: fakeR2() };
    const path = '/api/files/galleries/demo/IMG%20(2).jpg';
    const put = await call(env, 'PUT', path, 'jpeg', { 'content-type': 'image/jpeg' });
    expect(put.status).toBe(201);
    expect(await put.json()).toMatchObject({ key: 'galleries/demo/IMG (2).jpg', size: 4, contentType: 'image/jpeg' });

    const list = await (await call(env, 'GET', '/api/files?prefix=galleries/')).json();
    expect(list.items.map((i) => i.key)).toEqual(['galleries/demo/IMG (2).jpg']);

    const get = await call(env, 'GET', path);
    expect(get.headers.get('content-type')).toBe('image/jpeg');
    expect(await get.text()).toBe('jpeg');
    expect((await call(env, 'HEAD', path)).status).toBe(200);
    expect((await call(env, 'GET', '/api/meta/galleries/demo/IMG%20(2).jpg')).status).toBe(200);

    expect((await call(env, 'DELETE', path)).status).toBe(204);
    expect((await call(env, 'HEAD', path)).status).toBe(404);
    expect((await call(env, 'GET', path)).status).toBe(404);
  });

  it('answers 400 for a bad key and 404 for an unknown route', async () => {
    const env = { PHOTOS: fakeR2() };
    const bad = await call(env, 'PUT', '/api/files/a//b.jpg', 'x');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/segment/);
    expect((await call(env, 'GET', '/nope')).status).toBe(404);
  });

  it('answers 501 for signed URLs until R2 credentials exist, then signs', async () => {
    const without = await call({ PHOTOS: fakeR2() }, 'POST', '/api/sign/a.jpg');
    expect(without.status).toBe(501);
    expect((await without.json()).error).toMatch(/accessKeyId/);

    const env = { PHOTOS: fakeR2(), R2_ACCOUNT_ID: 'acc', R2_BUCKET_NAME: 'photos',
      R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret' };
    const signed = await call(env, 'POST', '/api/sign/a.jpg?expiresIn=900');
    expect(signed.status).toBe(200);
    expect(new URL((await signed.json()).url).searchParams.get('X-Amz-Expires')).toBe('900');
  });
});
