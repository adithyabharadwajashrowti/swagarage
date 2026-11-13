import { useMemo } from 'react';
import { AssistantPanel } from '../components/AssistantPanel';
import { ProductCard } from '../components/ProductCard';
import { ProductImage, Spinner } from '../components/ui';
import { useCatalogue } from '../lib/catalogue';
import { collectionCovers } from '../lib/covers';
import { Link } from '../lib/router';

const COLLECTION_STYLE = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];

export function Home() {
  const { products, categories, collections, loading, error } = useCatalogue();

  const featured = useMemo(() => {
    // One per subcategory, ready stock first, for variety.
    const seen = new Set<string>();
    return [...products]
      .sort((a, b) => Number((b.ready_stock ?? 0) > 0) - Number((a.ready_stock ?? 0) > 0))
      .filter((p) => {
        const k = p.subcategory ?? p.category.slug;
        if (seen.has(k) || !p.image_path) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 8);
  }, [products]);

  // One product photo per category for the hero, so it shows the range.
  const heroPicks = useMemo(() => {
    const out: typeof products = [];
    for (const slug of ['bags-backpacks', 'eco-friendly', 'gadgets-tech', 'travel-accessories']) {
      const p = products.find((x) => x.category.slug === slug && x.image_path && (slug !== 'gadgets-tech' || x.subcategory === 'Headphones & Earbuds') && (slug !== 'bags-backpacks' || x.brand === 'Oblique'));
      if (p) out.push(p);
    }
    return out;
  }, [products]);

  const covers = useMemo(() => collectionCovers(products, collections), [products, collections]);
  const brands = useMemo(() => new Set(products.map((p) => p.brand).filter(Boolean)).size, [products]);

  return (
    <>
      <section className="hero">
        <div className="wrap g">
          <div>
            <span className="eyebrow">Corporate gifting, made easy</span>
            <h1 className="big">Swag your team will <span>actually use</span></h1>
            <p className="lead">Branded bags, gadgets, apparel and eco gifts for onboarding, festivals and clients. Pick products, add your logo, and get a catalogue deck in minutes.</p>
            <div className="row">
              <Link to="/shop" className="btn pri">Shop the catalogue</Link>
              <Link to="/assistant" className="btn sec">Get a gift deck</Link>
            </div>
            {!loading && products.length > 0 && (
              <div className="facts">
                <div><b>{products.length}</b>products</div>
                <div><b>25</b>minimum order</div>
                <div><b>{brands}+</b>brands</div>
              </div>
            )}
          </div>
          <div className="collage" aria-hidden>
            {heroPicks.map((p) => (
              <div className="t" key={p.id}><ProductImage path={p.image_path} alt="" /></div>
            ))}
          </div>
        </div>
      </section>

      {error && <div className="wrap"><p className="alert err">{error}</p></div>}
      {loading ? (
        <Spinner label="Loading catalogue…" />
      ) : (
        <>
          <section className="s">
            <div className="wrap">
              <div className="sh">
                <div><div className="kick">What we do</div><h2>Every kind of gift, for every occasion</h2></div>
                <Link to="/shop" className="btn sec sm">Browse all products</Link>
              </div>
              <div className="cats">
                {categories.map((c) => {
                  const inCat = products.filter((p) => p.category_id === c.id);
                  const rep = inCat.find((p) => p.image_path);
                  return (
                    <Link key={c.id} to={`/shop?category=${c.slug}`} className="cat">
                      <div className="im">{rep ? <ProductImage path={rep.image_path} alt="" /> : <div className="noimg" />}</div>
                      <b>{c.name}</b>
                      <small>{inCat.length} products</small>
                    </Link>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="s alt">
            <div className="wrap">
              <div className="sh"><div><div className="kick">Collections</div><h2>Shop by occasion</h2><p>Curated sets for the moments that matter.</p></div></div>
              <div className="colls">
                {collections.map((c, i) => {
                  const count = products.filter((p) => p.collection_slugs.includes(c.slug)).length;
                  const pics = covers.get(c.slug) ?? [];
                  return (
                    <Link key={c.id} to={`/shop?collection=${c.slug}`} className={`coll ${COLLECTION_STYLE[i % 6]}`}>
                      <div className="pics" aria-hidden>
                        {pics.map((p) => <ProductImage key={p.id} path={p.image_path} alt="" />)}
                      </div>
                      <h3>{c.name}</h3>
                      <p>{c.description} · {count} products</p>
                    </Link>
                  );
                })}
              </div>
            </div>
          </section>

          {featured.length > 0 && (
            <section className="s">
              <div className="wrap">
                <div className="sh"><div><div className="kick">Featured</div><h2>Popular picks</h2></div><Link to="/shop" className="btn sec sm">Explore all</Link></div>
                <div className="grid">{featured.map((p) => <ProductCard key={p.id} p={p} />)}</div>
              </div>
            </section>
          )}

          <section className="s">
            <div className="wrap"><AssistantPanel /></div>
          </section>
        </>
      )}

      <section className="s alt">
        <div className="wrap">
          <div className="sh"><div><div className="kick">The process</div><h2>From idea to doorstep in four steps</h2></div></div>
          <div className="steps">
            <div className="step"><div className="no">1</div><h3>Choose your products</h3><p>Browse the catalogue or ask the Gift Assistant. Minimum order from 25 units.</p></div>
            <div className="step"><div className="no">2</div><h3>Share your logo</h3><p>We send a digital mockup to approve before anything is made.</p></div>
            <div className="step"><div className="no">3</div><h3>Approve your quote</h3><p>We confirm stock, branding method, price and timeline.</p></div>
            <div className="step"><div className="no">4</div><h3>Get it delivered</h3><p>Bulk delivery to your office, or individual packs to each person.</p></div>
          </div>
        </div>
      </section>
    </>
  );
}

export function AssistantPage() {
  return (
    <div className="wrap page">
      <AssistantPanel />
    </div>
  );
}
