// "Enquire on WhatsApp": opens a chat with the Swagarage team, with the message already typed.
// The number comes from VITE_WHATSAPP_NUMBER (a GitHub Actions variable). No number → no button.
import { absoluteUrl } from './router';

function normalise(raw: string | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`; // Indian mobile without country code
  if (digits.length >= 11 && digits.length <= 15) return digits.replace(/^0+/, '');
  return null;
}

export const WHATSAPP_NUMBER = normalise(import.meta.env.VITE_WHATSAPP_NUMBER as string | undefined);

export function whatsappLink(text: string): string | null {
  if (!WHATSAPP_NUMBER) return null;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text.slice(0, 1500))}`;
}

export function productEnquiry(p: { name: string; slug: string }, quantity: number): string | null {
  return whatsappLink(
    `Hi Swagarage, I'd like a quote for ${p.name}, ${quantity} units.\n${absoluteUrl(`/product/${p.slug}`)}`,
  );
}

export const _test = { normalise };
