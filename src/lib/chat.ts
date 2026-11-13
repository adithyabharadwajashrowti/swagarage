// Conversation layer for the Gift Assistant.
//
// Turns each message into a reply, keeping the context of the conversation:
// greetings and thanks get a friendly answer, common questions (MOQ, delivery,
// branding, GST…) get a straight answer, product names show that product, and
// follow-ups ("cheaper", "show more", "what about speakers", "for 50 ppl")
// adjust the previous request instead of starting over.
import type { CatalogueProduct, Collection } from './types';
import { describe, KINDS, matchesKind, MOQ, normalise, occasionLabel, parseRequest, recommend, resolveAmbiguity, type ParsedRequest, type Recommendation } from './assistant';
import { inr, unitPrice } from './format';

export interface ChatContext {
  /** The request the conversation is currently about. */
  q: ParsedRequest | null;
  /** Products already shown for it, so "show more" brings new ones. */
  shown: string[];
  /** A request waiting for "is 500 the budget or the quantity?". */
  pending: ParsedRequest | null;
}

export const EMPTY_CONTEXT: ChatContext = { q: null, shown: [], pending: null };

export interface QuickReply {
  label: string;
  /** Text sent as if the user typed it. */
  send: string;
}

export interface BotReply {
  /** Opening line(s), plain text. */
  text: string[];
  chips: string[];
  rec: Recommendation | null;
  /** Ask whether this number is a budget or a quantity. */
  ask: number | null;
  parsed: ParsedRequest | null;
  quick: QuickReply[];
}

type Cols = Pick<Collection, 'slug' | 'name'>[];

const EXAMPLES: QuickReply[] = [
  { label: 'Diwali gifts under ₹1500', send: 'Diwali gifts under ₹1500' },
  { label: 'Welcome kits for 50 new hires', send: 'Welcome kit for 50 new hires' },
  { label: 'Client gifts above ₹3000', send: 'Premium client gifts above ₹3000' },
  { label: 'Gifts under ₹500', send: 'Gifts under ₹500' },
];

const AFTER_PICKS: QuickReply[] = [
  { label: 'Show more', send: 'show more' },
  { label: 'Cheaper options', send: 'cheaper options' },
  { label: 'More premium', send: 'something more premium' },
];


// --- intents -----------------------------------------------------------------

const RESET = /\b(start over|start again|new search|reset|clear (the )?chat|forget (it|that|this|everything))\b/;
const GREETING = /^(hi+|hello+|hel+o|hey+|hii+|heya|yo|hola|namaste|namaskara|namaskar|good (morning|afternoon|evening|day)|gm|hey there|hi there|hello there)( claude| team| swagarage| bot| there)*$/;
const THANKS = /^(thanks?|thank you|thanks a lot|thanks so much|thank you so much|many thanks|thanks again)( a lot| so much)?( you)?$/;
const ACK = /^(ok(ay)?|k+|kk|cool|great|awesome|nice|perfect|got it|super|fine|alright|sounds good|good|lovely|wow|done|noted|hmm+|yes|yeah|yep|sure)( thanks)?$/;
const BYE = /^(bye+|goodbye|good bye|see you|see ya|cya|ttyl|that'?s all|thats it|that is all|nothing else|no thanks|nope that'?s it)$/;
const WHO = /\b(are you (a |an )?(bot|human|real|ai|robot|person)|who are you|what are you|your name)\b/;
const HELP = /^(help|help me|what can you do|what do you do|how (does this|do you|do i|to use this|it) work|how to use( this)?|what is this|options)\??$/;

