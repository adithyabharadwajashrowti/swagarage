// Builds a client catalogue deck in Swagarage's own template (orange frame,
// one product per slide, Notes, Thank You) and downloads it as .pptx.
import type { CatalogueProduct } from './types';
import { imageUrl } from './supabase';
import { asset } from './router';

const OR = 'EC6A1E';
const BL = '2464AE';
const INK = '1C1C1C';
const GREY = '555B63';

async function toDataUrl(url: string): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const blob = await res.blob();
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    const dims = await new Promise<[number, number]>((resolve) => {
      const img = new Image();
      img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
      img.onerror = () => resolve([1, 1]);
      img.src = data;
    });
    return { data, w: dims[0], h: dims[1] };
  } catch {
    return null;
  }
}

export async function buildCatalogueDeck(products: CatalogueProduct[], heading: string): Promise<Blob> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = 'Swagarage catalogue';
  pptx.company = 'Swagarage';

  const frame = (s: ReturnType<typeof pptx.addSlide>) => {
    s.background = { color: OR };
    s.addShape(pptx.ShapeType.rect, { x: 0.18, y: 0.18, w: 12.97, h: 7.14, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF' } });
  };

  const logo = await toDataUrl(asset('logo-deck.png'));
  let s = pptx.addSlide();
  frame(s);
  if (logo) {
    const h = 3.6;
    const w = (h * logo.w) / logo.h;
    s.addImage({ data: logo.data, x: (13.33 - w) / 2, y: 0.9, w, h });
  }
  s.addText(heading.slice(0, 140), { x: 1, y: 5.0, w: 11.33, h: 0.8, align: 'center', fontFace: 'Arial', fontSize: 18, color: GREY });

  for (const p of products) {
    s = pptx.addSlide();
    frame(s);
    const url = imageUrl(p.image_path);
    const img = url ? await toDataUrl(url) : null;
    if (img) {
      const bw = 5.6;
      const bh = 5.9;
      const sc = Math.min(bw / img.w, bh / img.h);
      s.addImage({ data: img.data, x: 0.6 + (bw - img.w * sc) / 2, y: 0.8 + (bh - img.h * sc) / 2, w: img.w * sc, h: img.h * sc });
    }
    s.addText(p.name, { x: 6.7, y: 0.7, w: 6, h: 1.2, fontFace: 'Arial', fontSize: 28, bold: true, color: BL, valign: 'top' });
    const lines = [
      ...p.features.slice(0, 4),
      ...Object.entries(p.specs).map(([k, v]) => `${k}: ${v}`),
      ...(p.colours.length ? [`Colours: ${p.colours.join(', ')}`] : []),
    ].slice(0, 10);
    s.addText(
      lines.map((text, i) => ({ text, options: { breakLine: i < lines.length - 1 } })),
      { x: 6.7, y: 2.0, w: 6, h: 3.2, fontFace: 'Arial', fontSize: 13, color: INK, valign: 'top', paraSpaceAfter: 4 },
    );
    const price =
      p.sell_price !== null
        ? `Cost: Rs.${p.sell_price.toLocaleString('en-IN')} + GST`
        : p.mrp !== null
          ? `MRP: Rs.${p.mrp.toLocaleString('en-IN')} (best price on request)`
          : 'Price on request';
    s.addText(price, { x: 6.7, y: 5.3, w: 6, h: 0.5, fontFace: 'Arial', fontSize: 15, bold: true, color: INK });
    s.addText(p.branding_possible ? 'Logo branding available.' : 'Branding not possible.', {
      x: 6.7, y: 5.8, w: 6, h: 0.4, fontFace: 'Arial', fontSize: 12, color: p.branding_possible ? GREY : 'C62828',
    });
    s.addText(`MOQ: ${p.moq} units · Delivery: ${p.delivery_note ?? 'confirmed with your quote'}`, {
      x: 6.7, y: 6.25, w: 6, h: 0.4, fontFace: 'Arial', fontSize: 12, color: INK,
    });
  }

  s = pptx.addSlide();
  s.background = { color: OR };
  s.addText('Notes', { x: 0, y: 0.6, w: 13.33, h: 1, align: 'center', fontFace: 'Arial', fontSize: 40, color: 'FFFFFF' });
  const notes = [
    'Minimum Order Quantity (MOQ): as listed per product',
    'GST: Applicable on all products',
    'Stock Availability: subject to change at the time of final order confirmation',
    'Packaging & Shipping: Charged additionally',
    'Branding/Customization: Cost included for single logo branding',
    'Payment Terms: 50% advance upon order confirmation, 50% balance upon delivery',
  ];
  s.addText(
    notes.map((text, i) => ({ text, options: { bullet: true, breakLine: i < notes.length - 1 } })),
    { x: 2, y: 1.9, w: 9.33, h: 4.6, fontFace: 'Arial', fontSize: 16, color: 'FFFFFF', valign: 'top', paraSpaceAfter: 10 },
  );

  s = pptx.addSlide();
  frame(s);
  if (logo) {
    const h = 2.7;
    const w = (h * logo.w) / logo.h;
    s.addImage({ data: logo.data, x: (13.33 - w) / 2, y: 1.1, w, h });
  }
  s.addText('Thank You!', { x: 0, y: 4.4, w: 13.33, h: 1, align: 'center', fontFace: 'Arial', fontSize: 34, bold: true, color: GREY });

  return (await pptx.write({ outputType: 'blob' })) as Blob;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
