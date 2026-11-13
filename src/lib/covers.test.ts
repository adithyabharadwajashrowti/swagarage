import { describe, expect, it } from 'vitest';
import { collectionCovers } from './covers';
import type { CatalogueProduct } from './types';
import fixture from './__fixtures__/catalogue.json';

const products = fixture.products as unknown as CatalogueProduct[];
const DESC: Record<string, string> = {
  'employee-welcome-kits': 'Laptop bags, tech and desk gear for day one',
  'diwali-festive': 'Speakers, lamps and gifts for the season',
  'premium-client-gifts': 'Leather, smartwatches and statement pieces',
  'eco-friendly-gifts': 'Plantable, cork, bamboo, jute and recycled',
  travel: 'Duffles, slings, passport and travel kits',
  'under-500': 'Thoughtful gifts that go easy on budgets',
};
const cols = fixture.collections.map((c) => ({ ...c, description: DESC[c.slug] ?? null }));
const covers = collectionCovers(products, cols);
const subs = (slug: string) => covers.get(slug)!.map((p) => p.subcategory);

describe('occasion card images', () => {
  it('two per card, all from that collection, no repeats across cards', () => {
    const ids: string[] = [];
    for (const c of cols) {
      const ps = covers.get(c.slug)!;
      expect(ps.length).toBe(2);
      for (const p of ps) expect(p.collection_slugs.includes(c.slug)).toBe(true);
      ids.push(...ps.map((p) => p.id));
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('match what each card says', () => {
    expect(subs('diwali-festive')).toContain('Speakers');
    expect(subs('premium-client-gifts')).toEqual(expect.arrayContaining(['Wallets & Folios', 'Smart Wearables']));
    expect(subs('employee-welcome-kits')).toContain('Laptop Backpacks');
    expect(subs('travel')).toEqual(expect.arrayContaining(['Duffle & Travel', 'Sling Bags']));
    expect(covers.get('eco-friendly-gifts')!.every((p) => p.category.slug === 'eco-friendly')).toBe(true);
    expect(covers.get('under-500')!.every((p) => (p.sell_price ?? p.mrp)! <= 500)).toBe(true);
  });
});