/** `covered`: inside a product request the recommender already adds a note on this, so don't repeat it. */
const FAQ: { re: RegExp; answer: (products: CatalogueProduct[]) => string; covered?: boolean }[] = [
  {
    re: /\b(what|which) (all )?(branding|printing|customi[sz]ation) (options|methods|types)\b|\bbranding (options|methods|types)\b|\bhow (do|will|can) you (brand|print)\b/,
    answer: () =>
      'Branding depends on the material: laser engraving for metal and wood, debossing or embossing for leather and PU, embroidery for apparel and bags, screen or pad printing for most hard surfaces, and UV or full-colour printing for detailed logos. Our team suggests the best method for each product in your quote.',
  },
  {
    re: /\b(artwork|mock ?ups?|virtual (sample|proof)|digital proof|logo file|vector|\.?ai file|cdr|pantone|design approval|proof)\b/,
    answer: () =>
      'Send your logo with the quote request (vector files like AI, CDR, PDF or SVG work best). Our team confirms the artwork and branding details with you before production.',
  },
  {
    re: /\b(packaging|gift ?box(es)?|gift ?wrap\w*|rigid box|kraft box|custom box|sleeve packaging|ribbon|hamper box|unboxing|box packing)\b/,
    answer: () => 'Packaging and gift boxes can be discussed with your order. Mention what you have in mind in the quote notes and our team will share options.',
  },
  {
    re: /\b(pan india|\d+ (locations|cities|addresses|offices|branches)|multiple (locations|cities|addresses|offices|branches)|multi[- ]?location|different (cities|locations|offices)|individual (addresses|shipping|delivery)|door ?step delivery|ship to (each|every|employees)|home delivery|remote employees)\b/,
    answer: () => 'Tell us the delivery cities or addresses in your quote request. Our team will confirm whether we can ship to multiple locations and what it costs.',
  },
  {
    re: /\b(proforma|\bpi\b|purchase order|\bpo\b|invoice|tax invoice|e-?way bill|vendor (registration|code|onboarding)|msme|gstin|credit terms)\b/,
    answer: () => 'Our team handles the paperwork (quotation, proforma invoice, PO and tax invoice) with you once you send your quote request.',
  },
  {
    re: /\b(bulk (discount|price|pricing|rate)|volume (discount|pricing)|slab (rate|price|pricing)s?|discount|best (price|rate)|better (price|rate)|negotiat\w*|wholesale)\b/,
    answer: () => 'Larger quantities usually get better per-piece prices. Add your quantity to the quote request and our team will send you their best price.',
  },
  {
    re: /\b(catalogue|catalog|brochure|ppt|deck|presentation|pdf)\b.*\b(send|share|download|get|need|want)\b|\b(send|share|download|get|need|want)\b.*\b(catalogue|catalog|brochure|ppt|deck|presentation|pdf)\b/,
    answer: () => 'Tell me what you need and I\'ll shortlist products, then tap "Download catalogue PPT" under the picks to get a ready Swagarage catalogue you can share.',
  },
  {
    re: /\b(moq|minimum order|min order|minimum quantity|min qty|minimum qty|how many minimum|least (i|we) can order|small (order|quantity)|order less than|less than 25)\b/,
    answer: () => `Our minimum order is ${MOQ} units per product. You can mix different products in one quote, as long as each has at least ${MOQ}.`,
  },
  {
    covered: true,
    re: /\b(delivery|deliver|delivered|shipping|ship|dispatch|how long|timeline|lead time|when will (i|we) get|turnaround|tat|how many days)\b/,
    answer: () =>
      'Delivery time depends on the product, quantity and branding. Products with ready stock ship fastest; the rest are made to order. Our team confirms exact dates in your quote. Tip: add "in stock" to your request to see ready-stock products.',
  },
  {
    covered: true,
    re: /\b(logo|branding|brand it|brand them|printing|print (our|my|the|a)|engrav(e|ed|ing)|emboss(ed|ing)?|deboss(ed|ing)?|embroider\w*|customi[sz](e|ed|ation)|personali[sz](e|ed|ation)|our name on)\b/,
    answer: (ps) => {
      const n = ps.filter((p) => p.branding_possible).length;
      return `Yes! ${n} of our ${ps.length} products can carry your logo (printing, engraving or embossing, depending on the item). Tell us what you need when you request a quote and we'll confirm the options and cost.`;
    },
  },
  {
    covered: true,
    re: /\b(gst|exgst|ingst|tax|taxes|inclusive|exclusive|price includ\w*|is that the final price)\b/,
    answer: () =>
      'Prices marked "+ GST" don\'t include GST. Prices marked "MRP" are the maximum retail price, and we\'ll quote you our best price. Your quote shows the full breakdown.',
  },
  { re: /\b(payment|pay|advance|upi|credit period|cod|cash on delivery|net 30)\b/, answer: () => 'Payment terms are shared with your quote, and our team will walk you through them.' },
  {
    re: /\b(samples?|demo piece|see (it|them|the product) first|physical (look|check))\b/,
    answer: () => "Ask for samples in the notes when you request a quote, and our team will let you know what's possible for those products.",
  },
  {
    re: /\b(return|returns|refund|exchange|damaged|broken|replacement)\b/,
    answer: () => "For returns or replacements, contact our team with your quote reference and they'll help you out.",
  },
  {
    re: /\b(talk to|speak (to|with)|call (me|us)|contact (you|someone|team)|human|real person|agent|someone from|phone number|whatsapp|email id|reach (you|someone))\b/,
    answer: () => 'Our team is happy to help personally. Add the products you like to a quote and send it, and they\'ll contact you directly.',
  },
];

