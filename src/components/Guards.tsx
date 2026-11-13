import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { navigate, useLocation } from '../lib/router';
import { Spinner } from './ui';

// Route guards improve UX only. Data access is enforced by row-level
// security in the database, so a bypassed guard shows an empty page, not data.

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (!loading && !session) navigate(`/login?next=${encodeURIComponent(pathname + (search.toString() ? `?${search}` : ''))}`, { replace: true });
  }, [loading, session, pathname, search]);
  if (loading || !session) return <Spinner />;
  return <>{children}</>;
}

export function RequireStaff({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { session, profile, loading, isStaff, isAdmin } = useAuth();
  if (loading || (session && !profile)) return <Spinner />;
  if (!session) return <RequireAuth>{children}</RequireAuth>;
  if (admin ? !isAdmin : !isStaff)
    return (
      <div className="wrap page">
        <h1>Not available</h1>
        <p className="sub">This area is for the Swagarage team.</p>
      </div>
    );
  return <>{children}</>;
}
