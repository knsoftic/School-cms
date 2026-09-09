'use strict';

const service = require('./classes.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function show(req, res) {
  const klass = await service.findClass(req, req.params.id);
  return ApiResponse.ok(res, { class: klass });
}

async function create(req, res) {
  const klass = await service.create(req, req.body);
  describeActivity(req, {
    entityId: klass.id,
    description: `Created class ${klass.name}`,
    metadata: { school_id: klass.school_id, academic_session_id: klass.academic_session_id },
  });
  return ApiResponse.created(res, { class: klass }, { message: 'Class created' });
}

async function update(req, res) {
  const klass = await service.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: klass.id,
    description: `Updated class ${klass.name}`,
    metadata: { school_id: klass.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { class: klass }, { message: 'Class updated' });
}

async function destroy(req, res) {
  const klass = await service.destroy(req, req.params.id);
  describeActivity(req, {
    entityId: klass.id,
    description: `Deleted class ${klass.name}`,
    metadata: { school_id: klass.school_id },
  });
  return ApiResponse.noContent(res);
}

async function listSections(req, res) {
  const { rows } = await service.listSections(req, req.params.id);
  return ApiResponse.ok(res, { sections: rows });
}

async function createSection(req, res) {
  const section = await service.createSection(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: section.id,
    description: `Created section ${section.name}`,
    metadata: { class_id: section.class_id },
  });
  return ApiResponse.created(res, { section }, { message: 'Section created' });
}

async function updateSection(req, res) {
  const section = await service.updateSection(req, req.params.id, req.params.sectionId, req.body);
  describeActivity(req, {
    entityId: section.id,
    description: `Updated section ${section.name}`,
    metadata: { class_id: section.class_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { section }, { message: 'Section updated' });
}

async function destroySection(req, res) {
  const section = await service.destroySection(req, req.params.id, req.params.sectionId);
  describeActivity(req, {
    entityId: section.id,
    description: `Deleted section ${section.name}`,
    metadata: { class_id: section.class_id },
  });
  return ApiResponse.noContent(res);
}

module.exports = {
  list,
  show,
  create,
  update,
  destroy,
  listSections,
  createSection,
  updateSection,
  destroySection,
};