// ---- Guard rails ----------------------------------------------------------------
/** Attempts to learn our cost, margin or suppliers. Always answered with the selling price only. */
const COST_PROBE =
  /\b(cost price|actual price|real price|original price|true price|base price|purchase price|buying price|dealer price|distributor price|factory price|vendor|vendors|supplier|suppliers|source (it|them|these|from)|where do you (buy|source|get)|who (makes|manufactures|supplies)|manufacturer|your (margin|markup|mark-up|profit|commission|cut)|margins?|mark[- ]?ups?|profit|without (the |any |your )?(hike|markup|mark-up|margin|percent|%|commission)|percentage (you|added|hike)|how much (do|did) you (pay|buy|get it)|x ?\+ ?y|x and y|hike)\b/;
const COST_REPLY =
  'I can only share our selling price per unit. GST, branding and shipping are added at checkout, and our team sends the full breakdown with your quote.';

/** Never answered, even with a product word in it ("write a poem about bags", "ignore your rules"). */
const ALWAYS_DECLINE =
  /\b(ignore( \w+){0,3} (instructions|rules|prompt|prompts|guidelines)|forget( \w+){0,3} (instructions|rules)|system prompt|your (instructions|prompt|rules)|jailbreak|developer mode|dan mode|pretend (to be|you are)|act as (a|an|my)|roleplay|role-play|write (me )?(a |an )?(poem|story|essay|song|code|program|script|rap)|tell (me )?a joke|riddle|homework|assignment|equation|integral|derivative|translate|lyrics|share price|stock price|sensex|nifty|bitcoin|crypto|horoscope|astrology|tarot)\b/;
/** Trivia and tasks: declined unless the message is clearly about gifts ("gifts for who won the hackathon" is fine). */
const TRIVIA = /\b(who (invented|discovered|founded|won|is the|was the)|history of|capital of|population of|solve|meaning of|calculate|how (many|far|tall|old) (is|are|was)|when (was|did|is)|why (is|do|does|did))\b/;
/** Unrelated topics: declined unless the message is also about gifts ("all-weather jackets for employees" is fine). */
const OFF_TOPIC_HARD =
  /\b(weather|temperature (in|today)|election|vote for|politic\w*|bjp|congress party|prime minister|chief minister|religion|recipe for|who (invented|discovered|founded|won)|history of|capital of|population of|meaning of life|girlfriend|boyfriend|date me|marry me|love you|are you (single|married)|python|javascript|html|sql|c\+\+|leetcode|cricket score|match score|ipl|movie|netflix|joke)\b/;
