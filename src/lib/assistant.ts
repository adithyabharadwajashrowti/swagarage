// Gift Assistant: turns a request like "Diwali gifts under ₹1500 for 200 people"
// into a structured request, then recommends products from the live catalogue.
//
// Rule-based on purpose: no AI cost, predictable, fully unit-tested. Matching is
// done on product text (name, sub-category, category, features), not on
// hard-coded sub-category names, so new vendors' products are picked up as-is.
//
// Guarantees (enforced by tests):
//  - a product above the budget is never recommended;
//  - a number is only used as a budget or quantity when the wording says so;
//    otherwise the assistant asks instead of guessing;
//  - anything it could not satisfy is reported in `notes`, never silently dropped.
import type { CatalogueProduct, Collection } from './types';
import { unitPrice } from './format';

export const MOQ = 25;

export interface ParsedRequest {
  /** Per-gift price bounds, inclusive. */
  minPrice: number;
  maxPrice: number;
  quantity: number | null;
  /** Total budget across all gifts, when the user gave one. */
  totalBudget: number | null;
  /** "around ₹500" – shown to the user so they can see the range we used. */
  approx: number | null;
  collections: string[];
  kinds: string[];
  /** Kinds the user said they don't want ("no bags", "except mugs"). */
  notKinds?: string[];
  /** Narrow products to leave out ("no mugs" when bottles are wanted). Keys of FOCUS. */
  notNouns?: string[];
  /** Features to leave out ("not bluetooth"). Keys of ATTRS. */
  notAttrs?: string[];
  /** Materials to leave out ("not steel"). Keys of MATERIALS. */
  notMaterials?: string[];
  /** Other words (brands, product words) used to boost or filter. */
  terms: string[];
  stockOnly: boolean;
  prefer: 'low' | 'high' | null;
  /** Numbers we could not classify as budget or quantity. The UI asks about the first. */
  ambiguous: number[];
  /** Budget stated including GST ("incl GST", "landing cost") or excluding it ("+ GST", "ex-GST"). */
  gst?: 'incl' | 'excl' | null;
  /** Materials asked for ("PU leather", "steel", "bamboo"): keys of MATERIALS. */
  materials?: string[];
  /** Logo/branding asked for; the method if named ("laser engraving"). */
  branding?: string | null;
  /** Brands asked for by name (lower-case). */
  brands?: string[];
  /** Specs like "10000mah", "750ml", "15.6in". */
  specs?: string[];
  /** Deadline as the user wrote it ("by 25th nov", "within 7 days"). */
  deadline?: string | null;
  /** Kind of occasion that has no collection of its own ("rewards & recognition", "event giveaways"). */
  purpose?: string | null;
  /** Exact product words asked for ("bottle", "mug"): products named that way come first. Keys of FOCUS. */
  nouns?: string[];
  /** Exact features asked for: colours, who it's for, connectors, "anti theft"... (keys of ATTRS, or "nin1:3"). */
  attrs?: string[];
}

/** Focus words that describe the same product family (a "Polo T-Shirt" is not a combo of a polo and a t-shirt). */
const JACKET_STYLES = ['bomber', 'puffer', 'windcheater', 'fleeceJacket', 'trackJacket', 'hoodedJacket', 'sleeveless', 'blazer', 'biker'];
const FAMILY: Record<string, string> = { ...Object.fromEntries(JACKET_STYLES.map((k) => [k, 'jacket'])), jacket: 'jacket', lamp: 'lamp', deskLamp: 'lamp', tshirt: 'tshirt', polo: 'tshirt', clock: 'clock', wallClock: 'clock', deskClock: 'clock', bottle: 'drink', mug: 'drink', tumbler: 'drink', sipper: 'drink', flask: 'drink', penStand: 'desk', deskOrg: 'desk', luggageTag: 'bag', powerbank: 'power', charger: 'power', backpack: 'bag', duffle: 'bag', trolley: 'bag' };
/** When both are asked, the narrower one wins ("polo t-shirts" → polos; "wall clock" → wall clocks). */
/** Where each focus word's products live: "bottle" means drinkware, not a bottle bag or a pen shaped like one. */
const FOCUS_CAT: Record<string, string[]> = { ...Object.fromEntries(JACKET_STYLES.map((k) => [k, ['apparel']])), bottle: ['drinkware'], mug: ['drinkware'], sipper: ['drinkware'], flask: ['drinkware'], tumbler: ['drinkware'], tshirt: ['apparel'], polo: ['apparel'], hoodie: ['apparel'], jacket: ['apparel'], hamper: ['gift-sets', 'gift-boxes'] };
const NARROWER: Record<string, string[]> = { luggageTag: ['trolley', 'duffle'], sipper: ['bottle', 'mug'], flask: ['bottle'], deskLamp: ['lamp'], ...Object.fromEntries(JACKET_STYLES.map((k) => [k, ['jacket']])), polo: ['tshirt'], wallClock: ['clock'], deskClock: ['clock'] };

/** How to name the picks when one narrow word was asked for ("Here are 2 bomber jackets"). */
const NOUN_LABEL: Record<string, string> = {
  mousePad: 'mouse pads', deskOrg: 'desk organisers', photoFrame: 'photo frames', sipper: 'sippers', chocolate: 'chocolates', dryFruit: 'dry fruits', luggageTag: 'luggage tags', flask: 'flasks', penStand: 'pen stands', deskLamp: 'desk lamps', bomber: 'bomber jackets', puffer: 'puffer jackets', windcheater: 'windcheaters', fleeceJacket: 'fleece jackets', trackJacket: 'track jackets & suits',
  hoodedJacket: 'hooded jackets', sleeveless: 'sleeveless jackets', blazer: 'blazers', biker: 'leather & biker jackets', polo: 'polo t-shirts',
  wallClock: 'wall clocks', deskClock: 'desk clocks', bottle: 'bottles', mug: 'mugs', tumbler: 'tumblers', mouse: 'mice', keyboard: 'keyboards',
  massager: 'massagers', yogaMat: 'yoga mats', medal: 'medals', kettle: 'kettles', fryer: 'air fryers', trimmer: 'trimmers', fan: 'fans', calendar: 'calendars',
};
/** The narrow label for these picks, if one narrow word was asked for and every pick is one. */
export function nounLabel(q: ParsedRequest, picks: CatalogueProduct[]): string | null {
  const ns = (q.nouns ?? []).filter((n) => NOUN_LABEL[n]);
  if (ns.length !== 1 || !picks.length) return null;
  const re = FOCUS[ns[0]!]!.name;
  return picks.every((p) => re.test(p.name.toLowerCase())) ? NOUN_LABEL[ns[0]!]! : null;
}

