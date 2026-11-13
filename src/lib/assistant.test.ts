import { describe, expect, it } from 'vitest';
import { featuredOrder, parseRequest, recommend, resolveAmbiguity, searchProducts, shortlist, type ParsedRequest } from './assistant';
import { unitPrice } from './format';
import type { CatalogueProduct } from './types';
import fixture from './__fixtures__/catalogue.json';

// The starter catalogue (135 products).
const products = fixture.products as unknown as CatalogueProduct[];
const collections = fixture.collections;
const price = (p: CatalogueProduct) => unitPrice(p)!;
const run = (text: string, limit = 8) => recommend(products, parseRequest(text), limit, collections);
const isToreto = (p: CatalogueProduct) => p.brand === 'Toreto' || /^toreto/i.test(p.name);

describe('parseRequest: budgets', () => {
  const cases: [string, number, number][] = [
    ['budget under 500', 0, 500],
    ['under 500', 0, 500],
    ['gifts under ₹500', 0, 500],
    ['under Rs.500', 0, 500],
    ['below rs 500 per gift', 0, 500],
    ['budget 500', 0, 500],
    ['500 budget', 0, 500],
    ['₹500 budget', 0, 500],
    ['budget: ₹500', 0, 500],
    ['budget is 500', 0, 500],
    ['budget of 500', 0, 500],
    ['500 rupees', 0, 500],
    ['500/- per gift', 0, 500],
    ['upto 500/-', 0, 500],
    ['within 500 rs', 0, 500],
    ['max 500', 0, 500],
    ['not more than ₹500', 0, 500],
    ['less than ₹ 500', 0, 500],
    ['500 each', 0, 500],
    ['₹500 per person', 0, 500],
    ['gifts at ₹500', 0, 500],
    ['₹1,500', 0, 1500],
    ['under 1.5k', 0, 1500],
    ['under 2k', 0, 2000],
    ['under ₹2 k', 0, 2000],
    ['between 500 and 1000', 500, 1000],
    ['500-1000', 500, 1000],
    ['₹500 – ₹1000', 500, 1000],
    ['500 to 1000 rupees', 500, 1000],
    ['from 1000 to 2500', 1000, 2500],
    ['above 4000', 4000, Infinity],
    ['over ₹4,000', 4000, Infinity],
    ['at least 4000', 4000, Infinity],
    ['₹4000+', 4000, Infinity],
    ['above 1000 below 2000', 1000, 2000],
  ];
  for (const [text, lo, hi] of cases) {
    it(`"${text}" → ${lo}–${hi}`, () => {
      const q = parseRequest(text);
      expect([q.minPrice, q.maxPrice]).toEqual([lo, hi]);
      expect(q.ambiguous).toEqual([]);
    });
  }
  it('around ₹1000 gives a window around it', () => {
    const q = parseRequest('around ₹1000');
    expect([q.minPrice, q.maxPrice, q.approx]).toEqual([700, 1150, 1000]);
  });
});

describe('parseRequest: quantities', () => {
  const cases: [string, number | null, number][] = [
    ['gifts for 200 people', 200, Infinity],
    ['Diwali gifts under ₹1,500 for 200 employees', 200, 1500],
    ['for 50 new hires', 50, Infinity],
    ['over 100 employees under 800', 100, 800],
    ['100 pcs under 500', 100, 500],
    ['qty 300 under 999', 300, 999],
    ['team of 40, budget 1200', 40, 1200],
    ['50 laptop bags', 50, Infinity],
    ['40 backpacks under 2000', 40, 2000],
    ['200 units', 200, Infinity],
    ['50-100 people', 100, Infinity],
    ['under 500 for 100', 100, 500],
    ['500 each for 100 people', 100, 500],
    ['100 x mugs', 100, Infinity],
  ];
  for (const [text, qty, hi] of cases) {
    it(`"${text}" → qty ${qty}, max ${hi}`, () => {
      const q = parseRequest(text);
      expect(q.quantity).toBe(qty);
      expect(q.maxPrice).toBe(hi);
    });
  }
});

