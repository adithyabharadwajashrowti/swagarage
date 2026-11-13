// How buyers and vendors actually write in corporate gifting: quantities in nos/pcs/pax,
// budgets "+ GST" or "landing", branding methods, materials, specs, brands and deadlines.
import { describe, expect, it } from 'vitest';
import { budgetPrice, parseRequest, recommend } from './assistant';
import { EMPTY_CONTEXT, respond } from './chat';
import { unitPrice } from './format';
import type { CatalogueProduct } from './types';
import fixture from './__fixtures__/catalogue.json';

const products = fixture.products as unknown as CatalogueProduct[];
const collections = fixture.collections;
const say = (m: string) => respond(m, EMPTY_CONTEXT, products, collections).reply;
const notes = (m: string) => (say(m).rec?.notes ?? []).join(' ');

describe('quantities the way vendors write them', () => {
  const cases: [string, number][] = [
    ['200 nos', 200], ['200 Nos.', 200], ['500 pcs', 500], ['500 pieces', 500], ['qty: 300', 300], ['Qty - 300', 300], ['Qty=250', 250],
    ['quantity 1200', 1200], ['1k pcs', 1000], ['2.5k units', 2500], ['40 pax', 40], ['approx 300 pax', 300], ['for 30 CXOs', 30],
    ['for 12 directors', 12], ['150 new joinees', 150], ['200x bottles', 200], ['MOQ 100 pcs', 100], ['min 100 pcs', 100],
    ['1,000 nos', 1000], ['100 sets', 100], ['60 kits', 60], ['75 hampers', 75],
  ];
  for (const [t, n] of cases) it(t, () => expect(parseRequest(t).quantity).toBe(n));
});

describe('prices the way vendors write them', () => {
  const cases: [string, number, number, 'incl' | 'excl' | null][] = [
    ['₹500/pc', 0, 500, null],
    ['500 per pc', 0, 500, null],
    ['Rs. 500/- per piece', 0, 500, null],
    ['500 + GST', 0, 500, 'excl'],
    ['500+gst', 0, 500, 'excl'],
    ['₹500 plus GST', 0, 500, 'excl'],
    ['500 ex-GST', 0, 500, 'excl'],
    ['500 excl. GST', 0, 500, 'excl'],
    ['500 excluding taxes', 0, 500, 'excl'],
    ['500 incl GST', 0, 500, 'incl'],
    ['500 inclusive of GST', 0, 500, 'incl'],
    ['500 all inclusive', 0, 500, 'incl'],
    ['landing cost 650', 0, 650, 'incl'],
    ['650 landing', 0, 650, 'incl'],
    ['@ 1200 per unit', 0, 1200, null],
    ['rate 1200', 0, 1200, null],
    ['target price 800', 0, 800, null],
    ['budget per head 2k', 0, 2000, null],
    ['price point of 1500', 0, 1500, null],
    ['basic price 400', 0, 400, 'excl'],
  ];
  for (const [t, lo, hi, g] of cases) {
    it(t, () => {
      const q = parseRequest(t);
      expect([q.minPrice, q.maxPrice, q.gst ?? null]).toEqual([lo, hi, g]);
      expect(q.ambiguous).toEqual([]);
    });
  }
  it('qty and price together, any order', () => {
    for (const t of ['Qty: 300 | Budget: 1500 + GST', '1500+gst x 300 nos', '300 nos @ 1500 + gst', 'need 300 pcs, rate 1500 plus gst']) {
      const q = parseRequest(t);
      expect([q.quantity, q.maxPrice, q.gst]).toEqual([300, 1500, 'excl']);
    }
  });
});

describe('GST is applied correctly to the budget', () => {
  // A "+ GST" product at ₹475 costs ₹561 with GST; an MRP product at ₹495 already includes GST.
  const pad = products.find((p) => p.name === 'Anti-Skid Mouse Pad')!;
  const holder = products.find((p) => p.name === 'Oblique Duo Card Holder')!;
  it('budgetPrice', () => {
    expect(budgetPrice(pad, 'incl')).toBe(561);
    expect(budgetPrice(pad, 'excl')).toBe(475);
    expect(budgetPrice(holder, 'incl')).toBe(495);
    expect(budgetPrice(holder, 'excl')).toBe(419);
  });
  it('"under 500 incl GST" leaves out a ₹475 + GST item', () => {
    const r = recommend(products, parseRequest('gifts under 500 incl gst'), 50, collections);
    expect(r.picks.some((p) => p.id === pad.id)).toBe(false);
    expect(r.picks.some((p) => p.id === holder.id)).toBe(true);
    for (const p of r.picks) expect(budgetPrice(p, 'incl')! <= 500).toBe(true);
  });
  it('"under 450 + GST" keeps a ₹495 MRP item (₹419 before GST)', () => {
    const r = recommend(products, parseRequest('gifts under 450 + gst'), 50, collections);
    expect(r.picks.some((p) => p.id === holder.id)).toBe(true);
    for (const p of r.picks) expect(budgetPrice(p, 'excl')! <= 450).toBe(true);
  });
  it('says what it assumed', () => expect(notes('gifts under 500 incl gst')).toMatch(/assumed 18%/));
});

