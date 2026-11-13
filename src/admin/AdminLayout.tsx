import { useEffect, type ReactNode } from 'react';
import { RequireStaff } from '../components/Guards';
import { useAuth } from '../lib/auth';
import { publishCatalogueToCdn } from '../lib/catalogue';
import { Link, useLocation } from '../lib/router';

const LINKS: { to: string; label: string; admin?: boolean }[] = [
  { to: '/admin', label: 'Dashboard' },
  { to: '/admin/quotes', label: 'Quotes' },
  { to: '/admin/products', label: 'Products' },
  { to: '/admin/import', label: 'Import sheet' },
  { to: '/admin/users', label: 'Users', admin: true },
  { to: '/admin/audit', label: 'Audit log', admin: true },
];

export function AdminLayout({ children, adminOnly = false }: { children: ReactNode; adminOnly?: boolean }) {
  return (
    <RequireStaff admin={adminOnly}>
      <AdminShell>{children}</AdminShell>
    </RequireStaff>
  );
}

function AdminShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { isAdmin } = useAuth();
  // Staff edits change the catalogue version; publish each new version to the
  // CDN so visitors don't have to build it from the database.
  useEffect(() => {
    void publishCatalogueToCdn();
    const t = window.setInterval(() => void publishCatalogueToCdn(), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const active = (to: string) => (to === '/admin' ? pathname === '/admin' : pathname.startsWith(to));
  return (
    <div className="admin">
      <nav aria-label="Admin">
        {LINKS.filter((l) => !l.admin || isAdmin).map((l) => (
          <Link key={l.to} to={l.to} aria-current={active(l.to) ? 'page' : undefined}>{l.label}</Link>
        ))}
      </nav>
      <main>{children}</main>
    </div>
  );
}
