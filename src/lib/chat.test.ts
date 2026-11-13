import { describe, expect, it } from 'vitest';
import { EMPTY_CONTEXT, respond, type BotReply, type ChatContext } from './chat';
import { unitPrice } from './format';
import type { CatalogueProduct } from './types';
import fixture from './__fixtures__/catalogue.json';

const products = fixture.products as unknown as CatalogueProduct[];
const collections = fixture.collections;

/** Plays a whole conversation and returns every reply. */
function chat(...messages: string[]): BotReply[] {
  let ctx: ChatContext = EMPTY_CONTEXT;
  const out: BotReply[] = [];
  for (const m of messages) {
    const r = respond(m, ctx, products, collections);
    ctx = r.ctx;
    out.push(r.reply);
  }
  return out;
}
const say = (m: string) => chat(m)[0]!;
const prices = (r: BotReply) => (r.rec?.picks ?? []).map((p) => unitPrice(p)!);

describe('texting language', () => {
  it('"Give me something nice for 3k w" → budget ₹3,000', () => {
    const r = say('Give me something nice for 3k w');
    expect(r.chips).toEqual(['Up to ₹3,000 per gift']);
    expect(prices(r).length).toBe(8);
    expect(prices(r).every((p) => p <= 3000)).toBe(true);
  });
  const cases: [string, string[]][] = [
    ['smthng for 3k', ['Up to ₹3,000 per gift']],
    ['need gifts for 20 ppl under 2k pls', ['Up to ₹2,000 per gift', '20 units']],
    ['bday gifts for my team of 15 undr 1500', ['Up to ₹1,500 per gift', '15 units']],
    ['500 tak ka gift 100 log ke liye', ['Up to ₹500 per gift', '100 units']],
    ['1000 ke andar bags chahiye', ['Up to ₹1,000 per gift', 'Bags']],
    ['b/w 500 n 1000', ['₹500–₹1,000 per gift']],
    ['abv 4k client gifts', ['From ₹4,000 per gift', 'Premium Client Gifts']],
    ['diwali hampers 2k each for 200 emps', ['Up to ₹2,000 per gift', '200 units', 'Diwali & Festive']],
    ['gifts for new joinees, budjet 1.5k', ['Up to ₹1,500 per gift', 'Employee Welcome Kits']],
    ['tech gifts but no speakers under 3k', ['Up to ₹3,000 per gift', 'Tech & gadgets', 'No speakers']],
    ['bags beda, 800 olage', ['Up to ₹800 per gift', 'No bags']],
    ['ANY GOOD GIFTS UNDER 1K??', ['Up to ₹1,000 per gift']],
  ];
  for (const [msg, chips] of cases) {
    it(msg, () => {
      const r = say(msg);
      expect(r.chips).toEqual(chips);
      expect(r.rec !== null && (r.rec.picks.length > 0 || r.rec.notes.length > 0)).toBe(true);
    });
  }
  it('"no speakers" really removes speakers', () => {
    const r = say('tech gifts but no speakers under 3k');
    expect(r.rec!.picks.some((p) => p.subcategory === 'Speakers')).toBe(false);
  });
});