describe('product jargon', () => {
  const cases: [string, string][] = [
    ['TWS', 'Earbuds & headphones'], ['neckband', 'Earbuds & headphones'], ['BT speaker', 'Speakers'], ['bluetooth speakers', 'Speakers'],
    ['PB 10000mah', 'Power banks & chargers'], ['powerbank', 'Power banks & chargers'], ['magsafe charger', 'Power banks & chargers'],
    ['sipper', 'Mugs & bottles'], ['temperature bottle', 'Mugs & bottles'], ['thermos', 'Mugs & bottles'], ['bottel', 'Mugs & bottles'],
    ['bagpack', 'Backpacks'], ['laptop bag', 'Laptop bags'], ['messenger', 'Laptop bags'], ['duffel', 'Duffle & travel bags'],
    ['trolley bag', 'Duffle & travel bags'], ['jute bag', 'Tote bags'], ['conference bag', 'Tote bags'], ['amenity kit', 'Pouches & organisers'],
    ['card holder', 'Wallets & card holders'], ['passport holder', 'Wallets & card holders'], ['cheque book holder', 'Wallets & card holders'],
    ['A5 diary', 'Notebooks & diaries'], ['dairy', 'Notebooks & diaries'], ['metal pen', 'Pens'], ['desk organiser', 'Desk & office items'],
    ['table calendar', 'Stationery & desk items'], ['polo t-shirts', 'T-shirts & polos'], ['round neck tees', 'T-shirts & polos'],
    ['hoody', 'Hoodies & jackets'], ['windcheater', 'Hoodies & jackets'], ['sweat shirt', 'Hoodies & jackets'], ['smart band', 'Smart watches & wearables'],
    ['keychain', 'Keychains'], ['lanyard', 'Lanyards & ID card holders'], ['umbrella', 'Umbrellas'], ['dry fruits', 'Sweets, dry fruits & gourmet hampers'],
    ['diyas', 'Candles & diyas'], ['pen drive', 'Pen drives'], ['trophy', 'Trophies, awards & mementos'], ['mobile stand', 'Mobile stands'],
  ];
  for (const [t, chip] of cases) it(t, () => expect(say(t).chips).toContain(chip));
  it('t-shirts are not formal shirts', () => expect(parseRequest('polo t-shirts').kinds).toEqual(['tshirt']));
  it('sweat shirt is not a formal shirt', () => expect(parseRequest('sweat shirts').kinds).toEqual(['hoodie']));
  it('pen stand / pen drive are not pens', () => {
    expect(parseRequest('pen stand').kinds).toEqual(['stationery']);
    expect(parseRequest('pen drive').kinds).toEqual(['usb']);
  });
  it('"long service awards" is an occasion, not trophies', () => {
    const q = parseRequest('gifts for long service awards');
    expect(q.kinds).toEqual([]);
    expect(q.purpose).toBe('Rewards & recognition');
  });
});

describe('things we do not stock get an honest answer', () => {
  for (const t of ['keychains 500 pcs', 'lanyards for event', 'umbrellas under 500', 'dry fruit hampers for diwali', 'trophies for annual day', 'polo t-shirts 250 nos', 'pen drives 100 nos', 'boat earbuds']) {
    it(t, () => {
      const r = say(t);
      expect(r.rec!.notes[0]).toMatch(/^Sorry/);
      expect(r.rec!.picks.length > 0 || r.rec!.suggestion !== null).toBe(true);
    });
  }
});

