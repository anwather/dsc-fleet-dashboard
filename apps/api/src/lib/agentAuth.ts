/**
 * Bearer-token auth for /api/agents/:agentId/* routes.
 *
 * The plaintext agent_api_key is only ever returned once (at register time).
 * We store sha256(key) in `agent_keys.key_hash` and compare hashes here.
 *
 * Flow:
 *   1. Look up the server by agentId (from URL).
 *   2. Hash the supplied bearer token.
 *   3. Find a matching, non-revoked agent_keys row for that server.
 *   4. Update last_used_at and decorate the request with { server, agentKey }.
 *
 * On mismatch we 401; on missing server we 404.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Server, AgentKey } from '@prisma/client';
import { prisma } from './prisma.js';

declare module 'fastify' {
  interface FastifyRequest {
    dscServer?: Server;
    dscAgentKey?: AgentKey;
  }
}

export function hashAgentKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

interface AgentParams {
  agentId: string;
}

export async function authenticateAgent(
  req: FastifyRequest<{ Params: AgentParams }>,
  reply: FastifyReply,
): Promise<void> {
  const agentId = req.params.agentId;
  if (!agentId) {
    return reply.status(400).send({ error: 'BadRequest', message: 'agentId required' });
  }

  const auth = req.headers['authorization'];
  if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Bearer token required' });
  }
  const token = auth.slice(7).trim();
  if (!token) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Empty bearer token' });
  }

  const server = await prisma.server.findUnique({ where: { agentId } });
  if (!server || server.deletedAt) {
    return reply.status(404).send({ error: 'NotFound', message: 'agent unknown' });
  }

  const tokenHash = hashAgentKey(token);
  const keys = await prisma.agentKey.findMany({
    where: { serverId: server.id, revokedAt: null },
  });
  const match = keys.find((k) => constantTimeEq(k.keyHash, tokenHash));
  if (!match) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'invalid agent key' });
  }

  prisma.agentKey
    .update({ where: { id: match.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => req.log.warn({ err }, 'failed to update agent key last_used_at'));

  req.dscServer = server;
  req.dscAgentKey = match;
}
