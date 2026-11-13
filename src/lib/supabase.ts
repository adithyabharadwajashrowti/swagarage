import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local.');
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
  // Guards against a typo pointing the app (and users' passwords) somewhere unexpected.
  throw new Error('VITE_SUPABASE_URL does not look like a Supabase project URL.');
}

export const supabase = createClient(url, anonKey, {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export const IMAGE_BUCKET = 'product-images';

export function imageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Turns Supabase/Postgres errors into messages safe to show users. */
export function friendlyError(err: unknown): string {
  if (!err) return 'Something went wrong. Please try again.';
  const e = err as { message?: string; code?: string };
  const msg = e.message ?? String(err);
  // Our database functions raise user-facing messages with these codes.
  if (e.code && ['22023', '54000', 'P0002', '42501'].includes(e.code)) return msg;
  if (/Invalid login credentials/i.test(msg)) return 'Email or password is incorrect.';
  if (/Email not confirmed/i.test(msg)) return 'Please confirm your email first. Check your inbox for the link.';
  if (/User already registered/i.test(msg)) return 'An account with this email already exists. Try signing in.';
  if (/rate limit/i.test(msg)) return 'Too many attempts. Please wait a minute and try again.';
  if (/password/i.test(msg) && /weak|short|characters/i.test(msg)) return msg;
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Network problem. Check your connection and try again.';
  return 'Something went wrong. Please try again.';
}