describe('materials, branding, specs, brands, deadlines', () => {
  it('PU leather + debossing + ex-GST budget', () => {
    const r = say('pls share options for PU leather card holders, 1k pcs, 400 per pc ex gst, logo debossing');
    expect(r.chips).toEqual(['Up to ₹400 per gift + GST', '1,000 units', 'Wallets & card holders', 'Leather / PU', 'With debossing']);
    expect(r.rec!.picks.map((p) => p.name)).toEqual(['Oblique Tripp']);
    expect(/133 of our/.test(r.text.join(' '))).toBe(false); // no duplicate logo FAQ inside a request
  });
  it('branding keeps only brandable products', () => {
    const r = recommend(products, parseRequest('gifts with our logo under 3000'), 50, collections);
    expect(r.picks.length > 0 && r.picks.every((p) => p.branding_possible)).toBe(true);
  });
  it('missing material is said', () => expect(notes('steel bottles under 700')).toMatch(/Sorry, we don't have steel \/ metal options/));
  it('material filter works', () => {
    const r = recommend(products, parseRequest('bamboo or cork gifts'), 20, collections);
    expect(r.picks.length > 0 && r.picks.every((p) => /bamboo|cork/i.test(`${p.name} ${p.features.join(' ')} ${Object.values(p.specs).join(' ')} ${p.description ?? ''}`))).toBe(true);
  });
  it('spec match ranks first', () => {
    const r = recommend(products, parseRequest('10000 mAh power bank'), 8, collections);
    expect(/10,?000 ?mah/i.test(JSON.stringify(r.picks[0]))).toBe(true);
  });
  it('one brand missing, one available', () => {
    const r = say('boat or toreto speakers under 3k');
    expect(r.rec!.notes[0]).toBe("Sorry, boAt isn't available with us right now.");
    expect(r.rec!.picks.every((p) => p.brand === 'Toreto')).toBe(true);
  });
  it('brand that is not stocked → similar products of the same kind', () => {
    const r = say('Mokobara backpacks for 30 CXOs');
    expect(r.chips).toContain('30 units');
    expect(r.rec!.picks.length > 0 && r.rec!.picks.every((p) => p.subcategory === 'Laptop Backpacks')).toBe(true);
  });
  it('catalogue brands with symbols', () => {
    expect(recommend(products, parseRequest('jack & jones hoodies'), 8).picks.every((p) => /jack/i.test(p.brand ?? ''))).toBe(true);
    expect(recommend(products, parseRequest('US Polo shirts'), 8).picks.every((p) => /polo/i.test(p.brand ?? ''))).toBe(true);
  });
  it('deadline noted and chips capitalised', () => {
    const r = say('need 200 nos by 25th nov under 1000');
    expect(r.chips).toContain('Needed by 25th Nov');
    expect(r.rec!.notes.join(' ')).toMatch(/Ready-stock products ship fastest/);
  });
  it('event giveaways lean affordable', () => {
    const r = say('giveaways for trade show 1000 pcs');
    expect(r.chips).toEqual(['1,000 units', 'Events & giveaways', 'Lowest prices first']);
    const ps = r.rec!.picks.map((p) => unitPrice(p)!);
    expect(ps).toEqual([...ps].sort((a, b) => a - b));
  });
  it('hamper with missing items gets substitutes and an honest lead line', () => {
    const r = say('Qty: 300 | Budget: 1500 + GST | Diwali hamper with diary + pen + bottle');
    expect(r.rec!.notes.slice(0, 2)).toEqual(["Sorry, we don't have any pens right now.", "Sorry, we don't have any notebooks & diaries right now."]);
    expect(r.text[0]).toMatch(/^Here are \d+ mugs & bottles and similar items/);
    expect(r.rec!.picks.some((p) => p.name === 'Eco Cork Mug')).toBe(true);
  });
});

describe('vendor questions', () => {
  const cases: [string, RegExp][] = [
    ['what branding options do you have?', /laser engraving for metal/],
    ['can u share mockup before production', /confirms the artwork/],
    ['do you provide gift box packaging', /Packaging and gift boxes/],
    ['can you ship to 12 cities', /multiple locations/],
    ['pan india delivery possible?', /multiple locations/],
    ['will you share proforma invoice', /proforma invoice, PO and tax invoice/],
    ['any bulk discount for 5000 pcs?', /better per-piece prices/],
    ['what is the TAT', /Delivery time depends/],
    ['is gst included?', /\+ GST/],
    ['moq?', /minimum order is 25/],
    ['send me your catalogue', /Download catalogue PPT/],
  ];
  for (const [t, re] of cases) it(t, () => expect(say(t).text.join(' ')).toMatch(re));
});

describe('a realistic RFQ thread', () => {
  it('keeps everything straight across messages', () => {
    let ctx = EMPTY_CONTEXT;
    const send = (m: string) => {
      const r = respond(m, ctx, products, collections);
      ctx = r.ctx;
      return r.reply;
    };
    const a = send('Hi, need welcome kits for 150 new joinees, budget 2k + gst per kit');
    expect(a.chips).toEqual(['Up to ₹2,000 per gift + GST', '150 units', 'Employee Welcome Kits']);
    const b = send('only bags');
    expect(b.chips).toEqual(['Up to ₹2,000 per gift + GST', '150 units', 'Employee Welcome Kits', 'Bags']);
    expect(b.rec!.picks.every((p) => p.category.slug === 'bags-backpacks')).toBe(true);
    const c = send('make it 1500 landing');
    expect(c.chips[0]).toBe('Up to ₹1,500 per gift incl. GST');
    for (const p of c.rec!.picks) expect(budgetPrice(p, 'incl')! <= 1500).toBe(true);
    const d = send('can you deboss our logo on these?');
    expect(d.chips).toContain('With debossing');
    expect(d.rec!.picks.every((p) => p.branding_possible)).toBe(true);
    const e = send('qty is 200 now');
    expect(e.chips).toContain('200 units');
  });
});

describe('fuzz: 20,000 vendor-style messages parse exactly', () => {
  const qtys: [string, number | null][] = [
    ['', null], ['200 nos', 200], ['qty: 300', 300], ['500 pcs', 500], ['1k pcs', 1000], ['for 40 pax', 40], ['Qty - 120', 120],
    ['150 new joinees', 150], ['for 30 CXOs', 30], ['250 units', 250], ['x 60', 60],
  ];
  const prices: [string, number, number, 'incl' | 'excl' | null][] = [
    ['', 0, Infinity, null], ['₹500/pc', 0, 500, null], ['700 + GST', 0, 700, 'excl'], ['budget 1500 + gst', 0, 1500, 'excl'],
    ['landing 650', 0, 650, 'incl'], ['1200 incl gst', 0, 1200, 'incl'], ['@ 900 per unit', 0, 900, null], ['under 2k ex-gst', 0, 2000, 'excl'],
    ['rate 450', 0, 450, null], ['between 500 and 1000 + gst', 500, 1000, 'excl'], ['above 3000', 3000, Infinity, null], ['2k-5k', 2000, 5000, null],
  ];
  const kinds = ['', 'TWS', 'steel bottles', 'PU leather card holders', 'laptop backpacks', 'diary + pen', 'BT speaker', 'hoodies', 'amenity kit', 'jute bags', 'desk organiser'];
  const extras = ['', 'with logo', 'laser engraved', 'by 25th Nov', 'urgent', 'for Diwali', 'welcome kit', 'for dealers', 'pls share options', 'R&R'];
  const seps = [' ', ', ', ' | ', '. ', ' - ', '\n'];
  let seed = 11;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  it('runs', () => {
    for (let i = 0; i < 20000; i++) {
      const [qt, qn] = qtys[rnd(qtys.length)]!;
      const [pt, lo, hi, g] = prices[rnd(prices.length)]!;
      const parts = [kinds[rnd(kinds.length)]!, qt, pt, extras[rnd(extras.length)]!];
      for (let j = parts.length - 1; j > 0; j--) {
        const k = rnd(j + 1);
        [parts[j], parts[k]] = [parts[k]!, parts[j]!];
      }
      const text = parts.filter(Boolean).join(seps[rnd(seps.length)]!);
      const q = parseRequest(rnd(4) ? text : text.toUpperCase());
      if (q.ambiguous.length) throw new Error(`asked about a clear request: "${text}"`);
      if (q.minPrice !== lo || q.maxPrice !== hi) throw new Error(`budget ${q.minPrice}-${q.maxPrice}, expected ${lo}-${hi}: "${text}"`);
      if ((q.gst ?? null) !== g) throw new Error(`gst ${q.gst}, expected ${g}: "${text}"`);
      if (q.quantity !== qn) throw new Error(`quantity ${q.quantity}, expected ${qn}: "${text}"`);
      if (i % 10 === 0) {
        const r = recommend(products, q, 8, collections);
        for (const p of r.picks) {
          const bp = budgetPrice(p, q.gst ?? null);
          if (bp !== null && (bp < q.minPrice || bp > q.maxPrice)) throw new Error(`over budget ${p.name} for "${text}"`);
        }
        if (!r.picks.length && !r.notes.length) throw new Error(`empty without explanation: "${text}"`);
      }
    }
  });
});