/** Product words narrower than a kind: "bottle" should show bottles, not every drinkware item. */
export const FOCUS: Record<string, { q: RegExp; name: RegExp }> = {
  bottle: { q: /\b(bottles?|flasks?|sippers?)\b/, name: /bottle|flask|^(?!.*\bmug\b).*sipper/ },
  mug: { q: /\b(mugs?|coffee cups?|cups?)\b/, name: /\bmug|\bcup\b/ },
  tumbler: { q: /\btumblers?\b/, name: /tumbler/ },
  pen: { q: /\bpens?\b(?! ?(stands?|holders?|drives?))/, name: /\bpens?\b(?! ?(stand|holder|drive))/ },
  notebook: { q: /\b(diar(y|ies)|note ?books?|journals?|planners?)\b/, name: /diary|notebook|note book|journal|planner/ },
  speaker: { q: /\b(speakers?|soundbars?)\b/, name: /speaker|soundbar/ },
  earbuds: { q: /\b(ear ?buds|tws|earphones?|neckbands?|head ?phones?)\b/, name: /buds|earphone|neckband|headphone/ },
  watch: { q: /\b(smart ?watch(es)?|watch(es)?)\b/, name: /watch/ },
  lamp: { q: /\b(lamps?|lanterns?)\b/, name: /lamp|lantern/ },
  clock: { q: /\bclocks?\b/, name: /clock/ },
  wallClock: { q: /\bwall clocks?\b/, name: /wall clock/ },
  deskClock: { q: /\b(desk|table|alarm) clocks?\b/, name: /desk clock|table clock|alarm clock|digital clock/ },
  mouse: { q: /\bmouse\b(?! ?pads?)|\bmice\b/, name: /\bmouse\b(?! ?pad)/ },
  keyboard: { q: /\bkeyboards?\b/, name: /keyboard/ },
  massager: { q: /\bmassagers?\b/, name: /massag/ },
  scale: { q: /\b(weighing )?scales?\b/, name: /scale/ },
  yogaMat: { q: /\byoga ?mats?\b/, name: /yoga/ },
  medal: { q: /\bmedals?\b/, name: /medal/ },
  calendar: { q: /\bcalendars?\b/, name: /calendar/ },
  kettle: { q: /\bkettles?\b/, name: /kettle/ },
  fryer: { q: /\bair ?fryers?\b/, name: /fryer/ },
  fan: { q: /\bfans?\b/, name: /\bfan\b/ },
  trimmer: { q: /\btrimmers?\b/, name: /trimmer/ },
  tote: { q: /\btotes?\b|\bjute bags?\b/, name: /tote|jute bag|shopping bag|canvas bag/ },
  powerbank: { q: /\bpower ?banks?\b/, name: /power ?bank/ },
  charger: { q: /\b(wireless )?chargers?\b/, name: /charg/ },
  umbrella: { q: /\bumbrellas?\b/, name: /umbrella/ },
  keychain: { q: /\bkey ?chains?\b/, name: /key ?chain/ },
  wallet: { q: /\b(wallets?|card ?holders?)\b/, name: /wallet|card ?holder/ },
  hoodie: { q: /\b(hoodies?|sweat ?shirts?)\b/, name: /hoodie|hoody|sweatshirt/ },
  jacket: { q: /\b(jackets?|blazers?|bombers?|wind ?cheaters?)\b/, name: /jacket|blazer|bomber|windcheater/ },
  hamper: { q: /\b(hampers?|gift ?sets?|combos?|gift ?kits?)\b/, name: /gift set|hamper|combo|gift kit|gift box|welcome kit|\btrunk\b|\d-piece/ },
  tshirt: { q: /\b(t-?shirts?|tees?|polos?)\b/, name: /t-?shirt|polo|\btee/ },
  polo: { q: /\bpolos?\b/, name: /\bpolo\b/ },
  sipper: { q: /\bsippers?\b/, name: /sipper/ },
  mousePad: { q: /\bmouse ?(pads?|mats?)\b/, name: /mouse ?(pad|mat)/ },
  deskOrg: { q: /\bdesk organi[sz]ers?\b|\bdesk caddy\b/, name: /desk organi[sz]er|table ?top organi[sz]er|pen stand|desk caddy|stationery holder|desk set|desk kit/ },
  photoFrame: { q: /\b(photo|picture) ?frames?\b/, name: /photo ?frame|picture frame|\bframe (\d|with|–|-)|\bframe$|\d+"? ?x ?\d+"? frame|forest frame/ },
  chocolate: { q: /\bchocolates?\b|\bchocos?\b/, name: /chocolate|choco/ },
  dryFruit: { q: /\bdry ?fruits?\b|\bnuts\b|\balmonds?\b|\bcashews?\b/, name: /dry ?fruit|almond|cashew|\bnuts?\b|pista|raisin/ },
  luggageTag: { q: /\b(luggage|bag) tags?\b/, name: /luggage tag|bag tag/ },
  flask: { q: /\bflasks?\b|\bthermos\b/, name: /flask|thermos|vacuum bottle/ },
  penStand: { q: /\bpen ?(stands?|holders?)\b|\bpencil (stands?|holders?)\b/, name: /pen ?(stand|holder)|pencil (stand|holder)|desk organi[sz]er|stationery holder/ },
  deskLamp: { q: /\b(desk|table|study|reading) lamps?\b/, name: /desk lamp|table lamp|study lamp|reading lamp|table top with led lamp/ },
  bomber: { q: /\bbombers?\b/, name: /bomber/ },
  puffer: { q: /\bpuffers?\b|\bpadded\b|\bquilted\b/, name: /puffer|padded|quilted/ },
  windcheater: { q: /\bwind ?(cheaters?|breakers?)\b/, name: /windcheater|windbreaker/ },
  fleeceJacket: { q: /\bfleece\b/, name: /fleece/ },
  trackJacket: { q: /\btrack ?(jackets?|tops?|suits?)\b/, name: /track (jacket|top|suit)/ },
  hoodedJacket: { q: /\bhooded\b|\bwith hood\b/, name: /hooded|hoodie jacket/ },
  sleeveless: { q: /\bsleeveless\b|\bgilets?\b/, name: /sleeveless|gilet/ },
  blazer: { q: /\bblazers?\b/, name: /blazer/ },
  biker: { q: /\bbiker\b|\bleather jackets?\b|\bsuede\b/, name: /biker|leather|suede/ },
  backpack: { q: /\bback ?packs?\b/, name: /back ?pack/ },
  duffle: { q: /\bduff(le|el)s?\b|\bgym bags?\b|\bweekenders?\b/, name: /duff(le|el)|gym bag|weekender/ },
  trolley: { q: /\b(trolleys?|luggage|suitcases?)\b/, name: /trolley|luggage|overnighter/ },
  trophy: { q: /\b(trophies|trophy|awards?|mementos?|plaques?)\b/, name: /trophy|award|memento|plaque/ },
};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Occasion words → collection slug. Only slugs that exist in the catalogue are used. */
export const OCCASIONS: { slug: string; re: RegExp; label: string }[] = [
  {
    slug: 'diwali-festive',
    label: 'Diwali & festive',
    re: /\b(diwali|deepavali|festive|festival|festivals|christmas|xmas|new year|holi|pongal|onam|eid|ramzan|ramadan|navratri|dussehra|dasara|ugadi|sankranti|rakhi|raksha bandhan|hampers?|season'?s greetings)\b/,
  },
  {
    slug: 'employee-welcome-kits',
    label: 'Employee welcome kits',
    re: /\b(onboard|onboarding|welcome|joining|new hires?|new joinees?|joiners?|joinees?|induction|day one|first day|interns?|freshers?)\b/,
  },
  {
    slug: 'eco-friendly-gifts',
    label: 'Eco-friendly',
    re: /\b(eco|eco-friendly|ecofriendly|sustainable|sustainability|go green|earth day|environment|environmental|recycled|recyclable|biodegradable|plantable|cork|jute|bamboo)\b/,
  },
  {
    slug: 'premium-client-gifts',
    label: 'Premium client gifts',
    re: /\b(clients?|customers?|premium|luxury|luxurious|vip|vips|leadership|executives?|ceo|cxo|cxos|directors?|board members?|partners?|investors?|high[- ]end|dealers?|distributors?|channel partners?|stakeholders?|key accounts?)\b/,
  },
  { slug: 'new-arrivals', label: 'New arrivals', re: /\b(new arrivals?|newly (added|arrived|launched)|latest (products|arrivals|items|gifts|launches|collection)|what'?s new|whats new|new (products|items|launches|collection|stuff))\b/ },
  { slug: 'travel', label: 'Travel', re: /\b(travel|travelling|traveling|offsite|off-site|trips?|journey|commute|vacation|holiday trip)\b/ },
];

type Hay = { core: string; full: string; p: CatalogueProduct };

/** Product kinds. `q` matches the request; `p` matches product text. */
export const KINDS: Record<string, { label: string; q: RegExp; p: (h: Hay) => boolean }> = {
  backpack: { label: 'backpacks', q: /\bback ?packs?\b|\brucksacks?\b/, p: (h) => /backpack|rucksack/.test(`${h.p.name} ${h.p.subcategory ?? ''}`.toLowerCase()) },
  laptopBag: {
    label: 'laptop bags',
    q: /\blaptop (bags?|cases?|sleeves?|carriers?)\b|\bmessengers?\b|\boffice bags?\b/,
    p: (h) => /messenger|laptop|sleeve|office bag/.test(h.core) && h.p.category.slug === 'bags-backpacks',
  },
  sleeve: { label: 'laptop sleeves', q: /\b(laptop |tablet |ipad |macbook )?sleeves?\b(?! (shirts?|t-?shirts?|tees?))/, p: (h) => /sleeve/.test(h.core) && h.p.category.slug !== 'drinkware' && h.p.category.slug !== 'apparel' && !/bottle|mug|tumbler|flask|jar|glass/.test(h.p.name.toLowerCase()) },
  sling: { label: 'sling bags', q: /\bslings?\b|\bcross ?body\b/, p: (h) => /sling|cross ?body/.test(h.core) },
  duffle: {
    label: 'duffle bags',
    q: /\bduffle|\bduffel|\bgym bags?\b|\bweekenders?\b|\btravel bags?\b|\bovernight(er)? bags?\b/,
    p: (h) => h.p.category.slug === 'bags-backpacks' && /duffle|duffel|weekender|gym bag|travel bag|overnighter/.test(h.core) && !/\b(tag|belt|scale|lock|pillow)s?\b|trolley|spinner|hard ?shell|cabin/.test(h.p.name.toLowerCase()),
  },
  trolley: {
    label: 'trolley bags & luggage',
    q: /\btrolleys?\b(?! (tags?|belts?))|\bluggage\b(?! (tags?|scales?|belts?|locks?|weigh\w*))|\bsuitcases?\b|\bcabin (bags?|luggage)\b|\bstrolleys?\b|\bhard ?shell\b/,
    p: (h) => h.p.category.slug === 'bags-backpacks' && /trolley|suitcase|cabin|spinner|hard ?shell|luggage/.test(h.core) && !/\b(tag|belt|scale|lock|pillow)s?\b/.test(h.core),
  },
  luggageAcc: {
    label: 'luggage tags & travel accessories',
    q: /\bluggage (tags?|scales?|belts?|locks?|weigh\w*)\b|\bbag tags?\b|\btravel (pillows?|locks?|adapters?|accessories|essentials|kits?)\b|\bneck pillows?\b/,
    p: (h) => /luggage tag|luggage belt|luggage (weighing )?scale|bag tag|travel pillow|neck pillow|travel lock|luggage lock|travel adapter|travel kit/.test(h.core) || h.p.subcategory === 'Travel Essentials' || h.p.subcategory === 'Luggage Tags',
  },
  pouch: { label: 'pouches & organisers', q: /\bpouch(es)?\b|\b(tech|cable|travel) organi[sz]ers?\b|\btoiletry\b|\bkit bags?\b|\bamenity kits?\b|\bdopp kits?\b|\btravel kits?\b/, p: (h) => /pouch|organi[sz]er|toiletry/.test(h.core) },
  lunch: { label: 'lunch bags', q: /\blunch|\btiffin/, p: (h) => /lunch|tiffin/.test(h.core) },
  tote: { label: 'tote bags', q: /\btotes?\b|\bjute bags?\b|\bshopping bags?\b|\bcloth bags?\b|\bcanvas bags?\b|\bcotton bags?\b|\bconference bags?\b|\bdrawstring\b/, p: (h) => /tote|jute bag|shopping bag/.test(h.core) },
  bag: {
    label: 'bags',
    q: /\bbags?\b/,
    p: (h) => h.p.category.slug === 'bags-backpacks' || /\bbags?\b|\btote|backpack/.test(h.core),
  },
  wallet: {
    label: 'wallets & card holders',
    q: /\bwallets?\b|\bcard ?holders?\b|\bvisiting card|\bpassport|\bfolios?\b|\bcheque ?book|\bdocument (holders?|folders?)\b|\bportfolios?\b/,
    p: (h) => /wallet|card ?holder|passport|folio/.test(h.core) && h.p.category.slug !== 'gift-sets' && h.p.subcategory !== 'Handbags & Purses' && !/notebook|calendar|\d ?pc\b|\d-piece|set of/.test(h.core),
  },
  purse: { label: 'purses & handbags', q: /\bpurses?\b|\bhandbags?\b|\bclutch(es)?\b|\bvanity (bags?|cases?)\b|\bladies bags?\b/, p: (h) => /purse|handbag|clutch|vanity/.test(h.core) || h.p.subcategory === 'Handbags & Purses' },
  speaker: { label: 'speakers', q: /\bspeakers?\b|\bsound ?bars?\b|\bmusic\b|\baudio\b|\bbt speakers?\b|\bbluetooth speakers?\b|\bpartybox\b/, p: (h) => /speaker|sound ?bar|audio ?dock/.test(h.core) || h.p.subcategory === 'Speakers' },
  earbuds: {
    label: 'earbuds & headphones',
    q: /\bear ?buds?\b|\bhead ?phones?\b|\bear ?phones?\b|\bheadsets?\b|\btws\b|\bneckbands?\b|\banc\b|\bbt (headset|earphones?)\b|\bpods\b/,
    p: (h) => /earbud|headphone|earphone|headset|\btws\b|neckband/.test(h.core),
  },
  power: {
    label: 'power banks',
    q: /\bpower ?banks?\b|\bpb\b|\bmagnetic power ?banks?\b/,
    p: (h) => /power ?bank|powerbank|\d+ ?mah\b/.test(h.core) && h.p.category.slug !== 'desk-office',
  },
  charger: {
    label: 'chargers & adapters',
    q: /\bchargers?\b|\bcharging (pads?|stations?|docks?|stands?)\b|\bwireless charg\w*|\bmag ?safe\b|\badapters?\b|\bcharging\b(?! cables?)/,
    p: (h) => /charger|charging (pad|station|dock|stand)|adapter|magsafe|wireless charg/.test(h.core) && !/power ?bank/.test(h.p.name.toLowerCase()),
  },
  cable: { label: 'cables', q: /\bcables?\b|\bcords?\b|\btype-?c (to|cable)|\b3[- ]in[- ]1 cable|\blightning cable|\bc to c\b/, p: (h) => (/cable|cord\b|dura trio/.test(h.core) || h.p.subcategory === 'Cables') && !/power ?bank|adapter|mouse ?pad|hub|speaker|earbuds|headphone/.test(h.p.name.toLowerCase()) },
  wearable: {
    label: 'smart watches & wearables',
    q: /\bwatch(es)?\b|\bsmart ?watch|\bwearables?\b|\bfitness (bands?|trackers?)\b|\bsmart ?bands?\b|\bfitbit\b/,
    p: (h) => /watch|wearable|fitness band/.test(h.core),
  },
  drinkware: {
    label: 'mugs & bottles',
    q: /\bmugs?\b|\bbottles?\b(?! ?openers?)|\bflasks?\b|\btumblers?\b|\bsippers?\b|\bcups?\b|\bdrinkware\b|\bthermos\b|\btemp(erature)? bottles?\b|\bsmart bottles?\b|\bcopper bottles?\b/,
    p: (h) => /mug|bottle|flask|tumbler|sipper|\bcups?\b|drinkware/.test(h.core) && !/\b(medals?|troph(y|ies)|awards?|mementos?|plaques?|opener|holder)\b/.test(h.p.name.toLowerCase()),
  },
  hoodie: {
    label: 'hoodies & sweatshirts',
    q: /\bhoodies?\b|\bhoody\b|\bsweat ?shirts?\b/,
    p: (h) => h.p.category.slug === 'apparel' && (/hoodie|hoody|sweatshirt/.test(h.p.name.toLowerCase()) || h.p.subcategory === 'Hoodies & Sweatshirts'),
  },
  jacket: {
    label: 'jackets',
    q: /\bjackets?\b|\bwinter ?wear\b|\bwind ?cheaters?\b|\bbombers?\b|\bblazers?\b|\bzipper\b|\btrack ?(tops?|suits?)\b/,
    p: (h) => h.p.category.slug === 'apparel' && (/jacket|blazer|bomber|windcheater|track (top|suit)/.test(h.p.name.toLowerCase()) || h.p.subcategory === 'Jackets'),
  },
  shirt: { label: 'shirts', q: /(?:^|[^-a-z])shirts?\b/, p: (h) => /\bshirt/.test(h.core) && !/t-?shirt/.test(h.core) },
  apparel: {
    label: 'apparel',
    q: /\bapparel\b|\bclothing\b|\bclothes\b|\bgarments?\b|\buniforms?\b|\bwear\b/,
    p: (h) => h.p.category.slug === 'apparel',
  },
  pen: { label: 'pens', q: /\bpens?\b(?! ?stands?| ?holders?| ?drives?)|\bpen sets?\b|\bball ?pens?\b|\bfountain pens?\b|\broller ?pens?\b|\bmetal pens?\b|\bstylus\b/, p: (h) => /\bpens?\b(?! ?(stand|holder|drive))|\bpen set/.test(h.core) && !/power ?bank|notebook|diary|table ?top|clock|organi[sz]er|lamp/.test(h.p.name.toLowerCase()) },
  notebook: {
    label: 'notebooks & diaries',
    q: /\bnote ?books?\b|\bnote ?pads?\b|\bdiar(y|ies)\b|\bjournals?\b|\bplanners?\b|\borgani[sz]er diar|\ba5\b|\bb5\b|\bexecutive diar/,
    p: (h) => /notebook|notepad|diary|diaries|journal|planner/.test(h.core),
  },
  calendar: { label: 'calendars', q: /\bcalendars?\b/, p: (h) => /calendar/.test(h.core) },
  stationery: {
    label: 'stationery & desk items',
    q: /\bstationery\b|\bstationary\b|\bpen ?stands?\b|\bpen ?holders?\b/,
    p: (h) => /\bpens?\b|pen ?stand|penstand|notebook|diary|journal|calendar|planner|stationery|card holder/.test(h.core),
  },
  desk: {
    label: 'desk & office items',
    q: /\bdesk\b|\boffice\b|\bwork ?station\b|\bwfh\b|\bwork from home\b|\bmouse ?pads?\b|\bdesk ?mats?\b|\bdesk organi[sz]ers?\b|\btable top\b/,
    p: (h) => /desk|mouse ?pad|deskmat|pen ?stand|penstand|calendar|card holder|lamp|organi[sz]er|office/.test(h.core),
  },
  plant: { label: 'planters & grow kits', q: /\bplants?\b|\bplanters?\b|\bsucculents?\b|\bseeds?\b|\bgrow (kits?|craft|gifts?)\b|\bterrariums?\b|\bplantable\b/, p: (h) => /plant|grow (kit|craft)|seed|terrarium|succulent/.test(h.core) },
  lamp: { label: 'lamps & lights', q: /\blamps?\b|\blights?\b(?! ?(colou?rs?|shades?|tones?|weight|blue|grey|gray|pink|green|brown|yellow|purple|colou?red))|\blanterns?\b|\btorch(es)?\b/, p: (h) => /\blamps?\b|\blights?\b|\blanterns?\b|\btorch/.test(h.core) && h.p.category.slug !== 'gift-sets' && !/bedsheet|towel|power strip/.test(h.core) },
  clock: { label: 'clocks', q: /\bclocks?\b/, p: (h) => /clock/.test(h.core) },
  fan: { label: 'fans', q: /\bfans?\b|\bcoolers?\b/, p: (h) => /\bfans?\b|cooler|snapcool/.test(h.core) },
  appliance: {
    label: 'kitchen & home appliances',
    q: /\bkettles?\b|\bair ?fryers?\b|\btoasters?\b|\bmixers?\b|\bgrinders?\b|\bblenders?\b|\bjuicers?\b|\bappliances?\b|\begg boilers?\b|\binduction\b|\bcoffee makers?\b|\botg\b|\bgas stoves?\b|\bsandwich makers?\b|\birons?\b|\bvacuum cleaners?\b/,
    p: (h) => h.p.subcategory === 'Kitchen & Home Appliances' || /kettle|fryer|toaster|mixer|grinder|blender|juicer|egg boiler|induction|coffee maker|\botg\b|stove|sandwich|\biron\b|vacuum cleaner/.test(h.core),
  },
  grooming: {
    label: 'trimmers & personal care',
    q: /\btrimmers?\b|\bgrooming\b|\bshavers?\b|\bhair ?dryers?\b|\bpersonal care\b/,
    p: (h) => h.p.subcategory === 'Personal Care' || /trimmer|groom|shaver|hair dryer/.test(h.core),
  },
  fitness: {
    label: 'fitness & wellness',
    q: /\bfitness\b(?! (bands?|trackers?))|\bgym\b(?! bags?)|\byoga\b|\bdumbbells?\b|\btreadmills?\b|\bworkout\b|\bexercise\b|\bmassagers?\b|\bweighing scales?\b|\bwellness\b|\bprotein shakers?\b/,
    p: (h) => !/luggage/.test(h.core) && (h.p.subcategory === 'Fitness & Wellness' || /yoga|dumbbell|treadmill|massag|weighing scale|fitness|protein shaker/.test(h.core)),
  },
  kitchen: {
    label: 'kitchen & dining',
    q: /\bkitchen\b|\bcooking\b|\bcookware\b|\bdining\b|\bserveware\b/,
    p: (h) => ['Kitchen & Home Appliances', 'Kitchen & Dining', 'Cookware', 'Lunch Boxes & Containers'].includes(h.p.subcategory ?? '') || /kitchen|cookware|\bpan\b|kadai|tawa|dining|serving/.test(h.core),
  },
  home: {
    label: 'home & kitchen',
    q: /\bhome\b|\bhousewarming\b/,
    p: (h) => h.p.category.slug === 'home-kitchen' || /home|kitchen/.test(h.core),
  },
  socks: { label: 'socks', q: /\bsocks?\b/, p: (h) => /\bsocks?\b/.test(h.core) },
  footwear: { label: 'shoes', q: /\bshoes?\b|\bsneakers?\b|\bfootwear\b|\bslippers?\b|\bflip ?flops?\b/, p: (h) => /shoe|sneaker|footwear|slipper|flip ?flop/.test(h.core) },
  bottoms: {
    label: 'track pants & shorts',
    q: /\btrack ?pants?\b|\bjoggers?\b|\bshorts\b|\btrousers?\b|\bpants\b/,
    p: (h) => h.p.category.slug === 'apparel' && /track pant|jogger|shorts|trouser|\bpants?\b|bottoms/.test(h.core),
  },
  tshirt: {
    label: 't-shirts & polos',
    q: /\bt-?shirts?\b|\btees?\b|\bpolos?\b|\bpolo t|\bround ?neck\b|\bcollar(ed)? t|\bdri-?fit\b|\bdry-?fit\b/,
    p: (h) => h.p.category.slug === 'apparel' && /t-?shirt|\bpolo\b|\btee\b|crew neck|round neck/.test(h.core),
  },
  cap: { label: 'caps', q: /\bcaps?\b|\bbaseball caps?\b|\bhats?\b/, p: (h) => h.p.category.slug === 'apparel' && /\bcaps?\b|\bhats?\b/.test(h.core) },
  keychain: { label: 'keychains', q: /\bkey ?chains?\b|\bkey ?rings?\b|\bkey ?tags?\b/, p: (h) => /key ?chain|key ?ring/.test(h.core) },
  lanyard: { label: 'lanyards & ID card holders', q: /\blanyards?\b|\bid cards?\b|\bid holders?\b|\bbadge holders?\b/, p: (h) => /lanyard|\bid card|badge holder/.test(h.core) },
  badge: { label: 'name badges & pins', q: /\b(name )?badges?\b(?! holders?)|\blapel pins?\b|\bbadge pins?\b/, p: (h) => h.p.subcategory === 'Name Badges & Pins' || /badge|lapel pin/.test(h.core) },
  umbrella: { label: 'umbrellas', q: /\bumbrellas?\b/, p: (h) => /umbrella/.test(h.core) },
  coaster: { label: 'coasters', q: /\bcoasters?\b/, p: (h) => /coaster/.test(h.core) },
  frame: { label: 'photo frames', q: /\bphoto ?frames?\b|\bframes?\b/, p: (h) => /frame/.test(h.core) },
  trophy: {
    label: 'trophies, awards & mementos',
    q: /\btroph(y|ies)\b|\bmementos?\b|\bmomentos?\b|\bplaques?\b|\bshields?\b|\bmedals?\b|(?<!service |for )\bawards?\b(?! (night|function|ceremony|show|event|gifts?))/,
    p: (h) => /troph|award|memento|plaque|medal/.test(h.core),
  },
  food: {
    label: 'sweets, dry fruits & gourmet hampers',
    q: /\bsweets?\b|\bmithai\b|\bdry ?fruits?\b|\bchocolates?\b|\bcookies\b|\bgourmet\b|\bsnacks?\b|\bnuts\b|\bteas?\b(?! ?shirt)|\bcoffee (hamper|gift|beans|powder)\b|\bfood\b/,
    p: (h) => /sweet|dry ?fruit|chocolate|cookie|gourmet|snack|\btea\b|coffee/.test(h.core) && !/\b(mugs?|cups?|bottles?|flasks?|tumblers?|sippers?|infuser|kettle|jars?|coasters?|tray|maker|pen|t-?shirt)\b/.test(h.p.name.toLowerCase()),
  },
  candle: { label: 'candles & diyas', q: /\bcandles?\b|\bdiyas?\b|\bdiyaas?\b|\blanterns?\b/, p: (h) => /candle|diya|lantern|tea ?light/.test(h.core) },
  incense: { label: 'incense & aroma', q: /\bagarbatti|\bincense\b|\bdhoop\b|\baroma (diffusers?|oils?)\b/, p: (h) => /incense|agarbatti|dhoop|aroma/.test(h.core) },
  fragrance: { label: 'perfumes & fragrances', q: /\bperfumes?\b|\bfragrances?\b|\bdeos?\b|\bdeodorants?\b|\battar\b/, p: (h) => /perfume|fragrance|\bdeo(dorant)?s?\b|eau de|attar/.test(h.core) },
  usb: { label: 'pen drives', q: /\bpen ?drives?\b|\busb drives?\b|\bflash drives?\b/, p: (h) => /pen ?drive|usb drive|flash drive/.test(h.core) },
  computer: {
    label: 'keyboards, mice & laptop accessories',
    q: /\bkeyboards?\b|\bmouse\b(?! ?pads?)|\bmice\b|\bwebcams?\b|\blaptop stands?\b|\busb hubs?\b|\bdocking\b/,
    p: (h) => h.p.category.slug !== 'stationery' && !/highlighter|\bpens?\b/.test(h.core) && /keyboard|\bmouse\b(?! ?pad)|webcam|laptop stand|usb hub|dock/.test(h.core),
  },
  phoneStand: { label: 'mobile stands', q: /\b(mobile|phone) (stands?|holders?)\b/, p: (h) => h.p.subcategory === 'Phone Stands' || /mobile stand|phone stand|tab stand|mobile holder|phone holder/.test(h.core) },
  tech: {
    label: 'tech & gadgets',
    q: /\btech\b|\bgadgets?\b|\belectronics?\b|\belectronic\b|\btechie\b|\bsmart gadgets?\b|\bconsumer durables?\b/,
    p: (h) => h.p.category.slug === 'gadgets-tech' || /tech|gadget/.test(h.core),
  },
};

// Closest substitutes when a kind isn't available.
export const RELATED: Record<string, string[]> = {
  pen: ['stationery', 'desk'], notebook: ['stationery', 'desk'], stationery: ['desk'], desk: ['stationery', 'home'],
  speaker: ['earbuds', 'tech'], earbuds: ['speaker', 'tech'], wearable: ['tech'], power: ['charger', 'cable', 'tech'], cable: ['power', 'charger', 'tech'],
  home: ['desk', 'tech'], tech: ['power', 'desk'], drinkware: ['home', 'desk'], plant: ['desk'],
  hoodie: ['jacket', 'apparel'], jacket: ['hoodie', 'apparel'], socks: ['apparel'], footwear: ['apparel'], bottoms: ['apparel'], calendar: ['stationery', 'desk'],
  lamp: ['home', 'desk'], clock: ['desk', 'home'], fan: ['home', 'tech'], appliance: ['kitchen', 'home'], kitchen: ['appliance', 'home'], grooming: ['tech', 'fitness'], fitness: ['home', 'wearable'], badge: ['lanyard'], shirt: ['apparel'], apparel: ['hoodie', 'jacket', 'shirt'],
  backpack: ['laptopBag', 'bag'], laptopBag: ['backpack', 'sleeve'], sleeve: ['laptopBag', 'pouch'], sling: ['bag'],
  duffle: ['trolley', 'bag'], trolley: ['duffle', 'bag'], luggageAcc: ['wallet', 'pouch'], charger: ['power', 'cable', 'tech'], pouch: ['wallet', 'sleeve'], lunch: ['bag'], tote: ['bag'], bag: ['pouch', 'wallet'], wallet: ['pouch'],
  tshirt: ['shirt', 'hoodie'], cap: ['apparel'], keychain: ['wallet', 'pouch'], lanyard: ['wallet', 'desk'], umbrella: ['bag'],
  coaster: ['drinkware', 'desk'], frame: ['desk', 'home'], trophy: ['desk', 'home'], food: ['drinkware', 'plant'], candle: ['home', 'plant'],
  fragrance: ['pouch', 'wallet'], usb: ['cable', 'power'], computer: ['desk', 'tech'], phoneStand: ['desk'],
};

// Kinds that are a broader version of another; when both are asked we keep the specific one.
const BROADER: Record<string, string[]> = {
  bag: ['backpack', 'laptopBag', 'sleeve', 'sling', 'duffle', 'trolley', 'pouch', 'lunch', 'tote'],
  apparel: ['hoodie', 'jacket', 'shirt', 'tshirt', 'cap', 'socks', 'footwear', 'bottoms'],
  laptopBag: ['sleeve'],
  home: ['lamp', 'clock', 'fan', 'appliance', 'kitchen'],
  kitchen: ['appliance'],
  tech: ['speaker', 'earbuds', 'power', 'charger', 'cable', 'wearable', 'usb', 'computer'],
  desk: ['stationery', 'pen', 'notebook', 'phoneStand', 'computer'],
  shirt: ['tshirt'],
  frame: ['phoneStand'],
  stationery: ['pen', 'notebook', 'calendar'],
};

// Strong head-count words: always a quantity, even after "over"/"above" ("over 100 employees").
const PEOPLE =
  String.raw`(?:people|persons?|pax|employees?|emps?|staff|members?|team ?mates?|colleagues?|hires?|joinees?|joiners?|interns?|clients?|customers?|guests?|attendees?|participants?|delegates?|students?|users?|partners?|vendors?|dealers?|distributors?|retailers?|units?|pcs|pc|pieces?|nos|qty|heads|cxos?|ceos?|cfos?|ctos?|directors?|managers?|executives?|leaders?|vps?|hods?|seniors?|juniors?|freshers?|trainees?|engineers?|developers?|associates?|consultants?|agents?|recipients?|winners?|speakers?|doctors?|teachers?|volunteers?|families|kids|children|women|men|ladies|gents|founders?|investors?|stakeholders?)`;
// Weak count words: a quantity unless the wording says price ("budget 500 gifts" stays a price).
const COUNTABLE =
  String.raw`(?:gifts?|kits?|hampers?|boxes|sets?|items?|bags?|back ?packs?|sleeves?|slings?|pouch(?:es)?|wallets?|mugs?|bottles?|flasks?|t-?shirts?|tees?|shirts?|hoodies?|jackets?|speakers?|ear ?buds?|head ?phones?|power ?banks?|chargers?|cables?|watch(?:es)?|pens?|note ?books?|diar(?:y|ies)|calendars?|planters?|lamps?|clocks?|kettles?|totes?)`;
// Up to two describing words between the number and the noun ("50 new hires", "40 laptop bags").
const FILL = String.raw`(?:(?!(?:for|under|below|each|per|and|to|of|with|in|at|from|within|upto|up|budget|rs|inr)\b)(?!${COUNTABLE}\b)[a-z][a-z-]*\s+){0,2}?`;
const UNITS = String.raw`(?:mah|watts?|volts?|gb|tb|ml|ltrs?|litres?|liters?|gsm|inch(?:es)?|"|cm|mm|kg|gms?|grams?|hrs?|hours?|mins?|minutes?|days?|weeks?|months?|years?|yrs?|pages?|%|st|nd|rd|th|am|pm|jan|january|feb|february|mar|march|apr|april|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)`;

const B = String.raw`(?:^|[^a-z])`;
const MAX_WORDS = new RegExp(B + String.raw`(?:under|below|beneath|less than|lesser than|lower than|cheaper than|not more than|no more than|not exceeding|at most|upto|up to|till|until|within|max|maximum|budget(?: is| of| per gift| per person| per head| per employee| per unit)?(?: around| about| approx| approximately)?|price(?: range)?(?: of)?|priced at|costing|costs?|worth|spend|spending|limit(?: of)?|cap(?: of)?|target(?: price)?(?: of| is)?|price point(?: of)?|rate(?: of| is)?|pricing(?: of)?|cost per (?:pc|piece|unit|head)|at|exgst|ingst|<=?|≤)\s*$`);
const MIN_WORDS = new RegExp(B + String.raw`(?:above|over|more than|greater than|higher than|at least|atleast|min|minimum|starting(?: at| from)?|from|>=?|≥)\s*$`);
const APPROX_WORDS = new RegExp(B + String.raw`(?:around|about|approx|approximately|roughly|near|nearly|~|close to|in the range of|ballpark)\s*$`);
const BUDGET_WORD = /\b(budget|spend|spending)\b/;
const TOTAL_WORDS = /\b(total|overall|altogether|in all|entire|combined|whole|lump ?sum)\b/;
const PER_WORDS = /^\s*(?:each|ea|apiece|pp|per (?:gift|person|head|piece|pc|pcs|nos|no|unit|item|kit|set|box|hamper|employee|guest|client|member|qty)|a (?:gift|piece|head|person|pc)|\/ ?(?:gift|person|head|piece|pc|pcs|nos|no|unit|item|employee|kit|set|box|each))\b/;

/** Materials buyers ask for → what to look for in product text. */
export const MATERIALS: Record<string, { label: string; q: RegExp; p: RegExp }> = {
  leather: { label: 'Leather / PU', q: /\b(genuine |pu |vegan |faux |synthetic )?leather(ette)?\b|\bpu\b/, p: /leather|\bpu\b/ },
  steel: { label: 'Steel / metal', q: /\bstainless\b|\bsteel\b|\bmetal(lic)?\b|\bss\b|\baluminium\b|\baluminum\b/, p: /steel|metal|aluminium|aluminum|\bss\b/ },
  bamboo: { label: 'Bamboo', q: /\bbamboo\b/, p: /bamboo/ },
  cork: { label: 'Cork', q: /\bcork\b/, p: /cork/ },
  jute: { label: 'Jute', q: /\bjute\b/, p: /jute/ },
  cotton: { label: 'Cotton / canvas', q: /\bcotton\b|\bcanvas\b|\bkhadi\b/, p: /cotton|canvas/ },
  wood: { label: 'Wood', q: /\bwood(en)?\b|\bmdf\b|\bteak\b/, p: /wood|mdf|teak/ },
  recycled: { label: 'Recycled', q: /\brecycled\b|\brpet\b|\bupcycled\b/, p: /recycl|rpet|upcycl/ },
  glass: { label: 'Glass', q: /\bglass\b|\bborosilicate\b/, p: /glass|borosilicate/ },
  ceramic: { label: 'Ceramic', q: /\bceramic\b|\bporcelain\b|\bbone china\b/, p: /ceramic|porcelain|bone china/ },
  copper: { label: 'Copper', q: /\bcopper\b|\bbrass\b/, p: /copper|brass/ },
  plantable: { label: 'Plantable / seed paper', q: /\bplantable\b|\bseed paper\b|\bseed\b/, p: /plantable|seed/ },
  plastic: { label: 'Plastic', q: /\bplastic\b|\btritan\b/, p: /plastic|tritan|\bpp\b|\babs\b/ },
  nylon: { label: 'Nylon / polyester', q: /\bnylon\b|\bpolyester\b|\bballistic\b/, p: /nylon|polyester|ballistic/ },
};

/** Branding methods → how we say them. Any of these (or "logo"/"branding") means the gift must be brandable. */
const BRANDING: [RegExp, string][] = [
  [/\blaser( engrav\w*| etch\w*| mark\w*)?\b|\bengrav\w*/, 'laser engraving'],
  [/\bembroider\w*/, 'embroidery'],
  [/\bdeboss\w*/, 'debossing'],
  [/\bemboss\w*/, 'embossing'],
  [/\bscreen ?print\w*/, 'screen printing'],
  [/\bpad ?print\w*/, 'pad printing'],
  [/\buv ?print\w*|\buv\b/, 'UV printing'],
  [/\bdtf\b|\bdirect to film\b/, 'DTF printing'],
  [/\bsublimation\b/, 'sublimation printing'],
  [/\bheat (transfer|press)\b/, 'heat transfer'],
  [/\bdigital print\w*|\bfull colou?r print\w*|\bcmyk\b/, 'full-colour printing'],
  [/\bfoil(ing)?\b|\bhot foil\b/, 'foil stamping'],
  [/\bname personali[sz]\w*|\bindividual names?\b|\bwith (their|each|employee) names?\b/, 'name personalisation'],
  [/\blogo\b|\bbranding\b|\bbranded\b|\bbrand (it|them|with)\b|\bprint(ed|ing)? (our|my|the|company)\b|\bco-?branded\b|\bcustomi[sz](ed|ation)\b/, 'your logo'],
];

/** Gifting brands people ask for by name. If one isn't in the catalogue we say so rather than show look-alikes. */
const BRAND_PHRASES = [
  'american tourister', 'nasher miles', 'f gear', 'da milano', 'tommy hilfiger', 'allen solly', 'peter england', 'louis philippe',
  'van heusen', 'us polo', 'u s polo', 'jack and jones', 'rare rabbit', 'swiss military', 'fire-boltt', 'fire boltt', 'pierre cardin',
  'urban jungle', 'mi band',
];
const KNOWN_BRANDS = new Set(
  ('hp samsonite american nykaa titan casio vip aristocrat parker sheaffer montblanc pierre cardin lamy boat jbl sony bose apple samsung fossil fastrack ' +
    'milton borosil cello wildcraft skybags nike puma adidas reebok fitbit oneplus xiaomi realme portronics ' +
    'ambrane logitech dell lenovo moleskine classmate oblique toreto wenger mokobara safari harissons stuffcool urbn ' +
    'zebronics boult mivi noise amazfit titan sonata hidesign raymond levis chumbak philips eveready mi ' +
    'lavie arrow uspa').split(' '),
);

/** Exact features people ask for. q: in the request; p: in the product (name, description, colours, specs). */
export const ATTRS: Record<string, { label: string; q: RegExp; p: RegExp }> = {
  black: { label: 'black', q: /\bblack\b/, p: /\bblack\b|\bjet\b/ },
  white: { label: 'white', q: /\bwhite\b(?! ?board)/, p: /\bwhite\b|\bivory\b/ },
  red: { label: 'red', q: /\bred\b/, p: /\bred\b|\bscarlet\b|\bcrimson\b/ },
  blue: { label: 'blue', q: /\bblue\b/, p: /\bblue\b|\bnavy\b|\broyal\b|\baqua\b|\bsky\b|\bcobalt\b|\bteal\b/ },
  navy: { label: 'navy', q: /\bnavy\b/, p: /\bnavy\b/ },
  green: { label: 'green', q: /\bgreen\b/, p: /\bgreen\b|\bolive\b|\bmint\b|\bteal\b|\bsage\b/ },
  grey: { label: 'grey', q: /\bgr[ae]y\b/, p: /\bgr[ae]y\b|\bcharcoal\b|\bmelange\b|\bash\b|\bslate\b/ },
  yellow: { label: 'yellow', q: /\byellow\b/, p: /\byellow\b|\bmustard\b/ },
  pink: { label: 'pink', q: /\bpink\b/, p: /\bpink\b|\brose\b|\bpeach\b/ },
  orange: { label: 'orange', q: /\borange\b/, p: /\borange\b|\brust\b/ },
  purple: { label: 'purple', q: /\bpurple\b|\bviolet\b|\blavender\b/, p: /\bpurple\b|\bviolet\b|\blavender\b/ },
  brown: { label: 'brown', q: /\bbrown\b|\btan\b/, p: /\bbrown\b|\btan\b|\bcoffee\b|\bwalnut\b|\bcognac\b/ },
  maroon: { label: 'maroon', q: /\bmaroon\b|\bburgundy\b|\bwine\b/, p: /\bmaroon\b|\bburgundy\b|\bwine\b/ },
  beige: { label: 'beige', q: /\bbeige\b|\bcream\b|\boff.?white\b|\bkhaki\b/, p: /\bbeige\b|\bcream\b|\boff.?white\b|\bkhaki\b|\bsand\b/ },
  silver: { label: 'silver', q: /\bsilver\b/, p: /\bsilver\b|\bchrome\b/ },
  gold: { label: 'gold', q: /\bgold(en)?\b/, p: /\bgold(en)?\b/ },
  kids: { label: "kids'", q: /\bkids?\b|\bchildren\b|\bchild\b|\bschool\b/, p: /\bkids?\b|\bchild|\bjunior\b|\bschool\b|\bbaby\b/ },
  women: { label: "women's", q: /\bwom[ae]n'?s?\b|\bladies\b|\bfemale\b|\bgirls?\b/, p: /\bwom[ae]n|\bladies\b|\blady\b|\bfemale\b|\bgirls?\b/ },
  typec: { label: 'Type-C', q: /\btype ?-?c\b|\busb ?-?c\b/, p: /type ?-?c|usb ?-?c|\bc to c\b|\bc-c\b|\bpd\b/ },
  lightning: { label: 'Lightning (iPhone)', q: /\blightning\b|\biphone cable/, p: /lightning|iphone|\bapple\b/ },
  wireless: { label: 'wireless', q: /\bwireless\b|\bcordless\b/, p: /wireless|cordless|bluetooth|\btws\b|\bqi\b|magsafe/ },
  magsafe: { label: 'MagSafe / magnetic', q: /\bmag ?safe\b|\bmagnetic\b/, p: /mag ?safe|magnetic/ },
  antitheft: { label: 'anti-theft', q: /\banti ?-?theft\b/, p: /anti ?-?theft/ },
  usbport: { label: 'USB charging port', q: /\busb (charging )?port\b|\bwith usb\b|\busb charging\b/, p: /usb (charging )?port|usb charging|\busb\b/ },
  waterproof: { label: 'waterproof', q: /\bwater ?(proof|resistant)\b|\bipx?\d{1,2}\b/, p: /water ?(proof|resistant|repellent)/ },
  rgb: { label: 'RGB', q: /\brgb\b/, p: /\brgb\b/ },
  led: { label: 'LED', q: /\bled\b|\blight ?up\b|\bglow/, p: /\bled\b|light ?up|\bglow|\blight\b/ },
  digital: { label: 'digital', q: /\bdigital\b/, p: /digital|\bled\b|\blcd\b/ },
  smart: { label: 'smart', q: /\bsmart\b/, p: /\bsmart\b|temperature|\bled\b|reminder/ },
  magic: { label: 'magic (colour-changing)', q: /\bmagic\b|\bcolou?r ?changing\b|\bheat ?sensitive\b/, p: /magic|colou?r ?chang|heat ?sensitive/ },
  insulated: { label: 'insulated', q: /\binsulated\b|\bvacuum\b|\bhot (and|&) cold\b|\bthermo/, p: /insulat|vacuum|hot (and|&) cold|\bthermos?\b|thermo ?steel|double ?wall/ },
  lid: { label: 'with lid', q: /\bwith (a )?lid\b|\blidded\b/, p: /\blid\b|lidded/ },
  zip: { label: 'zip', q: /\bzip(per|ped)?\b/, p: /\bzip/ },
  hooded: { label: 'hooded', q: /\bhooded\b|\bwith hood\b/, p: /hood/ },
  roundneck: { label: 'round-neck', q: /\bround ?-?neck\b|\bcrew ?-?neck\b/, p: /round ?-?neck|crew ?-?neck/ },
  drifit: { label: 'dri-fit', q: /\bdr[iy] ?-?fit\b|\bdry ?-?fit\b/, p: /dr[iy] ?-?fit|polyester|performance|quick ?dry/ },
  fullsleeve: { label: 'full-sleeve', q: /\bfull ?-?sleeves?\b|\blong ?-?sleeves?\b/, p: /full ?-?sleeve|long ?-?sleeve/ },
  foldable: { label: 'foldable', q: /\bfold(able|ing)\b|\bcollapsible\b/, p: /fold|collaps/ },
  scented: { label: 'scented', q: /\bscented\b|\bfragran(t|ce)\b|\baroma/, p: /scent|fragran|aroma|essential oil|lavender|jasmine|rose|sandal/ },
  darkc: { label: 'dark-coloured', q: /\bdark (colou?rs?|shades?|tones?|colou?red)\b/, p: /black|navy|maroon|charcoal|\bdark\b|brown|olive|wine|graphite|midnight/ },
  lightc: { label: 'light-coloured', q: /\blight (colou?rs?|shades?|tones?|colou?red)\b|\bpastels?\b/, p: /white|cream|beige|ivory|\bsky\b|\blight\b|pastel|off ?-?white|mint|lavender|peach/ },
  a4: { label: 'A4', q: /\ba4\b/, p: /\ba4\b/ },
  a5: { label: 'A5', q: /\ba5\b/, p: /\ba5\b/ },
  b5: { label: 'B5', q: /\bb5\b/, p: /\bb5\b/ },
  sports: { label: 'sports', q: /\bsports?\b(?! (day|meet|event|week|fest|tournament|function))/, p: /\bsports?\b|\bgym\b|\bsipper\b|\bshaker\b|\bactive\b/ },
  noisecancel: { label: 'noise-cancelling', q: /\bnoise ?-?cancel+(ing|ation)?\b|\banc\b|\benc\b/, p: /noise ?-?cancel|\banc\b|\benc\b/ },
  fastcharge: { label: 'fast charging', q: /\bfast ?-?charg/, p: /fast ?-?charg|\bpd\b|quick ?charg|\b(18|20|22\.5|25|30|45|65) ?w\b/ },
  personalised: { label: 'name-printed', q: /\bwith (their |employee )?names?\b/, p: /./ },
};
const ATTR_KEYS = Object.keys(ATTRS);
const COLOUR_ATTRS = new Set(['black', 'white', 'red', 'blue', 'navy', 'green', 'grey', 'yellow', 'pink', 'orange', 'purple', 'brown', 'maroon', 'beige', 'silver', 'gold', 'darkc', 'lightc']);
/** The test for one wanted feature ("nin1:3" → "3 in 1"). */
export function attrTest(key: string): { label: string; p: RegExp } {
  const m = /^nin1:(\d)$/.exec(key);
  if (m) return { label: `${m[1]}-in-1`, p: new RegExp(`\\b${m[1]} ?-?in ?-?(1|one)\\b`) };
  return ATTRS[key]!;
}

export const STOP = new Set(
  (
    'a an the and or with without for to of in on at by from our my we i us me you your need needs want wants looking look ' +
    'some any good best nice great cool ideas idea options option suggest suggestions recommend show give find get please pls ' +
    'gift gifts gifting gifted corporate company office team people employee employees staff budget price under below above ' +
    'within upto up range rs inr rupees each per around about approx total kit kits something things stuff items item can ' +
    'should would like also more less than between new hire hires day one first who is are be it its this that these those ' +
    'them they their all only just very really much many few lot lots buy order bulk quantity qty units pieces pcs branded ' +
    'brand branding logo custom customised customized personalised personalized print printed occasion event events ' +
    'urgent urgently asap immediately ready stock available availability cheap cheaper cheapest affordable low cost ' +
    'budget-friendly inexpensive premium luxury nos number numbers nahi nai beda except without excluding avoid skip worth tak ka ke ki wala wale wali se kam andar andhar ' +
    'exgst ingst gst tax taxes inclusive exclusive landing landed per pc pcs piece nos unit price rate rates quote quotation ' +
    'rfq enquiry inquiry requirement requirements require required urgent dispatch delivery deliver delivered pan india ' +
    'location locations city cities address addresses mockup mockups artwork sample samples packaging box boxes giftbox ' +
    'customization customisation personalization personalisation method methods engraving engraved laser embroidery ' +
    'embroidered printing screen pad uv dtf sublimation emboss embossed deboss debossed foil colour color colours colors ' +
    'black blue white grey navy brown tan green red maroon olive beige pink purple yellow orange silver gold golden ' +
    'material materials finish size sizes small medium large xl xxl moq minimum maximum min max days day weeks week ' +
    'month months nov dec jan feb mar apr may jun jul aug sep oct by before latest deadline need needed rewards ' +
    'recognition long service engagement giveaway giveaways freebies promotional promo expo exhibition trade show ' +
    'conference event delegate collateral collaterals dealer dealers meet channel distributor distributors retailers ' +
    'liye hai hain ho kuch koi neeche niche upar zyada jyada olage mele beku nice cool classy fancy unique special ' +
    'thoughtful useful lovely awesome amazing decent quality birthday anniversary appreciation farewell reward rewards ' +
    'recognition give send gimme lemme hey hi hello thanks thank yes yeah yep no nope maybe sure okay what which how when ' +
    'where why any anything else other others instead only same similar types type kind kinds sort'
  ).split(' '),
);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Marks a number written as money shorthand ("3k", "1.5 lakh"): it is a price unless a head-count word follows. */
const MONEY = '\uE000';

/** Texting shorthand and Hinglish → plain words the parser knows. Whole words only. */
const SLANG: [RegExp, string][] = [
  [/\b(ppl|ppls|peeps|pple|log|logon|logo ke liye)\b/g, 'people'],
  [/\b(emps|empls|employes|employess|employee's)\b/g, 'employees'],
  [/\b(pls|plz|plss|plzz|pleasee+|plis)\b/g, 'please'],
  [/\b(smthng|smthing|smth|sth|somethin|sumthing|smtg)\b/g, 'something'],
  [/\b(b'?day|bdy|bday)\b/g, 'birthday'],
  [/\b(abt|abut|abt\.)\b/g, 'about'],
  [/\b(b\/w|bw|btwn|betwn|bet)\b(?=\s*(?:₹|rs|\d))/g, 'between'],
  [/\b(frm|fr)\b(?=\s*(?:₹|rs|\d))/g, 'from'],
  [/\b(undr|unde|undar|blw|belw|bellow)\b/g, 'under'],
  [/\b(abv|abov|abve)\b/g, 'above'],
  [/\b(budgt|budjet|bugdet|buget|budge)\b/g, 'budget'],
  [/\b(aprox|approxx|apprx|appx)\b/g, 'approx'],
  [/\b(upto|up2|upt)\b/g, 'upto'],
  [/\b(less den|less thn|lesser than|less then)\b/g, 'less than'],
  [/\b(more thn|more den|more then)\b/g, 'more than'],
  [/\b(giftz|gifs|giftss|gfts)\b/g, 'gifts'],
  [/\b(tshirts?|t shirts?|tees)\b/g, 't-shirts'],
  [/\b(w\/|wid|wit)\b(?!\s*\d)/g, 'with'],
  [/\b(u)\b/g, 'you'],
  [/\b(ur)\b/g, 'your'],
  [/\b(r)\b(?!\s*\d)/g, 'are'],
  [/\b(n)\b(?=\s+[a-z₹\d])/g, 'and'],
  [/\s&\s/g, ' and '],
  [/\b(chahiye|chaiye|chaahiye|bekagide|beku)\b/g, 'need'],
  [/\b(thx|thnx|thnks|tnx|tq|ty|tysm)\b/g, 'thanks'],
  [/\b(gud|gd)\b/g, 'good'],
  [/\b(gr8)\b/g, 'great'],
  [/\b(qty\.?|qnty|quantity|quantities)\b/g, 'qty'],
  [/\bsweat ?shirts?\b/g, 'sweatshirt'],
  [/\b(nos\.|no\.s|numbers)\b/g, 'nos'],
  [/\b(pcs\.|pc\.|pieces)\b/g, 'pcs'],
  [/\b(r ?& ?r|rnr)\b/g, 'rewards and recognition'],
  [/\b(w\/o)\b/g, 'without'],
  [/\b(incl|inc|excl|ex)\.(?=\s)/g, '$1'],
  [/\bstationary\b/g, 'stationery'],
  [/\b(hoody)\b/g, 'hoodie'],
  [/\b(bagpack|back pack|bag pack)s?\b/g, 'backpack'],
  [/\b(bottel|botle|bottal)s?\b/g, 'bottle'],
  [/\b(dairy|diery)s?\b(?! (milk|products?|farm))/g, 'diary'],
  [/\b(hamper|humper)s?\b/g, 'hampers'],
  [/\b(powerbank|power-bank)s?\b/g, 'power bank'],
  [/\b(earbud|ear-buds?|airpods?)\b/g, 'earbuds'],
  [/\b(speeker|spkr)s?\b/g, 'speaker'],
];

/** GST wording → one marker each, so a number next to it is read as a price. */
const GST_EXCL = /\+\s*gst|\+\s*18\s*%|\bplus (18 ?% )?gst\b|\bex[- ]?gst\b|\bexcl?(uding|usive)?\.?\s*(of\s*)?(gst|tax(es)?)\b|\bwithout (gst|tax(es)?)\b|\bbefore (gst|tax(es)?)\b|\bpre[- ]?gst\b|\bgst (extra|additional|excluded)\b|\bbasic (price|cost)\b/g;
const GST_INCL = /\bincl?(uding|usive)?\.?\s*(of\s*)?(gst|tax(es)?|all( taxes)?|everything)\b|\ball[- ]inclusive\b|\bwith gst\b|\bafter gst\b|\bgst included\b|\blanding( cost| price)?\b|\blanded( cost| price)?\b|\bfinal (price|cost)\b/g;

/** "10000 mAh" → "10000mah", "1 litre" → "1000ml", '15.6"' → "15.6in" — so request and product text compare equal. */
export function specKey(n: string, unit: string): string {
  const u = unit.toLowerCase();
  if (/^(l|ltrs?|litres?|liters?)$/.test(u)) return `${Math.round(Number(n) * 1000)}ml`;
  if (/^(inch(es)?|")$/.test(u)) return `${Number(n)}in`;
  if (/^watts?$/.test(u)) return `${Number(n)}w`;
  return `${Number(n)}${u}`;
}

const UNIT_N: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS_N: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const MULT_N: Record<string, number> = { hundred: 100, thousand: 1000, lakh: 100000, lakhs: 100000 };
/** "five hundred" → 500, "two thousand" → 2000, "fifty people" → 50. A lone "one" ("this one") stays a word. */
function wordsToNumbers(t: string): string {
  const re = /\b((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakhs?|and|a)[\s-]+)*(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakhs?))\b/g;
  return t.replace(re, (m, _g, off: number, all: string) => {
    if (/\d[\s.]*$/.test(all.slice(0, off))) return m; // "1 lakh", "2.5 thousand": handled with the digits
    const words = m.split(/[\s-]+/).filter((w) => w !== 'and');
    if (words[0] === 'a') words.shift();
    if (!words.length || words.includes('a')) return m;
    const hasBig = words.some((w) => MULT_N[w] || TENS_N[w]);
    const after = all.slice(off + m.length, off + m.length + 25);
    const countish = /^\s*(people|persons|employees|members|pcs|pieces|units|nos|rupees|rs|gifts|bottles|mugs|bags|items|kits|staff|guests|clients)\b/.test(after);
    if (!hasBig && !(countish && words.length === 1 && words[0] !== 'one')) return m;
    let total = 0, cur = 0;
    for (const w of words) {
      if (UNIT_N[w] !== undefined) cur += UNIT_N[w]!;
      else if (TENS_N[w] !== undefined) cur += TENS_N[w]!;
      else if (w === 'hundred') cur = (cur || 1) * 100;
      else if (MULT_N[w]) { total += (cur || 1) * MULT_N[w]!; cur = 0; }
    }
    return String(total + cur);
  });
}

/** A few common Hindi and Kannada words typed in their own script. */
const SCRIPT_WORDS: [RegExp, string][] = [
  [/बोतल|ಬಾಟಲ್|ಬಾಟಲಿ/g, ' bottle '], [/उपहार|गिफ्ट|तोहफ़?ा|ಉಡುಗೊರೆ|ಗಿಫ್ಟ್/g, ' gift '], [/बैग|थैला|ಬ್ಯಾಗ್/g, ' bag '], [/मग|ಮಗ್/g, ' mug '], [/पेन|ಪೆನ್/g, ' pen '],
  [/डायरी|ಡೈರಿ/g, ' diary '], [/टी-?शर्ट|ಟಿ-?ಶರ್ಟ್/g, ' tshirt '], [/घड़ी|ಗಡಿಯಾರ/g, ' clock '], [/के अंदर|से कम|ಒಳಗೆ/g, ' ke andar '], [/रुपये|रुपए|ರೂಪಾಯಿ/g, ' rupees '], [/लोग|लोगों|ಜನ/g, ' people '],
];
export function normalise(text: string): string {
  for (const [re, to] of SCRIPT_WORDS) text = text.replace(re, to);
  let t = ` ${text.toLowerCase().replace(/[\u2018\u2019]/g, "'")} `;
  t = t.replace(/(\d+(?:\.\d+)?)\s*(thousand|hundred)\b/g, (_m, n: string, u: string) => String(Math.round(Number(n) * (u === 'thousand' ? 1000 : 100))));
  t = wordsToNumbers(t);
  t = t.replace(/\bx\s?(\d+)\b(?!\s*(?:ml|l|gb|mah|w)\b)/g, ' $1 pcs '); // "bottles x100"
  for (const [re, to] of SLANG) t = t.replace(re, to);
  t = t.replace(GST_EXCL, ' exgst ').replace(GST_INCL, ' ingst ');
  t = t.replace(/@/g, ' at ').replace(/[:=]/g, ' ');
  t = t.replace(/([a-z])\s*\+\s*(?=[a-z])/g, '$1 and '); // "bottle + diary"
  t = t.replace(/\b(\d+)\s*(?:x|×)\s*(?=[a-z])/g, '$1 x '); // "200x bottles"

  t = t.replace(/[‒-―−]/g, '-'); // dashes
  t = t.replace(/(\d),(?=\d)/g, '$1'); // 1,500 / 1,00,000
  t = t.replace(/₹/g, ' ₹ ');
  t = t.replace(/\brs\.?(?=\s|\d)/g, ' rs ');
  t = t.replace(/\/-/g, ' rs ');
  t = t.replace(/\b(rupees?|bucks)\b/g, ' rs ');
  const litreCtx = /\b(bags?|backpacks?|duffle|duffel|trolley|luggage|bottles?|flasks?|sippers?|tumblers?|jars?|capacity|litres?|liters?)\b/.test(t);
  t = t.replace(/(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|lac|l)\b(?!\s*(?:itre|iter|tr))/g, (_m, n: string, u: string) =>
    u === 'l' && litreCtx && Number(n) <= 100 ? ` ${n} litres ` : ` ${Math.round(Number(n) * 100000)}${MONEY} `);
  t = t.replace(/(\d+(?:\.\d+)?)\s*k\b/g, (_m, n: string) => ` ${Math.round(Number(n) * 1000)}${MONEY} `);
  t = t.replace(/(\d\uE000?)\s*-\s*(\d)/g, '$1 - $2');
  return t.replace(/\s+/g, ' ');
}

interface Num {
  value: number;
  start: number;
  end: number;
}

type Role = 'price' | 'qty' | 'ignore' | 'bare';
type Dir = 'max' | 'min' | 'approx';

interface Cls {
  role: Role;
  dir: Dir;
  /** The user called it a budget/spend or gave no direction word (not "under"/"above"). */
  budgetish: boolean;
  /** A head count that also had a price word ("around 1200 clients"): a price if another number is the head count. */
  priceAlt?: boolean;
  /** A price that is followed by a word like "clients" ("over 100 clients"): a head count if another number is the price. */
  qtyAlt?: boolean;
}

/** A head-count word follows. "1200 qty 250": the label belongs to the next number, not this one. */
function peopleFollow(rightRaw: string, words = PEOPLE): boolean {
  const right = rightRaw.replace(/^\uE000/, '');
  if (/^\s*(?:qty|quantity|pcs|nos|units?)\s*[:=-]?\s*\d/.test(right)) return false;
  return new RegExp(String.raw`^\s*\+?\s*${FILL}${words}\b`).test(right);
}
// Words that can only be a head count ("clients"/"partners" can also describe the gift, as in "2000 client gifts").
const HEADS = String.raw`(?:people|persons?|pax|employees?|emps?|staff|members?|team ?mates?|colleagues?|hires?|joinees?|joiners?|interns?|guests?|attendees?|participants?|delegates?|students?|users?|units?|pcs|pc|pieces?|nos|qty|heads|cxos?|ceos?|cfos?|ctos?|directors?|managers?|executives?|leaders?|vps?|hods?|seniors?|juniors?|freshers?|trainees?|engineers?|developers?|associates?|consultants?|agents?|recipients?|winners?|doctors?|teachers?|volunteers?|families|kids|children|women|men|ladies|gents|founders?)`;

const RIGHT_MAX = /^\s*(?:tak|tk|ke andar|ke andhar|ke neeche|ke niche|se kam|se neeche|olage|ond olage|or less|or below|and below|and under|max|maximum|only|at most|worth|ka|ke|ki|wala|wale|wali|range)\b/;
const RIGHT_MIN = /^\s*(?:se upar|se zyada|se jyada|ke upar|mele|melle|or more|or above|and above|plus|onwards|upwards|minimum|min)\b/;

function classify(t: string, n: Num): Cls {
  const left = t.slice(Math.max(0, n.start - 40), n.start);
  const rawRight = t.slice(n.end, n.end + 41);
  const money = rawRight.startsWith(MONEY);
  const right = money ? rawRight.slice(1) : rawRight;
  const leftCur = /(?:₹|\brs|\binr)\s*$/.test(left) && !/\d\s*(?:\brs|\binr)\s*$/.test(left); // "300 rs 50 people": the rs belongs to 300 (₹ is always a prefix)
  const rightCur = /^\s*(?:\brs|\binr)\b(?!\s*[₹\d])/.test(right) || /^\s*(?:exgst|ingst)\b(?!\s*(?:₹|\brs|\binr)?\s*\d)/.test(right); // in "120 landing 650" it belongs to 650 // "500 rs" — but in "40 rs 750" the rs belongs to 750
  const l = left.replace(/(?:₹|\brs|\binr)\s*$/, '');
  const isMax = MAX_WORDS.test(l);
  const isMin = MIN_WORDS.test(l);
  const isApprox = APPROX_WORDS.test(l);
  const dir: Dir = isApprox ? 'approx' : isMax ? 'max' : isMin ? 'min' : 'max'; // "not more than" is a max
  const priceWord = isMax || isMin || isApprox;
  const budgetish = BUDGET_WORD.test(left.slice(-25)) || BUDGET_WORD.test(right.slice(0, 12)) || !priceWord;
  const res = (role: Role, d: Dir = dir): Cls => ({ role, dir: d, budgetish });

  if (money && !peopleFollow(right, HEADS)) return res('price', RIGHT_MIN.test(right) || /^\s*\+/.test(right) ? 'min' : dir);
  if (!money && !leftCur && !rightCur && (new RegExp(String.raw`^\s*${UNITS}(?![a-z])`).test(right) || /^(?:w|v|g|l|kg)(?![a-z])/.test(right))) return res('ignore');
  if (!leftCur && !rightCur && n.value >= 1e9) return res('ignore'); // phone numbers
  // "per piece 300", "each 450": a price per gift
  if (/\bper (piece|gift|head|person|unit|pc|kit|item)\s*(?:₹|\brs|\binr)?\s*$/.test(left) && !/\d\s*(?:\S+\s*)?per (piece|gift|head|person|unit|pc|kit|item)\s*$/.test(left)) return res('price');
  // "top 5 gifts", "show 3": how many to show, not a budget or a head count
  if (!money && !leftCur && !rightCur && n.value <= 20 && /\b(top|best|show|first|show me|give me|only)\s*$/.test(l)) return res('ignore');
  if (leftCur || rightCur || PER_WORDS.test(right) || /^\s*(?:budget|price|range)\b(?!\s*(?:is|of|:|=)?\s*(?:₹|\brs|\binr)?\s*\d)/.test(right)) {
    // "₹500+" means "from ₹500"
    const plus = /^\s*(?:\brs|\binr)?\s*\+/.test(right);
    return res('price', plus ? 'min' : dir);
  }
  if (peopleFollow(right, HEADS)) return { ...res('qty'), priceAlt: priceWord };
  if (new RegExp(B + String.raw`(?:qty|quantity|team of|group of|batch of|count of|strength of|head ?count(?: of)?|x|×)\s*(?:is|of|-|–)?\s*$`).test(left)) return res('qty');
  if (RIGHT_MIN.test(right) && !peopleFollow(right)) return res('price', 'min');
  if (RIGHT_MAX.test(right) && !peopleFollow(right)) return res('price', 'max');
  // "budget 2000 client gifts": a budget word right before the number wins over a following noun.
  if (/(?:^|[^a-z])(?:budget(?: is| of)?|price(?: of)?|priced at|costing|costs?|spend|spending|worth)\s*:?\s*$/.test(l)) return res('price');
  // "under 500 client gifts" is a price; "over 100 employees" / "around 100 people" are head counts.
  if (priceWord) return { ...res('price'), qtyAlt: peopleFollow(right) };
  // "50 hoodies and 50 caps": a number right before a product word is how many
  if (!leftCur && !rightCur && Object.values(KINDS).some((k) => { const m = right.slice(0, 30).match(k.q); return !!m && (m.index ?? 9) <= 1; })) return res('qty');
  if (peopleFollow(right)) return res('qty');
  if (priceWord) return res('price');
  if (new RegExp(String.raw`^\s*\+?\s*${FILL}${COUNTABLE}\b`).test(right)) return res('qty');
  if (/^\s*(?:x|×)(?![a-z])(?!\s*\d)/.test(right)) return res('qty'); // "100 x" (but not "1000 x 10")
  if (n.value >= 2020 && n.value <= 2099 && /(?:diwali|christmas|new year|year|fy|in|of|for|by|this|next)\s*$/.test(left)) return res('ignore');
  return res('bare');
}

export function parseRequest(text: string): ParsedRequest {
  const t = normalise(text.slice(0, 500));
  const nums: Num[] = [];
  // "3 in 1 cable" is a product feature, not a budget or a quantity.
  const nin1 = [...t.matchAll(/\b\d ?-?in ?-?(1|one)\b/g)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const);
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
    const i = m.index ?? 0;
    if (nin1.some(([a, b]) => i >= a && i < b)) continue;
    // "ipx7", "v5", "bluetooth 5.0", "usb 3.0", "gen 2": a model or version, not a number of anything
    if (/[a-z]$/.test(t.slice(Math.max(0, i - 1), i)) && !/(?:rs|inr|(?:^|\s)x|under|below|upto|above|over|max|min|budget|around|for|of|is|qty|pcs|nos)$/.test(t.slice(Math.max(0, i - 6), i)) && !/^[ab]$/.test(t[i - 1] ?? '')) continue;
    if (/\b(bluetooth|bt|version|ver|usb|gen|generation|wifi|wi-fi|android|ios)\s*$/.test(t.slice(Math.max(0, i - 12), i)) && Number(m[0]) < 20) continue;
    // "A4 notebook", "B5 diary": a paper size. "diary 2027", "calendar for 2027": a year.
    if (/[a-z]$/.test(t.slice(Math.max(0, i - 1), i)) && /^[ab]$/.test(t[i - 1] ?? '') && /^\d$/.test(m[0]) && !/[a-z]/.test(t[i - 2] ?? '')) continue;
    if (/^20[2-3]\d$/.test(m[0]) && /\b(diar(y|ies)|calend[ae]rs?|planners?|year|new year|organi[sz]ers?|edition|batch|class|fy)\b/.test(t) && !/(₹|rs\.?|inr|budget|under|below|upto|up to|around|within|max)\s*$/.test(t.slice(Math.max(0, i - 12), i))) continue;
    nums.push({ value: Number(m[0]), start: i, end: i + m[0].length });
  }

  let minPrice = 0;
  let maxPrice = Number.POSITIVE_INFINITY;
  let quantity: number | null = null;
  let totalBudget: number | null = null;
  let approx: number | null = null;
  const prices: { value: number; dir: Dir; total: boolean; budgetish: boolean }[] = [];
  const bare: number[] = [];
  const used = new Set<number>();

  // Ranges first: "between 500 and 1000", "500-1000", "₹500 to ₹1000", "50-100 people".
  for (let i = 0; i < nums.length - 1; i++) {
    const a = nums[i]!;
    const b = nums[i + 1]!;
    if (used.has(i)) continue; // "400-900-50 people": 900 already belongs to a range
    const gap = t.slice(a.end, b.start);
    if (!/^\uE000?\s*(?:₹|\brs|\binr)?\s*(?:-|to|and)\s*(?:₹|\brs|\binr)?\s*$/.test(gap)) continue;
    if (/^\uE000?\s*(?:₹|\brs|\binr)?\s*and\s*(?:₹|\brs|\binr)?\s*$/.test(gap) && !/between\s*(?:₹|\brs|\binr)?\s*$/.test(t.slice(0, a.start))) continue;
    if (a.value >= b.value) continue; // ranges go low → high; "500 - 100 people" is two separate numbers
    const cb = classify(t, b);
    const ca = classify(t, a);
    if (cb.role === 'ignore' || ca.role === 'ignore' || ca.role === 'qty') continue;
    // Only a head count word makes a range a quantity ("50-100 people"); "500-1000 wallets" is a price range.
    const peopleAfter = peopleFollow(t.slice(b.end, b.end + 40), HEADS);
    // "650 - 1k pcs": a price, then a quantity. Not a range.
    if (peopleAfter && ca.role === 'price') continue;
    used.add(i).add(i + 1);
    if (peopleAfter && ca.role !== 'price') {
      quantity = Math.max(a.value, b.value);
    } else {
      const lo = Math.min(a.value, b.value);
      const hi = Math.max(a.value, b.value);
      prices.push({ value: lo, dir: 'min', total: false, budgetish: false }, { value: hi, dir: 'max', total: false, budgetish: false });
    }
  }

  const cls = nums.map((n, i) => (used.has(i) ? null : classify(t, n)));
  const firmQty = nums.find((_n, i) => cls[i]?.role === 'qty' && !cls[i]?.priceAlt);
  if (quantity === null && firmQty) quantity = firmQty.value;
  nums.forEach((n, i) => {
    const c = cls[i];
    if (!c || c.role === 'ignore') return;
    if (c.role === 'qty') {
      if (quantity === null) quantity = n.value;
      else if (c.priceAlt && n !== firmQty && quantity !== n.value) {
        const ctx = t.slice(Math.max(0, n.start - 30), n.end + 15);
        prices.push({ value: n.value, dir: c.dir, total: TOTAL_WORDS.test(ctx) && !/\bper (kit|gift|person|head|employee|hamper|box|set|piece|pack)\b/.test(ctx), budgetish: c.budgetish });
      }
      return;
    }
    if (c.role === 'price' && c.qtyAlt && quantity === null && cls.some((o, j) => j !== i && o?.role === 'price')) {
      quantity = n.value;
      return;
    }
    if (c.role === 'price') {
      const ctx = t.slice(Math.max(0, n.start - 30), n.end + 15);
      prices.push({ value: n.value, dir: c.dir, total: TOTAL_WORDS.test(ctx) && !/\bper (kit|gift|person|head|employee|hamper|box|set|piece|pack)\b/.test(ctx), budgetish: c.budgetish });
      return;
    }
    bare.push(n.value);
  });

  // A bare number gets the role that is still missing, but only when exactly one is missing.
  const ambiguous: number[] = [];
  if (bare.length === 1) {
    if (prices.length && quantity === null) quantity = bare[0]!;
    else if (!prices.length && quantity !== null) prices.push({ value: bare[0]!, dir: 'max', total: false, budgetish: true });
    else ambiguous.push(bare[0]!);
  } else if (bare.length > 1) {
    ambiguous.push(...bare);
  }

  // A big amount next to a head count, without "each"/"per", is a total budget ("1 lakh for 100 people").
  for (const p of prices) {
    if (!p.total && p.budgetish && quantity !== null && p.dir !== 'min' && p.value >= 20000 && p.value / quantity >= 10 && !/\b(each|per)\b/.test(t)) p.total = true;
  }

  for (const p of prices) {
    if (p.total) {
      totalBudget = p.value;
      continue;
    }
    if (p.dir === 'min') minPrice = Math.max(minPrice, p.value);
    else if (p.dir === 'approx') {
      approx = p.value;
      minPrice = Math.max(minPrice, Math.round(p.value * 0.7));
      maxPrice = Math.min(maxPrice, Math.round(p.value * 1.15));
    } else maxPrice = Math.min(maxPrice, p.value);
  }
  if (totalBudget !== null && quantity) maxPrice = Math.min(maxPrice, Math.floor(totalBudget / Math.max(quantity, 1)));
  if (minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];
  if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0)) quantity = null;
  if (quantity !== null) quantity = Math.min(Math.round(quantity), 1_000_000);

  const collections = OCCASIONS.filter((o) => o.re.test(t)).map((o) => o.slug);
  // "no bags", "except mugs", "without apparel", "not speakers"
  const negated = new Set<string>();
  const negSegs: string[] = [];
  let tpos = t; // the request with the "no …" parts taken out: what is actually wanted
  for (const m of t.matchAll(/\b(?:no|not|without|except|excluding|exclude|other than|apart from|dont want|don't want|do not want|skip|avoid|remove|drop|minus|hide|take out|get rid of|no more|leave out|nahi|beda)\s+(?:the\s+|all\s+|any\s+)?((?:[a-z-]+\s*){1,3})/g)) {
    // Stop at the next clause: "no mugs, show bottles" negates mugs only.
    const words = m[1]!.trim().split(/\s+/);
    const stop = words.findIndex((w) => /^(show|but|and|instead|only|give|need|want|please|pls|under|below|above|upto|for|in|with|rather|just|then|send|suggest)$/.test(w));
    let seg = ` ${(stop >= 0 ? words.slice(0, stop) : words).join(' ')} `;
    if (!seg.trim()) continue;
    const head = ` ${words[0]} `;
    if (words.length > 1 && (Object.values(MATERIALS).some((mm) => mm.q.test(head)) || ATTR_KEYS.some((k) => ATTRS[k]!.q.test(head)))) {
      negSegs.push(head);
      tpos = tpos.replace(m[0], ` ${words.slice(1).join(' ')} `);
      continue;
    }
    negSegs.push(seg);
    tpos = tpos.replace(m[0], ` ${stop >= 0 ? words.slice(stop).join(' ') : ''} `);
    for (const [key, k] of Object.entries(KINDS)) if (k.q.test(seg)) negated.add(key);
  }
  tpos = ` ${tpos.replace(/\s+/g, ' ').trim()} `;
  // "no mugs, show bottles": both are drinkware, so keep the kind and leave out only mugs.
  const notNouns = new Set<string>();
  for (const seg of negSegs) for (const [n, f] of Object.entries(FOCUS)) if (f.q.test(seg)) notNouns.add(n);
  for (const key of [...negated]) if (KINDS[key]!.q.test(tpos)) negated.delete(key);
  // "not bluetooth", "without lid": features to leave out
  const notMaterials = Object.entries(MATERIALS).filter(([, mm]) => negSegs.some((seg) => mm.q.test(seg))).map(([k]) => k);
  const notAttrs = ATTR_KEYS.filter((k) => k !== 'personalised' && negSegs.some((seg) => ATTRS[k]!.q.test(seg.replace(/\bbluetooth\b/, 'wireless')) || ATTRS[k]!.q.test(` with${seg}`)));
  // Hinglish/Kannada put the "no" after the noun: "bags nahi", "bags beda"
  for (const m of t.matchAll(/((?:[a-z-]+\s+){1,2})(?:nahi|nai|beda|not needed|no need)\b/g)) {
    for (const [key, k] of Object.entries(KINDS)) if (k.q.test(` ${m[1]} `)) negated.add(key);
  }
  // A brand name isn't a product word: "US Polo shirts" asks for shirts, not polos.
  const tk = BRAND_PHRASES.reduce((acc, b) => acc.replace(` ${b} `, ' '), tpos);
  let kinds = Object.entries(KINDS)
    .filter(([key, k]) => k.q.test(tk) && !negated.has(key))
    .map(([key]) => key);
  for (const [broad, narrow] of Object.entries(BROADER)) {
    if (kinds.includes(broad) && narrow.some((n) => kinds.includes(n))) kinds = kinds.filter((k) => k !== broad);
  }

  const stockOnly = /\b(in stock|ready stock|ready to ship|ready to dispatch|ex[- ]?stock|off the shelf|available now|immediate(ly)?|urgent(ly)?|asap|this week|tomorrow)\b/.test(t);
  const gst = /\bingst\b/.test(t) ? 'incl' : /\bexgst\b/.test(t) ? 'excl' : null;
  const materials = Object.entries(MATERIALS)
    .filter(([, m]) => m.q.test(tpos))
    .map(([k]) => k);
  const brandingHit = BRANDING.find(([re]) => re.test(t));
  const branding = brandingHit ? brandingHit[1] : null;
  const brands = [
    ...BRAND_PHRASES.filter((b) => t.includes(` ${b} `)),
    ...[...KNOWN_BRANDS].filter((b) => new RegExp(`\\b${b}\\b`).test(t) && !BRAND_PHRASES.some((p) => p.split(' ').includes(b) && t.includes(` ${p} `))),
  ];
  const specs = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(mah|ml|ltrs?|litres?|liters?|gsm|inch(?:es)?|"|w|watts?|gb|tb)\b/g)].map((m) => specKey(m[1]!, m[2]!));
  const dl = t.match(/\b(?:by|before|within|in|latest by|deadline|delivery by|delivered by|needed by|need (?:it|them) by|required by|dispatch by)\s+(\d+\s*(?:working\s+)?(?:days?|weeks?)|(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?(?:\s*(?:of\s*)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*)?|next week|this week|month[- ]end|end of (?:the )?month|tomorrow|diwali|christmas|new year)\b/);
  const deadline = dl && /\d|week|month|tomorrow|diwali|christmas|new year/.test(dl[1] ?? '') && (/\b(days?|weeks?|week|month|tomorrow|diwali|christmas|new year|st|nd|rd|th|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(dl[1] ?? '')) ? dl[0].trim().replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)([a-z]*)\b/, (m) => m[0]!.toUpperCase() + m.slice(1)) : null;
  const purpose = /\brewards and recognition\b|\blong service\b|\bwork anniversar|\bservice award|\bemployee engagement\b|\bappreciation\b|\bemployee of the (month|year)\b/.test(t)
    ? 'Rewards & recognition'
    : /\bfarewell\b|\bretire(ment|ing)?\b|\bsend ?off\b|\bleaving (gift|present)\b/.test(t)
    ? 'Farewell & retirement'
    : /\bbirthdays?\b|\bbday\b|\banniversar(y|ies)\b|\bteachers'? day\b|\bdoctors'? day\b|\bwomen'?s day\b|\bmothers'? day\b|\bfathers'? day\b|\bcelebrations?\b|\bwedding\b|\breturn gifts?\b/.test(t)
    ? 'Celebrations'
    : /\bgiveaways?\b|\bfreebies?\b|\bmerch(andise)?\b|\bswag\b|\bpromotional\b|\bpromo\b|\btrade ?show\b|\bexpo\b|\bexhibition\b|\bconference\b|\bevent kits?\b|\bdelegate kits?\b|\bcollaterals?\b/.test(t)
      ? 'Events & giveaways'
      : /\bdealer meet\b|\bchannel partners?\b|\bdistributors?\b|\bdealers?\b|\bretailers?\b/.test(t)
        ? 'Dealer & partner gifts'
        : null;
  const prefer = /\b(most expensive|costliest|priciest|highest price|top end|high end|top of the range)\b/.test(t) ? 'high' : /\b(sasta|sasti|saste|kam daam|cheap|cheaper|cheapest|affordable|low cost|low-cost|budget-friendly|budget friendly|inexpensive|economical|value for money)\b/.test(t) || (purpose === 'Events & giveaways' && maxPrice === Infinity && minPrice === 0) ? 'low' : null;

  const terms = [...new Set(tpos.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/))].filter(
    (w) =>
      w.length >= 3 &&
      !/^\d/.test(w) &&
      !STOP.has(w) &&
      !FILLER.has(w) &&
      !(w === 'sports' && /\bsports (day|meet|event|week|fest|tournament|function)\b/.test(t)) &&
      !OCCASIONS.some((o) => o.re.test(` ${w} `)) &&
      !Object.values(KINDS).some((k) => k.q.test(` ${w} `)) &&
      !new RegExp(String.raw`^${PEOPLE}$`).test(w) &&
      !Object.values(MATERIALS).some((m) => m.q.test(` ${w} `)) &&
      !BRANDING.some(([re]) => re.test(` ${w} `)),
  );

  // "office bag", "office backpack": a bag for the office, not desk items.
  if (kinds.includes('desk') && kinds.length > 1 && /\boffice (bags?|backpacks?|laptop bags?|sling)\b/.test(t)) kinds.splice(kinds.indexOf('desk'), 1);
  // "desk lamp", "desk clock": the desk word describes the product, it isn't a second kind.
  if (kinds.includes('desk') && kinds.length > 1 && /\b(desk|table) (lamps?|lights?|clocks?|organi[sz]ers?|fans?|calendars?|mats?|pads?|chargers?|speakers?)\b/.test(t)) kinds.splice(kinds.indexOf('desk'), 1);
  const attrs = ATTR_KEYS.filter((k) => k !== 'personalised' && ATTRS[k]!.q.test(tpos));
  for (const m of t.matchAll(/\b(\d) ?-?in ?-?(1|one)\b/g)) attrs.push(`nin1:${m[1]}`);
  // "navy" is a kind of blue: keep the narrower one.
  if (attrs.includes('navy')) attrs.splice(attrs.indexOf('blue'), attrs.includes('blue') ? 1 : 0);

  let nouns = Object.entries(FOCUS).filter(([n, f]) => f.q.test(tk) && !notNouns.has(n)).map(([k]) => k);
  for (const [narrow, broad] of Object.entries(NARROWER)) if (nouns.includes(narrow)) nouns = nouns.filter((n) => !broad.includes(n));

  return {
    minPrice, maxPrice, quantity, totalBudget, approx, collections, kinds, notKinds: [...negated], terms, stockOnly, prefer, ambiguous,
    gst, materials, branding, brands: [...new Set(brands)], specs: [...new Set(specs)], deadline, purpose, nouns, attrs: [...new Set(attrs)],
    notNouns: [...notNouns].filter((n) => !nouns.includes(n)), notAttrs, notMaterials,
  };
}

/** Apply the user's answer to "is 500 the budget or the quantity?". */
export function resolveAmbiguity(q: ParsedRequest, role: 'price' | 'qty'): ParsedRequest {
  const [first, second] = q.ambiguous;
  if (first === undefined) return q;
  const r: ParsedRequest = { ...q, ambiguous: [] };
  const setPrice = (v: number) => {
    r.maxPrice = Math.min(r.maxPrice, v);
    if (r.minPrice > r.maxPrice) r.minPrice = 0;
  };
  if (role === 'price') {
    setPrice(first);
    if (second !== undefined && r.quantity === null) r.quantity = second;
  } else {
    r.quantity = first;
    if (second !== undefined && r.maxPrice === Infinity) setPrice(second);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Recommending
// ---------------------------------------------------------------------------

export interface Recommendation {
  picks: CatalogueProduct[];
  /** Plain-language notes on anything we relaxed or could not find. */
  notes: string[];
  /** A follow-up request worth offering, e.g. a higher budget. */
  suggestion: { label: string; query: ParsedRequest } | null;
  /** How many products matched before we trimmed to `limit`. */
  matched: number;
  /** True when what was asked isn't available and `picks` are the closest alternatives. */
  alternative: boolean;
}

/** Unique notes, with the "Sorry…" ones first so what's missing is read before the details. */
const dedupe = (xs: string[]) => {
  const u = [...new Set(xs)];
  return [...u.filter((x) => x.startsWith('Sorry')), ...u.filter((x) => !x.startsWith('Sorry'))];
};
const inrN = (n: number) => '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));

function hay(p: CatalogueProduct): Hay {
  const core = ` ${p.name} ${p.subcategory ?? ''} ${p.category.name} `.toLowerCase();
  const full = `${core} ${p.brand ?? ''} ${p.description ?? ''} ${(p.features ?? []).join(' ')} ${Object.values(p.specs ?? {}).join(' ')} ${(p.colours ?? []).join(' ')}`.toLowerCase();
  return { core, full, p };
}

/** Everyday words that are never a product feature ("do you HAVE", "MAKE it cheaper", "SHOW me"). */
const FILLER = new Set(('build create curate put together assemble combine colour colours color colors shade shades tone tones merchandise merch next previous prev page back less lower that this these those ondu beku beda olage tak ke andar mein ka ki ko compare comparison best top trending popular bestseller bestsellers selling famous '
  + 'most expensive costly costliest priciest highest pricey cheap cheaper cheapest sasta sasti saste low high end top year years '
  + 'head heads per wala wali wale waala chahiye dikhao dikha batao kuch accha acha boss manager colleague colleagues friend friends client clients sir madam '
  + 'but however though although rather instead have has had having make made makes do does did doing done what which whats who whom whose where when why how want wants wanted need needs needed '
  + 'some any all every each show shows showing give get got find found see look looking looks also please pls plz kindly can could would will should shall '
  + 'the and for our my your their them they these those this that there here with from into onto about like just only same more less much many few lot lots '
  + 'thing things item items available availability send share list catalogue catalog suggest suggestion suggestions recommend recommendation idea ideas '
  + 'okay fine good nice best great cool awesome lovely amazing beautiful better new latest ones one two three us me you we team teams people employees staff '
  + 'corporate gifting gift gifts present presents buy order ordering price prices budget cost costs rate rates around approx approximately per each piece pieces pcs qty units '
  + 'something anything stuff instead too also again still even maybe perhaps really very quite bit little big small large medium size sizes '
  + 'make it okay alright sure yes yeah yep hmm then now today soon urgent asap required requirement requirements bulk').split(' '));

/** Words that only say what the product is for, already covered by its kind ("COFFEE mug", "PHOTO frame", "WALL clock"). */
const KIND_WORDS = /^(organiser|organisers|organizer|organizers|frame|frames|pad|pads|stand|stands|coffee|tea|water|photo|picture|wall|desk|table|travel|office|laptop|phone|mobile|formal|casual|daily|everyday|regular|normal|standard|simple|basic|plain|usual|corporate|executive|men|mens|women|womens|unisex)$/;

/** One thing the customer asked for exactly (a colour, size, feature or descriptive word). */
export type Need = { label: string; hard: boolean; ok: (p: CatalogueProduct) => boolean };
const hayCache = new WeakMap<CatalogueProduct, Hay>();
const specHayCache = new WeakMap<CatalogueProduct, Set<string>>();
/** Everything in the request that products must match: features and sizes (hard), other descriptive words (soft). */
export function askedNeeds(q: ParsedRequest, skip: string[] = []): Need[] {
  const Hc = (p: CatalogueProduct) => hayCache.get(p) ?? (hayCache.set(p, hay(p)), hayCache.get(p)!);
  const specsOf = (p: CatalogueProduct) => specHayCache.get(p) ?? (specHayCache.set(p, productSpecs(Hc(p).full)), specHayCache.get(p)!);
  const hardWords = new Set((q.attrs ?? []).flatMap((k) => [k, ...attrTest(k).label.toLowerCase().split(/[\s-]+/)]));
  const UNIT_WORDS = /^(mah|ml|ltrs?|litres?|liters?|gsm|inch|inches|watts?|gb|tb|size|sized|colou?rs?|shade|type|one|piece)$/;
  return [
    ...(q.attrs ?? []).map((k) => {
      const a = attrTest(k);
      const colour = COLOUR_ATTRS.has(k);
      return { label: a.label, hard: true, ok: (p: CatalogueProduct) => a.p.test(colour ? `${Hc(p).core} ${(p.colours ?? []).join(' ').toLowerCase()}` : Hc(p).full) };
    }),
    ...(q.specs ?? []).map((sp) => ({ label: prettySpec(sp), hard: true, ok: (p: CatalogueProduct) => specsOf(p).has(sp) || Hc(p).full.replace(/,/g, '').includes(sp.replace(/[a-z"]+$/, '')) })),
    ...q.terms
      .filter((w) => !hardWords.has(w) && !KIND_WORDS.test(w) && !(q.nouns ?? []).some((n) => w.length >= 3 && (FOCUS[n]?.name.source ?? '').includes(w.replace(/s$/, ''))))
      .filter((w) => !skip.includes(w) && !UNIT_WORDS.test(w) && !FILLER.has(w) && !/^(sets?|combos?|hampers?|kits?|options?|range|friendly|related|type|types|style|styles|design|designs|quality|stuff|product|products)$/.test(w))
      .map((w) => { const re = new RegExp(`\\b${w.replace(/s$/, '')}(s|es|ed|ing|ies)?\\b`); return { label: w, hard: false, ok: (p: CatalogueProduct) => re.test(Hc(p).full) }; }),
  ];
}
/** Narrow words that should be shown strictly ("bomber jackets" → bombers only). */
export const isNarrowNoun = (n: string) => !!NOUN_LABEL[n];

/** Does this product count as the given kind (e.g. "backpack")? */
export function matchesKind(p: CatalogueProduct, kind: string): boolean {
  return KINDS[kind]?.p(hay(p)) ?? false;
}

export function inOccasion(p: CatalogueProduct, slug: string): boolean {
  if (p.collection_slugs.includes(slug)) return true;
  return slug === 'eco-friendly-gifts' && p.category.slug === 'eco-friendly';
}

/** Assumed GST for comparing "+ GST" prices with an all-inclusive budget (most gifting items). */
export const GST_RATE = 0.18;

/** The price to compare with the user's budget, on the same GST basis they used. */
export function budgetPrice(p: Pick<CatalogueProduct, 'sell_price' | 'mrp'>, gst: ParsedRequest['gst']): number | null {
  const price = unitPrice(p);
  if (price === null) return null;
  if (gst === 'incl' && p.sell_price !== null) return Math.round(price * (1 + GST_RATE)); // "+ GST" price → add GST
  if (gst === 'excl' && p.sell_price === null) return Math.round(price / (1 + GST_RATE)); // MRP already includes GST
  return price;
}

const brandNorm = (b: string) => ` ${b.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()} `;
const BRAND_ALIASES: Record<string, string> = { uspa: 'u s polo', 'us polo': 'u s polo', 'j and j': 'jack and jones', 'fire boltt': 'fire-boltt' };
const BRAND_NAMES: Record<string, string> = { hp: 'HP', vip: 'VIP', boat: 'boAt', jbl: 'JBL', mi: 'Mi', 'mi band': 'Mi Band', 'us polo': 'U.S. Polo', 'u s polo': 'U.S. Polo', uspa: 'USPA', urbn: 'URBN', 'f gear': 'F Gear' };
export const brandLabel = (b: string) => BRAND_NAMES[b] ?? b.replace(/\b[a-z]/g, (c) => c.toUpperCase());
export function brandMatches(productBrand: string | null, b: string): boolean {
  if (!productBrand) return false;
  const n = brandNorm(productBrand);
  const want = BRAND_ALIASES[b] ?? b;
  return n.includes(` ${want} `) || n.replace(/ /g, '') === want.replace(/[^a-z0-9]/g, '');
}

export const prettySpec = (sp: string) =>
  /^\d+ml$/.test(sp) && parseInt(sp, 10) >= 1000 ? `${parseInt(sp, 10) / 1000} L` : sp.replace(/^(\d+(?:\.\d+)?)(\D+)$/, (_x, n: string, u: string) => `${Number(n).toLocaleString('en-IN')} ${({ in: 'inch', mah: 'mAh', w: 'W', gb: 'GB', tb: 'TB', ml: 'ml', gsm: 'GSM' } as Record<string, string>)[u] ?? u}`);

const SPEC_RE = /(\d+(?:\.\d+)?)\s*(mah|ml|ltrs?|litres?|liters?|l(?=\s*[),]|\s*$)|gsm|inch(?:es)?|"|w|watts?|gb|tb)\b/g;
function productSpecs(text: string): Set<string> {
  return new Set([...text.matchAll(SPEC_RE)].map((m) => specKey(m[1]!, m[2]!)));
}

export function inBudget(p: CatalogueProduct, q: ParsedRequest): boolean {
  const price = budgetPrice(p, q.gst ?? null);
  const hasBudget = q.minPrice > 0 || Number.isFinite(q.maxPrice);
  if (price === null) return !hasBudget;
  return price >= q.minPrice && price <= q.maxPrice;
}

export function occasionLabel(slug: string, collections?: Pick<Collection, 'slug' | 'name'>[]): string {
  return collections?.find((c) => c.slug === slug)?.name ?? OCCASIONS.find((o) => o.slug === slug)?.label ?? slug.replace(/-/g, ' ');
}

/** Human-readable summary chips of what we understood. */
export function describe(q: ParsedRequest, collections?: Pick<Collection, 'slug' | 'name'>[]): string[] {
  const out: string[] = [];
  for (const k of q.attrs ?? []) { const l = attrTest(k).label; out.push(l[0]!.toUpperCase() + l.slice(1)); }
  const g = q.gst === 'incl' ? ' incl. GST' : q.gst === 'excl' ? ' + GST' : '';
  if (q.totalBudget !== null) out.push(`${inrN(q.totalBudget)} total`);
  if (q.approx !== null) out.push(`Around ${inrN(q.approx)} per gift${g} (${inrN(q.minPrice)}–${inrN(q.maxPrice)})`);
  else if (q.minPrice > 0 && Number.isFinite(q.maxPrice)) out.push(`${inrN(q.minPrice)}–${inrN(q.maxPrice)} per gift${g}`);
  else if (Number.isFinite(q.maxPrice)) out.push(`Up to ${inrN(q.maxPrice)} per gift${g}`);
  else if (q.minPrice > 0) out.push(`From ${inrN(q.minPrice)} per gift${g}`);
  if (q.quantity !== null) out.push(`${new Intl.NumberFormat('en-IN').format(q.quantity)} units`);
  for (const c of q.collections) out.push(occasionLabel(c, collections));
  for (const k of q.kinds) out.push(KINDS[k]!.label.replace(/^./, (s) => s.toUpperCase()));
  for (const k of q.notKinds ?? []) out.push(`No ${KINDS[k]!.label}`);
  for (const n of q.notNouns ?? []) { const c = `No ${NOUN_LABEL[n] ?? `${n}s`}`; if (!out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c); }
  for (const k of q.notAttrs ?? []) out.push(`No ${attrTest(k).label}`);
  for (const m of q.notMaterials ?? []) out.push(`No ${MATERIALS[m]!.label.toLowerCase()}`);
  for (const m of q.materials ?? []) out.push(MATERIALS[m]!.label);
  for (const b of q.brands ?? []) out.push(brandLabel(b));
  for (const sp of q.specs ?? []) out.push(prettySpec(sp));
  if (q.branding) out.push(`With ${q.branding}`);
  if (q.purpose) out.push(q.purpose);
  if (q.deadline) out.push(`Needed ${q.deadline}`);
  if (q.stockOnly) out.push('Ready stock');
  if (q.prefer === 'low') out.push('Lowest prices first');
  if (q.prefer === 'high') out.push('Premium first');
  return out;
}

export function recommend(
  products: CatalogueProduct[],
  q: ParsedRequest,
  limit = 8,
  collections?: Pick<Collection, 'slug' | 'name'>[],
  opts: { fallback?: boolean; exclude?: ReadonlySet<string> } = {},
): Recommendation {
  const fallback = opts.fallback ?? true; // alternatives are looked up one level deep only
  const notes: string[] = [];
  let suggestion: Recommendation['suggestion'] = null;
  const live = products.filter((p) => (p.status === undefined || p.status === 'live') && !opts.exclude?.has(p.id));
  const hays = new Map(live.map((p) => [p.id, hay(p)]));
  const H = (p: CatalogueProduct) => hays.get(p.id)!;

  // Occasions that don't exist as collections (renamed or removed) are dropped, not silently matched to nothing.
  const occ = collections ? q.collections.filter((s) => collections.some((c) => c.slug === s)) : q.collections;

  if (q.quantity !== null && q.quantity < MOQ) notes.push(`Just so you know, the minimum order is ${MOQ} units per product, so we'll start you at ${MOQ}.`);
  if (q.totalBudget !== null && q.quantity === null) notes.push(`Tell me how many gifts you need and I'll work out the per-gift budget from ${inrN(q.totalBudget)}.`);

  // Brands asked for: the known list plus any word that is one of our catalogue brands.
  const catalogueBrands = [...new Set(live.map((p) => p.brand).filter((b): b is string => !!b))];
  const termBrands = q.terms.filter((w) => w.length >= 3 && catalogueBrands.some((b) => brandMatches(b, w)));
  const asked = [...new Set([...(q.brands ?? []), ...termBrands])];
  const haveBrand = asked.filter((b) => live.some((p) => brandMatches(p.brand, b)));
  const missingBrands = asked.filter((b) => !haveBrand.includes(b));
  const termRe = q.terms.filter((w) => !asked.includes(w)).map((w) => new RegExp(`\\b${w.replace(/s$/, '')}`));
  if (missingBrands.length) {
    const name = missingBrands.map(brandLabel).join(' / ');
    notes.push(`Sorry, ${name} ${missingBrands.length > 1 ? "aren't" : "isn't"} available with us right now.`);
    if (!haveBrand.length) {
      const brandWords = new Set(asked.flatMap((b) => [b, ...b.split(/\s+/)]));
      const alt = recommend(products, { ...q, brands: [], terms: q.terms.filter((w) => !brandWords.has(w)) }, limit, collections, opts);
      return { ...alt, notes: dedupe([...notes, ...alt.notes]), alternative: true };
    }
  }
  if (q.gst) notes.push(`I've compared prices ${q.gst === 'incl' ? 'including' : 'excluding'} GST (assumed 18% where prices are "+ GST"). Your quote will show the exact tax.`);
  if (q.deadline) notes.push(`Need it ${q.deadline}? Ready-stock products ship fastest. Our team will confirm delivery dates in your quote.`);

  let base = live;
  if (q.notKinds?.length) base = base.filter((p) => !q.notKinds!.some((k) => KINDS[k]!.p(H(p)) || (KINDS[k]!.label.split(/[ &,]+/)[0]!.length > 3 && (p.subcategory ?? '').toLowerCase().startsWith(KINDS[k]!.label.split(/[ &,]+/)[0]!.toLowerCase()))));
  if (q.notNouns?.length) base = base.filter((p) => !q.notNouns!.some((n) => FOCUS[n]?.name.test(p.name.toLowerCase())));
  if (q.notMaterials?.length) base = base.filter((p) => !q.notMaterials!.some((m) => MATERIALS[m]!.p.test(H(p).full)));
  if (q.notAttrs?.length) base = base.filter((p) => !q.notAttrs!.some((k) => attrTest(k).p.test(H(p).full)));
  if (q.stockOnly) {
    const inStock = base.filter((p) => (p.ready_stock ?? 0) > 0);
    const wanted = (p: CatalogueProduct) => (!q.kinds.length || q.kinds.some((k) => KINDS[k]!.p(H(p)))) && (!(q.nouns ?? []).length || (q.nouns ?? []).some((n) => !FOCUS[n] || FOCUS[n]!.name.test(p.name.toLowerCase())));
    if ((q.kinds.length || (q.nouns ?? []).length) && !inStock.some(wanted) && base.some(wanted)) {
      // Nothing of this kind is in stock: show it made to order rather than unrelated stock items.
      const what = nounLabel(q, base.filter(wanted)) ?? q.kinds.map((k) => KINDS[k]!.label).join(' / ');
      notes.push(`Sorry, none of our ${what} are in ready stock right now. Here are made-to-order options; our team will confirm delivery dates in your quote.`);
    } else {
      base = inStock;
      notes.push('Showing only products with ready stock.');
    }
  }
  if (haveBrand.length) base = base.filter((p) => haveBrand.some((b) => brandMatches(p.brand, b)));
  // The brand exists, but not in this kind ("Lifelong desk organiser"): say so, then show that kind from other brands.
  const nounsAsked = (q.nouns ?? []).filter((n) => FOCUS[n]);
  const kindHit = (p: CatalogueProduct) => (q.kinds.length ? q.kinds.some((k) => KINDS[k]!.p(H(p))) : nounsAsked.some((n) => FOCUS[n]!.name.test(H(p).core)));
  if (haveBrand.length && (q.kinds.length || nounsAsked.length) && !base.some(kindHit)) {
    const what = nounsAsked.length ? nounsAsked.map((n) => NOUN_LABEL[n] ?? `${n}s`).join(' / ') : q.kinds.map((k) => KINDS[k]!.label).join(' / ');
    const alt = recommend(products, { ...q, brands: [], terms: q.terms.filter((w) => !asked.includes(w)) }, limit, collections, opts);
    return { ...alt, notes: dedupe([`Sorry, ${haveBrand.map(brandLabel).join(' / ')} ${what} are currently not available. Here are some close options from other brands.`, ...notes, ...alt.notes]), alternative: true };
  }
  if (q.branding) {
    const brandable = base.filter((p) => p.branding_possible);
    base = brandable;
    notes.push(
      q.branding === 'your logo'
        ? 'All of these can carry your logo. Our team confirms the branding method and cost in your quote.'
        : `All of these can be branded. Whether ${q.branding} suits each one depends on its material, and our team confirms it in your quote.`,
    );
  }

  const kindOk = (p: CatalogueProduct) => !q.kinds.length || q.kinds.some((k) => KINDS[k]!.p(H(p)));
  let pool = base.filter((p) => inBudget(p, q) && kindOk(p));
  // Trophies only when asked for (or for rewards & recognition), not as general gift ideas.
  if (!q.kinds.some((k) => /troph|award/.test(k + ' ' + KINDS[k]!.label)) && !(q.nouns ?? []).includes('trophy') && q.purpose !== 'Rewards & recognition') {
    const noTrophy = pool.filter((p) => !/^troph/.test(p.category.slug));
    if (noTrophy.length) pool = noTrophy;
  }
  // "bottle": show bottles, not every drinkware item. Sets/combos only when asked for.
  const focus = (q.nouns ?? []).map((n) => FOCUS[n]!.name);
  const wantSets = q.terms.some((w) => /^(sets?|combos?|hampers?|kits?)$/.test(w)) || (q.nouns ?? []).includes('hamper');
  const focusOk = (p: CatalogueProduct) => {
    const n = p.name.toLowerCase();
    // A notebook-and-pen combo is not what "pens" means.
    const fams = new Set((q.nouns ?? []).map((k) => FAMILY[k] ?? k));
    const combo = !wantSets && Object.entries(FOCUS).some(([k, f]) => k !== 'hamper' && !(q.nouns ?? []).includes(k) && !fams.has(FAMILY[k] ?? k) && f.name.test(n));
    const catOk = (q.nouns ?? []).some((k) => !FOCUS_CAT[k] || FOCUS_CAT[k]!.includes(p.category.slug) || (wantSets && p.category.slug === 'gift-sets'));
    return !combo && catOk && focus.some((re) => re.test(n)) && !focus.some((re) => new RegExp(`(without (a |the )?|opener|holder|stand|optional)\\W*(?:${re.source})|(?:${re.source})\\W*(opener|holder|stand|optional|drive|bag|cover|sleeve|shape|pouch|lamp|seeds?)`).test(n)) && (wantSets || !/gift set|\bset\b|combo|hamper/.test(n));
  };
  let nounMissing = false;
  // With two kinds asked ("laptop bag and bottle"), narrowing to one word would drop the other kind.
  if (focus.length && q.kinds.length <= 1) {
    // Asked for "bomber jackets" or "puffer jackets": show only those, never pad with other jackets.
    const focused = pool.filter(focusOk);
    const allFocused = base.filter((p) => kindOk(p) && focusOk(p));
    const strict = (q.nouns ?? []).some((n) => NOUN_LABEL[n]);
    if (!strict) {
      if (focused.length >= Math.min(3, pool.length)) pool = focused;
    } else if (focused.length) {
      pool = focused;
      const label = nounLabel(q, allFocused);
      if (label && allFocused.length > focused.length && (Number.isFinite(q.maxPrice) || q.minPrice > 0)) {
        notes.push(`We have ${allFocused.length} ${label} in all; ${focused.length} fit${focused.length === 1 ? 's' : ''} this budget.`);
        suggestion = { label: `Show all ${allFocused.length} ${label}`, query: { ...q, minPrice: 0, maxPrice: Infinity, approx: null, totalBudget: null } };
      }
    } else if (allFocused.length) {
      // None in budget: never break the budget; say where they start and offer them.
      const label = nounLabel(q, allFocused);
      const prices = allFocused.map(unitPrice).filter((x): x is number => x !== null);
      if (label) {
        notes.push(`Sorry, none of our ${label} fit this budget${prices.length ? `; they start at ${inrN(Math.min(...prices))}` : ''}. Here are the closest picks.`);
        suggestion = { label: `Show all ${allFocused.length} ${label}`, query: { ...q, minPrice: 0, maxPrice: Infinity, approx: null, totalBudget: null } };
      }
    } else {
      // We don't stock that exact product ("chocolates", "sipper"): say so, then show the closest.
      const labels = (q.nouns ?? []).filter((n) => NOUN_LABEL[n]).map((n) => NOUN_LABEL[n]!);
      const stocked = live.some((p) => focusOk(p));
      const bt = !stocked ? '' : Number.isFinite(q.maxPrice) ? ` under ${inrN(q.maxPrice)}` : q.minPrice > 0 ? ` above ${inrN(q.minPrice)}` : '';
      notes.push(`Sorry, ${labels.join(' / ')}${bt} are currently not available. Here are some close options.`);
      nounMissing = true;
    }
  }
  const mats = q.materials ?? [];
  if (mats.length && pool.length) {
    // A glass bottle with a steel infuser is not a steel bottle.
    const matOk = (p: CatalogueProduct, m: string) => MATERIALS[m]!.p.test(H(p).full) && !(m === 'steel' && /glass|borosilicate/.test(p.name.toLowerCase()) && !/steel (body|bottle|flask)/.test(p.name.toLowerCase()));
    const byAll = mats.length > 1 ? pool.filter((p) => mats.every((m) => matOk(p, m))) : [];
    const byMat = byAll.length ? byAll : pool.filter((p) => mats.some((m) => matOk(p, m)));
    if (mats.length > 1 && !byAll.length && byMat.length) {
      const have = mats.filter((m) => byMat.some((p) => matOk(p, m)));
      const lack = mats.filter((m) => !have.includes(m));
      notes.push(`Sorry, we don't have ${mats.map((m) => MATERIALS[m]!.label.toLowerCase()).join(' + ')} together${lack.length ? `, or anything ${lack.map((m) => MATERIALS[m]!.label.toLowerCase()).join(' / ')} here` : ''}. Here are the ${have.map((m) => MATERIALS[m]!.label.toLowerCase()).join(' / ')} options.`);
    }
    const label = mats.map((m) => MATERIALS[m]!.label.toLowerCase()).join(' / ');
    if (byMat.length) pool = byMat;
    else notes.push(`Sorry, we don't have ${label} options for this right now, so here are the closest picks.`);
  }
  const budgetText = Number.isFinite(q.maxPrice) ? `under ${inrN(q.maxPrice)}` : q.minPrice > 0 ? `from ${inrN(q.minPrice)}` : '';

  // Report each requested kind we have nothing for in this budget.
  for (const k of q.kinds) {
    const kind = KINDS[k]!;
    const any = base.filter((p) => kind.p(H(p)));
    if (pool.some((p) => kind.p(H(p)))) continue;
    if (!any.length) {
      if (q.stockOnly && live.some((p) => kind.p(H(p)))) {
        notes.push(`Sorry, none of our ${kind.label} are in ready stock right now. They're made to order, so request a quote and we'll confirm delivery dates.`);
        if (!suggestion) suggestion = { label: `Show ${kind.label} (made to order)`, query: { ...q, stockOnly: false } };
      } else notes.push(`Sorry, we don't have any ${kind.label} right now.`);
      continue;
    }
    const prices = any.map(unitPrice).filter((x): x is number => x !== null);
    if (Number.isFinite(q.maxPrice) && prices.length) {
      const cheapest = Math.min(...prices);
      if (cheapest > q.maxPrice) {
        notes.push(`Sorry, we don't have any ${kind.label} ${budgetText} right now. They start at ${inrN(cheapest)}.`);
        if (!suggestion) suggestion = { label: `Show ${kind.label} up to ${inrN(cheapest)}`, query: { ...q, maxPrice: cheapest, approx: null, totalBudget: null } };
        continue;
      }
    }
    if (q.minPrice > 0 && prices.length && Math.max(...prices) < q.minPrice) {
      notes.push(`Sorry, we don't have any ${kind.label} above ${inrN(q.minPrice)} right now. They go up to ${inrN(Math.max(...prices))}.`);
      if (!suggestion) suggestion = { label: `Show all our ${kind.label}`, query: { ...q, minPrice: 0, approx: null } };
      continue;
    }
    notes.push(`Sorry, we don't have any ${kind.label} in this price range right now.`);
  }

  // Some kinds asked for aren't available but others are: add their closest substitutes too.
  const missingKinds = q.kinds.filter((k) => !pool.some((p) => KINDS[k]!.p(H(p))));
  if (pool.length && missingKinds.length && fallback) {
    const extraKinds = [...new Set(missingKinds.flatMap((k) => RELATED[k] ?? []))].filter((k) => !q.kinds.includes(k));
    const extra = base.filter((p) => inBudget(p, q) && !pool.includes(p) && extraKinds.some((k) => KINDS[k]!.p(H(p))));
    if (extra.length) {
      pool = [...pool, ...extra];
      notes.push(`I've added some ${KINDS[extraKinds[0]!]!.label} in their place.`);
    }
  }

  if (!pool.length && q.kinds.length) {
    // Nothing of the kind asked for: offer related kinds first, then the best of everything that fits.
    if (!fallback) return { picks: [], notes: dedupe(notes), suggestion, matched: 0, alternative: false };
    const related = [...new Set(q.kinds.flatMap((k) => RELATED[k] ?? []))].filter((k) => !q.kinds.includes(k));
    const rel = related.length ? recommend(products, { ...q, kinds: related }, limit, collections, { ...opts, fallback: false }) : null;
    const gen = recommend(products, { ...q, kinds: [] }, limit, collections, { ...opts, fallback: false });
    const picks = [...(rel?.picks ?? [])];
    for (const p of gen.picks) if (picks.length < limit && !picks.includes(p)) picks.push(p);
    return { picks, notes: dedupe([...notes, ...gen.notes]), suggestion: suggestion ?? gen.suggestion, matched: picks.length, alternative: picks.length > 0 };
  }

  if (!pool.length) {
    {
      const prices = base.map(unitPrice).filter((x): x is number => x !== null);
      if (prices.length && Number.isFinite(q.maxPrice) && Math.min(...prices) > q.maxPrice) {
        const cheapest = Math.min(...prices);
        const who = asked.length ? asked.map((b) => b.replace(/\b\w/g, (c) => c.toUpperCase())).join(' / ') + ' products' : q.kinds.length ? q.kinds.map((k) => KINDS[k]!.label).join(' / ') : 'gifts';
        notes.push(asked.length || q.kinds.length ? `Sorry, ${who} are currently not available ${budgetText}. They start at ${inrN(cheapest)}.` : `Sorry, we don't have anything ${budgetText} right now. Our gifts start at ${inrN(cheapest)}.`);
        suggestion = { label: 'Show our most affordable gifts', query: { ...q, maxPrice: Math.round(cheapest * 1.5), approx: null, totalBudget: null } };
      } else if (prices.length && q.minPrice > Math.max(...prices)) {
        if (!notes.some((n) => n.startsWith('Sorry'))) notes.push(`Sorry, we don't have anything above ${inrN(q.minPrice)} right now. Our most premium gifts go up to ${inrN(Math.max(...prices))}.`);
        suggestion = { label: 'Show our most premium gifts', query: { ...q, minPrice: Math.round(Math.max(...prices) * 0.5), maxPrice: Infinity, approx: null, totalBudget: null } };
      } else if (q.stockOnly) notes.push(`Sorry, nothing with ready stock fits that right now. Ask without "in stock" and we'll check delivery times for you.`);
      else if (!notes.some((n) => n.startsWith('Sorry'))) notes.push(`Sorry, we don't have anything in that price range right now.`);
    }
    return { picks: [], notes: dedupe(notes), suggestion, matched: 0, alternative: false };
  }

  let ranked = pool;
  if (occ.length) {
    // Per kind: keep the occasion's products, but don't drop a kind the occasion has none of.
    const kindsOf = (p: CatalogueProduct) => q.kinds.filter((k) => KINDS[k]!.p(H(p))).join('|') || 'other';
    const occOk = (p: CatalogueProduct) => occ.some((s) => inOccasion(p, s));
    const byOcc = q.kinds.length
      ? pool.filter((p) => occOk(p) || !pool.some((o) => kindsOf(o) === kindsOf(p) && occOk(o)))
      : pool.filter(occOk);
    if (q.kinds.length && byOcc.length && !byOcc.some(occOk)) byOcc.length = 0; // none fit the occasion at all
    if (byOcc.length) ranked = byOcc;
    else notes.push(`We don't have ${occ.map((s) => occasionLabel(s, collections)).join(' / ')} picks ${budgetText ? budgetText + ' ' : ''}for this yet, but these would make lovely gifts too.`);
  }

  // A farewell or a birthday suggests keepsakes and treats, not giveaway badges.
  const purposeRe = q.purpose === 'Farewell & retirement' ? /photo frame|plaque|memento|\bpens?\b|watch|diary|desk|clock|wallet|leather|planner|crystal|personali|engrav/
    : q.purpose === 'Celebrations' ? /hamper|chocolate|sweet|gourmet|\bmugs?\b|photo frame|candle|plant|gift box|speaker|earbuds|perfume|cake|dry fruit/
    : null;
  const hasMax = Number.isFinite(q.maxPrice);
  const wantSpecs = q.specs ?? [];
  const specCache = new Map<string, Set<string>>();
  const specsOf = (p: CatalogueProduct) => specCache.get(p.id) ?? specCache.set(p.id, productSpecs(H(p).full)).get(p.id)!;

  // Give exactly what was asked: every colour, size, feature and descriptive word must match if anything matches.
  // Hard needs (colours, sizes, features) are reported when missing; other words only narrow when something has them.
  const needs = askedNeeds(q, [...asked, ...asked.flatMap((b) => b.split(/\s+/)), ...missingBrands.flatMap((b) => b.split(/\s+/))]);
  if (needs.length && ranked.length) {
    // A colour or feature (hard) outweighs any number of descriptive words: "pink water bottle" → pink bottles first.
    const sc = new Map(ranked.map((p) => [p.id, needs.reduce((t, n) => t + (n.ok(p) ? (n.hard ? 100 : 1) : 0), 0)]));
    const best = Math.max(...sc.values());
    // Several kinds asked ("backpack, power bank and earbuds"): narrow each kind on its own so none drops out.
    const kindOf = (p: CatalogueProduct) => (q.kinds.length > 1 ? q.kinds.find((k) => KINDS[k]!.p(H(p))) ?? 'other' : 'all');
    const bestBy = new Map<string, number>();
    for (const p of ranked) bestBy.set(kindOf(p), Math.max(bestBy.get(kindOf(p)) ?? 0, sc.get(p.id)!));
    const hard = needs.filter((n) => n.hard);
    const what = nounLabel(q, ranked) ?? (q.kinds.length ? q.kinds.map((k) => KINDS[k]!.label).join(' / ') : 'products');
    if (best > 0) {
      ranked = ranked.filter((p) => sc.get(p.id) === bestBy.get(kindOf(p)));
      const missing = hard.filter((n) => !ranked.some(n.ok));
      if (missing.length) notes.push(`Sorry, ${missing.map((n) => n.label).join(', ')} ${what} are currently not available. Here are the closest matches.`);
    } else if (hard.length) {
      // Nothing in this budget has it: say so, and offer it at any price if we have it.
      const anyPrice = base.filter((p) => kindOk(p) && hard.every((n) => n.ok(p)));
      notes.push(`Sorry, ${hard.map((n) => n.label).join(', ')} ${what}${anyPrice.length && budgetText ? ` ${budgetText}` : ''} are currently not available. Here are some close options.`);
      if (anyPrice.length && !suggestion) {
        suggestion = { label: `Show ${hard.map((n) => n.label).join(' ')} ${what} at any price (${anyPrice.length})`, query: { ...q, minPrice: 0, maxPrice: Infinity, approx: null, totalBudget: null } };
      }
    } else if ((q.kinds.length || (q.nouns ?? []).length) && !nounMissing) {
      // A product word we don't stock ("sipper" bottle, "airpods" case): say so, then show the closest.
      const words = needs.map((n) => n.label);
      notes.push(`Sorry, ${words.map((w) => `"${w}"`).join(' ')} ${what} are currently not available. Here are some close options.`);
    }
  }
  const allPrices = live.map(unitPrice).filter((x): x is number => x !== null);
  const topPrice = allPrices.length ? Math.max(...allPrices) : 1;
  const poolPrices = ranked.map(unitPrice).filter((x): x is number => x !== null && x > 0).sort((a, b) => a - b);
  const midPrice = poolPrices.length ? Math.max(50, poolPrices[Math.floor(poolPrices.length * 0.55)]!) : 900;
  const score = (p: CatalogueProduct) => {
    const h = H(p);
    const price = budgetPrice(p, q.gst ?? null);
    let s = 0;
    s += occ.filter((o) => inOccasion(p, o)).length * 2;
    if (purposeRe && purposeRe.test(h.core)) s += 2.5;
    s += termRe.filter((re) => re.test(h.full)).length * 3;
    s += q.kinds.filter((k) => KINDS[k]!.p(h)).length * 0.5;
    if (focus.length && focusOk(p)) s += 4;
    if (wantSets && p.category.slug === 'gift-sets') s += 3 + focus.filter((re) => re.test(p.name.toLowerCase())).length * 1.5;
    if (p.image_path) s += 1;
    if ((p.ready_stock ?? 0) > 0) s += q.deadline || q.stockOnly ? 1.5 : 0.3;
    if (wantSpecs.length) s += wantSpecs.filter((sp) => specsOf(p).has(sp)).length * 4;
    if (price === null) s -= 2;
    else if (q.prefer === 'low') s -= (price / topPrice) * 3;
    else if (q.prefer === 'high') s += (price / topPrice) * 3;
    else if (q.approx !== null) s -= Math.abs(price - q.approx) / q.approx;
    else if (hasMax) s += (price / q.maxPrice) * 1.5; // make good use of the budget
    else if (q.minPrice > 0) s -= Math.abs(Math.log(price / (q.minPrice * 1.5))) * 0.5; // "above 5000": stay near the floor
    else s -= Math.abs(Math.log(Math.max(price, 1) / midPrice)) * 0.6; // no budget: favour typical prices of what was asked for
    return s;
  };
  const scored = ranked
    .map((p) => ({ p, s: score(p) }))
    .sort((a, b) => b.s - a.s || (unitPrice(a.p) ?? 0) - (unitPrice(b.p) ?? 0) || a.p.name.localeCompare(b.p.name));

  // Variety: round-robin across groups (requested kinds, else sub-categories within a kind, else categories).
  const groupOf = (p: CatalogueProduct) => {
    if (q.kinds.length > 1) return q.kinds.find((k) => KINDS[k]!.p(H(p))) ?? 'other';
    if (q.kinds.length === 1) return p.subcategory ?? p.category.slug;
    return p.category.slug;
  };
  const groups = new Map<string, CatalogueProduct[]>();
  for (const { p } of scored) {
    const g = groupOf(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(p);
  }
  const perSub = new Map<string, number>();
  // One design in many colours ("Rhine Black / Blue / Grey Smart Bottle") counts once for variety.
  const family = (p: CatalogueProduct) =>
    p.name.toLowerCase().replace(/\(.*?\)|–\s*style \d+|\b(black|white|grey|gray|blue|red|green|mint|purple|pink|olive|teal|yellow|orange|beige|brown|gold|rose gold|silver|navy|dark|light|edition|marble|sustainable)\b|[-–&]/g, ' ').replace(/\s+/g, ' ').trim();
  const perFamily = new Map<string, number>();
  const picks: CatalogueProduct[] = [];
  const lists = [...groups.values()];
  let progress = true;
  while (picks.length < limit && progress) {
    progress = false;
    for (const list of lists) {
      if (picks.length >= limit) break;
      const idx = list.findIndex((p) => (perSub.get(p.subcategory ?? p.category.slug) ?? 0) < 2 && (perFamily.get(family(p)) ?? 0) < 1);
      if (idx < 0) continue;
      const [p] = list.splice(idx, 1);
      picks.push(p!);
      const sub = p!.subcategory ?? p!.category.slug;
      perSub.set(sub, (perSub.get(sub) ?? 0) + 1);
      perFamily.set(family(p!), (perFamily.get(family(p!)) ?? 0) + 1);
      progress = true;
    }
  }
  for (const pass of [1, 2]) {
    for (const { p } of scored) {
      if (picks.length >= limit) break;
      if (!picks.includes(p) && (pass === 2 || (perFamily.get(family(p)) ?? 0) < 1)) {
        picks.push(p);
        perFamily.set(family(p), (perFamily.get(family(p)) ?? 0) + 1);
      }
    }
  }
  // Present cheapest-first when the user asked for low prices, else best-first order as picked.
  if (q.prefer === 'low') picks.sort((a, b) => (unitPrice(a) ?? Infinity) - (unitPrice(b) ?? Infinity));
  return { picks, notes: dedupe(notes), suggestion, matched: ranked.length, alternative: false };
}

/** Back-compat helper: just the picks. */
export function shortlist(products: CatalogueProduct[], q: ParsedRequest, limit = 8): CatalogueProduct[] {
  return recommend(products, q, limit).picks;
}

// ---------------------------------------------------------------------------
// Shop search box: same understanding, but returns every match (no trimming).
// ---------------------------------------------------------------------------

export function searchProducts(products: CatalogueProduct[], text: string): { results: CatalogueProduct[]; understood: string[] } {
  const raw = text.trim().slice(0, 200);
  if (!raw) return { results: products, understood: [] };
  const q = parseRequest(raw);
  const structured = q.kinds.length > 0 || q.collections.length > 0 || q.minPrice > 0 || Number.isFinite(q.maxPrice) || q.stockOnly;
  const hays = new Map(products.map((p) => [p.id, hay(p)]));
  const H = (p: CatalogueProduct) => hays.get(p.id)!;
  const wordMatch = (words: string[]) => (p: CatalogueProduct) =>
    words.every((w) => H(p).full.includes(w) || H(p).full.includes(w.replace(/(es|s)$/, '')));

  if (!structured) {
    const words = normalise(raw).replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w));
    const needle = raw.toLowerCase();
    return { results: products.filter((p) => H(p).full.includes(needle) || (words.length > 0 && wordMatch(words)(p))), understood: [] };
  }
  let r = products.filter((p) => inBudget(p, q));
  if (q.stockOnly) r = r.filter((p) => (p.ready_stock ?? 0) > 0);
  if (q.kinds.length) r = r.filter((p) => q.kinds.some((k) => KINDS[k]!.p(H(p))));
  if (q.collections.length) {
    const occ = r.filter((p) => q.collections.some((s) => inOccasion(p, s)));
    if (occ.length) r = occ;
  }
  if (q.terms.length) {
    const t = r.filter(wordMatch(q.terms));
    if (t.length) r = t;
  }
  if (q.prefer === 'low') r = [...r].sort((a, b) => (unitPrice(a) ?? Infinity) - (unitPrice(b) ?? Infinity));
  return { results: r, understood: describe(q).filter((c) => !/units$/.test(c)) };
}

const featuredRank = (p: CatalogueProduct) => {
  const x = unitPrice(p);
  return x === null ? 99 : Math.abs(Math.log(x / 900));
};

/** Default shop order: categories interleaved so no single vendor dominates the first screen. */
export function featuredOrder(products: CatalogueProduct[]): CatalogueProduct[] {
  const groups = new Map<string, CatalogueProduct[]>();
  const sorted = [...products].sort(
    // Typical gift prices first (₹300–₹2,500 sorts ahead of ₹8 pens and ₹9,000 appliances).
    (a, b) => Number(!!b.image_path) - Number(!!a.image_path) || featuredRank(a) - featuredRank(b) || a.name.localeCompare(b.name),
  );
  for (const p of sorted) {
    const k = p.subcategory ?? p.category.slug;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  const lists = [...groups.values()];
  const out: CatalogueProduct[] = [];
  while (out.length < products.length) for (const l of lists) if (l.length) out.push(l.shift()!);
  return out;
}