describe('parseRequest: totals, units and noise', () => {
  it('reads a total budget and divides by head count', () => {
    const q = parseRequest('total budget 1 lakh for 100 people');
    expect([q.totalBudget, q.quantity, q.maxPrice]).toEqual([100000, 100, 1000]);
  });
  it('treats a big budget next to a head count as total', () => {
    const q = parseRequest('budget 50000 for 100 employees');
    expect([q.totalBudget, q.maxPrice]).toEqual([50000, 500]);
  });
  it('keeps "each" as per gift even when large', () => {
    const q = parseRequest('₹25000 each for 30 directors');
    expect([q.totalBudget, q.maxPrice, q.quantity]).toEqual([null, 25000, 30]);
  });
  it('"under 25000 for 100 people" is a per-gift cap, not a total', () => {
    expect(parseRequest('under 25000 for 100 people').maxPrice).toBe(25000);
  });
  it('ignores product specs, dates and years', () => {
    for (const t of ['10000mah power bank', '20000 mAh power banks', '500 ml bottle', '15.6 inch sleeve', 'need by 25th nov', 'delivery in 2 weeks', 'Diwali 2026 gifts']) {
      const q = parseRequest(t);
      expect([q.minPrice, q.maxPrice, q.ambiguous]).toEqual([0, Infinity, []]);
    }
  });
  it('a spec next to a real budget keeps the budget', () => {
    const q = parseRequest('10000mah power bank under 2000 for 50 people');
    expect([q.maxPrice, q.quantity]).toEqual([2000, 50]);
  });
  it('asks when a lone number could be either', () => {
    expect(parseRequest('gifts 500').ambiguous).toEqual([500]);
    expect(parseRequest('gifts for 500').ambiguous).toEqual([500]);
    expect(parseRequest('diwali 300').ambiguous).toEqual([300]);
  });
  it('fills the missing role from a lone number', () => {
    const a = parseRequest('under ₹800, 150');
    expect([a.maxPrice, a.quantity]).toEqual([800, 150]);
    const b = parseRequest('200 employees 700');
    expect([b.maxPrice, b.quantity]).toEqual([700, 200]);
  });
  it('resolveAmbiguity applies the answer', () => {
    const q = parseRequest('gifts 500');
    expect(resolveAmbiguity(q, 'price').maxPrice).toBe(500);
    expect(resolveAmbiguity(q, 'qty').quantity).toBe(500);
    const two = resolveAmbiguity(parseRequest('gifts 100 600'), 'qty');
    expect([two.quantity, two.maxPrice]).toEqual([100, 600]);
  });
  it('never throws on junk', () => {
    for (const t of ['', '   ', '₹', '-', '1e999', '9'.repeat(400), '<script>alert(1)</script>', 'under under under', '₹₹₹500', 'between and', '0', '-500', 'NaN', '१२३']) {
      const q = parseRequest(t);
      expect(Number.isNaN(q.maxPrice) || Number.isNaN(q.minPrice)).toBe(false);
      expect(q.minPrice <= q.maxPrice).toBe(true);
    }
  });
});

describe('parseRequest: occasions and kinds', () => {
  it('occasions', () => {
    expect(parseRequest('Deepavali hampers').collections).toEqual(['diwali-festive']);
    expect(parseRequest('onboarding kit for interns').collections).toEqual(['employee-welcome-kits']);
    expect(parseRequest('sustainable gifts').collections).toEqual(['eco-friendly-gifts']);
    expect(parseRequest('gifts for our CXOs').collections).toEqual(['premium-client-gifts']);
    expect(parseRequest('team offsite').collections).toEqual(['travel']);
    expect(parseRequest('green bottle').collections).toEqual([]);
  });
  it('kinds, keeping the specific one', () => {
    expect(parseRequest('onboarding kit with backpack and power bank').kinds).toEqual(expect.arrayContaining(['backpack', 'power']));
    expect(parseRequest('laptop bags').kinds).toEqual(['laptopBag']);
    expect(parseRequest('bags').kinds).toEqual(['bag']);
    expect(parseRequest('hoodies').kinds).toEqual(['hoodie']);
    expect(parseRequest('mugs and bottles').kinds).toEqual(['drinkware']);
    expect(parseRequest('earbuds').kinds).toEqual(['earbuds']);
  });
  it('flags ready stock and low-price wording', () => {
    expect(parseRequest('urgent, need in stock speakers').stockOnly).toBe(true);
    expect(parseRequest('cheap gifts').prefer).toBe('low');
  });
});

