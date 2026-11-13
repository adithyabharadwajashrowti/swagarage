import { useState, type FormEvent } from 'react';
import { ProductImage, Spinner, TextArea, TextField } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useCart } from '../lib/cart';
import { useCatalogue } from '../lib/catalogue';
import { buildCatalogueDeck, downloadBlob } from '../lib/deck';
import { checkoutTotals, inr, unitPrice } from '../lib/format';
import { Link, navigate } from '../lib/router';
import { friendlyError, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { fieldErrors, quoteFormSchema, type QuoteForm } from '../lib/validation';

export function QuotePage() {
  const { products: shopProducts, addons, loading } = useCatalogue();
  const products = [...shopProducts, ...addons];
  const { session, profile } = useAuth();
  const cart = useCart();
  const toast = useToast();
  const [form, setForm] = useState<QuoteForm>({
    contact_name: '', company: '', email: '', phone: '', occasion: '', delivery_city: '', needed_by: '', notes: '',
  });
  const [prefilled, setPrefilled] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deckBusy, setDeckBusy] = useState(false);

  if (profile && !prefilled) {
    setPrefilled(true);
    setForm((f) => ({
      ...f,
      contact_name: f.contact_name || profile.full_name || '',
      company: f.company || profile.company || '',
      email: f.email || profile.email || '',
      phone: f.phone || profile.phone || '',
    }));
  }

  if (loading) return <Spinner />;

  const lines = cart.lines.map((l) => ({ line: l, product: products.find((p) => p.id === l.productId) }));
  const valid = lines.filter((x) => x.product);
  const missing = lines.filter((x) => !x.product);
  const totals = checkoutTotals(valid.map(({ line, product }) => ({ quantity: line.quantity, product: product! })));
  const giftUnits = valid.filter(({ product }) => !product!.is_addon).reduce((s, { line }) => s + (Number.isFinite(line.quantity) ? line.quantity : 0), 0);
  const lineErrors = valid.filter(({ line, product }) => !Number.isInteger(line.quantity) || line.quantity < product!.moq);
  const set = (k: keyof QuoteForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const parsed = quoteFormSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    if (!valid.length || lineErrors.length) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('submit_quote', {
      p_quote: {
        ...parsed.data,
        items: valid.map(({ line }) => ({
          product_id: line.productId,
          quantity: line.quantity,
          colour: line.colour ?? null,
          branding: line.branding ?? null,
        })),
      },
    });
    setBusy(false);
    if (error) {
      setSubmitError(friendlyError(error));
      return;
    }
    const row = (data as { quote_id: string; quote_ref: string }[] | null)?.[0];
    cart.clear();
    toast('Quote request sent. We will get back to you shortly.', 'success');
    navigate(row ? `/account/quotes/${row.quote_ref}` : '/account');
  }

  async function deck() {
    setDeckBusy(true);
    try {
      downloadBlob(await buildCatalogueDeck(valid.map((v) => v.product!), 'Your shortlist'), 'Swagarage_Catalogue.pptx');
    } catch {
      toast('Could not build the deck. Please try again.', 'error');
    } finally {
      setDeckBusy(false);
    }
  }

  if (!cart.lines.length)
    return (
      <div className="wrap page">
        <h1>Your quote is empty</h1>
        <p className="sub">Add products from the catalogue, or ask the Gift Assistant for ideas.</p>
        <div className="row"><Link to="/shop" className="btn pri">Shop the catalogue</Link><Link to="/assistant" className="btn sec">Gift Assistant</Link></div>
      </div>
    );

  return (
    <div className="wrap qpage">
      <section>
        <h1 style={{ fontSize: 28, marginBottom: 4 }}>Your quote</h1>
        <p className="note" style={{ marginBottom: 8 }}>Set quantities, colours and branding notes. Prices shown are indicative; we confirm the final quote.</p>
        {missing.length > 0 && (
          <p className="alert info">
            {missing.length} product{missing.length > 1 ? 's are' : ' is'} no longer available and will not be included.{' '}
            <button className="btn ghost sm" onClick={() => missing.forEach((m) => cart.remove(m.line.productId))}>Remove</button>
          </p>
        )}
        {valid.map(({ line, product: p }) => {
          const prod = p!;
          const bad = !Number.isInteger(line.quantity) || line.quantity < prod.moq;
          return (
            <div className="qline" key={line.productId}>
              <ProductImage path={prod.image_path} alt="" />
              <div className="meta">
                <Link to={`/product/${prod.slug}`}><b>{prod.name}</b></Link>
                <span className="note">{unitPrice(prod) !== null ? `${inr(unitPrice(prod))} per unit` : 'Price on request'} · Min. {prod.moq}{prod.is_addon ? ' · Gift box' : ''}</span>
                <div className="opts">
                  <label className="sr-only" htmlFor={`q-${prod.id}`}>Quantity</label>
                  <input id={`q-${prod.id}`} className="input" type="number" min={prod.moq} max={100000} value={line.quantity} aria-invalid={bad}
                    onChange={(e) => cart.update(prod.id, { quantity: Math.floor(Number(e.target.value)) })} style={{ width: 100 }} />
                  {prod.colours.length > 0 && (
                    <>
                      <label className="sr-only" htmlFor={`c-${prod.id}`}>Colour</label>
                      <select id={`c-${prod.id}`} className="input" value={line.colour ?? ''} onChange={(e) => cart.update(prod.id, { colour: e.target.value || undefined })}>
                        <option value="">Any colour</option>
                        {prod.colours.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </>
                  )}
                  {prod.branding_possible && (
                    <>
                      <label className="sr-only" htmlFor={`b-${prod.id}`}>Branding note</label>
                      <input id={`b-${prod.id}`} className="input" placeholder="Branding note (e.g. logo on front)" maxLength={200} value={line.branding ?? ''}
                        onChange={(e) => cart.update(prod.id, { branding: e.target.value || undefined })} style={{ minWidth: 220 }} />
                    </>
                  )}
                </div>
                {bad && <span className="note" style={{ color: 'var(--err)' }}>Minimum {prod.moq} units</span>}
              </div>
              <button className="btn ghost sm" onClick={() => cart.remove(prod.id)} aria-label={`Remove ${prod.name}`}>Remove</button>
            </div>
          );
        })}
        {addons.length > 0 && giftUnits > 0 && (
          <div className="addons">
            <h2>Add a gift box?</h2>
            <p className="note">Presentation boxes for your gifts, one per unit ({giftUnits.toLocaleString('en-IN')} units).</p>
            <div className="addon-list">
              {addons.slice(0, 12).map((a) => {
                const inCart = cart.lines.some((l) => l.productId === a.id);
                return (
                  <div className="addon" key={a.id}>
                    <ProductImage path={a.image_path} alt="" />
                    <div className="meta"><b>{a.name}</b><span className="note">{inr(unitPrice(a))} per box</span></div>
                    <button className="btn sec sm" disabled={inCart} onClick={() => cart.add(a.id, Math.max(a.moq, giftUnits))}>{inCart ? '✓ Added' : 'Add'}</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn blue sm" onClick={deck} disabled={deckBusy || !valid.length}>{deckBusy ? 'Building deck…' : 'Download catalogue PPT'}</button>
          <Link to="/shop" className="btn ghost sm">Add more products</Link>
        </div>
      </section>
      <aside className="box sticky">
        <div className="checkout" aria-label="Estimate">
          <div className="ln"><span>Products</span><span>{inr(totals.subtotal)}</span></div>
          {totals.gstByRate.map(([r, v]) => (
            <div className="ln" key={r}><span>GST {r}%</span><span>{inr(v)}</span></div>
          ))}
          <div className="ln muted"><span>Branding</span><span>Quoted by our team</span></div>
          <div className="ln muted"><span>Shipping</span><span>Quoted by our team</span></div>
          <div className="tot"><span>Estimated total</span><span>{inr(totals.total)}</span></div>
        </div>
        <p className="note" style={{ margin: '4px 0 16px' }}>Includes GST. Branding and shipping are added to your final quote.</p>
        {!session ? (
          <div className="form">
            <p>Sign in to send this quote request. Your selection is saved.</p>
            <Link to="/login?next=/quote" className="btn pri block">Sign in</Link>
            <Link to="/signup?next=/quote" className="btn sec block">Create an account</Link>
          </div>
        ) : (
          <form className="form" onSubmit={submit} noValidate>
            <h2>Contact details</h2>
            <TextField label="Contact name" value={form.contact_name} onChange={set('contact_name')} error={errors.contact_name} autoComplete="name" required />
            <TextField label="Company" value={form.company} onChange={set('company')} error={errors.company} autoComplete="organization" required />
            <div className="form-grid">
              <TextField label="Work email" type="email" value={form.email} onChange={set('email')} error={errors.email} autoComplete="email" required />
              <TextField label="Phone" type="tel" value={form.phone} onChange={set('phone')} error={errors.phone} autoComplete="tel" />
            </div>
            <div className="form-grid">
              <TextField label="Occasion" value={form.occasion} onChange={set('occasion')} error={errors.occasion} placeholder="e.g. Diwali, onboarding" />
              <TextField label="Delivery city" value={form.delivery_city} onChange={set('delivery_city')} error={errors.delivery_city} />
            </div>
            <TextField label="Needed by" type="date" value={form.needed_by} onChange={set('needed_by')} error={errors.needed_by} min={new Date().toISOString().slice(0, 10)} />
            <TextArea label="Anything else?" value={form.notes} onChange={set('notes')} error={errors.notes} maxLength={2000} placeholder="Packaging, individual delivery, logo files…" />
            {submitError && <p className="alert err" role="alert">{submitError}</p>}
            <button className="btn pri block" type="submit" disabled={busy || !valid.length || lineErrors.length > 0}>
              {busy ? 'Sending…' : 'Request final quote'}
            </button>
          </form>
        )}
      </aside>
    </div>
  );
}
