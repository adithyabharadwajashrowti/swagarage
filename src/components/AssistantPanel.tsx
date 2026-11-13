import { useEffect, useRef, useState } from 'react';
import { type ParsedRequest } from '../lib/assistant';
import { useAuth } from '../lib/auth';
import { useCart } from '../lib/cart';
import { useCatalogue } from '../lib/catalogue';
import { EMPTY_CONTEXT, respond, runRequest, type BotReply, type ChatContext } from '../lib/chat';
import { buildCatalogueDeck, downloadBlob } from '../lib/deck';
import { inr, unitPrice } from '../lib/format';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import type { CatalogueProduct } from '../lib/types';
import { ProductImage } from './ui';

type Msg =
  | { id: number; from: 'user'; text: string }
  | { id: number; from: 'bot'; reply: BotReply; off: Set<string>; title: string };

const EXAMPLES = [
  'Diwali gifts under ₹3000 for 200 employees',
  'Onboarding kit for 50 new hires, laptop bag and tech',
  'Something nice for 3k for our clients',
  'Gifts under ₹500 for 100 people',
];

export function AssistantPanel() {
  const { products, collections, loading } = useCatalogue();
  const { session } = useAuth();
  const cart = useCart();
  const toast = useToast();
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const ctx = useRef<ChatContext>(EMPTY_CONTEXT);
  const nextId = useRef(1);
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Keep the newest message in view (inside the chat box only, not the page).
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  function logLead(query: string, picks: CatalogueProduct[]) {
    if (session && picks.length) {
      // Lead signal for the team; failures are ignored on purpose.
      void supabase.rpc('log_assistant_request', { p_query: query.slice(0, 300), p_product_ids: picks.map((p) => p.id) });
    }
  }

  function push(userText: string | null, result: { reply: BotReply; ctx: ChatContext }, title: string) {
    ctx.current = result.ctx;
    const add: Msg[] = [];
    if (userText) add.push({ id: nextId.current++, from: 'user', text: userText });
    add.push({ id: nextId.current++, from: 'bot', reply: result.reply, off: new Set(), title });
    setMsgs((m) => [...m, ...add].slice(-60));
    logLead(title, result.reply.rec?.picks ?? []);
  }

  /** `send` is what the assistant reads; `shown` is what appears in the chat (for buttons). */
  function say(send: string, shown = send) {
    const text = send.trim().slice(0, 300);
    if (!text || loading) return;
    push(shown.trim().slice(0, 300), respond(text, ctx.current, products, collections), shown);
    setInput('');
  }

  function follow(label: string, q: ParsedRequest) {
    push(label, runRequest(products, collections, q, ctx.current, 'Sure! '), label);
  }

  function reset() {
    ctx.current = EMPTY_CONTEXT;
    setMsgs([]);
  }

  function toggle(msgId: number, productId: string) {
    setMsgs((ms) =>
      ms.map((m) => {
        if (m.id !== msgId || m.from !== 'bot') return m;
        const off = new Set(m.off);
        if (off.has(productId)) off.delete(productId);
        else off.add(productId);
        return { ...m, off };
      }),
    );
  }

  async function deck(m: Extract<Msg, { from: 'bot' }>) {
    const chosen = (m.reply.rec?.picks ?? []).filter((p) => !m.off.has(p.id));
    if (!chosen.length) return toast('Pick at least one product', 'error');
    setBusy(m.id);
    try {
      const blob = await buildCatalogueDeck(chosen, `Curated for: ${m.title}`);
      downloadBlob(blob, 'Swagarage_Catalogue.pptx');
    } catch {
      toast('Could not build the deck. Please try again.', 'error');
    } finally {
      setBusy(null);
    }
  }

  function addAll(m: Extract<Msg, { from: 'bot' }>) {
    const qty = m.reply.parsed?.quantity ?? 0;
    for (const p of (m.reply.rec?.picks ?? []).filter((x) => !m.off.has(x.id))) cart.add(p.id, Math.max(p.moq, qty));
    toast('Added to your quote', 'success');
  }

  const lastBot = [...msgs].reverse().find((m) => m.from === 'bot');

  return (
    <div className="asst">
      <div>
        <div className="kick" style={{ color: '#FF9A5C' }}>Gift Assistant</div>
        <h2>Tell us what you need.<br /><span>Get a ready catalogue deck.</span></h2>
        <p>Chat like you would with a person: occasion, budget per gift and how many. Say "cheaper", "show more" or "what about bags" to fine-tune, then download a Swagarage catalogue PPT.</p>
        <div className="ex">
          {EXAMPLES.map((e) => <button key={e} onClick={() => say(e)} disabled={loading}>{e}</button>)}
        </div>
      </div>
      <div className="chat">
        {msgs.length > 0 && (
          <div className="chat-top">
            <span>Gift Assistant</span>
            <button className="btn ghost sm" onClick={reset}>New chat</button>
          </div>
        )}
        <div className="msgs" aria-live="polite" ref={list}>
          <div className="m b">Hi! 👋 What are you gifting for? Tell me the occasion, budget per gift and how many you need. Talk to me like you'd text a friend.</div>
          {msgs.map((m) =>
            m.from === 'user' ? (
              <div key={m.id} className="m u">{m.text}</div>
            ) : (
              <BotMessage
                key={m.id}
                m={m}
                busy={busy === m.id}
                onToggle={(pid) => toggle(m.id, pid)}
                onDeck={() => void deck(m)}
                onAddAll={() => addAll(m)}
                onAsk={(send, shown) => say(send, shown)}
                onFollow={follow}
              />
            ),
          )}
        </div>
        {lastBot && lastBot.from === 'bot' && lastBot.reply.quick.length > 0 && (
          <div className="quick" aria-label="Suggestions">
            {lastBot.reply.quick.map((q) => <button key={q.label} onClick={() => say(q.send, q.label)}>{q.label}</button>)}
          </div>
        )}
        <form
          className="inrow"
          onSubmit={(e) => {
            e.preventDefault();
            say(input);
          }}
        >
          <label htmlFor="ask" className="sr-only">Message the Gift Assistant</label>
          <input id="ask" className="input" value={input} maxLength={300} onChange={(e) => setInput(e.target.value)} placeholder="e.g. something nice for 3k for 50 ppl" autoComplete="off" enterKeyHint="send" />
          <button className="btn pri sm" type="submit" disabled={loading || !input.trim()}>Send</button>
        </form>
      </div>
    </div>
  );
}