describe('recommend: budget is never exceeded', () => {
  const queries = [
    'budget under 500', '500 budget', 'gifts under ₹500 for 100 people', 'under 300', 'under 1000', 'Diwali gifts under ₹1500',
    'tech under 1000', 'bags under 1500', 'around 2000', 'between 1000 and 2000', 'premium client gifts above ₹4000',
    'total budget 1 lakh for 100 people', 'speakers under 1000', 'cheap gifts under 800', 'eco gifts under 400',
  ];
  for (const text of queries) {
    it(text, () => {
      const q = parseRequest(text);
      const r = recommend(products, q, 8, collections);
      for (const p of r.picks) {
        expect(unitPrice(p) !== null).toBe(true);
        expect(price(p) >= q.minPrice && price(p) <= q.maxPrice).toBe(true);
      }
      expect(new Set(r.picks.map((p) => p.id)).size).toBe(r.picks.length);
      expect(r.picks.length <= 8).toBe(true);
    });
  }
});

describe('recommend: the reported bug', () => {
  it('"budget under 500" shows the under-₹500 products, not Toreto', () => {
    const r = run('budget under 500');
    expect(r.picks.length).toBe(8);
    expect(r.picks.some(isToreto)).toBe(false);
    expect(r.picks.every((p) => price(p) <= 500)).toBe(true);
    expect(r.picks.some((p) => /oblique/i.test(p.name))).toBe(true);
    const all = products.filter((p) => price(p) !== undefined && unitPrice(p) !== null && price(p) <= 500);
    expect(r.matched).toBe(all.length);
  });
  it('"500 budget" and "₹500 each" behave the same', () => {
    const a = run('budget under 500').picks.map((p) => p.id).sort();
    expect(run('500 budget').picks.map((p) => p.id).sort()).toEqual(a);
    expect(run('₹500 each').picks.map((p) => p.id).sort()).toEqual(a);
  });
  it('no budget does not default to stock-first Toreto', () => {
    const r = run('corporate gifts');
    expect(r.picks.filter(isToreto).length <= 3).toBe(true);
    expect(new Set(r.picks.map((p) => p.category.slug)).size >= 4).toBe(true);
  });
  it('uses the budget well: picks are near the top of the budget', () => {
    const r = run('gifts under 2000');
    const avg = r.picks.reduce((s, p) => s + price(p), 0) / r.picks.length;
    expect(avg > 1000).toBe(true);
  });
});

describe('recommend: matching', () => {
  it('kinds come from product text, across vendors', () => {
    const r = run('laptop bags under 2000');
    expect(r.picks.length > 0).toBe(true);
    for (const p of r.picks) expect(/messenger|laptop|sleeve/i.test(`${p.name} ${p.subcategory}`)).toBe(true);
  });
  it('mixed kinds are all represented', () => {
    const r = run('onboarding kit with backpack, power bank and earbuds');
    const subs = new Set(r.picks.map((p) => p.subcategory));
    expect(subs.has('Laptop Backpacks')).toBe(true);
    expect(subs.has('Power & Charging')).toBe(true);
    expect(subs.has('Headphones & Earbuds')).toBe(true);
  });
  it('occasion narrows when possible', () => {
    const r = run('Diwali gifts under 3000');
    expect(r.picks.length > 0).toBe(true);
    for (const p of r.picks) expect(p.collection_slugs.includes('diwali-festive')).toBe(true);
  });
  it('eco matches the eco category too', () => {
    const r = run('eco-friendly gifts under 500');
    expect(r.picks.length > 0).toBe(true);
    for (const p of r.picks) expect(p.category.slug === 'eco-friendly' || p.collection_slugs.includes('eco-friendly-gifts')).toBe(true);
  });
  it('brand names filter', () => {
    const r = run('parker pens');
    // No Parker in this catalogue: say so politely, then offer alternatives.
    expect(r.notes[0]).toBe("Sorry, Parker isn't available with us right now.");
    expect(r.alternative).toBe(true);
    expect(r.picks.every((p) => !/parker/i.test(p.name))).toBe(true);
    const t = run('toreto speakers under 2000');
    expect(t.picks.length > 0).toBe(true);
    for (const p of t.picks) expect(isToreto(p)).toBe(true);
  });
  it('ready stock filter', () => {
    const r = run('in stock gifts under 2000');
    for (const p of r.picks) expect((p.ready_stock ?? 0) > 0).toBe(true);
    expect(r.notes.some((n) => /ready stock/.test(n))).toBe(true);
  });
  it('cheap sorts low-first', () => {
    const r = run('cheap gifts');
    const ps = r.picks.map(price);
    expect(ps).toEqual([...ps].sort((a, b) => a - b));
    expect(ps[0]! <= 300).toBe(true);
  });
});

