import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { z } from 'zod';

export interface CartLine {
  productId: string;
  quantity: number;
  colour?: string;
  branding?: string;
}

const STORAGE_KEY = 'swagarage.quote.v1';
const lineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(100000),
  colour: z.string().max(60).optional(),
  branding: z.string().max(200).optional(),
});
const cartSchema = z.array(lineSchema).max(50);

function readCart(): CartLine[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = cartSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

interface CartState {
  lines: CartLine[];
  has: (productId: string) => boolean;
  add: (productId: string, quantity: number) => void;
  update: (productId: string, patch: Partial<Omit<CartLine, 'productId'>>) => void;
  remove: (productId: string) => void;
  clear: () => void;
}

const Ctx = createContext<CartState | null>(null);

export const MAX_CART_LINES = 50;

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(readCart);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      /* storage unavailable: cart lives in memory only */
    }
  }, [lines]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setLines(readCart());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const has = useCallback((id: string) => lines.some((l) => l.productId === id), [lines]);
  const add = useCallback((productId: string, quantity: number) => {
    setLines((ls) => {
      const existing = ls.find((l) => l.productId === productId);
      if (existing) return ls.map((l) => (l.productId === productId ? { ...l, quantity: Math.max(l.quantity, quantity) } : l));
      if (ls.length >= MAX_CART_LINES) return ls;
      return [...ls, { productId, quantity }];
    });
  }, []);
  const update = useCallback((productId: string, patch: Partial<Omit<CartLine, 'productId'>>) => {
    setLines((ls) => ls.map((l) => (l.productId === productId ? { ...l, ...patch } : l)));
  }, []);
  const remove = useCallback((productId: string) => setLines((ls) => ls.filter((l) => l.productId !== productId)), []);
  const clear = useCallback(() => setLines([]), []);

  const value = useMemo(() => ({ lines, has, add, update, remove, clear }), [lines, has, add, update, remove, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart(): CartState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCart outside CartProvider');
  return ctx;
}