function BotMessage({
  m,
  busy,
  onToggle,
  onDeck,
  onAddAll,
  onAsk,
  onFollow,
}: {
  m: Extract<Msg, { from: 'bot' }>;
  busy: boolean;
  onToggle: (productId: string) => void;
  onDeck: () => void;
  onAddAll: () => void;
  onAsk: (send: string, shown: string) => void;
  onFollow: (label: string, q: ParsedRequest) => void;
}) {
  const { reply } = m;
  const rec = reply.rec;
  const picks = rec?.picks ?? [];
  return (
    <div style={{ display: 'contents' }}>
      {reply.chips.length > 0 && (
        <div className="m b understood" aria-label="What I understood">
          {reply.chips.map((c) => <span key={c} className="chip">{c}</span>)}
        </div>
      )}
      <div className={`m b ${picks.length ? 'wide' : ''}`}>
        {rec?.notes.map((n) => <div key={n} className="note">{n}</div>)}
        {reply.text.map((t) => <p key={t} className="line">{t}</p>)}
        {reply.ask !== null && (
          <>
            <p className="line">Is <b>{reply.ask}</b> your budget per gift, or the number of gifts you need?</p>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sec sm" onClick={() => onAsk('its the budget', `${inr(reply.ask)} per gift`)}>{inr(reply.ask)} per gift</button>
              <button className="btn sec sm" onClick={() => onAsk('number of gifts', `${reply.ask} gifts`)}>{reply.ask} gifts</button>
            </div>
          </>
        )}
        {rec && picks.length === 0 && reply.text.length === 0 && rec.notes.length === 0 && <p className="line">Sorry, I couldn't find a match for that right now.</p>}
        {rec && picks.length === 0 && (
          <p className="line">Try a different budget or kind of gift. Our team can also source it for you: just mention it in the notes when you request a quote.</p>
        )}
        {rec?.alternative && picks.length > 0 && <p className="line">But here {picks.length === 1 ? 'is something' : 'are some lovely gifts'} you might like instead. Tap any you don't want to drop it.</p>}
        {picks.length > 0 && (
          <>
            <div className="picks">
              {picks.map((p) => (
                <button key={p.id} className={`pk ${m.off.has(p.id) ? 'off' : ''}`} onClick={() => onToggle(p.id)} aria-pressed={!m.off.has(p.id)}>
                  <ProductImage path={p.image_path} alt="" />
                  <span><b>{p.name}</b>{inr(unitPrice(p))}</span>
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn blue sm" onClick={onDeck} disabled={busy}>{busy ? 'Building deck…' : 'Download catalogue PPT'}</button>
              <button className="btn sec sm" onClick={onAddAll}>Add all to quote</button>
            </div>
          </>
        )}
        {rec?.suggestion && (
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ghost sm" onClick={() => onFollow(rec.suggestion!.label, rec.suggestion!.query)}>{rec.suggestion.label}</button>
          </div>
        )}
      </div>
    </div>
  );
}
