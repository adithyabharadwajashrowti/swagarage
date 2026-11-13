import { describe, expect, it } from 'vitest';
import { mapProofreadingSheet, parseCsv } from './csv';

describe('parseCsv', () => {
  it('handles quotes, commas and newlines in fields', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']]);
  });
});

const header = 'ID,Status,Name,Brand,Category,Subcategory,Price (INR),Price basis,MOQ,Colours,Dimensions,Material,Weight,Laptop fit,Model,Warranty,Other specs,Features,Branding possible,Ready stock (units),Under production,Collections,Vendor (internal),Source,Data origin / what to check';

describe('mapProofreadingSheet', () => {
  it('maps a sheet row', () => {
    const csv = `${header}\nobl-10,OK,Oblique Ally,Oblique,Bags & Backpacks,Sling Bags,1795,MRP,25,"Black, Tan",H 22 cm,Canvas,300 g,,,,Capacity: 5 L,Strap | Zip,Yes,,,"Travel, Under ₹500",Oblique,p.10,OCR`;
    const { rows, errors } = mapProofreadingSheet(parseCsv(csv), { publishChecked: true });
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      sku: 'obl-10', mrp: 1795, sell_price: null, price_basis: 'mrp', status: 'live', proofread_status: 'ok',
      colours: ['Black', 'Tan'], features: ['Strap', 'Zip'], collections: ['Travel', 'Under ₹500'],
      specs: { Dimensions: 'H 22 cm', Material: 'Canvas', Weight: '300 g', Capacity: '5 L' },
    });
  });
  it('keeps unchecked rows in review and archives removed ones', () => {
    const csv = `${header}\na-1,,A one,,Apparel,,500,+ GST,,,,,,,,,,,No,,,,,,\na-2,Remove,A two,,Apparel,,500,MRP,,,,,,,,,,,,,,,,,`;
    const { rows } = mapProofreadingSheet(parseCsv(csv), { publishChecked: true });
    expect(rows.map((r) => [r.status, r.price_basis, r.branding_possible])).toEqual([
      ['review', 'gst_extra', false],
      ['archived', 'mrp', true],
    ]);
  });
  it('reads the optional Logo column', () => {
    const csv = `${header},Logo\nx-1,,Bottle,,Apparel,,500,MRP,,,,,,,,,,,,,,,,,,Replace with Swagarage\nx-2,,Pen,Parker,Apparel,,500,MRP,,,,,,,,,,,,,,,,,,keep\nx-3,,Cap,,Apparel,,500,MRP,,,,,,,,,,,,,,,,,,sometimes`;
    const { rows, errors } = mapProofreadingSheet(parseCsv(csv), { publishChecked: false });
    expect(rows.map((r) => r.logo_action)).toEqual(['replace', 'keep', null]);
    expect(errors.join(' ')).toMatch(/Logo must be/);
  });
  it('reports bad rows', () => {
    const csv = `${header}\nBAD ID!,,X,,Apparel\nok-1,,Fine,,Apparel,,abc`;
    const { errors } = mapProofreadingSheet(parseCsv(csv), { publishChecked: false });
    expect(errors.join(' ')).toMatch(/invalid ID/);
    expect(errors.join(' ')).toMatch(/not a number/);
  });
});
