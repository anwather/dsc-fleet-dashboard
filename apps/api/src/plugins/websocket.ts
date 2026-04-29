/**
 * WebSocket plugin — topic-based broadcast.
 *
 * Clients connect to /ws?access_token=<entra-jwt> and send JSON frames:
 *   {"action":"subscribe","topic":"job:<id>"}
 *   {"action":"unsubscribe","topic":"server:<id>"}
 *
 * Server-side code calls `app.broadcast(topic, type, payload)` to push events
 * to every subscriber of `topic`. Persisted state in the DB remains the
 * source of truth — WS messages are an optimisation, not authoritative.
 *
 * Entra auth: the access_token query param is validated on connect. On
 * failure we close the socket with code 4401 (custom-application range).
 */
import fp from 'fastify-plugin';
import websocketPlugin, { type WebSocket } from '@fastify/websocket';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../lib/logger.js';
import { verifyEntraJwt } from '../lib/entraAuth.js';
import type { WsEvent } from '@dsc-fleet/shared-types';

interface ClientState {
  socket: WebSocket;
  topics: Set<string>;
}

declare module 'fastify' {
  interface FastifyInstance {
    broadcast(topic: string, type: string, payload: unknown): void;
  }
}

const wsPlugin: FastifyPluginAsync = async (app) => {
  await app.register(websocketPlugin, { options: { maxPayload: 1024 * 1024 } });

  // topic → Set<client>
  const subscriptions = new Map<string, Set<ClientState>>();
  const clients = new Set<ClientState>();

  function subscribe(client: ClientState, topic: string): void {
    if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
    subscriptions.get(topic)!.add(client);
    client.topics.add(topic);
  }

  function unsubscribe(client: ClientState, topic: string): void {
    subscriptions.get(topic)?.delete(client);
    client.topics.delete(topic);
  }

  function dropClient(client: ClientState): void {
    for (const topic of client.topics) {
      subscriptions.get(topic)?.delete(client);
    }
    clients.delete(client);
  }

  app.decorate('broadcast', (topic: string, type: string, payload: unknown) => {
    const subs = subscriptions.get(topic);
    if (!subs || subs.size === 0) return;
    const event: WsEvent = {
      topic,
      type,
      payload,
      ts: new Date().toISOString(),
    };
    const frame = JSON.stringify(event);
    for (const c of subs) {
      try {
        if (c.socket.readyState === c.socket.OPEN) c.socket.send(frame);
      } catch (err) {
        logger.warn({ err, topic }, 'ws send failed');
      }
    }
  });

  app.get(
    '/ws',
    {
      websocket: true,
      // Validate the Entra access token before the WebSocket upgrade. We use
      // an onRequest hook (not preHandler) because @fastify/websocket short-
      // circuits other lifecycle hooks for upgrade requests on some versions.
      onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
        const q = req.query as { access_token?: string };
        const token = typeof q?.access_token === 'string' ? q.access_token.trim() : '';
        if (!token) {
          return reply.status(401).send({ error: 'Unauthorized', message: 'access_token required' });
        }
        try {
          await verifyEntraJwt(token);
        } catch (err) {
          const reason = (err as Error).message;
          req.log.warn({ reason }, 'ws entra token rejected');
          return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token', reason });
        }
      },
    },
    (socket /* WebSocket */, req) => {
    const client: ClientState = { socket, topics: new Set() };
    clients.add(client);
    req.log.debug({ remote: req.ip }, 'ws client connected');

    socket.send(
      JSON.stringify({
        topic: 'system',
        type: 'welcome',
        payload: { msg: 'connected' },
        ts: new Date().toISOString(),
      } satisfies WsEvent),
    );

    socket.on('message', (raw: Buffer) => {
      let msg: { action?: string; topic?: string };
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!msg.topic || typeof msg.topic !== 'string') return;
      if (msg.action === 'subscribe') subscribe(client, msg.topic);
      else if (msg.action === 'unsubscribe') unsubscribe(client, msg.topic);
    });

    socket.on('close', () => {
      dropClient(client);
      req.log.debug('ws client disconnected');
    });
    socket.on('error', (err) => {
      req.log.warn({ err }, 'ws client error');
      dropClient(client);
    });
  });
};

export default fp(wsPlugin, { name: 'websocket' });
