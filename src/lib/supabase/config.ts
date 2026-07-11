/**
 * Supabase configuration.
 * The site is designed to build and run even before Supabase is set up, so the
 * public marketing pages never break. When these env vars are missing, the
 * member area shows a friendly "not configured yet" state instead of crashing.
 *
 * Set these in .env.local (local) and in Vercel → Settings → Environment Variables:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
