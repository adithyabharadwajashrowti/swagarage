import { useMemo } from 'react';
import { ProductCard } from '../components/ProductCard';
import { Spinner } from '../components/ui';
import { featuredOrder } from '../lib/assistant';
import { useCatalogue } from '../lib/catalogue';
import { unitPrice } from '../lib/format';
import { navigate, useLocation } from '../lib/router';
import { smartSearch } from '../lib/search';
import type { CatalogueProduct } from '../lib/types';

const PRICES: { key: string; label: string; lo: number; hi: number }[] = [
  { key: 'u500', label: 'Under ₹500', lo: 0, hi: 500 },
  { key: '500-1000', label: '₹500 – ₹1,000', lo: 500, hi: 1000 },
  { key: '1000-2500', label: '₹1,000 – ₹2,500', lo: 1000, hi: 2500 },
  { key: '2500-5000', label: '₹2,500 – ₹5,000', lo: 2500, hi: 5000 },
  { key: '5000+', label: '₹5,000 and above', lo: 5000, hi: Infinity },
];

export function Shop() {
  const { products, categories, collections, loading, error } = useCatalogue();
  const { search } = useLocation();

  const q = search.get('q') ?? '';
  const category = search.get('category') ?? '';
  const collection = search.get('collection') ?? '';
  const priceKey = search.get('price') ?? '';
  const brand = search.get('brand') ?? '';
  const sort = search.get('sort') ?? (q ? 'relevance' : 'featured');

  function set(key: string, value: string) {
    const p = new URLSearchParams(search);
    if (value) p.set(key, value);
    else p.delete(key);
    const s = p.toString();
    navigate(`/shop${s ? `?${s}` : ''}`, { replace: true });
  }

  const brands = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products) m.set(p.brand ?? 'Swagarage', (m.get(p.brand ?? 'Swagarage') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([b]) => b);
  }, [products]);

  const view = useMemo(() => {
    const band = PRICES.find((x) => x.key === priceKey);
    const keep = (p: CatalogueProduct) => {
      if (category && p.category.slug !== category) return false;
      if (collection && !p.collection_slugs.includes(collection)) return false;
      if (brand && (p.brand ?? 'Swagarage') !== brand) return false;
      if (band) {
        const price = unitPrice(p);
        if (price === null || price < band.lo || price >= band.hi) return false;
      }
      return true;
    };
    const found = smartSearch(products, q);
    let exact = found.exact.filter(keep);
    const related = q.trim() ? found.related.filter(keep) : [];
    const price = (x: CatalogueProduct) => unitPrice(x) ?? Infinity;
    if (sort === 'price-asc') exact = [...exact].sort((a, b) => price(a) - price(b));
    if (sort === 'price-desc') exact = [...exact].sort((a, b) => (unitPrice(b) ?? -1) - (unitPrice(a) ?? -1));
    if (sort === 'name') exact = [...exact].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'featured' && !q.trim()) exact = featuredOrder(exact);
    // A search that finds nothing still shows something useful.
    const popular = q.trim() && !exact.length && !related.length ? featuredOrder(products.filter(keep)).slice(0, 8) : [];
    return { exact, related, popular, understood: found.understood, corrected: found.corrected };
  }, [products, q, category, collection, priceKey, brand, sort]);

  if (loading) return <Spinner label="Loading catalogue…" />;

  const filtered = !!(category || collection || priceKey || brand);
  const title = category
    ? categories.find((c) => c.slug === category)?.name ?? 'All products'
    : collection
      ? collections.find((c) => c.slug === collection)?.name ?? 'All products'
      : 'Shop all products';

  return (
    <div className="wrap shop2">
      <header className="shop-head">
        <h1>{title}</h1>
        <p>Corporate gifts with your branding. Prices are per unit, minimum order 25.</p>
      </header>

      <div className="shop-bar">
        <label htmlFor="q" className="sr-only">Search products</label>
        <input
          id="q"
          className="input search"
          type="search"
          placeholder="Search, e.g. bottle, laptop bag"
          value={q}
          maxLength={80}
          enterKeyHint="search"
          onChange={(e) => set('q', e.target.value.trimStart())}
        />
        <label htmlFor="cat" className="sr-only">Category</label>
        <select id="cat" className="input" value={category} onChange={(e) => set('category', e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </select>
        <label htmlFor="occ" className="sr-only">Occasion</label>
        <select id="occ" className="input" value={collection} onChange={(e) => set('collection', e.target.value)}>
          <option value="">All occasions</option>
          {collections.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </select>
        <label htmlFor="pr" className="sr-only">Price</label>
        <select id="pr" className="input" value={priceKey} onChange={(e) => set('price', e.target.value)}>
          <option value="">Any price</option>
          {PRICES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
        <label htmlFor="sort" className="sr-only">Sort</label>
        <select id="sort" className="input" value={sort} onChange={(e) => set('sort', e.target.value)}>
          {q && <option value="relevance">Best match</option>}
          <option value="featured">Featured</option>
          <option value="price-asc">Price: low to high</option>
          <option value="price-desc">Price: high to low</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      <div className="brand-chips" role="group" aria-label="Brands">
        <button className={!brand ? 'on' : ''} aria-pressed={!brand} onClick={() => set('brand', '')}>All</button>
        {brands.map((b) => (
          <button key={b} className={brand === b ? 'on' : ''} aria-pressed={brand === b} onClick={() => set('brand', brand === b ? '' : b)}>{b}</button>
        ))}
      </div>

      {error && <p className="alert err">{error}</p>}

      <div className="chips">
        <span className="note">{view.exact.length} {view.exact.length === 1 ? 'product' : 'products'}</span>
        {view.corrected && <span className="note">Showing results for “{view.corrected}”</span>}
        {view.understood.map((c) => <span key={c} className="chip">{c}</span>)}
        {(filtered || q) && <button className="btn ghost sm" onClick={() => navigate('/shop', { replace: true })}>Clear all</button>}
      </div>

      {view.exact.length > 0 && <div className="grid">{view.exact.map((p) => <ProductCard key={p.id} p={p} />)}</div>}

      {view.exact.length === 0 && (
        <div className="empty">
          {q ? <>Sorry, we don't have an exact match for “{q}” right now.{view.related.length ? ' Here are the closest products.' : ''}</> : 'No products match these filters. Try clearing one.'}
        </div>
      )}

      {view.related.length > 0 && (
        <section className="related">
          <h2>{view.exact.length ? 'Related products' : 'Closest matches'}</h2>
          <div className="grid">{view.related.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        </section>
      )}

      {view.popular.length > 0 && (
        <section className="related">
          <h2>Popular products</h2>
          <div className="grid">{view.popular.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        </section>
      )}
    </div>
  );
}
