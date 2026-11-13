// A small history-API router: enough for this app, no dependency.
import { createContext, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

// The app can live under a sub-path (e.g. GitHub Pages: /swagarage/).
// Routes inside the app are always written without it ("/shop").
export const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

/** "/shop" -> "/swagarage/shop" (or unchanged at the domain root). */
export function withBase(path: string): string {
  return BASE + path;
}

/** Absolute URL for links that leave the app (e.g. auth emails). */
export function absoluteUrl(path: string): string {
  return window.location.origin + withBase(path);
}

/** Public asset in /public, e.g. asset('logo.png'). */
export function asset(name: string): string {
  return `${BASE}/${name}`;
}

interface Location {
  pathname: string;
  search: URLSearchParams;
}

const RouterCtx = createContext<Location | null>(null);

function readLocation(): Location {
  let pathname = window.location.pathname;
  if (BASE && (pathname === BASE || pathname.startsWith(BASE + '/'))) pathname = pathname.slice(BASE.length) || '/';
  return { pathname, search: new URLSearchParams(window.location.search) };
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  // Only same-origin, path-relative targets are allowed (no open redirects).
  if (!to.startsWith('/') || to.startsWith('//')) to = '/';
  if (opts.replace) window.history.replaceState(null, '', withBase(to));
  else window.history.pushState(null, '', withBase(to));
  window.dispatchEvent(new PopStateEvent('popstate'));
  if (!opts.replace) window.scrollTo(0, 0);
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState<Location>(readLocation);
  useEffect(() => {
    const onPop = () => setLoc(readLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return <RouterCtx.Provider value={loc}>{children}</RouterCtx.Provider>;
}

export function useLocation(): Location {
  const loc = useContext(RouterCtx);
  if (!loc) throw new Error('useLocation outside RouterProvider');
  return loc;
}

/** Match "/product/:slug" against a pathname. Returns params or null. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const a = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    const val = a[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}

export interface Route {
  path: string;
  render: (params: Record<string, string>) => ReactNode;
}

export function Routes({ routes, fallback }: { routes: Route[]; fallback: ReactNode }) {
  const { pathname } = useLocation();
  const hit = useMemo(() => {
    for (const r of routes) {
      const params = matchPath(r.path, pathname);
      if (params) return { r, params };
    }
    return null;
  }, [routes, pathname]);
  return <>{hit ? hit.r.render(hit.params) : fallback}</>;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

export function Link({ to, onClick, children, ...rest }: LinkProps) {
  return (
    <a
      href={withBase(to)}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** Safe "next" redirect after login: only internal paths. */
export function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}