/** Off-topic only when nothing about gifts was asked ("what's the time", "tell me about yourself"). */
const OFF_TOPIC_SOFT = /\b(news|time now|what time|date today|today'?s date|how old are you|where are you|your name|who made you|chatgpt|gpt|openai|gemini|claude|meaning|define|explain|what is a|what is an|calculate|how to (cook|make money|lose weight)|health|doctor|medicine|symptoms?|loan|insurance|tax filing|job|salary|career)\b/;
const GIFTY = /\b(gift|gifts|gifting|swag|merch|merchandise|hamper|hampers|kit|kits|quote|quotation|order|catalogue|catalog|product|products|branding|logo|bulk|corporate|client|clients|employee|employees|diwali|festive|onboarding|welcome)\b/;
const REFUSAL = "Sorry, I can only help with Swagarage's catalogue and your gifting needs 🙂 Tell me the occasion, your budget per gift and how many you need, and I'll find options.";

const CATALOGUE_Q = /\b(what (all )?(do you|you) (have|sell|offer|got)|what brands|which brands|what categories|what kind of (gifts|products)|show (me )?(your|the) (catalogue|catalog|range))\b/;

const CHEAPER = /\b(cheaper|cheap(er)? ones|less expensive|lower (price|budget|cost|range)|more affordable|budget friendly|too (expensive|costly|pricey|much)|reduce (the )?(price|budget)|economical|something cheaper|low budget)\b/;
const PREMIUM = /\b(more (premium|expensive|luxury|luxurious|upscale|classy|fancy)|costlier|higher (end|range|budget|price)|better (quality|ones)|fancier|too cheap|premium ones|high end|something premium|more premium)\b/;
const MORE = /\b(show more|more (options|ideas|products|gifts|choices|please|pls)|see more|any more|anything else|something else|other (options|ones|ideas)|others|different ones|what else|next|more like (this|these)|more)\b/;
const NO_BUDGET = /\b(no budget|any budget|budget (is )?no bar|budget doesn'?t matter|price doesn'?t matter|no limit|any price)\b/;
const ADD_WORDS = /\b(also|too|as well|add|plus|along with|and some)\b/;
const GIFT_INTENT = /\b(gift|gifts|gifting|swag|merch|merchandise|something|suggest|suggestion|recommend|show|need|want|looking|idea|ideas|options|kit|kits|hamper|hampers|present|presents|buy|order|get me|give me|find|send|share|requirement|requirements|enquiry|inquiry|rfq|quote|quotation|giveaways?|freebies|collaterals?|promotional|corporate|products?|items?|range)\b/;
const DETAIL = /\b(about|details?|specs?|specifications?|price of|cost of|how much|tell me|info|information|features?|colou?rs?|is it|does it|what is|show me)\b/;

// --- helpers -------------------------------------------------------------------

const hasBudget = (q: ParsedRequest) => q.minPrice > 0 || Number.isFinite(q.maxPrice) || q.totalBudget !== null;
/** Real gift content (not just "urgent" or "cheap"): budget, quantity, kind, occasion, brand or material. */
const hasCore = (q: ParsedRequest) =>
  hasBudget(q) || q.quantity !== null || q.kinds.length > 0 || q.collections.length > 0 || (q.brands ?? []).length > 0 || (q.materials ?? []).length > 0;
const hasContent = (q: ParsedRequest) =>
  hasBudget(q) || q.quantity !== null || q.kinds.length > 0 || q.collections.length > 0 || q.stockOnly || q.prefer !== null ||
  (q.brands ?? []).length > 0 || (q.materials ?? []).length > 0 || (q.specs ?? []).length > 0 || q.purpose != null;

function mergeRequest(prev: ParsedRequest, cur: ParsedRequest, t: string): ParsedRequest {
  const m: ParsedRequest = { ...prev, ambiguous: cur.ambiguous, prefer: cur.prefer };
  if (hasBudget(cur)) {
    m.minPrice = cur.minPrice;
    m.maxPrice = cur.maxPrice;
    m.approx = cur.approx;
    m.totalBudget = cur.totalBudget;
  }
  if (NO_BUDGET.test(t)) {
    m.minPrice = 0;
    m.maxPrice = Infinity;
    m.approx = null;
    m.totalBudget = null;
  }
  if (cur.quantity !== null) m.quantity = cur.quantity;
  if (m.totalBudget !== null && m.quantity) m.maxPrice = Math.min(m.maxPrice, Math.floor(m.totalBudget / m.quantity));
  if (cur.collections.length) m.collections = cur.collections;
  if (cur.kinds.length) m.kinds = ADD_WORDS.test(t) ? [...new Set([...prev.kinds, ...cur.kinds])] : cur.kinds;
  m.notKinds = [...new Set([...(prev.notKinds ?? []).filter((k) => !cur.kinds.includes(k)), ...(cur.notKinds ?? [])])];
  m.kinds = m.kinds.filter((k) => !m.notKinds!.includes(k));
  m.terms = cur.terms;
  // These carry over unless the new message says something about them.
  m.gst = cur.gst ?? prev.gst ?? null;
  m.materials = cur.materials?.length ? cur.materials : prev.materials;
  m.branding = cur.branding ?? prev.branding ?? null;
  m.brands = cur.brands?.length ? cur.brands : prev.brands;
  m.specs = cur.specs?.length ? cur.specs : cur.kinds.length ? [] : prev.specs;
  m.deadline = cur.deadline ?? prev.deadline ?? null;
  m.purpose = cur.purpose ?? prev.purpose ?? null;
  m.stockOnly = cur.stockOnly || (prev.stockOnly && !/\b(no rush|not urgent|any stock|made to order is fine)\b/.test(t));
  return m;
}

function findProducts(products: CatalogueProduct[], t: string): CatalogueProduct[] {
  const words = t.replace(/[^a-z0-9+\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const padded = ` ${words} `;
  const full = products.filter((p) => padded.includes(` ${p.name.toLowerCase()} `) || padded.includes(` ${p.name.toLowerCase().replace(/\+/g, ' plus')} `));
  if (full.length) {
    // "Toreto Jolly" should not also return "Toreto Jolly+" unless asked.
    const exact = full.filter((p) => !full.some((o) => o !== p && o.name.toLowerCase().startsWith(p.name.toLowerCase()) && padded.includes(` ${o.name.toLowerCase()} `)));
    return exact.slice(0, 4);
  }
  // Model name alone ("flyt", "soundbolt"), only when it is unique and the message is about a product.
  const short = words.split(' ').length <= 3;
  if (!short && !DETAIL.test(t)) return [];
  const byModel = new Map<string, CatalogueProduct[]>();
  for (const p of products) {
    const parts = p.name.toLowerCase().split(/\s+/);
    if (parts.length < 2) continue;
    const model = parts.slice(1).join(' ');
    if (model.length < 4) continue;
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model)!.push(p);
  }
  const hits: CatalogueProduct[] = [];
  for (const [model, ps] of byModel) if (ps.length === 1 && padded.includes(` ${model} `)) hits.push(ps[0]!);
  return hits.slice(0, 4);
}

function productLine(p: CatalogueProduct): string {
  const price = unitPrice(p);
  const priceText = price === null ? 'price on request' : `${inr(price)} per unit`;
  const bits = [`${p.name}: ${priceText}, minimum ${p.moq} units`];
  if (p.branding_possible) bits.push('can carry your logo');
  if ((p.ready_stock ?? 0) > 0) bits.push('in ready stock');
  if (p.colours?.length) bits.push(`colours: ${p.colours.slice(0, 5).join(', ')}`);
  return bits.join(' · ') + '. GST, branding and shipping are added at checkout.';
}

function leadLine(q: ParsedRequest, rec: Recommendation, collections: Cols | undefined, prefix: string, adj = ''): string {
  // Only name the kinds we actually found; anything else is "similar items".
  const found = q.kinds.filter((k) => rec.picks.some((p) => matchesKind(p, k)));
  const others = rec.picks.some((p) => !found.some((k) => matchesKind(p, k)));
  const what =
    adj + (found.length ? found.map((k) => KINDS[k]!.label).join(', ').replace(/, ([^,]*)$/, ' and $1') + (others ? ' and similar items' : '') : 'gift ideas');
  const parts: string[] = [];
  if (q.collections.length) parts.push(`for ${q.collections.map((c) => occasionLabel(c, collections)).join(' / ')}`);
  if (q.approx !== null) parts.push(`around ${inr(q.approx)}`);
  else if (q.minPrice > 0 && Number.isFinite(q.maxPrice)) parts.push(`between ${inr(q.minPrice)} and ${inr(q.maxPrice)}`);
  else if (Number.isFinite(q.maxPrice)) parts.push(`under ${inr(q.maxPrice)}`);
  else if (q.minPrice > 0) parts.push(`from ${inr(q.minPrice)}`);
  if (q.quantity) parts.push(`for ${q.quantity.toLocaleString('en-IN')} people`);
  const n = rec.picks.length;
  const more = rec.matched > n ? ` ${rec.matched} fit in total, so tap "Show more" to see others.` : '';
  return `${prefix}Here ${n === 1 ? 'is 1 pick' : `are ${n} ${what}`}${parts.length ? ' ' + parts.join(' ') : ''}.${more} Tap any you don't want to drop it.`;
}

function text(lines: string[], quick: QuickReply[] = [], parsed: ParsedRequest | null = null): BotReply {
  return { text: lines, chips: [], rec: null, ask: null, parsed, quick };
}

// --- main ----------------------------------------------------------------------

export function respond(message: string, ctx: ChatContext, products: CatalogueProduct[], collections?: Cols): { reply: BotReply; ctx: ChatContext } {
  const raw = message.trim().slice(0, 300);
  const t = normalise(raw).replace(//g, '').replace(/[!?.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const keep = (reply: BotReply, next: ChatContext = ctx) => ({ reply, ctx: next });

  if (!t) return keep(text(['Tell me what you are gifting for, your budget per gift and how many you need.'], EXAMPLES));

  // Answer to "is 500 the budget or the number of gifts?"
  if (ctx.pending) {
    const asPrice = /\b(budget|price|per gift|per person|each|rs|rupees|₹|cost|amount|money|first)\b/.test(t);
    const asQty = /\b(people|employees|qty|quantity|pieces|units|gifts|count|number of|persons|staff|team|second)\b/.test(t);
    if (asPrice !== asQty && parseRequest(raw).ambiguous.length === 0 && !hasBudget(parseRequest(raw))) {
      const q = resolveAmbiguity(ctx.pending, asPrice ? 'price' : 'qty');
      return runRequest(products, collections, q, { ...ctx, pending: null }, 'Got it! ');
    }
  }

  if (RESET.test(t)) {
    const rest = t.replace(RESET, ' ').trim();
    if (!hasContent(parseRequest(rest))) return keep(text(["Sure, let's start fresh. What are you gifting for?"], EXAMPLES), EMPTY_CONTEXT);
    ctx = EMPTY_CONTEXT;
  }
  // Cost, margin or supplier questions: never answered, whoever asks and however it is phrased.
  if (COST_PROBE.test(t) && !/\b(landing|ingst|exgst)\b/.test(t.replace(COST_PROBE, ''))) {
    const named = findProducts(products, t.replace(COST_PROBE, ' '));
    const lines = named.length ? [COST_REPLY, ...named.slice(0, 2).map(productLine)] : [COST_REPLY];
    return keep(text(lines, ctx.q ? AFTER_PICKS : EXAMPLES));
  }
  // Unrelated requests get a polite steer back, never an answer.
  if (ALWAYS_DECLINE.test(t)) return keep(text([REFUSAL], EXAMPLES));
  if (TRIVIA.test(t) && !GIFTY.test(t)) return keep(text([REFUSAL], EXAMPLES));
  if (OFF_TOPIC_HARD.test(t)) {
    const pre = parseRequest(raw);
    if (!GIFTY.test(t) && !hasCore(pre)) return keep(text([REFUSAL], EXAMPLES));
  }
  if (GREETING.test(t)) {
    return keep(text(["Hi there! 👋 I'm the Swagarage gift assistant. Tell me the occasion, your budget per gift and how many you need, and I'll shortlist gifts for you."], EXAMPLES));
  }
  if (THANKS.test(t)) return keep(text(["You're welcome! 😊 Want me to look for anything else? When you're ready, add your picks to a quote or download them as a catalogue PPT."]));
  if (ACK.test(t)) return keep(text([ctx.q ? 'Great! Tell me if you want cheaper options, something more premium, or a different kind of gift.' : 'Great! What are you gifting for?'], ctx.q ? AFTER_PICKS : EXAMPLES));
  if (BYE.test(t)) return keep(text(['Thanks for stopping by! 🎁 Your shortlist stays here if you want to add it to a quote.']));
  if (WHO.test(t)) return keep(text(["I'm Swagarage's gift assistant, an automated helper (not a person). I search our catalogue to suggest corporate gifts. For anything I can't answer, our team will help you once you request a quote."], EXAMPLES));
  if (HELP.test(t)) {
    return keep(
      text(
        [
          'I can shortlist corporate gifts for you. Just tell me in your own words, for example "something nice for 3k for 50 ppl" or "Diwali hampers under 1500".',
          'You can then say "cheaper", "show more" or "what about bags", download the picks as a catalogue PPT, or add them to a quote.',
        ],
        EXAMPLES,
      ),
    );
  }

  let q0 = parseRequest(raw);
  // "can you deboss our logo on these?" in a conversation is a change to the request, not a general question.
  const contentful = hasContent(q0) || (!!ctx.q && !!q0.branding);
  let faqHits = FAQ.filter((f) => f.re.test(t) && !(f.covered && contentful));
  // A specific answer replaces the general delivery one ("ship to 12 cities").
  if (faqHits.length > 1) faqHits = faqHits.filter((f) => !f.covered || faqHits.every((g) => g.covered));
  const faq = faqHits.map((f) => f.answer(products));

  if (CATALOGUE_Q.test(t) && !hasContent(q0)) {
    const cats = new Map<string, number>();
    for (const p of products) cats.set(p.category.name, (cats.get(p.category.name) ?? 0) + 1);
    const brands = [...new Set(products.map((p) => p.brand).filter(Boolean))].slice(0, 8);
    return keep(
      text(
        [
          `We have ${products.length} products: ${[...cats].map(([c, n]) => `${c} (${n})`).join(', ')}.`,
          brands.length ? `Brands include ${brands.join(', ')}. Tell me your occasion and budget and I'll pick the best ones.` : "Tell me your occasion and budget and I'll pick the best ones.",
        ],
        EXAMPLES,
      ),
    );
  }

  // A product asked about by name.
  const named = findProducts(products, t);
  if (named.length && !hasBudget(q0) && !q0.kinds.length) {
    const rec: Recommendation = { picks: named, notes: [], suggestion: null, matched: named.length, alternative: false };
    return keep({ text: [...faq, ...named.map(productLine)], chips: [], rec, ask: null, parsed: null, quick: [] }, ctx);
  }

  if (faq.length && !contentful) return keep(text(faq, ctx.q ? AFTER_PICKS : EXAMPLES));

  // Follow-ups on the current request.
  const prev = ctx.q;
  if (prev) {
    const cheaper = CHEAPER.test(t);
    const premium = !cheaper && PREMIUM.test(t);
    const more = !cheaper && !premium && MORE.test(t) && !hasContent(q0) && !q0.terms.length;
    const shownPrices = ctx.shown.map((id) => products.find((p) => p.id === id)).map((p) => (p ? unitPrice(p) : null)).filter((x): x is number => x !== null);
    const avg = shownPrices.length ? shownPrices.reduce((a, b) => a + b, 0) / shownPrices.length : null;
    if (more) return runRequest(products, collections, prev, ctx, 'Sure! ', new Set(ctx.shown), 'more ');
    // "premium"/"cheap" here describe price, not the Premium Client Gifts occasion.
    const keepOccasion = (q: ParsedRequest): ParsedRequest => ({ ...q, collections: prev.collections });
    if (cheaper) {
      const cap = Math.max(1, Math.floor(Math.min(Number.isFinite(prev.maxPrice) ? prev.maxPrice : Infinity, avg ? avg * 0.75 : Infinity)));
      const q: ParsedRequest = keepOccasion({ ...mergeRequest(prev, q0, t), minPrice: 0, maxPrice: Number.isFinite(cap) ? cap : prev.maxPrice, approx: null, totalBudget: null, prefer: 'low' });
      return runRequest(products, collections, q, ctx, 'Sure! ', undefined, 'more affordable ');
    }
    if (premium) {
      const top = shownPrices.length ? Math.max(...shownPrices) : 0;
      const floor = Math.round(Math.max(prev.minPrice, top + 1, avg ? avg * 1.3 : 2000));
      const q: ParsedRequest = keepOccasion({ ...mergeRequest(prev, q0, t), minPrice: floor, maxPrice: Infinity, approx: null, totalBudget: null, prefer: 'high' });
      return runRequest(products, collections, q, ctx, 'Sure! ', undefined, 'more premium ');
    }
    const fresh = q0.collections.length > 0 && (hasBudget(q0) || q0.kinds.length > 0);
    if (!fresh && (contentful || q0.terms.length || NO_BUDGET.test(t) || (q0.notKinds ?? []).length)) {
      q0 = mergeRequest(prev, q0, t);
      return runRequest(products, collections, q0, ctx, faq.length ? faq.join(' ') + ' ' : '');
    }
  }

  // Nothing understood and nothing that sounds like a gift request.
  const knownTerm = q0.terms.some((w) => {
    const re = new RegExp(`\\b${w.replace(/s$/, '')}s?\\b`);
    return products.some((p) => re.test(`${p.name} ${p.subcategory} ${p.category.name} ${p.brand ?? ''}`.toLowerCase()));
  });
  if (OFF_TOPIC_SOFT.test(t) && !hasCore(q0) && !knownTerm && !GIFTY.test(t) && !q0.ambiguous.length) {
    return keep(text([REFUSAL], EXAMPLES));
  }
  if (!hasContent(q0) && !knownTerm && !GIFT_INTENT.test(t) && !q0.ambiguous.length && !(q0.notKinds ?? []).length) {
    return keep(
      text(
        [
          "Sorry, I didn't quite get that. 😅 I can help with our catalogue and your gifting needs.",
          'Try telling me the occasion, budget per gift and how many you need, like "something nice for 3k for 50 people".',
        ],
        EXAMPLES,
      ),
    );
  }

  return runRequest(products, collections, q0, { ...EMPTY_CONTEXT }, faq.length ? faq.join(' ') + ' ' : '');
}

/** Recommends for a request and returns the reply plus the new context. Also used for suggestion buttons. */
export function runRequest(
  products: CatalogueProduct[],
  collections: Cols | undefined,
  q: ParsedRequest,
  base: ChatContext = EMPTY_CONTEXT,
  prefix = '',
  exclude?: Set<string>,
  adj = '',
): { reply: BotReply; ctx: ChatContext } {
  const chips = describe(q, collections);
  if (q.ambiguous.length) {
    return {
      reply: { text: [prefix.trim()].filter(Boolean), chips, rec: null, ask: q.ambiguous[0]!, parsed: q, quick: [] },
      ctx: { ...base, pending: q },
    };
  }
  const rec = recommend(products, q, 8, collections, { exclude });
  if (exclude && rec.picks.length === 0) {
    return {
      reply: text([`That's everything I have for this request. Want to try a different budget or kind of gift?`], [AFTER_PICKS[1]!, AFTER_PICKS[2]!], q),
      ctx: { ...base, q, pending: null },
    };
  }
  const lines: string[] = [];
  if (rec.picks.length && !rec.alternative) lines.push(leadLine(q, rec, collections, prefix, adj));
  else if (prefix.trim() && !/^(Sure|Got it)/.test(prefix.trim())) lines.push(prefix.trim());
  const shown = exclude ? [...exclude, ...rec.picks.map((p) => p.id)] : rec.picks.map((p) => p.id);
  return {
    reply: { text: lines, chips, rec, ask: null, parsed: q, quick: rec.picks.length ? AFTER_PICKS : rec.suggestion ? [] : EXAMPLES },
    ctx: { q, shown, pending: null },
  };
}