describe('small talk', () => {
  it('greets', () => {
    for (const m of ['hi', 'Hii', 'hello!', 'hey there', 'good morning', 'namaste']) {
      const r = say(m);
      expect(r.text[0]).toMatch(/^Hi there!/);
      expect(r.rec).toBe(null);
      expect(r.quick.length > 0).toBe(true);
    }
  });
  it('thanks / ok / bye', () => {
    expect(say('thanks!').text[0]).toMatch(/^You're welcome/);
    expect(say('thx').text[0]).toMatch(/^You're welcome/);
    expect(say('ok').text[0]).toMatch(/^Great!/);
    expect(say('bye').text[0]).toMatch(/^Thanks for stopping by/);
  });
  it('who are you / help', () => {
    expect(say('are you a bot?').text[0]).toMatch(/automated helper/);
    expect(say('what can you do').text[0]).toMatch(/shortlist corporate gifts/);
  });
  it('off-topic gets a gentle steer, not random products', () => {
    const r = say("what's the weather today");
    expect(r.rec).toBe(null);
    expect(r.text[0]).toMatch(/^Sorry, I can only help with Swagarage's catalogue and your gifting needs/);
  });
});

describe('questions', () => {
  it('MOQ', () => expect(say('what is the minimum order?').text[0]).toMatch(/minimum order is 25 units/));
  it('delivery', () => expect(say('how long does delivery take').text[0]).toMatch(/Delivery time depends/));
  it('branding', () => expect(say('can you print our logo?').text[0]).toMatch(/can carry your logo/));
  it('GST', () => expect(say('is gst included?').text[0]).toMatch(/\+ GST/));
  it('talk to a person', () => expect(say('can i talk to someone').text[0]).toMatch(/team is happy to help/));
  it('catalogue overview', () => expect(say('what do you have?').text[0]).toMatch(/^We have 135 products/));
  it('question + request answers both', () => {
    const r = say('can you put our logo on bags under 1000');
    expect(r.rec!.notes.join(' ')).toMatch(/can carry your logo/);
    expect(prices(r).length > 0 && prices(r).every((p) => p <= 1000)).toBe(true);
  });
});

describe('products by name', () => {
  it('tell me about the oblique flyt', () => {
    const r = say('tell me about oblique flyt');
    expect(r.rec!.picks.map((p) => p.name)).toEqual(['Oblique Flyt']);
    expect(r.text[0]).toMatch(/^Oblique Flyt: ₹299 per unit/);
  });
  it('model name alone', () => {
    expect(say('soundbolt').rec!.picks.map((p) => p.name)).toEqual(['Toreto Soundbolt']);
  });
  it('Jolly does not also return Jolly+', () => {
    expect(say('price of toreto jolly+').rec!.picks.map((p) => p.name)).toEqual(['Toreto Jolly+']);
  });
});

describe('conversation memory', () => {
  it('follow-up changes only what is said', () => {
    const [a, b, c, d] = chat('diwali gifts under 3k for 100 ppl', 'what about speakers', 'for 50 people instead', 'under 2000');
    expect(a!.chips).toEqual(['Up to ₹3,000 per gift', '100 units', 'Diwali & Festive']);
    expect(b!.chips).toEqual(['Up to ₹3,000 per gift', '100 units', 'Diwali & Festive', 'Speakers']);
    expect(b!.rec!.picks.every((p) => p.subcategory === 'Speakers')).toBe(true);
    expect(c!.chips).toEqual(['Up to ₹3,000 per gift', '50 units', 'Diwali & Festive', 'Speakers']);
    expect(d!.chips).toEqual(['Up to ₹2,000 per gift', '50 units', 'Diwali & Festive', 'Speakers']);
    expect(prices(d!).every((p) => p <= 2000)).toBe(true);
  });
  it('show more brings new products, then says when done', () => {
    const replies = chat('gifts under 500', 'show more', 'more', 'more');
    const seen = replies.flatMap((r) => r.rec?.picks.map((p) => p.id) ?? []);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(12); // exactly the 12 products under ₹500
    expect(replies[3]!.text[0]).toMatch(/That's everything I have/);
  });
  it('cheaper and more premium', () => {
    const [a, b, c] = chat('gifts under 3000', 'too expensive', 'something more premium');
    const avg = (r: BotReply) => prices(r).reduce((x, y) => x + y, 0) / prices(r).length;
    expect(avg(b!) < avg(a!)).toBe(true);
    expect(b!.text[0]).toMatch(/^Sure! Here are 8 more affordable gift ideas/);
    expect(c!.text[0]).toMatch(/^Sure! Here are 8 more premium gift ideas/);
    expect(Math.min(...prices(c!)) > Math.max(...prices(b!))).toBe(true);
  });
  it('also / add keeps earlier kinds', () => {
    const [, b] = chat('backpacks under 2500', 'add earbuds too');
    expect(b!.chips).toEqual(['Up to ₹2,500 per gift', 'Backpacks', 'Earbuds & headphones']);
  });
  it('a full new request starts fresh', () => {
    const [, b] = chat('speakers under 3000 for 50', 'eco friendly gifts under 500');
    expect(b!.chips).toEqual(['Up to ₹500 per gift', 'Eco-Friendly Gifts']);
  });
  it('start over clears it', () => {
    const [, b, c] = chat('speakers under 3000', 'start over', 'under 1000');
    expect(b!.text[0]).toMatch(/start fresh/);
    expect(c!.chips).toEqual(['Up to ₹1,000 per gift']);
  });
  it('answers the budget-or-quantity question in words', () => {
    const [a, b] = chat('gifts 500', 'its the budget');
    expect(a!.ask).toBe(500);
    expect(b!.chips).toEqual(['Up to ₹500 per gift']);
    const [, c] = chat('gifts 500', '500 people');
    expect(c!.chips).toEqual(['500 units']);
  });
  it('no budget clears the budget', () => {
    const [, b] = chat('bags under 1000', 'budget no bar');
    expect(b!.chips).toEqual(['Bags']);
  });
});

describe('never breaks', () => {
  it('random chatter in a conversation', () => {
    const msgs = ['hi', 'hmm', '', '   ', '???', 'lol', 'gifts', 'under', '₹', 'more', 'cheaper', 'show more', 'ok', 'thanks', 'diwali', '50', 'premium', 'no', 'yes', 'bags nahi', '<b>hi</b>', '9'.repeat(50), 'reset', 'something nice'];
    let ctx: ChatContext = EMPTY_CONTEXT;
    for (let i = 0; i < 400; i++) {
      const m = msgs[(i * 7) % msgs.length]!;
      const r = respond(m, ctx, products, collections);
      ctx = r.ctx;
      const said = r.reply.text.length + (r.reply.rec?.picks.length ?? 0) + (r.reply.rec?.notes.length ?? 0) + (r.reply.ask ? 1 : 0);
      if (said === 0) throw new Error(`said nothing to "${m}"`);
      const q = r.reply.parsed;
      for (const p of r.reply.rec?.picks ?? []) {
        const pr = unitPrice(p);
        if (q && pr !== null && (pr > q.maxPrice || pr < q.minPrice) && !r.reply.text.some((x) => /:/.test(x))) throw new Error(`over budget after "${m}"`);
      }
    }
  });
});
