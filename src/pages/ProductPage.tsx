import { useState } from 'react';
import { ProductCard } from '../components/ProductCard';
import { productEnquiry } from '../lib/whatsapp';
import { ProductImage, Spinner } from '../components/ui';
import { useCart } from '../lib/cart';
import { useCatalogue } from '../lib/catalogue';
import { displayPrice, inr, swatch, unitPrice } from '../lib/format';
import { Link, navigate } from '../lib/router';
import { useToast } from '../lib/toast';

export function ProductPage({ slug }: { slug: string }) {
  const { products, loading } = useCatalogue();
  const cart = useCart();
  const toast = useToast();
  const p = products.find((x) => x.slug === slug);
  const existing = p ? cart.lines.find((l) => l.productId === p.id) : undefined;
  const [qtyInput, setQty] = useState<number | null>(null);

  if (loading) return <Spinner />;
  if (!p)
    return (
      <div className="wrap page">
        <h1>Product not found</h1>
        <p className="sub">It may have been removed or is not available right now.</p>
        <Link to="/shop" className="btn sec">Back to the catalogue</Link>
      </div>
    );

  const qty = qtyInput ?? existing?.quantity ?? p.moq;
  const price = displayPrice(p);
  const each = unitPrice(p);
  const related = products.filter((x) => x.id !== p.id && x.subcategory === p.subcategory).slice(0, 4);
  const qtyOk = Number.isInteger(qty) && qty >= p.moq && qty <= 100000;
  const wa = productEnquiry(p, qtyOk ? qty : p.moq);

  return (
    <div className="wrap">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/shop">Shop</Link> / <Link to={`/shop?category=${p.category.slug}`}>{p.category.name}</Link> / {p.name}
      </nav>
      <div className="pdp">
        <div className="pic"><ProductImage path={p.image_path} alt={p.name} /></div>
        <div>
          <div className="br">{p.brand ?? 'Swagarage'} · {p.subcategory}</div>
          <h1>{p.name}</h1>
          <div className="price" style={{ paddingTop: 0 }}>
            {price.amount !== null && <b style={{ fontSize: 28 }}>{inr(price.amount)}</b>}
            <small>{price.amount !== null ? 'per unit · GST, branding & shipping added at checkout' : price.label}</small>
          </div>
          <div className="pills" style={{ margin: '12px 0' }}>
            {p.branding_possible ? <span className="pill">Logo branding available</span> : <span className="pill r">Branding not possible</span>}
          </div>
          {p.description && <p>{p.description}</p>}
          {p.features.length > 0 && <ul className="feats">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>}
          <table className="specs">
            <tbody>
              {Object.entries(p.specs).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
              {p.colours.length > 0 && (
                <tr><td>Colours</td><td><div className="dots">{p.colours.map((c) => <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 8 }}><span className="dot" style={{ background: swatch(c) }} />{c}</span>)}</div></td></tr>
              )}
              <tr><td>Minimum order</td><td>{p.moq} units</td></tr>
              {p.delivery_note && <tr><td>Delivery</td><td>{p.delivery_note}</td></tr>}
            </tbody>
          </table>
          <div className="qty" style={{ marginTop: 18 }}>
            <label htmlFor="qty">Quantity</label>
            <input id="qty" className="input" type="number" min={p.moq} max={100000} step={1} value={Number.isNaN(qty) ? '' : qty} onChange={(e) => setQty(Math.floor(Number(e.target.value)))} aria-invalid={!qtyOk} />
            {each !== null && qtyOk && <span className="note">{inr(each * qty)} estimate</span>}
            {!qtyOk && <span className="note" style={{ color: 'var(--err)' }}>Minimum {p.moq} units</span>}
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="btn pri"
              disabled={!qtyOk}
              onClick={() => {
                if (existing) cart.update(p.id, { quantity: qty });
                else cart.add(p.id, qty);
                toast(existing ? 'Quote updated' : 'Added to your quote', 'success');
              }}
            >
              {existing ? 'Update quote' : 'Add to quote'}
            </button>
            <button className="btn sec" onClick={() => navigate('/quote')}>View quote</button>
            {wa && (
              <a className="btn wa" href={wa} target="_blank" rel="noopener noreferrer">Enquire on WhatsApp</a>
            )}
          </div>
        </div>
      </div>
      {related.length > 0 && (
        <section className="s" style={{ paddingTop: 0 }}>
          <div className="sh"><h2>Similar products</h2></div>
          <div className="grid">{related.map((r) => <ProductCard key={r.id} p={r} />)}</div>
        </section>
      )}
    </div>
  );
}
