import { useEffect, useMemo, useState } from 'react';
import { ProductImage, SelectField, Spinner, StatusBadge, TextArea, TextField } from '../components/ui';
import { inr } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { friendlyError, IMAGE_BUCKET, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import type { Category, Collection, LogoAction, Product, ProductInternal, ProductStatus, ProofreadStatus } from '../lib/types';

type Row = Product & { product_internal: Pick<ProductInternal, 'proofread_status' | 'source_ref'> | null };

const PRODUCT_STATUSES: ProductStatus[] = ['draft', 'review', 'live', 'archived'];
const PROOF: ProofreadStatus[] = ['unchecked', 'ok', 'fixed', 'remove'];

export function AdminProducts() {
  const toast = useToast();
  const { search } = useLocation();
  const status = search.get('status') ?? '';
  const proof = search.get('proofread') ?? '';
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setRows(null);
    (async () => {
      const all: Row[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from('products')
          .select('*, product_internal(proofread_status, source_ref)')
          .order('sku')
          .range(from, from + 999);
        if (error) {
          toast(friendlyError(error), 'error');
          break;
        }
        all.push(...((data ?? []) as Row[]));
        if (!data || data.length < 1000) break;
      }
      setRows(all);
    })();
  }, [tick, toast]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter(
      (r) =>
        (!status || (status === 'review' ? r.status === 'review' || r.status === 'draft' : r.status === status)) &&
        (!proof || r.product_internal?.proofread_status === proof) &&
        (!needle || `${r.sku} ${r.name} ${r.brand ?? ''}`.toLowerCase().includes(needle)),
    );
  }, [rows, status, proof, q]);

  function setParam(k: string, v: string) {
    const p = new URLSearchParams(search);
    if (v) p.set(k, v);
    else p.delete(k);
    navigate(`/admin/products${p.toString() ? `?${p}` : ''}`, { replace: true });
  }

  async function bulk(newStatus: ProductStatus) {
    const ids = [...picked];
    if (!ids.length) return;
    const { error } = await supabase.from('products').update({ status: newStatus }).in('id', ids);
    if (error) return toast(friendlyError(error), 'error');
    toast(`${ids.length} products set to ${newStatus}`, 'success');
    setPicked(new Set());
    setTick((t) => t + 1);
  }

  const allShownPicked = shown.length > 0 && shown.every((r) => picked.has(r.id));

  return (
    <>
      <h1>Products</h1>
      <div className="toolbar">
        <input className="input" placeholder="Search SKU, name, brand" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
        <select className="input" value={status} onChange={(e) => setParam('status', e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {PRODUCT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input" value={proof} onChange={(e) => setParam('proofread', e.target.value)} aria-label="Proofread">
          <option value="">Any proofread state</option>
          {PROOF.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Link to="/admin/products/new" className="btn sec sm">New product</Link>
      </div>
      {picked.size > 0 && (
        <div className="toolbar alert info">
          <b>{picked.size} selected</b>
          <button className="btn blue sm" onClick={() => bulk('live')}>Publish</button>
          <button className="btn ghost sm" onClick={() => bulk('review')}>Move to review</button>
          <button className="btn ghost sm" onClick={() => bulk('archived')}>Archive</button>
        </div>
      )}
      {rows === null ? (
        <Spinner />
      ) : (
        <div className="tablewrap">
          <table className="t">
            <thead>
              <tr>
                <th><input type="checkbox" aria-label="Select all shown" checked={allShownPicked}
                  onChange={() => setPicked(allShownPicked ? new Set() : new Set(shown.map((r) => r.id)))} /></th>
                <th></th><th>SKU</th><th>Name</th><th>Brand</th><th className="num">Price</th><th>MOQ</th><th>Status</th><th>Proofread</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" aria-label={`Select ${r.name}`} checked={picked.has(r.id)}
                    onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} /></td>
                  <td><ProductImage path={r.image_path} alt="" className="thumb" /></td>
                  <td>{r.sku}</td>
                  <td><Link to={`/admin/products/${r.id}`} style={{ color: 'var(--blue)', fontWeight: 600 }}>{r.name}</Link></td>
                  <td>{r.brand ?? '—'}</td>
                  <td className="num">{inr(r.sell_price ?? r.mrp)} <span className="note">{r.sell_price !== null ? '+GST' : r.mrp !== null ? 'MRP' : ''}</span></td>
                  <td>{r.moq}</td>
                  <td><StatusBadge value={r.status} /></td>
                  <td><StatusBadge value={r.product_internal?.proofread_status ?? 'unchecked'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && <p className="empty">No products match.</p>}
        </div>
      )}
      <p className="note" style={{ marginTop: 10 }}>{shown.length} of {rows?.length ?? 0} products</p>
    </>
  );
}

// ---------------------------------------------------------------------------

interface EditState {
  sku: string; name: string; slug: string; brand: string; category_id: string; subcategory: string; description: string;
  features: string; specs: string; colours: string; mrp: string; sell_price: string; moq: string; branding_possible: boolean;
  delivery_note: string; ready_stock: string; under_production: boolean; status: ProductStatus; image_path: string | null;
  proofread_status: ProofreadStatus; logo_action: LogoAction; internal_notes: string; source_ref: string; collections: Set<number>;
}

const EMPTY: EditState = {
  sku: '', name: '', slug: '', brand: '', category_id: '', subcategory: '', description: '', features: '', specs: '', colours: '',
  mrp: '', sell_price: '', moq: '25', branding_possible: true, delivery_note: '', ready_stock: '', under_production: false,
  status: 'draft', image_path: null, proofread_status: 'unchecked', logo_action: 'keep', internal_notes: '', source_ref: '', collections: new Set(),
};

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 110);
const optNum = (s: string) => (s.trim() === '' ? null : Number(s));

function parseSpecs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function AdminProductEdit({ id }: { id: string }) {
  const toast = useToast();
  const isNew = id === 'new';
  const [s, setS] = useState<EditState | null | undefined>(isNew ? EMPTY : undefined);
  const [cats, setCats] = useState<Category[]>([]);
  const [cols, setCols] = useState<Collection[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from('categories').select('*').order('sort_order').then(({ data }) => setCats((data ?? []) as Category[]));
    supabase.from('collections').select('*').order('sort_order').then(({ data }) => setCols((data ?? []) as Collection[]));
    if (isNew) return;
    (async () => {
      const [{ data: p }, { data: internal }, { data: pc }] = await Promise.all([
        supabase.from('products').select('*').eq('id', id).maybeSingle(),
        supabase.from('product_internal').select('*').eq('product_id', id).maybeSingle(),
        supabase.from('product_collections').select('collection_id').eq('product_id', id),
      ]);
      if (!p) return setS(null);
      const prod = p as Product;
      setS({
        sku: prod.sku, name: prod.name, slug: prod.slug, brand: prod.brand ?? '', category_id: String(prod.category_id),
        subcategory: prod.subcategory ?? '', description: prod.description ?? '', features: prod.features.join('\n'),
        specs: Object.entries(prod.specs).map(([k, v]) => `${k}: ${v}`).join('\n'), colours: prod.colours.join(', '),
        mrp: prod.mrp?.toString() ?? '', sell_price: prod.sell_price?.toString() ?? '', moq: String(prod.moq),
        branding_possible: prod.branding_possible, delivery_note: prod.delivery_note ?? '', ready_stock: prod.ready_stock?.toString() ?? '',
        under_production: prod.under_production, status: prod.status, image_path: prod.image_path,
        proofread_status: (internal as ProductInternal | null)?.proofread_status ?? 'unchecked',
        logo_action: (internal as ProductInternal | null)?.logo_action ?? 'keep',
        internal_notes: (internal as ProductInternal | null)?.notes ?? '', source_ref: (internal as ProductInternal | null)?.source_ref ?? '',
        collections: new Set(((pc ?? []) as { collection_id: number }[]).map((x) => x.collection_id)),
      });
    })();
  }, [id, isNew]);

  if (s === undefined) return <Spinner />;
  if (s === null) return <p className="empty">Product not found.</p>;
  const set = <K extends keyof EditState>(k: K, v: EditState[K]) => setS({ ...s, [k]: v });

  function validate(): string[] {
    const e: string[] = [];
    if (!/^[a-z0-9-]{2,40}$/.test(s!.sku)) e.push('SKU: 2-40 lowercase letters, numbers or dashes.');
    if (s!.name.trim().length < 2) e.push('Name is required.');
    if (!s!.category_id) e.push('Pick a category.');
    for (const [k, label] of [['mrp', 'MRP'], ['sell_price', 'Sell price'], ['ready_stock', 'Ready stock']] as const) {
      const v = optNum(s![k]);
      if (v !== null && (!Number.isFinite(v) || v < 0)) e.push(`${label} must be a positive number.`);
    }
    const mrp = optNum(s!.mrp);
    const sell = optNum(s!.sell_price);
    if (mrp !== null && sell !== null && sell > mrp) e.push('Sell price cannot be above MRP.');
    const moq = Number(s!.moq);
    if (!Number.isInteger(moq) || moq < 1) e.push('MOQ must be a whole number of at least 1.');
    return e;
  }

  async function save() {
    const e = validate();
    setErrors(e);
    if (e.length) return;
    setBusy(true);
    const st = s!;
    const sell = optNum(st.sell_price);
    const mrp = optNum(st.mrp);
    const payload = {
      sku: st.sku, name: st.name.trim(), slug: st.slug.trim() || `${slugify(st.name)}-${st.sku}`, brand: st.brand.trim() || null,
      category_id: Number(st.category_id), subcategory: st.subcategory.trim() || null, description: st.description.trim() || null,
      features: st.features.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 12), specs: parseSpecs(st.specs),
      colours: st.colours.split(',').map((x) => x.trim()).filter(Boolean), mrp, sell_price: sell,
      price_basis: sell !== null ? 'gst_extra' : mrp !== null ? 'mrp' : 'on_request', moq: Number(st.moq),
      branding_possible: st.branding_possible, delivery_note: st.delivery_note.trim() || null,
      ready_stock: optNum(st.ready_stock), under_production: st.under_production, status: st.status, image_path: st.image_path,
    };
    const res = isNew
      ? await supabase.from('products').insert(payload).select('id').single()
      : await supabase.from('products').update(payload).eq('id', id).select('id').single();
    if (res.error) {
      setBusy(false);
      return toast(friendlyError(res.error), 'error');
    }
    const pid = (res.data as { id: string }).id;
    const internal = await supabase.from('product_internal').upsert({
      product_id: pid, proofread_status: st.proofread_status, logo_action: st.logo_action, notes: st.internal_notes.trim() || null, source_ref: st.source_ref.trim() || null,
    });
    await supabase.from('product_collections').delete().eq('product_id', pid);
    if (st.collections.size)
      await supabase.from('product_collections').insert([...st.collections].map((cid) => ({ product_id: pid, collection_id: cid })));
    setBusy(false);
    if (internal.error) return toast(friendlyError(internal.error), 'error');
    toast('Product saved', 'success');
    if (isNew) navigate(`/admin/products/${pid}`, { replace: true });
  }

  async function upload(file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return toast('Use a JPG, PNG or WebP image', 'error');
    if (file.size > 2 * 1024 * 1024) return toast('Image must be under 2 MB', 'error');
    if (!/^[a-z0-9-]{2,40}$/.test(s!.sku)) return toast('Set a valid SKU first', 'error');
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const path = `products/${s!.sku}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false });
    if (error) return toast(friendlyError(error), 'error');
    set('image_path', path);
    toast('Image uploaded. Save to keep it.', 'success');
  }


  return (
    <>
      <p className="note"><Link to="/admin/products">← All products</Link></p>
      <h1>{isNew ? 'New product' : s.name}</h1>
      {errors.length > 0 && <div className="alert err" role="alert" style={{ marginBottom: 14 }}>{errors.map((e) => <div key={e}>{e}</div>)}</div>}
      <div className="two">
        <section className="box form">
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, aspectRatio: '1', padding: 12 }}>
            <ProductImage path={s.image_path} alt={s.name} />
          </div>
          <label className="btn ghost sm" style={{ cursor: 'pointer' }}>
            Upload image
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
          <SelectField label="Status" value={s.status} onChange={(e) => set('status', e.target.value as ProductStatus)} options={PRODUCT_STATUSES.map((x) => ({ value: x, label: x }))} />
          <SelectField label="Proofread" value={s.proofread_status} onChange={(e) => set('proofread_status', e.target.value as ProofreadStatus)} options={PROOF.map((x) => ({ value: x, label: x }))} />
          <SelectField label="Logo on product photo" value={s.logo_action} onChange={(e) => set('logo_action', e.target.value as LogoAction)}
            options={[{ value: 'keep', label: 'Keep brand logo (known brand)' }, { value: 'replace', label: 'Replace vendor logo with Swagarage' }, { value: 'none', label: 'Remove vendor logo, leave blank' }]} />
          <TextArea label="Internal notes" value={s.internal_notes} onChange={(e) => set('internal_notes', e.target.value)} maxLength={2000} />
          {!isNew && (
            <>
              <MergeDuplicate keepId={id} keepSku={s.sku} />
            </>
          )}
        </section>
        <section className="box form">
          <div className="form-grid">
            <TextField label="SKU" value={s.sku} onChange={(e) => set('sku', e.target.value.toLowerCase())} disabled={!isNew} />
            <TextField label="Brand" value={s.brand} onChange={(e) => set('brand', e.target.value)} maxLength={80} />
          </div>
          <TextField label="Name" value={s.name} onChange={(e) => set('name', e.target.value)} maxLength={160} />
          <div className="form-grid">
            <SelectField label="Category" value={s.category_id} onChange={(e) => set('category_id', e.target.value)}
              options={[{ value: '', label: 'Choose…' }, ...cats.map((c) => ({ value: String(c.id), label: c.name }))]} />
            <TextField label="Subcategory" value={s.subcategory} onChange={(e) => set('subcategory', e.target.value)} maxLength={80} />
          </div>
          <div className="form-grid">
            <TextField label="MRP (₹)" inputMode="decimal" value={s.mrp} onChange={(e) => set('mrp', e.target.value)} />
            <TextField label="Sell price (₹, + GST)" inputMode="decimal" value={s.sell_price} onChange={(e) => set('sell_price', e.target.value)} hint="Leave empty to show MRP with 'best price on request'." />
          </div>
          <div className="form-grid">
            <TextField label="MOQ" inputMode="numeric" value={s.moq} onChange={(e) => set('moq', e.target.value)} />
            <TextField label="Ready stock (units)" inputMode="numeric" value={s.ready_stock} onChange={(e) => set('ready_stock', e.target.value)} />
          </div>
          <TextField label="Colours" hint="Comma separated" value={s.colours} onChange={(e) => set('colours', e.target.value)} />
          <TextArea label="Features" hint="One per line (max 12)" value={s.features} onChange={(e) => set('features', e.target.value)} />
          <TextArea label="Specs" hint='One per line, as "Name: value"' value={s.specs} onChange={(e) => set('specs', e.target.value)} />
          <TextArea label="Description" value={s.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} />
          <TextField label="Delivery note" value={s.delivery_note} onChange={(e) => set('delivery_note', e.target.value)} maxLength={200} />
          <label className="row"><input type="checkbox" checked={s.branding_possible} onChange={(e) => set('branding_possible', e.target.checked)} /> Logo branding possible</label>
          <label className="row"><input type="checkbox" checked={s.under_production} onChange={(e) => set('under_production', e.target.checked)} /> More units in production</label>
          <fieldset style={{ border: 'none' }}>
            <legend style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Collections</legend>
            {cols.map((c) => (
              <label key={c.id} className="row" style={{ fontSize: 14 }}>
                <input type="checkbox" checked={s.collections.has(c.id)} onChange={() => {
                  const n = new Set(s.collections);
                  if (n.has(c.id)) n.delete(c.id); else n.add(c.id);
                  set('collections', n);
                }} />
                {c.name}
              </label>
            ))}
          </fieldset>
          <button className="btn pri" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save product'}</button>
        </section>
      </div>
    </>
  );
}

/** Same product listed twice (e.g. two vendors): fold the duplicate into this one. */
function MergeDuplicate({ keepId, keepSku }: { keepId: string; keepSku: string }) {
  const toast = useToast();
  const [sku, setSku] = useState('');
  const [busy, setBusy] = useState(false);
  async function merge() {
    const dupSku = sku.trim().toLowerCase();
    if (!dupSku || dupSku === keepSku) return toast('Enter the SKU of the duplicate listing', 'error');
    const { data } = await supabase.from('products').select('id, name').eq('sku', dupSku).maybeSingle();
    if (!data) return toast(`No product with SKU ${dupSku}`, 'error');
    const dup = data as { id: string; name: string };
    if (!window.confirm(`Merge "${dup.name}" into ${keepSku}? It gets archived and this listing keeps the lower price.`)) return;
    setBusy(true);
    const { error } = await supabase.rpc('staff_merge_products', { p_keep: keepId, p_duplicate: dup.id });
    setBusy(false);
    if (error) return toast(friendlyError(error), 'error');
    toast('Merged. Reloading…', 'success');
    window.setTimeout(() => window.location.reload(), 600);
  }
  return (
    <div className="form" style={{ marginTop: 12, gap: 8 }}>
      <h2>Merge a duplicate</h2>
      <p className="note">Same item from another vendor? Merge it here: one listing for clients, lowest price wins.</p>
      <div className="row">
        <input className="input" style={{ width: 160 }} placeholder="Duplicate SKU" value={sku} onChange={(e) => setSku(e.target.value)} aria-label="Duplicate SKU" />
        <button className="btn ghost sm" onClick={merge} disabled={busy}>{busy ? 'Merging…' : 'Merge into this'}</button>
      </div>
    </div>
  );
}
