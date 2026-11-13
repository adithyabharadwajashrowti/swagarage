import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from './supabase';
import type { CatalogueProduct, Category, Collection } from './types';

// Catalogue loading, built for traffic:
//   1. ask the database for the catalogue version (tiny, cheap)
//   2. same version as the copy cached in this browser -> use it, done
//   3. else fetch catalogue/v<version>.json from the Supabase Storage CDN
//   4. else (not published to the CDN yet) call get_catalogue() once
// The database therefore sees one tiny query per visit in the normal case.

export interface CataloguePayload {
  version: number;
  products: CatalogueProduct[];
  categories: Category[];
  collections: Collection[];
}

interface CatalogueState {
  products: CatalogueProduct[];
  categories: Category[];
  collections: Collection[];
  version: number | null;
  loading: boolean;
  error: string | null;
  /** Gift boxes and other checkout add-ons (kept out of `products`). */
  addons: CatalogueProduct[];
  reload: () => void;
}

const Ctx = createContext<CatalogueState | null>(null);
const CACHE_KEY = 'swagarage.catalogue.v1';
export const CATALOGUE_BUCKET = 'catalogue';

export function catalogueFileUrl(version: number): string {
  return supabase.storage.from(CATALOGUE_BUCKET).getPublicUrl(`v${version}.json`).data.publicUrl;
}

function isPayload(x: unknown): x is CataloguePayload {
  const p = x as CataloguePayload;
  return !!p && typeof p.version === 'number' && Array.isArray(p.products) && Array.isArray(p.categories) && Array.isArray(p.collections);
}

function readCache(): CataloguePayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(p: CataloguePayload): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(p));
  } catch {
    /* quota or private mode: skip caching */
  }
}

export async function fetchCatalogue(): Promise<CataloguePayload> {
  const { data: version, error } = await supabase.rpc('catalogue_version');
  if (error || typeof version !== 'number') throw error ?? new Error('No catalogue version');

  const cached = readCache();
  if (cached && cached.version === version) return cached;

  try {
    const res = await fetch(catalogueFileUrl(version), { cache: 'force-cache' });
    if (res.ok) {
      const body: unknown = await res.json();
      if (isPayload(body) && body.version === version) {
        writeCache(body);
        return body;
      }
    }
  } catch {
    /* CDN unavailable: fall through to the database */
  }

  const { data, error: e2 } = await supabase.rpc('get_catalogue');
  if (e2 || !isPayload(data)) throw e2 ?? new Error('Bad catalogue');
  writeCache(data);
  return data;
}

export function CatalogueProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<CatalogueState, 'reload' | 'addons'>>(() => {
    // Show the cached catalogue instantly while checking for updates.
    const c = readCache();
    return c
      ? { products: c.products, categories: c.categories, collections: c.collections, version: c.version, loading: false, error: null }
      : { products: [], categories: [], collections: [], version: null, loading: true, error: null };
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let active = true;
    fetchCatalogue()
      .then((c) => {
        if (active)
          setState({ products: c.products, categories: c.categories, collections: c.collections, version: c.version, loading: false, error: null });
      })
      .catch(() => {
        if (active)
          setState((s) => ({ ...s, loading: false, error: s.products.length ? null : 'Could not load the catalogue. Please refresh.' }));
      });
    return () => {
      active = false;
    };
  }, [tick]);

  // Add-ons (gift boxes) are offered at checkout only, never listed in the shop, search or assistant.
  const value = useMemo(() => {
    const products = state.products.filter((p) => !p.is_addon);
    const addons = state.products.filter((p) => p.is_addon);
    // Browse only categories that have something to show (gift boxes are offered at checkout instead).
    const used = new Set(products.map((p) => p.category.slug));
    const categories = state.loading ? state.categories : state.categories.filter((c) => used.has(c.slug));
    return { ...state, categories, products, addons, reload };
  }, [state, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCatalogue(): CatalogueState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCatalogue outside CatalogueProvider');
  return ctx;
}

/**
 * Staff only: publish the current snapshot to the CDN if it isn't there yet.
 * Files are versioned and immutable, so a stale copy is never served.
 */
export async function publishCatalogueToCdn(): Promise<'published' | 'current' | 'failed'> {
  try {
    const { data: version } = await supabase.rpc('catalogue_version');
    if (typeof version !== 'number') return 'failed';
    const head = await fetch(catalogueFileUrl(version), { method: 'HEAD', cache: 'no-store' });
    if (head.ok) return 'current';
    const { data, error } = await supabase.rpc('get_catalogue');
    if (error || !isPayload(data) || data.version !== version) return 'failed';
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const up = await supabase.storage
      .from(CATALOGUE_BUCKET)
      .upload(`v${version}.json`, blob, { contentType: 'application/json', cacheControl: '31536000', upsert: false });
    if (up.error && !/exists|duplicate/i.test(up.error.message)) return 'failed';
    return 'published';
  } catch {
    return 'failed';
  }
}
