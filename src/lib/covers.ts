// Picks the two cover images for each "Shop by occasion" card so that each card
// shows what its description promises (Diwali → speakers, lamps; Premium →
// leather, smartwatches) and no image repeats across cards.
import type { CatalogueProduct, Collection } from './types';
import { unitPrice } from './format';

/** Words in collection descriptions → what to look for in product text. */
const SYNONYMS: Record<string, RegExp> = {
  laptop: /laptop|backpack|messenger|sleeve/,
  bag: /bag|backpack|messenger|sling|duffle|tote/,
  tech: /gadgets|tech|speaker|earbud|power|charg/,
  desk: /desk|mouse ?pad|penstand|pen stand|calendar|organi[sz]er/,
  speaker: /speaker|sound/,
  lamp: /lamp|light|glow|clock|home & desk/,
  leather: /leather|folio|wallet|passport|card holder/,
  smartwatch: /watch|wearable|fitbit|charge|inspire/,
  statement: /premium|executive|duffle|messenger/,
  plantable: /plant|seed/,
  cork: /cork/,
  bamboo: /bamboo/,
  jute: /jute|tote/,
  recycled: /recycl|eco/,
  duffle: /duffle|duffel|weekender/,
  sling: /sling/,
  passport: /passport|travel wallet|folio/,
  travel: /travel|pouch|organi[sz]er|luggage|tag/,
};

function hay(p: CatalogueProduct): string {
  return `${p.name} ${p.subcategory ?? ''} ${p.category.name} ${(p.features ?? []).join(' ')} ${Object.values(p.specs ?? {}).join(' ')}`.toLowerCase();
}

function keywords(description: string | null): RegExp[] {
  const words = (description ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3);
  const out: RegExp[] = [];
  for (const w of words) {
    const stem = w.replace(/(es|s)$/, '');
    const key = Object.keys(SYNONYMS).find((k) => stem.startsWith(k) || k.startsWith(stem));
    if (key) out.push(SYNONYMS[key]!);
  }
  return out;
}

export function collectionCovers(products: CatalogueProduct[], collections: Pick<Collection, 'slug' | 'description'>[], perCard = 2): Map<string, CatalogueProduct[]> {
  const used = new Set<string>();
  const out = new Map<string, CatalogueProduct[]>();
  for (const c of collections) {
    const pool = products.filter((p) => p.collection_slugs.includes(c.slug) && p.image_path);
    // Pricier items first: they tend to have the strongest product photos and suit the card better.
    // Budget collections lead with their most affordable items instead.
    const budget = /under|budget|affordable/.test(`${c.slug} ${c.description ?? ''}`.toLowerCase());
    const dir = budget ? -1 : 1;
    pool.sort((a, b) => dir * ((unitPrice(b) ?? 0) - (unitPrice(a) ?? 0)) || a.name.localeCompare(b.name));
    const picks: CatalogueProduct[] = [];
    const take = (p: CatalogueProduct | undefined) => {
      if (!p || picks.includes(p) || picks.some((x) => x.subcategory === p.subcategory)) return;
      picks.push(p);
      used.add(p.id);
    };
    for (const re of keywords(c.description)) {
      if (picks.length >= perCard) break;
      // Name/sub-category matches beat a word buried in the features.
      const core = (p: CatalogueProduct) => `${p.name} ${p.subcategory ?? ''}`.toLowerCase();
      take(pool.find((p) => !used.has(p.id) && re.test(core(p)) && !picks.some((x) => x.subcategory === p.subcategory)) ?? pool.find((p) => !used.has(p.id) && re.test(hay(p))));
    }
    for (const p of pool) {
      if (picks.length >= perCard) break;
      if (!used.has(p.id)) take(p);
    }
    // Small collections: allow a repeat rather than an empty slot.
    for (const p of pool) if (picks.length < perCard && !picks.includes(p)) picks.push(p);
    out.set(c.slug, picks);
  }
  return out;
}
