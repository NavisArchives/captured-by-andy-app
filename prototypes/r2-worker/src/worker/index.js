import { createStorage, StorageInputError, StorageConfigError } from '../storage/index.js';
import { PAGE } from './page.js';

// A small front end for the storage layer: one page plus a JSON API that
// reaches every StorageProvider method. `wrangler dev` simulates the PHOTOS R2
// bucket on disk (.wrangler/state), so it runs without a Cloudflare account;
// signed URLs answer 501 until the R2 API token is configured.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      return await route(request, url, createStorage(env));
    } catch (err) {
      if (err instanceof StorageInputError || err instanceof URIError) return json({ error: err.message }, 400);
      if (err instanceof StorageConfigError) return json({ error: err.message }, 501);
      console.error(JSON.stringify({ message: 'request failed', method: request.method, path: url.pathname,
        error: String(err?.stack ?? err) }));
      return json({ error: 'Something went wrong' }, 500);
    }
  },
};

async function route(request, url, storage) {
  const { pathname } = url;
  const { method } = request;

  if (pathname === '/' && method === 'GET') {
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (pathname === '/api/files' && method === 'GET') {
    return json(await storage.list({ prefix: url.searchParams.get('prefix') ?? '',
      cursor: url.searchParams.get('cursor') || undefined }));
  }
  if (pathname.startsWith('/api/files/')) {
    const key = keyFrom(pathname, '/api/files/');
    if (method === 'PUT') {
      return json(await storage.upload(key, request.body, { contentType: request.headers.get('content-type') }), 201);
    }
    if (method === 'GET') {
      const file = await storage.download(key);
      if (!file) return missing(key);
      return new Response(file.body, { headers: {
        'content-type': file.contentType ?? 'application/octet-stream', etag: `"${file.etag}"` } });
    }
    if (method === 'HEAD') return new Response(null, { status: (await storage.exists(key)) ? 200 : 404 });
    if (method === 'DELETE') {
      await storage.delete(key);
      return new Response(null, { status: 204 });
    }
  }
  if (pathname.startsWith('/api/meta/') && method === 'GET') {
    const key = keyFrom(pathname, '/api/meta/');
    const meta = await storage.getMetadata(key);
    return meta ? json(meta) : missing(key);
  }
  if (pathname.startsWith('/api/sign/') && method === 'POST') {
    const q = url.searchParams;
    const signed = await storage.getSignedUrl(keyFrom(pathname, '/api/sign/'), {
      method: q.get('method') ?? 'GET',
      expiresIn: q.has('expiresIn') ? Number(q.get('expiresIn')) : undefined,
      contentType: q.get('contentType') ?? undefined,
    });
    return json({ url: signed });
  }
  return json({ error: `No route for ${method} ${pathname}` }, 404);
}

// Keys arrive with each segment percent-encoded: /api/files/galleries/IMG%20(2).jpg
function keyFrom(pathname, prefix) {
  return pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function missing(key) {
  return json({ error: `No file at ${key}` }, 404);
}
