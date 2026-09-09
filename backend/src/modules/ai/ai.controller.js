'use strict';

/**
 * AI module controllers — SRS §21, FR-AI-001 and FR-AI-002.
 *
 * Every handler that returns a bank goes through `service.presentBank()`, so `source_path` cannot leak
 * and `extracted_text` is carried only where it was asked for.
 *
 * The activity metadata records which stage moved and how much was produced, never the extracted text
 * or the generated questions: an activity row is read by anyone who can read the trail, and the
 * extracted text is a teacher's uploaded material.
 */

const service = require('./ai.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

/* ── FR-AI-002 — the counter a client renders the block/warning from ── */

async function usage(req, res) {
  return ApiResponse.ok(res, { usage: await service.usage(req, req.query) });
}

/* ── the reads ── */

async function listBanks(req, res) {
  const pagination = getPagination(req);
  const result = await service.listBanks(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function showBank(req, res) {
  const bank = await service.findBankById(req, req.params.id);
  return ApiResponse.ok(res, {
    bank: service.presentBank(bank, { includeText: req.query.include_text === true }),
  });
}

/** SRS:1161 — *"Teacher previews the generated questions."* */
async function listQuestions(req, res) {
  const pagination = getPagination(req);
  const result = await service.listQuestions(req, req.params.id, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

/* ── the workflow ── */

/** SRS:1155 — *"Teacher uploads a PDF, Image, or Syllabus."* */
async function createBank(req, res) {
  const bank = await service.createBank(req, req.body);
  describeActivity(req, {
    entityId: bank.id,
    description: `Uploaded ${bank.source_type} "${bank.source_filename}" for AI question generation`,
    metadata: {
      school_id: bank.school_id,
      source_type: bank.source_type,
      /* Whether a file came with it, never where it was put. */
      has_source: Boolean(bank.source_path),
    },
  });
  return ApiResponse.created(res, { bank: service.presentBank(bank) }, { message: 'Source uploaded' });
}

/** SRS:1156 — *"System extracts content from the upload."* */
async function extract(req, res) {
  const bank = await service.extract(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: bank.id,
    description: `Extracted content from "${bank.source_filename}"`,
    metadata: { school_id: bank.school_id, stage: bank.workflow_stage, characters: (bank.extracted_text || '').length },
  });
  return ApiResponse.ok(res, { bank: service.presentBank(bank) }, { message: 'Content extracted' });
}

/** SRS:1157 — *"System analyzes topics within the extracted content."* */
async function analyze(req, res) {
  const bank = await service.analyze(req, req.params.id, req.body);
  const topics = Array.isArray(bank.analyzed_topics) ? bank.analyzed_topics : [];
  describeActivity(req, {
    entityId: bank.id,
    description: `Analysed ${topics.length} topic(s) in "${bank.name}"`,
    metadata: { school_id: bank.school_id, stage: bank.workflow_stage, topics: topics.length },
  });
  return ApiResponse.ok(res, { bank: service.presentBank(bank) }, { message: 'Topics analysed' });
}

/**
 * SRS:1158-1159 — the MCQs and their answers.
 *
 * The response carries the usage counter alongside the bank, because this is the request that consumed
 * a unit and FR-AI-002 asks the system to show where the school now stands.
 */
async function generate(req, res) {
  const { bank, usage: after } = await service.generate(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: bank.id,
    description: `Generated ${bank.generated_count} question(s) for "${bank.name}"`,
    metadata: {
      school_id: bank.school_id,
      stage: bank.workflow_stage,
      generated: bank.generated_count,
      difficulty: bank.requested_difficulty,
      ai_model: bank.ai_model,
    },
  });
  return ApiResponse.ok(
    res,
    { bank: service.presentBank(bank), usage: after },
    { message: 'Questions generated' }
  );
}

/** SRS:1160 — *"Teacher selects difficulty."* */
async function setDifficulty(req, res) {
  const { bank, changed } = await service.setDifficulty(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: bank.id,
    description: `Set difficulty "${bank.requested_difficulty}" on ${changed} question(s)`,
    metadata: { school_id: bank.school_id, stage: bank.workflow_stage, difficulty: bank.requested_difficulty },
  });
  return ApiResponse.ok(
    res,
    { bank: service.presentBank(bank), updated: changed },
    { message: 'Difficulty applied' }
  );
}

/** SRS:1162-1164 — *"Teacher approves"*, and the Question Bank. */
async function review(req, res) {
  const bank = await service.review(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: bank.id,
    description: `Reviewed "${bank.name}" — ${bank.approved_count} question(s) approved`,
    metadata: {
      school_id: bank.school_id,
      stage: bank.workflow_stage,
      approved: req.body.approve.length,
      rejected: req.body.reject.length,
    },
  });
  return ApiResponse.ok(res, { bank: service.presentBank(bank) }, { message: 'Questions reviewed' });
}

module.exports = {
  usage,
  listBanks,
  showBank,
  listQuestions,
  createBank,
  extract,
  analyze,
  generate,
  setDifficulty,
  review,
};
