import { useEffect, useState, type FormEvent } from 'react';
import { Spinner, StatusBadge, TextField } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime, inr, QUOTE_STATUS_LABEL } from '../lib/format';
import { Link } from '../lib/router';
import { friendlyError, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import type { Quote, QuoteEvent, QuoteItem } from '../lib/types';
import { fieldErrors, profileSchema } from '../lib/validation';

export function AccountPage() {
  const { profile, refreshProfile } = useAuth();
  const toast = useToast();
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [form, setForm] = useState({ full_name: '', company: '', phone: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (profile) setForm({ full_name: profile.full_name ?? '', company: profile.company ?? '', phone: profile.phone ?? '' });
  }, [profile]);

  useEffect(() => {
    if (!profile) return;
    supabase
      .from('quotes')
      .select('*')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => setQuotes((data ?? []) as Quote[]));
  }, [profile]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const parsed = profileSchema.safeParse(form);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: parsed.data.full_name, company: parsed.data.company || null, phone: parsed.data.phone || null })
      .eq('id', profile!.id);
    setBusy(false);
    if (error) return toast(friendlyError(error), 'error');
    await refreshProfile();
    toast('Profile saved', 'success');
  }

  if (!profile) return <Spinner />;

  return (
    <div className="wrap page">
      <h1>Your account</h1>
      <p className="sub">{profile.email}</p>
      <div className="two">
        <form className="box form" onSubmit={save} noValidate>
          <h2>Profile</h2>
          <TextField label="Name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} error={errors.full_name} autoComplete="name" />
          <TextField label="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} error={errors.company} autoComplete="organization" />
          <TextField label="Phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} error={errors.phone} autoComplete="tel" />
          <button className="btn pri" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <Link to="/forgot-password" className="note">Change password</Link>
        </form>
        <section className="box">
          <h2>Your quotes</h2>
          {quotes === null ? (
            <Spinner />
          ) : quotes.length === 0 ? (
            <p className="note">No quotes yet. <Link to="/shop" style={{ color: 'var(--blue)' }}>Browse the catalogue</Link></p>
          ) : (
            <div className="tablewrap">
              <table className="t">
                <thead><tr><th>Quote</th><th>Date</th><th>Status</th><th className="num">Estimate</th></tr></thead>
                <tbody>
                  {quotes.map((q) => (
                    <tr key={q.id}>
                      <td><Link to={`/account/quotes/${q.ref}`} style={{ color: 'var(--blue)', fontWeight: 600 }}>{q.ref}</Link></td>
                      <td>{formatDate(q.created_at)}</td>
                      <td><StatusBadge value={q.status} label={QUOTE_STATUS_LABEL[q.status]} /></td>
                      <td className="num">{inr(q.quoted_total ?? q.estimate_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function QuoteItemsTable({ items }: { items: QuoteItem[] }) {
  return (
    <div className="tablewrap">
      <table className="t">
        <thead><tr><th>Product</th><th>Colour</th><th>Branding</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Line</th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td>{i.product_name}</td>
              <td>{i.colour ?? 'Any'}</td>
              <td>{i.branding ?? '—'}</td>
              <td className="num">{i.quantity}</td>
              <td className="num">{inr(i.unit_price)} <span className="note">{i.price_basis === 'gst_extra' ? '+GST' : i.price_basis === 'mrp' ? 'MRP' : ''}</span></td>
              <td className="num">{i.unit_price !== null ? inr(Number(i.unit_price) * i.quantity) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function QuoteTimeline({ events }: { events: QuoteEvent[] }) {
  return (
    <div className="timeline">
      {events.map((e) => (
        <div className="ev" key={e.id}>
          <small>{formatDateTime(e.created_at)}</small>
          <StatusBadge value={e.to_status} label={QUOTE_STATUS_LABEL[e.to_status]} />
          {e.message && <p style={{ marginTop: 4 }}>{e.message}</p>}
        </div>
      ))}
    </div>
  );
}

export function AccountQuotePage({ quoteRef }: { quoteRef: string }) {
  const toast = useToast();
  const [quote, setQuote] = useState<Quote | null | undefined>(undefined);
  const [items, setItems] = useState<QuoteItem[]>([]);
  const [events, setEvents] = useState<QuoteEvent[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    (async () => {
      const { data: q } = await supabase.from('quotes').select('*').eq('ref', quoteRef).maybeSingle();
      setQuote((q as Quote | null) ?? null);
      if (!q) return;
      const [it, ev] = await Promise.all([
        supabase.from('quote_items').select('*').eq('quote_id', q.id),
        supabase.from('quote_events').select('*').eq('quote_id', q.id).order('created_at'),
      ]);
      setItems((it.data ?? []) as QuoteItem[]);
      setEvents((ev.data ?? []) as QuoteEvent[]);
    })();
  }, [quoteRef, tick]);

  async function cancel() {
    if (!quote) return;
    const { error } = await supabase.rpc('cancel_my_quote', { p_quote_id: quote.id });
    if (error) return toast(friendlyError(error), 'error');
    toast('Quote cancelled');
    setTick((t) => t + 1);
  }

  if (quote === undefined) return <Spinner />;
  if (quote === null)
    return (
      <div className="wrap page">
        <h1>Quote not found</h1>
        <Link to="/account" className="btn sec">Back to your account</Link>
      </div>
    );

  return (
    <div className="wrap page">
      <p className="note"><Link to="/account">← Your quotes</Link></p>
      <h1>Quote {quote.ref}</h1>
      <p className="sub">
        Requested {formatDate(quote.created_at)} · <StatusBadge value={quote.status} label={QUOTE_STATUS_LABEL[quote.status]} />
      </p>
      <div className="two">
        <section className="box">
          <h2>Status</h2>
          <QuoteTimeline events={events} />
          {quote.quoted_total !== null && <p className="tot" style={{ marginTop: 16 }}><span>Quoted total</span><span>{inr(quote.quoted_total)}</span></p>}
          {(quote.status === 'submitted' || quote.status === 'in_review') && (
            <button className="btn danger sm" style={{ marginTop: 16 }} onClick={cancel}>Cancel request</button>
          )}
        </section>
        <section className="box">
          <h2>Products</h2>
          <QuoteItemsTable items={items} />
          <p className="tot" style={{ marginTop: 14 }}><span>Estimate</span><span>{inr(quote.estimate_total)}</span></p>
          <p className="note">Indicative, before GST, branding, packaging and shipping.</p>
        </section>
      </div>
    </div>
  );
}
