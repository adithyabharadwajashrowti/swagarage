// Shop search: ranks every product by how well it matches what was typed, fixes
// typos ("botle" → "bottle"), understands budgets and product words like the
// Gift Assistant ("bags under 1500"), and adds a second tier of related
// products so a search never ends empty-handed.
import type { CatalogueProduct } from './types';
import {
  brandMatches,
  describe,
  FOCUS,
  inBudget,
  KINDS,
  MATERIALS,
  matchesKind, askedNeeds, isNarrowNoun,
  normalise,
  parseRequest,
  RELATED,
  STOP,
  type ParsedRequest,
} from './assistant';

export interface SearchResult {
  /** Best matches, most relevant first. */
  exact: CatalogueProduct[];
  /** Close relatives: same family of products, or partial matches. */
  related: CatalogueProduct[];
  /** What the search understood (budget, kinds…), for chips. */
  understood: string[];
  /** Set when a typo was fixed: the query we actually searched for. */
  corrected: string | null;
}

/** Words people search for that may not appear in product names, mapped to kinds. */
const SEARCH_WORDS =
  'bottle bottles mug mugs flask sipper tumbler backpack backpacks bag bags laptop sleeve sling duffle duffel tote pouch wallet ' +
  'card holder passport speaker speakers earbuds headphones neckband charger power bank cable watch smartwatch fitness band ' +
  'hoodie hoodies jacket jackets shirt shirts tshirt apparel diary notebook pen pens calendar planner planter plant lamp light ' +
  'clock kettle fan desk mousepad organiser organizer stand tech gadget gadgets travel eco bamboo cork jute leather steel ' +
  'gift gifts hamper kit premium bluetooth wireless magnetic portable waterproof leather insulated anti-theft rolltop';

const COLOURS = new Set('black blue white grey gray navy brown tan green red maroon olive beige pink purple yellow orange silver gold golden charcoal mustard'.split(' '));

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/&/g, ' ')
    .split(/[^a-z0-9+]+/)
    .filter((w) => w.length >= 2);
}

