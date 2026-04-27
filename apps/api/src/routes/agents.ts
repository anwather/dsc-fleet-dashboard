import type { FastifyPluginAsync } from 'fastify';
import { notImplemented } from './_stub.js';

const route: FastifyPluginAsync = async (app) => {
  app.post('/register', notImplemented('agentRegister'));
  app.get('/:agentId/assignments', notImplemented('agentAssignments'));
  app.get('/:agentId/revisions/:revId', notImplemented('agentRevision'));
  app.post('/:agentId/results', notImplemented('agentResults'));
  app.post('/:agentId/heartbeat', notImplemented('agentHeartbeat'));
  app.post('/:agentId/removal-ack', notImplemented('agentRemovalAck'));
};

export default route;
