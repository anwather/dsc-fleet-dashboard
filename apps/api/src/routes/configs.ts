import type { FastifyPluginAsync } from 'fastify';
import { notImplemented } from './_stub.js';

const route: FastifyPluginAsync = async (app) => {
  app.get('/', notImplemented('listConfigs'));
  app.post('/', notImplemented('createConfig'));
  app.get('/:id', notImplemented('getConfig'));
  app.patch('/:id', notImplemented('updateConfig'));
  app.delete('/:id', notImplemented('deleteConfig'));
  app.get('/:id/revisions', notImplemented('listConfigRevisions'));
  app.get('/:id/revisions/:revId', notImplemented('getConfigRevision'));
  app.post('/parse', notImplemented('parseConfig'));
};

export default route;
