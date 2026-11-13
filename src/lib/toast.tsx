import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Tone = 'info' | 'error' | 'success';
const Ctx = createContext<(message: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: Tone } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((message: string, tone: Tone = 'info') => {
    setToast({ message, tone });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className={`toast ${toast ? 'on' : ''} ${toast?.tone ?? ''}`} role="status" aria-live="polite">
        {toast?.message}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
