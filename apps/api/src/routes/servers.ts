import type { FastifyPluginAsync } from 'fastify';
import { notImplemented } from './_stub.js';

const route: FastifyPluginAsync = async (app) => {
  app.get('/', notImplemented('listServers'));
  app.post('/', notImplemented('createServer'));
  app.get('/:id', notImplemented('getServer'));
  app.patch('/:id', notImplemented('updateServer'));
  app.delete('/:id', notImplemented('deleteServer'));
  app.post('/:id/provision', notImplemented('provisionServer'));
  app.post('/:id/install-modules', notImplemented('installServerModules'));
  app.post('/:id/rotate-key', notImplemented('rotateServerKey'));
};

export default route;
