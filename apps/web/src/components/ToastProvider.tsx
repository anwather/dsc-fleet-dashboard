import { createContext, useCallback, useContext, useState, type PropsWithChildren } from 'react';
import {
  ToastProviderRoot,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  type ToastVariant,
} from './ui/toast';

interface ToastMsg {
  id: number;
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastApi {
  toast(msg: Omit<ToastMsg, 'id'>): void;
}

const Ctx = createContext<ToastApi | null>(null);
let nextId = 1;

export function ToastProvider({ children }: PropsWithChildren) {
  const [items, setItems] = useState<ToastMsg[]>([]);

  const toast = useCallback((msg: Omit<ToastMsg, 'id'>) => {
    const id = nextId++;
    setItems((cur) => [...cur, { id, ...msg }]);
  }, []);

  const remove = useCallback((id: number) => {
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      <ToastProviderRoot swipeDirection="right" duration={5000}>
        {children}
        {items.map((t) => (
          <Toast
            key={t.id}
            variant={t.variant}
            onOpenChange={(open) => !open && remove(t.id)}
          >
            <div className="grid gap-0.5">
              <ToastTitle>{t.title}</ToastTitle>
              {t.description && <ToastDescription>{t.description}</ToastDescription>}
            </div>
            <ToastClose />
          </Toast>
        ))}
        <ToastViewport />
      </ToastProviderRoot>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
