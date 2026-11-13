import { useEffect, useState } from 'react';
import { useCart } from '../lib/cart';
import { displayPrice, inr } from '../lib/format';
import { Link } from '../lib/router';
import { useToast } from '../lib/toast';
import type { CatalogueProduct } from '../lib/types';
import { productEnquiry } from '../lib/whatsapp';
import { ProductImage } from './ui';

const MAX_QTY = 100000;

export function ProductCard({ p }: { p: CatalogueProduct }) {
  const cart = useCart();
  const toast = useToast();
  const line = cart.lines.find((l) => l.productId === p.id);
  const [qty, setQty] = useState<string>(String(line?.quantity ?? p.moq));
  useEffect(() => {
    if (line) setQty(String(line.quantity));
  }, [line?.quantity]); // eslint-disable-line react-hooks/exhaustive-deps

  const price = displayPrice(p);
  const n = Number.parseInt(qty, 10);
  const valid = Number.isFinite(n) && n >= p.moq && n <= MAX_QTY;
  const wa = productEnquiry(p, valid ? n : p.moq);

  function add() {
    if (!Number.isFinite(n) || n < p.moq) {
      setQty(String(p.moq));
      return toast(`Minimum order is ${p.moq} units`, 'error');
    }
    const q = Math.min(n, MAX_QTY);
    if (line) cart.update(p.id, { quantity: q });
    else cart.add(p.id, q);
    toast(line ? `Updated to ${q} units` : `Added to quote · ${q} units`, 'success');
  }

  return (
    <article className="card">
      <Link to={`/product/${p.slug}`} className="im" aria-label={p.name}>
        <ProductImage path={p.image_path} alt="" />
      </Link>
      <div className="bd">
        <h3><Link to={`/product/${p.slug}`}>{p.name}</Link></h3>
        <div className="meta">
          <span className="br">{p.brand ?? 'Swagarage'}</span>
          <span className="price">
            {price.amount !== null ? <b>{inr(price.amount)}</b> : <b>On request</b>}
            {price.label && <small>{price.label}</small>}
          </span>
        </div>
        <div className="buy">
          <label className="sr-only" htmlFor={`q-${p.id}`}>Quantity for {p.name}</label>
          <input
            id={`q-${p.id}`}
            className="input qty"
            type="number"
            inputMode="numeric"
            min={p.moq}
            max={MAX_QTY}
            step={1}
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            aria-invalid={!valid}
          />
          <button className={`btn pri sm ${line ? 'in' : ''}`} onClick={add}>{line ? (Number(qty) === line.quantity ? '✓ Added' : 'Update') : 'Add'}</button>
        </div>
        <div className="moq">Min. order {p.moq} units</div>
        {wa && (
          <a className="btn wa sm" href={wa} target="_blank" rel="noopener noreferrer">
            Enquire on WhatsApp
          </a>
        )}
      </div>
    </article>
  );
}
