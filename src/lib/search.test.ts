import { describe, expect, it } from 'vitest';
import { editDistance, smartSearch } from './search';
import { matchesKind } from './assistant';
import { unitPrice } from './format';
import type { CatalogueProduct } from './types';
import fixture from './__fixtures__/catalogue.json';
import { _test } from './whatsapp';

const products = fixture.products as unknown as CatalogueProduct[];
const find = (q: string) => smartSearch(products, q);
const names = (ps: CatalogueProduct[]) => ps.map((p) => p.name);

describe('shop search finds related and closest products', () => {
  it('empty search returns everything', () => expect(find('').exact.length).toBe(products.length));
  it('bottle → drinkware, not backpacks that merely have a bottle pocket', () => {
    const r = find('bottle');
    expect(names(r.exact)).toEqual(['Eco Cork Mug']);
    expect(r.related.length > 0).toBe(true);
  });
  it('laptop → laptop bags, sleeves and backpacks', () => {
    const r = find('laptop');
    expect(r.exact.length > 15).toBe(true);
    expect(r.exact.every((p) => p.category.slug === 'bags-backpacks' || /laptop/i.test(`${p.name} ${p.subcategory} ${p.features.join(' ')} ${p.description ?? ''}`))).toBe(true);
  });
  it('speaker → all speakers first', () => {
    const r = find('speaker');
    expect(r.exact.slice(0, 10).every((p) => p.subcategory === 'Speakers')).toBe(true);
  });
  it('typos are fixed', () => {
    for (const [typo, fixed] of [['speker', 'speaker'], ['laptp bag', 'laptop bag'], ['walet', 'wallet'], ['hodie', 'hoodie'], ['backpak', 'backpack'], ['bluetoth speaker', 'bluetooth speaker']]) {
      const r = find(typo!);
      expect(r.corrected).toBe(fixed);
      expect(r.exact.length > 0).toBe(true);
    }
  });
  it('plural / singular and case do not matter', () => {
    expect(names(find('Wallets').exact)).toEqual(names(find('wallet').exact));
    expect(names(find('HOODIES').exact)).toEqual(names(find('hoodie').exact));
  });
  it('model and brand names', () => {
    expect(names(find('soundbolt').exact)[0]).toBe('Toreto Soundbolt');
    expect(find('fitbit').exact.every((p) => p.brand === 'Fitbit')).toBe(true);
    expect(find('toreto').exact.length).toBe(products.filter((p) => p.brand === 'Toreto').length);
  });
  it('budgets work in the search box', () => {
    const r = find('bags under 1500');
    expect(r.exact.length > 0 && r.exact.every((p) => unitPrice(p)! <= 1500 && matchesKind(p, 'bag'))).toBe(true);
    expect(r.understood).toEqual(['Up to ₹1,500 per gift', 'Bags']);
  });
  it('materials and colours rank matching products first', () => {
    expect(names(find('cork').exact).slice(0, 2).sort()).toEqual(['Eco Cork Mug', 'Magnetic Cork Planter']);
    expect(/blue/i.test(find('blue backpack').exact[0]!.colours.join(' '))).toBe(true);
  });
  it('things we do not have: no exact match, but related products', () => {
    const r = find('diary');
    expect(r.exact.length).toBe(0);
    expect(r.related.length > 0).toBe(true);
  });
  it('nonsense returns nothing (the page then shows popular products)', () => {
    const r = find('xyzqw');
    expect([r.exact.length, r.related.length]).toEqual([0, 0]);
  });
  it('related never repeats exact results and is capped', () => {
    for (const t of ['bottle', 'laptop', 'speaker', 'hoodie', 'wallet', 'travel', 'eco gifts', 'pen']) {
      const r = find(t);
      const ids = new Set(r.exact.map((p) => p.id));
      expect(r.related.every((p) => !ids.has(p.id))).toBe(true);
      expect(r.related.length <= 12).toBe(true);
    }
  });
  it('never throws, and is fast', () => {
    const t0 = Date.now();
    for (const t of ['<script>', '₹', '1e9', 'a', '"', '9'.repeat(80), 'under', 'gifts gifts gifts', 'नमस्ते', '%%%', 'bag'.repeat(30)]) find(t);
    expect(Date.now() - t0 < 2000).toBe(true);
  });
  it('edit distance', () => {
    expect(editDistance('botle', 'bottle')).toBe(1);
    expect(editDistance('wlalet', 'wallet')).toBe(1); // transposition
    expect(editDistance('abc', 'xyz') > 2).toBe(true);
  });
});

describe('WhatsApp number', () => {
  it('normalises Indian numbers', () => {
    expect(_test.normalise('98765 43210')).toBe('919876543210');
    expect(_test.normalise('+91 98765-43210')).toBe('919876543210');
    expect(_test.normalise('')).toBe(null);
    expect(_test.normalise('12345')).toBe(null);
  });
});

describe('shop search at catalogue scale', () => {
  const base = products[0]!;
  let n = 0;
  const mk = (name: string, price: number, sub: string): CatalogueProduct =>
    ({ ...base, id: `s${++n}`, sku: `s-${n}`, slug: `s-${n}`, name, brand: null, sell_price: price, mrp: null, subcategory: sub, colours: [], features: [], specs: {}, description: null, collection_slugs: [] }) as CatalogueProduct;
  const big = [
    mk('2-piece Gift Set: Bottle & Pen', 300, 'Gift Sets'), mk('3-piece Gift Set: Bottle, Diary & Pen', 450, 'Gift Sets'),
    mk('Grace Bottle', 876, 'Bottles & Flasks'), mk('Torino Bottle', 787, 'Bottles & Flasks'), mk('Steel Flask', 650, 'Bottles & Flasks'),
    mk('Coffee Mug', 176, 'Mugs'), mk('Keychain with Bottle Opener', 105, 'Keychains'),
  ];
  it('"bottle" lists bottles first, not gift sets or openers', () => {
    const r = smartSearch(big, 'bottle');
    expect(r.exact.map((p) => p.name).sort()).toEqual(['Grace Bottle', 'Steel Flask', 'Torino Bottle']);
  });
  it('"gift set with bottle" lists the sets', () => {
    expect(smartSearch(big, 'bottle gift set').exact[0]!.name).toMatch(/Gift Set/);
  });
});
