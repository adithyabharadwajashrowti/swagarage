import { useEffect, useState } from 'react';
import { SelectField, Spinner, StatusBadge, TextArea, TextField } from '../components/ui';
import { QuoteItemsTable, QuoteTimeline } from '../pages/Account';
import { formatDate, inr, QUOTE_STATUS_LABEL } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { friendlyError, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import type { Quote, QuoteEvent, QuoteItem, QuoteStatus } from '../lib/types';

const STATUSES = Object.keys(QUOTE_STATUS_LABEL) as QuoteStatus[];

export function AdminDashboard() {
  const [stats, setStats] = useState<{ open: number; quoted: number; won: number; live: number; review: number; unchecked: number } | null>(null);
  const [recent, setRecent] = useState<Quote[]>([]);

  useEffect(() => {
    (async () => {
      const count = async (table: string, col: string, vals: string[]) => {
        const { count: c } = await supabase.from(table).select('*', { count: 'exact', head: true }).in(col, vals);
        return c ?? 0;
      };
      const [open, quoted, won, live, review, unchecked, rec] = await Promise.all([
        count('quotes', 'status', ['submitted', 'in_review']),
        count('quotes', 'status', ['quoted']),
        count('quotes', 'status', ['won']),
        count('products', 'status', ['live']),
        count('products', 'status', ['review', 'draft']),
        count('product_internal', 'proofread_status', ['unchecked']),
        supabase.from('quotes').select('*').order('created_at', { ascending: false }).limit(8),
      ]);
      setStats({ open, quoted, won, live, review, unchecked });
      setRecent((rec.data ?? []) as Quote[]);
    })();
  }, []);

  if (!stats) return <Spinner />;
  return (
    <>
      <h1>Dashboard</h1>
      <div className="stats">
        <Link to="/admin/quotes?status=submitted" className="stat"><b>{stats.open}</b><span>Open quote requests</span></Link>
        <div className="stat"><b>{stats.quoted}</b><span>Quoted, awaiting client</span></div>
        <div className="stat"><b>{stats.won}</b><span>Confirmed orders</span></div>
        <Link to="/admin/products?proofread=unchecked" className="stat"><b>{stats.unchecked}</b><span>Products to proofread</span></Link>
        <Link to="/admin/products?status=live" className="stat"><b>{stats.live}</b><span>Live products</span></Link>
        <Link to="/admin/products?status=review" className="stat"><b>{stats.review}</b><span>In review / draft</span></Link>
      </div>
      <h2 style={{ fontSize: 18, marginBottom: 10 }}>Latest quote requests</h2>
      <QuotesTable quotes={recent} />
    </>
  );
}

function QuotesTable({ quotes }: { quotes: Quote[] }) {
  if (!quotes.length) return <p className="empty">No quotes yet.</p>;
  return (
    <div className="tablewrap">
      <table className="t">
        <thead><tr><th>Ref</th><th>Company</th><th>Contact</th><th>Date</th><th>Needed by</th><th>Status</th><th className="num">Estimate</th></tr></thead>
        <tbody>
          {quotes.map((q) => (
            <tr key={q.id}>
              <td><Link to={`/admin/quotes/${q.id}`} style={{ color: 'var(--blue)', fontWeight: 600 }}>{q.ref}</Link></td>
              <td>{q.company}</td>
              <td>{q.contact_name}</td>
              <td>{formatDate(q.created_at)}</td>
              <td>{formatDate(q.needed_by)}</td>
              <td><StatusBadge value={q.status} label={QUOTE_STATUS_LABEL[q.status]} /></td>
              <td className="num">{inr(q.quoted_total ?? q.estimate_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminQuotes() {
  const { search } = useLocation();
  const status = search.get('status') ?? '';
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    setQuotes(null);
    let query = supabase.from('quotes').select('*').order('created_at', { ascending: false }).limit(500);
    if (status) query = query.eq('status', status);
    query.then(({ data }) => setQuotes((data ?? []) as Quote[]));
  }, [status]);

  const needle = q.trim().toLowerCase();
  const shown = (quotes ?? []).filter((x) => !needle || `${x.ref} ${x.company} ${x.contact_name} ${x.email}`.toLowerCase().includes(needle));

  return (
    <>
      <h1>Quotes</h1>
      <div className="toolbar">
        <select className="input" value={status} aria-label="Status" onChange={(e) => navigate(`/admin/quotes${e.target.value ? `?status=${e.target.value}` : ''}`, { replace: true })}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{QUOTE_STATUS_LABEL[s]}</option>)}
        </select>
        <input className="input" placeholder="Search ref, company, email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search quotes" />
      </div>
      {quotes === null ? <Spinner /> : <QuotesTable quotes={shown} />}
    </>
  );
}

export function AdminQuoteDetail({ id }: { id: string }) {
  const toast = useToast();
  const [quote, setQuote] = useState<Quote | null | undefined>(undefined);
  const [items, setItems] = useState<QuoteItem[]>([]);
  const [events, setEvents] = useState<QuoteEvent[]>([]);
  const [form, setForm] = useState({ status: 'submitted' as QuoteStatus, message: '', quoted_total: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    (async () => {
      const { data: q } = await supabase.from('quotes').select('*').eq('id', id).maybeSingle();
      setQuote((q as Quote | null) ?? null);
      if (!q) return;
      const [it, ev, internal] = await Promise.all([
        supabase.from('quote_items').select('*').eq('quote_id', id),
        supabase.from('quote_events').select('*').eq('quote_id', id).order('created_at'),
        supabase.from('quote_internal').select('notes').eq('quote_id', id).maybeSingle(),
      ]);
      setItems((it.data ?? []) as QuoteItem[]);
      setEvents((ev.data ?? []) as QuoteEvent[]);
      setForm({ status: q.status, message: '', quoted_total: q.quoted_total?.toString() ?? '', notes: internal.data?.notes ?? '' });
    })();
  }, [id, tick]);

  async function save() {
    const total = form.quoted_total.trim() === '' ? null : Number(form.quoted_total);
    if (total !== null && (!Number.isFinite(total) || total < 0)) return toast('Quoted total must be a positive number', 'error');
    setBusy(true);
    const { error } = await supabase.rpc('staff_update_quote', {
      p_quote_id: id,
      p_status: form.status,
      p_message: form.message.trim() || null,
      p_quoted_total: total,
      p_internal_notes: form.notes,
    });
    setBusy(false);
    if (error) return toast(friendlyError(error), 'error');
    toast('Quote updated', 'success');
    setTick((t) => t + 1);
  }

  if (quote === undefined) return <Spinner />;
  if (quote === null) return <p className="empty">Quote not found.</p>;

  return (
    <>
      <p className="note"><Link to="/admin/quotes">← All quotes</Link></p>
      <h1>{quote.ref} · {quote.company}</h1>
      <div className="two">
        <section className="box form">
          <h2>Client</h2>
          <table className="specs">
            <tbody>
              <tr><td>Contact</td><td>{quote.contact_name}</td></tr>
              <tr><td>Email</td><td><a href={`mailto:${quote.email}`} style={{ color: 'var(--blue)' }}>{quote.email}</a></td></tr>
              <tr><td>Phone</td><td>{quote.phone ?? '—'}</td></tr>
              <tr><td>Occasion</td><td>{quote.occasion ?? '—'}</td></tr>
              <tr><td>Delivery city</td><td>{quote.delivery_city ?? '—'}</td></tr>
              <tr><td>Needed by</td><td>{formatDate(quote.needed_by)}</td></tr>
              <tr><td>Notes</td><td style={{ whiteSpace: 'pre-wrap' }}>{quote.notes ?? '—'}</td></tr>
            </tbody>
          </table>
          <h2 style={{ marginTop: 10 }}>Update</h2>
          <SelectField label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as QuoteStatus })}
            options={STATUSES.map((s) => ({ value: s, label: QUOTE_STATUS_LABEL[s] }))} />
          <TextField label="Quoted total (₹, before GST)" inputMode="decimal" value={form.quoted_total} onChange={(e) => setForm({ ...form, quoted_total: e.target.value })} />
          <TextArea label="Message to client" hint="Shown to the client on their quote page." maxLength={1000} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          <TextArea label="Internal notes" hint="Only the Swagarage team sees these." maxLength={4000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <button className="btn pri" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </section>
        <section className="box">
          <h2>Products</h2>
          <QuoteItemsTable items={items} />
          <p className="tot" style={{ marginTop: 14 }}><span>Estimate</span><span>{inr(quote.estimate_total)}</span></p>
          <h2 style={{ marginTop: 24 }}>History</h2>
          <QuoteTimeline events={events} />
        </section>
      </div>
    </>
  );
}
