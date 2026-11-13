// Emails the Swagarage team when a new quote request arrives.
// Trigger: Supabase Database Webhook on INSERT into public.quotes, sending
// header "x-webhook-secret: <WEBHOOK_SECRET>". Email via Resend.
//
// Secrets (supabase secrets set ...):
//   WEBHOOK_SECRET      long random string, same value in the webhook header
//   RESEND_API_KEY      from resend.com
//   NOTIFY_EMAIL_TO     team inbox, e.g. orders@swagarage.in
//   NOTIFY_EMAIL_FROM   verified sender, e.g. "Swagarage <quotes@swagarage.in>"
//   SITE_URL            e.g. https://swagarage.in

const enc = new TextEncoder();

function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secret = Deno.env.get('WEBHOOK_SECRET') ?? '';
  const given = req.headers.get('x-webhook-secret') ?? '';
  if (secret.length < 24 || !safeEqual(given, secret)) return new Response('Unauthorized', { status: 401 });

  let payload: { type?: string; table?: string; record?: Record<string, unknown> };
  try {
    payload = await req.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  if (payload.type !== 'INSERT' || payload.table !== 'quotes' || !payload.record) return new Response('Ignored', { status: 200 });

  const q = payload.record;
  const site = Deno.env.get('SITE_URL') ?? '';
  const total = Number(q.estimate_total ?? 0).toLocaleString('en-IN');
  const html = `
    <h2>New quote request ${esc(q.ref)}</h2>
    <p><b>${esc(q.company)}</b> · ${esc(q.contact_name)} · ${esc(q.email)} · ${esc(q.phone ?? '')}</p>
    <p>Occasion: ${esc(q.occasion ?? '—')} · Needed by: ${esc(q.needed_by ?? '—')} · City: ${esc(q.delivery_city ?? '—')}</p>
    <p>Estimate (indicative): ₹${esc(total)}</p>
    <p><a href="${esc(site)}/admin/quotes/${esc(q.id)}">Open in admin</a></p>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: Deno.env.get('NOTIFY_EMAIL_FROM'),
      to: [Deno.env.get('NOTIFY_EMAIL_TO')],
      reply_to: String(q.email ?? ''),
      subject: `New quote request ${String(q.ref ?? '')} from ${String(q.company ?? '')}`.slice(0, 200),
      html,
    }),
  });
  if (!res.ok) {
    console.error('Resend error', res.status, await res.text());
    return new Response('Email failed', { status: 502 });
  }
  return new Response('ok', { status: 200 });
});
