/**
 * Single shared WebSocket connection with topic-based subscribe/unsubscribe.
 *
 * - One connection for the whole app (mounted via <WsTopicsRoot/> in App).
 * - Pages call `useWsTopic(topic, handler)` to subscribe; on unmount
 *   the topic ref-count is decremented and unsubscribed when it hits 0.
 * - Reconnect with exponential backoff (max 30s).
 * - On reconnect: invalidate every active TanStack Query (pages re-fetch)
 *   per the architecture decision (WS = invalidation trigger, DB = source of truth).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEvent } from '@dsc-fleet/shared-types';
import { getApiAccessToken } from '@/lib/authToken';

type Handler = (ev: WsEvent) => void;

interface WsApi {
  subscribe(topic: string, handler: Handler): () => void;
  send(action: 'subscribe' | 'unsubscribe', topic: string): void;
}

const WsCtx = createContext<WsApi | null>(null);

function buildWsUrl(token: string): string {
  const explicit = import.meta.env.VITE_WS_PATH;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = explicit ?? '/ws';
  return `${proto}//${window.location.host}${path}?access_token=${encodeURIComponent(token)}`;
}

export function WsTopicsRoot({ children }: PropsWithChildren) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<Handler>>>(new Map());
  const refCountsRef = useRef<Map<string, number>>(new Map());
  const reconnectAttemptRef = useRef(0);
  const closedByUserRef = useRef(false);
  const queryClient = useQueryClient();

  const sendRaw = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    if (closedByUserRef.current) return;
    // Acquire fresh token, then open the socket. If acquisition fails or
    // triggers a redirect, just bail — auth state will resolve and the next
    // attempt will succeed.
    getApiAccessToken()
      .then((token) => {
        if (closedByUserRef.current) return;
        let ws: WebSocket;
        try {
          ws = new WebSocket(buildWsUrl(token));
        } catch (e) {
          console.warn('ws ctor failed', e);
          scheduleReconnect();
          return;
        }
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectAttemptRef.current = 0;
          for (const topic of handlersRef.current.keys()) {
            sendRaw({ action: 'subscribe', topic });
          }
          queryClient.invalidateQueries();
        };

        ws.onmessage = (e) => {
          let ev: WsEvent;
          try {
            ev = JSON.parse(typeof e.data === 'string' ? e.data : '');
          } catch {
            return;
          }
          const set = handlersRef.current.get(ev.topic);
          if (set) {
            for (const h of set) {
              try {
                h(ev);
              } catch (err) {
                console.warn('ws handler error', err);
              }
            }
          }
          const wildcards = handlersRef.current.get('*');
          if (wildcards) {
            for (const h of wildcards) h(ev);
          }
        };

        ws.onclose = (ev) => {
          wsRef.current = null;
          // 4401 = our custom "auth failed" close. Force a fresh token on
          // the next attempt by relying on getApiAccessToken's silent path.
          if (ev.code === 4401) {
            console.warn('ws closed: auth rejected, will reacquire token');
          }
          scheduleReconnect();
        };
        ws.onerror = () => {
          // onclose follows.
        };
      })
      .catch((err) => {
        console.warn('ws token acquisition failed', err);
        scheduleReconnect();
      });
  }, [queryClient, sendRaw]);

  const scheduleReconnect = useCallback(() => {
    if (closedByUserRef.current) return;
    const attempt = ++reconnectAttemptRef.current;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    setTimeout(connect, delay);
  }, [connect]);

  useEffect(() => {
    closedByUserRef.current = false;
    connect();
    return () => {
      closedByUserRef.current = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const api: WsApi = useMemo(
    () => ({
      subscribe(topic, handler) {
        let handlers = handlersRef.current.get(topic);
        if (!handlers) {
          handlers = new Set();
          handlersRef.current.set(topic, handlers);
        }
        handlers.add(handler);

        const prev = refCountsRef.current.get(topic) ?? 0;
        refCountsRef.current.set(topic, prev + 1);
        if (prev === 0 && topic !== '*') {
          sendRaw({ action: 'subscribe', topic });
        }

        return () => {
          handlers!.delete(handler);
          const next = (refCountsRef.current.get(topic) ?? 1) - 1;
          if (next <= 0) {
            refCountsRef.current.delete(topic);
            handlersRef.current.delete(topic);
            if (topic !== '*') sendRaw({ action: 'unsubscribe', topic });
          } else {
            refCountsRef.current.set(topic, next);
          }
        };
      },
      send(action, topic) {
        sendRaw({ action, topic });
      },
    }),
    [sendRaw],
  );

  return <WsCtx.Provider value={api}>{children}</WsCtx.Provider>;
}

export function useWs(): WsApi {
  const ctx = useContext(WsCtx);
  if (!ctx) throw new Error('useWs must be used inside <WsTopicsRoot>');
  return ctx;
}

/**
 * Subscribe to a topic for the lifetime of the calling component.
 * `handler` is wrapped in a ref so updating it doesn't unsubscribe.
 */
export function useWsTopic(topic: string | null, handler: Handler) {
  const ws = useWs();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!topic) return;
    return ws.subscribe(topic, (ev) => handlerRef.current(ev));
  }, [ws, topic]);
}
