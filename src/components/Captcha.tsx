import { useEffect, useRef } from 'react';

// Optional Cloudflare Turnstile bot protection for sign-up, sign-in and
// password reset. Enable by setting VITE_TURNSTILE_SITE_KEY and turning on
// Supabase > Authentication > Bot and Abuse Protection (Turnstile secret).
// Without the key this renders nothing and the forms work as before.

export const CAPTCHA_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || null;

interface Turnstile {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loader: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loader ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loader = null;
      reject(new Error('captcha failed to load'));
    };
    document.head.appendChild(s);
  });
  return loader;
}

/** Renders the widget and reports a fresh token (or null when it expires). */
export function Captcha({ onToken, resetKey }: { onToken: (t: string | null) => void; resetKey?: number }) {
  const box = useRef<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);

  useEffect(() => {
    if (!CAPTCHA_SITE_KEY) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !box.current || !window.turnstile) return;
        widget.current = window.turnstile.render(box.current, {
          sitekey: CAPTCHA_SITE_KEY,
          callback: (t: string) => onToken(t),
          'expired-callback': () => onToken(null),
          'error-callback': () => onToken(null),
        });
      })
      .catch(() => onToken(null));
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (resetKey && widget.current && window.turnstile) {
      window.turnstile.reset(widget.current);
      onToken(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  if (!CAPTCHA_SITE_KEY) return null;
  return <div ref={box} style={{ minHeight: 65 }} />;
}
