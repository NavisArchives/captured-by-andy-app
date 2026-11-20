import { R2StorageProvider } from './r2.js';
import { StorageConfigError } from './provider.js';

export { StorageProvider, StorageInputError, StorageConfigError } from './provider.js';
export { R2StorageProvider } from './r2.js';
export { MemoryStorageProvider } from './memory.js';

// Builds the production provider from a Worker's env: the PHOTOS bucket binding
// plus the R2 API token that presigned URLs need (set with `wrangler secret put`).
export function createStorage(env) {
  if (!env.PHOTOS) {
    throw new StorageConfigError('createStorage: no PHOTOS bucket binding - add it under r2_buckets in wrangler.jsonc');
  }
  return new R2StorageProvider(env.PHOTOS, {
    accountId: env.R2_ACCOUNT_ID,
    bucketName: env.R2_BUCKET_NAME,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
}
