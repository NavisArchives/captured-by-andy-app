# CapturedByAndy

## Run it

```sh
npm run dev        # http://localhost:8789
```

`wrangler dev` simulates the `PHOTOS` R2 bucket on disk (`.wrangler/state`), so
nothing is uploaded to Cloudflare and no account is needed. The page lets you
upload, list, open, inspect and delete files. Signed links answer 501 until R2
API credentials are configured (see below).

## Storage

`src/storage/` is the one place the app touches file storage. Everything goes
through a `StorageProvider`:

| Method | Returns |
|---|---|
| `list({ prefix, cursor, limit })` | `{ items: Metadata[], cursor }` — `cursor` is `null` on the last page; max 1000 per page |
| `upload(key, body, { contentType, customMetadata })` | `Metadata` — `body` can be a stream, bytes, Blob or string |
| `download(key)` | `{ ...Metadata, body: ReadableStream }`, or `null` if missing |
| `exists(key)` | `boolean` |
| `delete(key \| keys[])` | nothing; missing keys are fine |
| `getMetadata(key)` | `Metadata`, or `null` if missing |
| `getSignedUrl(key, { method, expiresIn, contentType })` | a presigned URL string |

`Metadata` is `{ key, size, contentType, etag, uploadedAt, customMetadata }`.
Keys are folder-style paths such as `galleries/sofie/01.jpg`.

Two providers implement it: `R2StorageProvider` (production) and
`MemoryStorageProvider` (tests, and running without a bucket). Both pass the
same contract suite in `test/storage-contract.test.js`.

### Wiring R2 in a Worker

```jsonc
// wrangler.jsonc
"r2_buckets": [{ "binding": "PHOTOS", "bucket_name": "REPLACE_ME" }],
"vars": { "R2_ACCOUNT_ID": "<account id>", "R2_BUCKET_NAME": "REPLACE_ME" }
```

Presigned URLs need an R2 API token (R2 → Manage API tokens). Store it as
secrets, never in config:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

```js
import { createStorage } from './storage/index.js';
const storage = createStorage(env);
const url = await storage.getSignedUrl('galleries/sofie/01.jpg', { expiresIn: 900 });
```

Signed URLs: `GET`, `HEAD`, `PUT` or `DELETE`, valid 1 second to 7 days, and
only on the `*.r2.cloudflarestorage.com` endpoint (not a custom domain). For
browser uploads with a `PUT` URL, add a CORS rule to the bucket and pass
`contentType` so the upload is locked to that file type.

## Tests

```sh
npm test
```
