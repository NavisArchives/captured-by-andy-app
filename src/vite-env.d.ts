/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The web app's Supabase project, and its public (anon) key. */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