describe('recommend: says what it could not do', () => {
  it('kind out of budget → polite note, alternatives in budget, and a suggestion', () => {
    const r = run('speakers under 500');
    expect(r.notes[0]).toBe("Sorry, we don't have any speakers under ₹500 right now. They start at ₹1,599.");
    expect(r.alternative).toBe(true);
    expect(r.picks.length).toBe(8);
    expect(r.picks.every((p) => price(p) <= 500)).toBe(true);
    expect(r.suggestion !== null).toBe(true);
    const again = recommend(products, r.suggestion!.query, 8, collections);
    expect(again.picks.length > 0).toBe(true);
  });
  it('kind not in catalogue', () => {
    const r = run('notebooks under 1000');
    expect(r.notes[0]).toBe("Sorry, we don't have any notebooks & diaries right now.");
    expect(r.alternative).toBe(true);
    expect(r.picks.length > 0 && r.picks.every((p) => price(p) <= 1000)).toBe(true);
    expect(run('pen stand').picks.some((p) => /penstand/i.test(p.name))).toBe(true);
  });
  it('nothing under a tiny budget', () => {
    const r = run('under 100');
    expect(r.picks.length).toBe(0);
    expect(r.notes.join(' ')).toMatch(/^Sorry, we don't have anything under ₹100 right now\. Our gifts start at ₹225\.$/);
    expect(r.suggestion!.label).toBe('Show our most affordable gifts');
    expect(r.suggestion !== null).toBe(true);
  });
  it('MOQ note for small quantities', () => {
    expect(run('10 mugs').notes.join(' ')).toMatch(/minimum order is 25 units/);
  });
  it('occasion relaxed with a note', () => {
    const r = run('Diwali hoodies');
    expect(r.picks.length > 0).toBe(true);
    expect(r.notes.join(' ')).toMatch(/We don't have Diwali & Festive picks for this yet, but these would make lovely gifts too\./);
  });
  it('total without quantity asks for quantity', () => {
    expect(run('total budget 50000').notes.join(' ')).toMatch(/how many gifts/);
  });
});

describe('shop search', () => {
  it('understands budget text', () => {
    const { results, understood } = searchProducts(products, 'budget under 500');
    expect(results.length).toBe(products.filter((p) => unitPrice(p) !== null && price(p) <= 500).length);
    expect(understood).toEqual(['Up to ₹500 per gift']);
  });
  it('kind + budget', () => {
    const { results } = searchProducts(products, 'sling bags under 1000');
    expect(results.length > 0).toBe(true);
    for (const p of results) expect(p.subcategory === 'Sling Bags' && price(p) <= 1000).toBe(true);
  });
  it('plain words still work', () => {
    expect(searchProducts(products, 'oblique').results.length > 50).toBe(true);
    expect(searchProducts(products, 'Toreto speaker').results.every(isToreto)).toBe(true);
    expect(searchProducts(products, 'zzzz').results.length).toBe(0);
  });
  it('featured order mixes sub-categories and keeps every product', () => {
    const f = featuredOrder(products);
    expect(f.length).toBe(products.length);
    expect(new Set(f.slice(0, 12).map((p) => p.subcategory)).size >= 10).toBe(true);
  });
});

describe('every reply is friendly', () => {
  it('all "not available" notes start politely and never end empty-handed without a next step', () => {
    for (const t of ['speakers under 500', 'notebooks', 'parker pens', 'under 50', 'sony headphones under 300', 'Diwali hoodies', 'in stock hoodies', 'lamps above 50000', 'apple watch', 'pens under 200']) {
      const r = run(t);
      for (const n of r.notes) if (/don't|isn't|nothing/i.test(n)) expect(n).toMatch(/^(Sorry|We don't have .* but these would make lovely gifts too)/);
      expect(r.picks.length > 0 || r.suggestion !== null).toBe(true);
      expect(new Set(r.notes).size).toBe(r.notes.length);
    }
  });
});

describe('back-compat', () => {
  it('shortlist returns picks', () => {
    const q: ParsedRequest = parseRequest('under 1000');
    expect(shortlist(products, q).length).toBe(8);
  });
});

describe('fuzz: 20,000 generated requests keep every guarantee', () => {
  const occ = ['', 'Diwali', 'onboarding', 'eco', 'client', 'travel', 'festive hampers', 'new joinee', 'Deepavali', 'premium'];
  const kinds = ['', 'gifts', 'bags', 'backpack', 'speakers', 'mugs', 'tech', 'hoodies', 'wallet', 'sling', 'earbuds', 'power bank', 'desk', 'laptop bags', 'gadgets', 'shirts', 'something nice', 'merch'];
  const budgets: [string, number, number][] = [
    ['', 0, Infinity], ['under 500', 0, 500], ['under ₹1,000', 0, 1000], ['below 1.5k', 0, 1500], ['budget 2000', 0, 2000],
    ['₹800 each', 0, 800], ['between 500 and 1500', 500, 1500], ['above 3000', 3000, Infinity], ['around 1200', 840, 1380],
    ['500-1000', 500, 1000], ['upto 300/-', 0, 300], ['500 budget', 0, 500], ['rs 750 per gift', 0, 750], ['not more than 2k', 0, 2000],
    ['₹400 – ₹900', 400, 900], ['max ₹650', 0, 650], ['1000 rupees', 0, 1000], ['₹3000+', 3000, Infinity], ['less than Rs.450', 0, 450],
  ];
  const qty: [string, number | null][] = [
    ['', null], ['for 100 people', 100], ['50 employees', 50], ['qty 250', 250], ['for 30 new hires', 30], ['x 10', 10],
    ['team of 40', 40], ['200 pcs', 200], ['over 120 staff', 120], ['for 75 clients', 75], ['300 units', 300],
  ];
  const seps = [' ', ', ', ' - ', '. ', ' and '];
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  it('runs', () => {
    for (let i = 0; i < 20000; i++) {
      const [bt, lo, hi] = budgets[rnd(budgets.length)]!;
      const [qt, qn] = qty[rnd(qty.length)]!;
      const parts = [occ[rnd(occ.length)]!, kinds[rnd(kinds.length)]!, bt, qt];
      for (let j = parts.length - 1; j > 0; j--) {
        const k = rnd(j + 1);
        [parts[j], parts[k]] = [parts[k]!, parts[j]!];
      }
      const text = parts.filter(Boolean).join(seps[rnd(seps.length)]!);
      const q = parseRequest(rnd(3) ? text : text.toUpperCase());
      if (q.ambiguous.length) throw new Error(`asked about a clear request: "${text}"`);
      if (q.minPrice !== lo || q.maxPrice !== hi) throw new Error(`budget ${q.minPrice}-${q.maxPrice}, expected ${lo}-${hi}: "${text}"`);
      if (q.quantity !== qn) throw new Error(`quantity ${q.quantity}, expected ${qn}: "${text}"`);
      const r = recommend(products, q, 8, collections);
      for (const p of r.picks) {
        const pr = unitPrice(p);
        if (pr === null && (q.minPrice > 0 || Number.isFinite(q.maxPrice))) throw new Error(`unpriced pick for "${text}"`);
        if (pr !== null && (pr < q.minPrice || pr > q.maxPrice)) throw new Error(`over budget ${p.name} ${pr} for "${text}"`);
      }
      if (new Set(r.picks.map((p) => p.id)).size !== r.picks.length) throw new Error(`duplicate for "${text}"`);
      if (!r.picks.length && !r.notes.length) throw new Error(`empty without explanation: "${text}"`);
    }
  });
});

describe('head count vs price words', () => {
  it('clients after a price word', () => {
    expect(parseRequest('around 1200 client gifts').maxPrice).toBe(1380);
    const q = parseRequest('over 100 clients, under 2000');
    expect([q.quantity, q.minPrice, q.maxPrice]).toEqual([100, 0, 2000]);
    expect(parseRequest('budget 2000 client gifts').maxPrice).toBe(2000);
    expect(parseRequest('500 budget 300 units').quantity).toBe(300);
  });
});

describe('large catalogue ranking', () => {
  const base = products[0]!;
  let n = 0;
  const mk = (name: string, price: number, cat: string, sub: string): CatalogueProduct =>
    ({ ...base, id: `x${++n}`, sku: `x-${n}`, slug: `x-${n}`, name, brand: null, sell_price: price, mrp: null, price_basis: 'gst_extra',
      category: { id: 99, name: cat, slug: cat.toLowerCase().replace(/[^a-z]+/g, '-') }, subcategory: sub, collection_slugs: [], features: [], specs: {}, colours: [], description: null }) as CatalogueProduct;
  const big = [
    ...['Black', 'Blue', 'Grey', 'White', 'Mint', 'Purple'].map((c) => mk(`Rhine ${c} Smart Bottle`, 839, 'Drinkware', 'Bottles & Flasks')),
    mk('Grace Bottle', 876, 'Drinkware', 'Bottles & Flasks'), mk('Torino Bottle', 787, 'Drinkware', 'Bottles & Flasks'),
    mk('Steel Flask 750ml', 650, 'Drinkware', 'Bottles & Flasks'), mk('Coffee Mug 350 ml', 176, 'Drinkware', 'Mugs'),
    mk('Bamboo Wireless Charger with Coaster (without Mug)', 855, 'Gadgets & Tech', 'Power & Charging'),
    mk('Carabiner Keychain with Bottle Opener', 105, 'Travel & Accessories', 'Keychains'),
    mk('3-piece Gift Set: Notebook, Pen & Bottle', 429, 'Gift Sets & Hampers', 'Gift Sets'),
    mk('Duke Pen', 47, 'Pens & Stationery', 'Pens'), mk('Zest Pen', 47, 'Pens & Stationery', 'Pens'), mk('Ride Pen', 30, 'Pens & Stationery', 'Pens'),
    mk('Eco Notebook + Cork Pen', 241, 'Pens & Stationery', 'Notebooks & Diaries'), mk('Desk Lamp with Pen Holder', 493, 'Home & Lifestyle', 'Lamps & Lights'),
    mk('Crystal Trophy 7"', 523, 'Trophies & Awards', 'Crystal Trophies'), mk('Award Trophy 10 x 8 in', 910, 'Trophies & Awards', 'Awards & Plaques'),
  ];
  const go = (t: string, limit = 8) => recommend(big, parseRequest(t), limit).picks.map((p) => p.name);
  it('"bottle" shows bottles: no mugs, openers, chargers or sets', () => {
    const r = go('bottle');
    expect(r.length > 2).toBe(true);
    for (const name of r) expect(name).toMatch(/bottle|flask/i);
    expect(/opener|without|gift set/i.test(r.join(' '))).toBe(false);
  });
  it('one design in many colours appears once while others are available', () => {
    expect(go('bottle', 4).filter((x) => x.startsWith('Rhine')).length).toBe(1);
  });
  it('"pens" shows pens, not pen holders or notebook combos', () => {
    const r = go('pens');
    expect(r.length).toBe(3);
    for (const name of r) expect(name).toMatch(/ pen$/i);
  });
  it('trophies appear only when asked for', () => {
    expect(/trophy/i.test(go('gifts under 1000').join(' '))).toBe(false);
    expect(go('trophies').every((x) => /trophy/i.test(x))).toBe(true);
    expect(go('trophies').length).toBe(2);
  });
  it('"gift set with bottle" prefers gift sets', () => {
    expect(go('gift set with notebook pen and bottle')[0]).toMatch(/gift set/i);
  });
});
