import type { PriceBasis, QuoteStatus } from './types';

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function inr(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return '₹' + inrFmt.format(Math.round(n));
}

export interface DisplayPrice {
  amount: number | null;
  label: string;
}

/**
 * What a client sees for a product price: one clean per-unit price.
 * GST, branding and shipping are added at checkout, never shown on product cards.
 */
export function displayPrice(p: { sell_price: number | null; mrp: number | null; price_basis?: PriceBasis }): DisplayPrice {
  const amount = p.sell_price ?? p.mrp;
  return amount !== null ? { amount, label: '' } : { amount: null, label: 'Price on request' };
}

/** GST % for a product (18% when the price list did not say). */
export function gstRate(p: { gst_rate?: number | null }): number {
  const g = Number(p.gst_rate);
  return [0, 3, 5, 12, 18, 28].includes(g) ? g : 18;
}

export interface CheckoutLine {
  quantity: number;
  product: { sell_price: number | null; mrp: number | null; gst_rate?: number | null };
}

/** Checkout totals: subtotal + GST per line. Branding and shipping are quoted by the team. */
export function checkoutTotals(lines: CheckoutLine[]): { subtotal: number; gst: number; total: number; gstByRate: [number, number][] } {
  let subtotal = 0;
  const byRate = new Map<number, number>();
  for (const { quantity, product } of lines) {
    const price = unitPrice(product);
    if (price === null) continue;
    const amount = price * quantity;
    subtotal += amount;
    const r = gstRate(product);
    byRate.set(r, (byRate.get(r) ?? 0) + (amount * r) / 100);
  }
  const gstByRate = [...byRate.entries()].sort((a, b) => b[0] - a[0]).map(([r, v]) => [r, Math.round(v * 100) / 100] as [number, number]);
  const gst = Math.round(gstByRate.reduce((s, [, v]) => s + v, 0) * 100) / 100;
  return { subtotal, gst, total: Math.round((subtotal + gst) * 100) / 100, gstByRate };
}

export function unitPrice(p: { sell_price: number | null; mrp: number | null }): number | null {
  return p.sell_price ?? p.mrp;
}

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  submitted: 'Submitted',
  in_review: 'In review',
  quoted: 'Quoted',
  won: 'Confirmed',
  lost: 'Closed',
  cancelled: 'Cancelled',
};

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

const COLOURS: Record<string, string> = {
  black: '#1c1c1c', tan: '#C68B59', navy: '#1F2E55', olive: '#6B6B3A', grey: '#9097A0', gray: '#9097A0',
  green: '#2F7D5B', blue: '#2E6FD8', brown: '#6B4226', beige: '#E2D3B5', mustard: '#D9A521', white: '#F7F7F7',
  'off white': '#F1ECE2', 'off-white': '#F1ECE2', pink: '#F2A7C3', red: '#D33C3C', purple: '#7A4FC9',
  lavender: '#B9A6E8', golden: '#D4AF37', gold: '#D4AF37', charcoal: '#3A3D42', mocha: '#7B5B4A', silver: '#C0C4C8',
  'dark green': '#1F5A3E', 'light olive': '#9DA06A', 'dark olive': '#4E5130', yellow: '#F2C230', maroon: '#7A1F2B',
};

/** CSS background for a colour swatch, e.g. "Green/Black" -> split swatch. */
export function swatch(name: string): string {
  const parts = name.toLowerCase().split(/[/+&]| and /).map((s) => s.trim()).filter(Boolean);
  const cols = parts.map((x) => COLOURS[x] ?? COLOURS[x.split(' ')[0] ?? ''] ?? '#cccccc');
  if (cols.length > 1) return `linear-gradient(135deg, ${cols[0]} 50%, ${cols[1]} 50%)`;
  return cols[0] ?? '#cccccc';
}