const stem = (w: string) => w.replace(/(ies)$/, 'y').replace(/(sses|shes|ches|xes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, '$1');

/** Damerau–Levenshtein distance with an early exit above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

const allowedTypos = (w: string) => (w.length >= 7 ? 2 : w.length >= 4 ? 1 : 0);

interface Indexed {
  p: CatalogueProduct;
  name: string[];
  strong: string[]; // sub-category, brand
  category: string[];
  weak: string[]; // features, description, specs
  colours: string[];
}

function index(p: CatalogueProduct): Indexed {
  return {
    p,
    name: words(p.name).map(stem),
    strong: words(`${p.subcategory ?? ''} ${p.brand ?? ''}`).map(stem),
    category: words(p.category.name).map(stem),
    weak: words(`${p.description ?? ''} ${(p.features ?? []).join(' ')} ${Object.values(p.specs ?? {}).join(' ')}`).map(stem),
    colours: words((p.colours ?? []).join(' ')).map(stem),
  };
}

/** Fix typos against the catalogue's own words. Returns the corrected words and whether anything changed. */
function correct(tokens: string[], vocab: Set<string>): { tokens: string[]; changed: boolean } {
  let changed = false;
  const out = tokens.map((w) => {
    const s = stem(w);
    if (vocab.has(s) || vocab.has(w) || /\d/.test(w) || STOP.has(w)) return w;
    const max = allowedTypos(w);
    if (!max) return w;
    let best: string | null = null;
    let bestD = max + 1;
    for (const v of vocab) {
      if (Math.abs(v.length - s.length) > max) continue;
      const dist = editDistance(s, v, max);
      if (dist < bestD || (dist === bestD && best !== null && v.length > best.length)) {
        best = v;
        bestD = dist;
      }
    }
    if (best && bestD <= max) {
      changed = true;
      return best;
    }
    return w;
  });
  return { tokens: out, changed };
}

/** `knownKind`: the query names a kind of product, so the category name alone ("Bags & Backpacks") is not enough. */
function fieldScore(token: string, ix: Indexed, knownKind = false): number {
  // "hoodies" → "hoody" by the usual rule; also try just dropping the "s".
  const alt = token.replace(/([^s])s$/, '$1');
  if (alt !== stem(token) && alt !== token) return Math.max(fieldScoreOf(stem(token), ix, knownKind), fieldScoreOf(alt, ix, knownKind));
  return fieldScoreOf(stem(token), ix, knownKind);
}

function fieldScoreOf(t: string, ix: Indexed, knownKind: boolean): number {
  let best = 0;
  const check = (list: string[], exact: number, prefix: number, fuzzy: number) => {
    for (const w of list) {
      if (w === t) best = Math.max(best, exact);
      else if (t.length >= 3 && w.startsWith(t)) best = Math.max(best, prefix);
      else if (t.length >= 4 && w.length >= 4 && (w.includes(t) || t.includes(w))) best = Math.max(best, prefix * 0.8);
      else if (allowedTypos(t) && editDistance(t, w, allowedTypos(t)) <= allowedTypos(t)) best = Math.max(best, fuzzy);
    }
  };
  check(ix.name, 10, 7, 5);
  check(ix.strong, 7, 5, 3.5);
  check(ix.category, knownKind ? 3 : 6, knownKind ? 2 : 4, knownKind ? 0 : 3);
  check(ix.weak, 2.5, 1.5, 0);
  // A colour asked for ("blue backpack") matters more than where the word "backpack" appears.
  if (ix.colours.includes(t)) best = Math.max(best, 4) + 8;
  return best;
}

/** Words the chat fixes typos towards: product types, colours and materials only, so Hinglish or names are left alone. */
const CHAT_WORDS = new Set<string>([
  ...'bottle mug flask sipper tumbler backpack laptop sleeve sling duffle duffel tote pouch wallet speaker earbuds headphones neckband charger cable smartwatch hoodie jacket shirt tshirt apparel diary notebook pen calendar planner planter lamp clock kettle mousepad organiser organizer gadget hamper bluetooth wireless magnetic portable waterproof insulated'.split(' '),
  ...'umbrella umbrellas trophy trophies memento medal medals keychain keychains calendar calendars candle candles diya planter succulent coaster coasters frame frames purse purses trolley trolleys suitcase luggage cushion towel blanket shawl perfume trimmer massager kettle tumbler tumblers sipper sippers thermos lunchbox lunch tiffin container stationery notebook notebooks diaries pouch pouches organiser hoodie sweatshirt tshirt polo polos socks shoes sneakers cap caps hat shirt blazer windcheater bomber puffer fleece speaker speakers earphones headphone headphones earbuds charger chargers adapter powerbank cable cables mouse keyboard webcam lamp lamps lantern torch clock clocks watch watches smartwatch tracker backpack backpacks rucksack duffle duffel sling tote wallet wallets hamper hampers chocolate chocolates dryfruits gift gifts combo handbag handbags umbrella medal formal casual mobile mobiles phone phones stand stands holder holders charger chargers'.split(' '),
  ...COLOURS,
].map(stem));
/** Fix typos in a chat message against the catalogue's words ("backpak" → "backpack"). Null when nothing changed. */
const knownCache = new WeakMap<CatalogueProduct[], Set<string>>();
/** Every word in the catalogue (names, types, colours): these are never "fixed". */
function knownWords(products: CatalogueProduct[]): Set<string> {
  let v = knownCache.get(products);
  if (!v) {
    v = new Set<string>([...SEARCH_WORDS.split(' ').map(stem), ...STOP]);
    for (const p of products) for (const w of words(`${p.name} ${p.subcategory ?? ''} ${p.category.name} ${p.brand ?? ''} ${(p.colours ?? []).join(' ')}`)) v.add(stem(w));
    knownCache.set(products, v);
  }
  return v;
}
const brandCache = new WeakMap<CatalogueProduct[], string[]>();
/** One-word brand names we carry ("adidas", "reebok"), so "addidas" can be fixed. */
function brandWords(products: CatalogueProduct[]): string[] {
  let v = brandCache.get(products);
  if (!v) {
    v = [...new Set(products.map((p) => (p.brand ?? '').toLowerCase()).filter((b) => /^[a-z]{5,}$/.test(b)))];
    brandCache.set(products, v);
  }
  return v;
}
/** Fix product-word typos in a chat message ("backpak" → "backpack", "umbrela" → "umbrella"). Null when nothing changed. */
export function correctText(text: string, products: CatalogueProduct[] = []): { text: string; fixed: [string, string][] } | null {
  const known = knownWords(products);
  const tokens = normalise(text).replace(/\u20b9/g, ' ').split(/\s+/).filter(Boolean);
  const PROTECT = /^(kids?|men|mens|women|ladies|team|teams|lady|girls?|boys?|staff|ceo|vip|whats|thats|pls|plz|pcs|ppl)$/;
  const ALIAS: Record<string, string> = { bagpakc: 'backpack', bagpac: 'backpack', bakpack: 'backpack', backpac: 'backpack', bakpak: 'backpack', tshit: 't-shirt', tshits: 't-shirts', tshrt: 't-shirt', tshrts: 't-shirts', bagack: 'backpack', backpak: 'backpack', bagpack: 'backpack', bagpacks: 'backpacks', bagpak: 'backpack', bottel: 'bottle', bottels: 'bottles', botel: 'bottle', calender: 'calendar', calenders: 'calendars', momento: 'memento', momentos: 'mementos', speakr: 'speaker', umbrela: 'umbrella', umbrellas: 'umbrellas' };
  const fixed: [string, string][] = [];
  const out = tokens.map((tok) => {
    const w = tok.replace(/[^a-z0-9+-]/g, '');
    if (!w || /\d/.test(w) || PROTECT.test(w)) return tok;
    const wn = w.replace(/-/g, '');
    if (ALIAS[wn]) { fixed.push([w, ALIAS[wn]!]); return ALIAS[wn]!; }
    if (w.includes('-') && (known.has(stem(wn)) || CHAT_WORDS.has(stem(wn)) || CHAT_WORDS.has(wn) || /^t-?shirts?$/.test(w) || !/^[a-z]-?[a-z]{4,}$/.test(w))) return tok; // "t-shirt", "3-in-1" are fine
    if (w.includes('-')) {
      // "t-shirrt": fix the joined word, then put the hyphen back
      const sw = stem(wn);
      for (const v of CHAT_WORDS) if (v[0] === sw[0] && Math.abs(v.length - sw.length) <= 1 && editDistance(sw, v, 1) <= 1) { const out = (v === 'tshirt' ? 't-shirt' : v) + (wn.endsWith('s') && !v.endsWith('s') ? 's' : ''); fixed.push([w, out]); return out; }
      return tok;
    }
    if (w.length < 5 || known.has(stem(w)) || known.has(w) || CHAT_WORDS.has(stem(w))) return tok;
    // One slip (a missing, extra, wrong or swapped letter) on a product word with the same first letter.
    let best: string | null = null;
    for (const v of [...CHAT_WORDS, ...brandWords(products)]) {
      const sw = stem(w);
      if (v[0] !== sw[0] || Math.abs(v.length - sw.length) > 1) continue;
      const swapped = v.length === sw.length && [...v].filter((c, i) => c !== sw[i]).length === 2 && [...v].sort().join('') === [...sw].sort().join('');
      if (swapped || editDistance(sw, v, 1) <= 1 || editDistance(sw, stem(v), 1) <= 1) { best = w.endsWith('s') && !v.endsWith('s') ? v + 's' : v; break; }
    }
    if (!best) return tok;
    fixed.push([w, best]);
    return best;
  });
  return fixed.length ? { text: out.join(' '), fixed } : null;
}

export function smartSearch(products: CatalogueProduct[], text: string): SearchResult {
  const raw = text.trim().slice(0, 120);
  if (!raw) return { exact: products, related: [], understood: [], corrected: null };

  const idx = products.map(index);
  const vocab = new Set<string>([
    ...SEARCH_WORDS.split(' ').map(stem),
    ...idx.flatMap((i) => [...i.name, ...i.strong, ...i.category, ...i.colours].filter((w) => w.length >= 3 && !/\d/.test(w))),
  ]);

  // Fix typos first, then understand the (corrected) request.
  const rawTokens = normalise(raw).replace(//g, '').split(/[^a-z0-9+-]+/).filter(Boolean);
  const fixed = correct(rawTokens, vocab);
  const query = fixed.changed ? fixed.tokens.join(' ') : raw;
  const q: ParsedRequest = parseRequest(query);

  // Words that carry meaning for matching (not "under", "for", numbers…).
  const tokens = [...new Set(words(normalise(query).replace(//g, '')))].filter(
    (w) => (!STOP.has(w) || COLOURS.has(w)) && !/^\d/.test(w) && !['ingst', 'exgst', 'rs', 'inr'].includes(w),
  );

  // Hard filters from the request.
  let pool = idx.filter((i) => inBudget(i.p, q));
  if (q.notKinds?.length) pool = pool.filter((i) => !q.notKinds!.some((k) => matchesKind(i.p, k)));
  // Brands asked for: the known list plus any of our own catalogue brands named in the query ("hummel bags").
  const flat = (t: string) => ` ${normalise(t).replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const nq = flat(query);
  const catBrands = [...new Set(products.map((p) => p.brand).filter((b): b is string => !!b && b.length >= 3))]
    .filter((b) => nq.includes(flat(b)))
    .map((b) => b.toLowerCase());
  const brandHits = [...new Set([...(q.brands ?? []), ...catBrands])].filter((b) => products.some((p) => brandMatches(p.brand, b)));
  if (brandHits.length) pool = pool.filter((i) => brandHits.some((b) => brandMatches(i.p.brand, b)));
  const brandWords = new Set(brandHits.flatMap((b) => b.split(' ')));

  const focus = (q.nouns ?? []).map((k) => FOCUS[k]!.name);
  const wantSets = (q.nouns ?? []).includes('hamper') || /\b(sets?|combos?|kits?)\b/.test(normalise(query));
  const priceOf = (p: CatalogueProduct) => p.sell_price ?? p.mrp ?? Infinity;
  const scored = pool.map((i) => {
    let score = 0;
    let matched = 0; // words found anywhere
    let strongMatched = 0; // words found in the name, sub-category, category or brand
    for (const t of tokens) {
      if (brandWords.has(t)) {
        matched++;
        strongMatched++;
        continue;
      }
      const s = fieldScore(t, i, q.kinds.length > 0);
      if (s > 0) matched++;
      if (s >= 3.5) strongMatched++;
      score += s;
    }
    const kindHit = q.kinds.some((k) => matchesKind(i.p, k));
    if (kindHit) score += 12;
    for (const m of q.materials ?? []) if (MATERIALS[m]!.p.test(`${i.name.join(' ')} ${i.weak.join(' ')}`)) score += 3;
    for (const c of q.collections) if (i.p.collection_slugs.includes(c)) score += 2;
    const phrase = tokens.join(' ');
    const stemmed = tokens.map((w) => w.replace(/([^s])s$/, '$1')).join(' ');
    if (phrase.length >= 3 && (i.p.name.toLowerCase().includes(phrase) || i.p.name.toLowerCase().includes(stemmed))) score += 8;
    const allMatched = tokens.length > 0 && matched === tokens.length;
    const strongAll = tokens.length > 0 && strongMatched === tokens.length;
    const inOcc = q.collections.some((c) => i.p.collection_slugs.includes(c));
    // "bottle": real bottles first; gift sets that merely contain one come after.
    const n = i.p.name.toLowerCase();
    const isSet = /gift set|\d-piece|\bcombo\b|hamper/.test(n);
    const focusHit = focus.length > 0 && focus.some((re) => re.test(`${n} ${(i.p.subcategory ?? '').toLowerCase()}`)) && !/without|opener|holder\b|stand\b|optional/.test(n);
    if (focusHit && !isSet) score += 10;
    if (isSet && !wantSets) score -= 6;
    return { i, score, matched, kindHit, allMatched, strongAll, inOcc, focusHit, isSet };
  });

  // Exact: the kind of product asked for, or every word found in its name/category/brand.
  let exact = scored.filter((s) => s.kindHit || s.strongAll || (tokens.length === 0 && !q.kinds.length));
  // A kind was asked for and we have several: show that kind only (no look-alike words: "socks" is not "dock").
  if (q.kinds.length && scored.filter((s) => s.kindHit).length >= 3) exact = exact.filter((s) => s.kindHit);
  // Nothing that strong: accept every word found anywhere (e.g. in the features), then the occasion's products.
  if (!exact.length) exact = scored.filter((s) => s.allMatched);
  if (!exact.length && q.collections.length) exact = scored.filter((s) => s.inOcc);
  // Asked for bottles and we have plenty: other drinkware moves to "related".
  const narrow = (q.nouns ?? []).some(isNarrowNoun);
  if (focus.length && !wantSets && exact.filter((s) => s.focusHit && !s.isSet).length >= (narrow ? 1 : 3)) exact = exact.filter((s) => s.focusHit && !s.isSet);
  // Exactly what was typed: colours, sizes, features and descriptive words ("black", "3 in 1", "anti theft").
  const needs = askedNeeds(q, brandHits);
  if (needs.length && exact.length) {
    const sc = new Map(exact.map((s) => [s.i.p.id, needs.filter((n) => n.ok(s.i.p)).length]));
    const best = Math.max(...sc.values());
    if (best > 0) exact = exact.filter((s) => sc.get(s.i.p.id) === best);
  }
  exact.sort((a, b) => b.score - a.score || Number(!!b.i.p.image_path) - Number(!!a.i.p.image_path) || priceOf(a.i.p) - priceOf(b.i.p) || a.i.p.name.localeCompare(b.i.p.name));
  const exactIds = new Set(exact.map((s) => s.i.p.id));

  // Related: the families next to what was found, plus partial word matches.
  const foundKinds = new Set<string>(q.kinds);
  for (const s of exact.slice(0, 12)) for (const k of Object.keys(KINDS)) if (matchesKind(s.i.p, k)) foundKinds.add(k);
  const relatedKinds = new Set([...foundKinds].flatMap((k) => RELATED[k] ?? []));
  const topSubs = new Set(exact.slice(0, 6).map((s) => s.i.p.subcategory));
  const exPrices = exact.map((s) => priceOf(s.i.p)).filter(Number.isFinite).sort((a, b) => a - b);
  const mid = exPrices.length ? exPrices[Math.floor(exPrices.length / 2)]! : 500;
  const related = scored
    .filter((s) => !exactIds.has(s.i.p.id))
    .map((s) => {
      let r = s.score;
      if ([...relatedKinds].some((k) => matchesKind(s.i.p, k))) r += 6;
      if (topSubs.has(s.i.p.subcategory)) r += 4;
      if (s.inOcc) r += 3;
      if (s.isSet && !wantSets) r -= 3;
      return { ...s, r };
    })
    .filter((s) => s.r >= 3) // a real relation, not noise
    .sort((a, b) => b.r - a.r || Math.abs(priceOf(a.i.p) - mid) - Math.abs(priceOf(b.i.p) - mid) || a.i.p.name.localeCompare(b.i.p.name))
    .slice(0, 12);

  return {
    exact: exact.map((s) => s.i.p),
    related: related.map((s) => s.i.p),
    understood: describe(q).filter((c) => !/units$/.test(c)),
    corrected: fixed.changed ? fixed.tokens.filter((w) => !STOP.has(w)).join(' ') : null,
  };
}
