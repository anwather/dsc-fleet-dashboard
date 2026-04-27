/**
 * WebSocket plugin — topic-based broadcast.
 *
 * Clients connect to /ws and send JSON frames:
 *   {"action":"subscribe","topic":"job:<id>"}
 *   {"action":"unsubscribe","topic":"server:<id>"}
 *
 * Server-side code calls `app.broadcast(topic, type, payload)` to push events
 * to every subscriber of `topic`. Persisted state in the DB remains the
 * source of truth — WS messages are an optimisation, not authoritative.
 */
import fp from 'fastify-plugin';
import websocketPlugin, { type WebSocket } from '@fastify/websocket';
import type { FastifyPluginAsync } from 'fastify';
import { logger } from '../lib/logger.js';
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

  app.get('/ws', { websocket: true }, (socket /* WebSocket */, req) => {
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
