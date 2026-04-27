import type { FastifyPluginAsync } from 'fastify';
import { notImplemented } from './_stub.js';

const route: FastifyPluginAsync = async (app) => {
  app.get('/', notImplemented('listAssignments'));
  app.post('/', notImplemented('createAssignment'));
  app.patch('/:id', notImplemented('updateAssignment'));
  app.delete('/:id', notImplemented('deleteAssignment'));
  app.post('/:id/force-remove', notImplemented('forceRemoveAssignment'));
};

export default route;
