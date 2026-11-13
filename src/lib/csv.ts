// CSV parsing (RFC 4180) and mapping of the proofreading sheet to import rows.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

export interface ImportRow {
  sku: string;
  name: string;
  brand: string | null;
  category: string;
  subcategory: string | null;
  mrp: number | null;
  sell_price: number | null;
  cost_price: number | null;
  price_basis: 'mrp' | 'gst_extra' | 'on_request';
  moq: number;
  colours: string[];
  specs: Record<string, string>;
  features: string[];
  branding_possible: boolean;
  ready_stock: number | null;
  under_production: boolean;
  collections: string[];
  vendor: string | null;
  vendor_sku: string | null;
  source_ref: string | null;
  data_origin: string | null;
  proofread_status: 'unchecked' | 'ok' | 'fixed' | 'remove';
  logo_action: 'keep' | 'replace' | 'none' | null;
  status: 'review' | 'live' | 'archived';
}

export interface MappedImport {
  rows: ImportRow[];
  errors: string[];
}

const SPEC_COLUMNS = ['Dimensions', 'Material', 'Weight', 'Laptop fit', 'Model', 'Warranty'];

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const cleaned = v.replace(/[₹,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function list(v: string | undefined, sep: RegExp): string[] {
  return (v ?? '').split(sep).map((s) => s.trim()).filter(Boolean);
}

/**
 * Maps the Swagarage proofreading sheet (exported as CSV) to import rows.
 * Required columns: ID, Name, Category. Optional: everything else in the sheet,
 * (cost and supplier columns are ignored: costs never pass through the app).
 */
export function mapProofreadingSheet(table: string[][], opts: { publishChecked: boolean }): MappedImport {
  const errors: string[] = [];
  const [header, ...body] = table;
  if (!header) return { rows: [], errors: ['The file is empty.'] };
  const idx = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const col = (r: string[], name: string) => {
    const i = idx.get(name.toLowerCase());
    return i === undefined ? undefined : (r[i] ?? '').trim();
  };
  for (const required of ['ID', 'Name', 'Category']) {
    if (!idx.has(required.toLowerCase())) errors.push(`Missing column "${required}".`);
  }
  if (errors.length) return { rows: [], errors };

  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  body.forEach((r, n) => {
    const line = n + 2;
    const sku = (col(r, 'ID') ?? '').toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(sku)) {
      errors.push(`Row ${line}: invalid ID "${col(r, 'ID') ?? ''}".`);
      return;
    }
    if (seen.has(sku)) {
      errors.push(`Row ${line}: duplicate ID ${sku}.`);
      return;
    }
    seen.add(sku);
    const name = col(r, 'Name') ?? '';
    if (name.length < 2 || name.length > 160) errors.push(`Row ${line}: name must be 2-160 characters.`);

    const price = num(col(r, 'Price (INR)'));
    const basisText = (col(r, 'Price basis') ?? '').toLowerCase();
    const sell = num(col(r, 'Sell price'));
    const cost = num(col(r, 'Cost price'));
    for (const [label, v] of [['price', price], ['sell price', sell], ['cost price', cost]] as const) {
      if (Number.isNaN(v)) errors.push(`Row ${line}: ${label} is not a number.`);
    }
    const isGst = basisText.includes('gst');
    const mrp = isGst ? null : price;
    const sellPrice = sell ?? (isGst ? price : null);
    if (mrp !== null && sellPrice !== null && !Number.isNaN(mrp) && !Number.isNaN(sellPrice) && sellPrice > mrp) {
      errors.push(`Row ${line}: sell price is above MRP.`);
    }

    const moqRaw = col(r, 'MOQ');
    const moq = moqRaw ? Number(moqRaw) : 25;
    if (!Number.isInteger(moq) || moq < 1 || moq > 100000) errors.push(`Row ${line}: MOQ must be a whole number.`);

    const specs: Record<string, string> = {};
    for (const c of SPEC_COLUMNS) {
      const v = col(r, c);
      if (v) specs[c] = v;
    }
    for (const part of list(col(r, 'Other specs'), /;/)) {
      const [k, ...rest] = part.split(':');
      if (k && rest.length) specs[k.trim()] = rest.join(':').trim();
    }

    const check = (col(r, 'Status') ?? '').toLowerCase();
    const proofread = check === 'ok' ? 'ok' : check === 'fixed' ? 'fixed' : check === 'remove' ? 'remove' : 'unchecked';
    const status = proofread === 'remove' ? 'archived' : opts.publishChecked && (proofread === 'ok' || proofread === 'fixed') ? 'live' : 'review';
    const stockRaw = num(col(r, 'Ready stock (units)'));
    const logoRaw = (col(r, 'Logo') ?? '').toLowerCase();
    const logo = logoRaw === '' ? null : logoRaw.startsWith('keep') ? 'keep' : logoRaw.startsWith('replace') ? 'replace' : logoRaw.startsWith('none') || logoRaw.startsWith('remove') ? 'none' : undefined;
    if (logo === undefined) errors.push(`Row ${line}: Logo must be keep, replace or none.`);

    rows.push({
      sku,
      name,
      brand: col(r, 'Brand') || null,
      category: col(r, 'Category') ?? '',
      subcategory: col(r, 'Subcategory') || null,
      mrp: mrp === null || Number.isNaN(mrp) ? null : mrp,
      sell_price: sellPrice === null || Number.isNaN(sellPrice) ? null : sellPrice,
      cost_price: null, // costs are never handled in the app (see pricing_v2 migration)
      price_basis: sellPrice !== null ? 'gst_extra' : mrp !== null ? 'mrp' : 'on_request',
      moq: Number.isInteger(moq) ? moq : 25,
      colours: list(col(r, 'Colours'), /,/),
      specs,
      features: list(col(r, 'Features'), /\|/).slice(0, 12),
      branding_possible: !/^no$/i.test(col(r, 'Branding possible') ?? ''),
      ready_stock: stockRaw === null || Number.isNaN(stockRaw) ? null : Math.round(stockRaw),
      under_production: /^yes$/i.test(col(r, 'Under production') ?? ''),
      collections: list(col(r, 'Collections'), /,/),
      vendor: null,
      vendor_sku: null,
      source_ref: col(r, 'Source') || null,
      data_origin: col(r, 'Data origin / what to check') || null,
      proofread_status: proofread,
      logo_action: logo ?? null,
      status,
    });
  });
  if (rows.length > 3000) errors.push('At most 3000 rows per import.');
  return { rows, errors };
}
