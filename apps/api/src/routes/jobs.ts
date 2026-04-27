import type { FastifyPluginAsync } from 'fastify';
import { notImplemented } from './_stub.js';

const route: FastifyPluginAsync = async (app) => {
  app.get('/', notImplemented('listJobs'));
  app.get('/:id', notImplemented('getJob'));
};

export default route;
