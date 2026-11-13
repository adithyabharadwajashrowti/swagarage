import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Profile } from './types';

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /** True right after the user lands from a password-reset email link. */
  recovering: boolean;
  isStaff: boolean;
  isAdmin: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, company, phone, role, created_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) return null;
  return data as Profile | null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      setProfile(data.session ? await loadProfile(data.session.user.id) : null);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      if (event === 'SIGNED_OUT') {
        setProfile(null);
        setRecovering(false);
      }
      // Load the profile outside the callback (supabase-js recommends not awaiting here).
      if (next && (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED')) {
        setTimeout(() => {
          loadProfile(next.user.id).then((p) => active && setProfile(p));
        }, 0);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const refreshProfile = useCallback(async () => {
    if (session) setProfile(await loadProfile(session.user.id));
  }, [session]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthState>(() => {
    // UI convenience only. Every staff/admin permission is enforced again by
    // row-level security and database functions on the server.
    const role = profile?.role ?? 'client';
    return {
      session,
      profile,
      loading,
      recovering,
      isStaff: !!session && (role === 'staff' || role === 'admin'),
      isAdmin: !!session && role === 'admin',
      refreshProfile,
      signOut,
    };
  }, [session, profile, loading, recovering, refreshProfile, signOut]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
