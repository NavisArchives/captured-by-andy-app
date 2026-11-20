// A hand-rolled stand-in for an R2Bucket binding. It copies the parts of R2's
// behaviour the provider relies on: key-ordered listing with limit and cursor,
// null for missing keys, and deletes of at most 1000 keys per call.
export function fakeR2() {
  const objects = new Map();
  const calls = [];
  let uploads = 0;

  const describe = (key, o) => ({
    key, size: o.bytes.length, etag: o.etag, httpEtag: `"${o.etag}"`, uploaded: o.uploaded,
    httpMetadata: { ...o.httpMetadata }, customMetadata: { ...o.customMetadata },
  });

  return {
    calls,
    async put(key, value, options = {}) {
      calls.push(['put', key, options]);
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      uploads += 1;
      const o = { bytes, etag: `etag${uploads}`, uploaded: new Date('2026-09-24T12:00:00.000Z'),
        httpMetadata: options.httpMetadata ?? {}, customMetadata: options.customMetadata ?? {} };
      objects.set(key, o);
      return describe(key, o);
    },
    async head(key) {
      calls.push(['head', key]);
      return objects.has(key) ? describe(key, objects.get(key)) : null;
    },
    async get(key) {
      calls.push(['get', key]);
      if (!objects.has(key)) return null;
      const o = objects.get(key);
      return { ...describe(key, o), body: new Response(o.bytes).body };
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.length > 1000) throw new Error('R2 deletes at most 1000 keys per call');
      calls.push(['delete', list]);
      for (const k of list) objects.delete(k);
    },
    async list({ prefix = '', cursor, limit = 1000, include } = {}) {
      calls.push(['list', { prefix, cursor, limit, include }]);
      if (limit > 1000) throw new Error('R2 lists at most 1000 keys per call');
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const truncated = start + limit < keys.length;
      return {
        objects: keys.slice(start, start + limit).map((k) => describe(k, objects.get(k))),
        truncated,
        ...(truncated ? { cursor: String(start + limit) } : {}),
        delimitedPrefixes: [],
      };
    },
  };
}
