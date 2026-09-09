'use strict';

/**
 * AI module schemas — SRS §21, FR-AI-001 and FR-AI-002.
 *
 * §21 documents one workflow and says twice that nothing else is documented: *"Only the AI workflow
 * provided in the source is documented"* and *"No other AI functionality is documented in the source."*
 * So these schemas describe that workflow's transitions and nothing more.
 *
 * ## Every column the system owns is refused, not stripped
 *
 * `question_banks` carries the workflow's whole state — `workflow_stage`, `extracted_text`,
 * `analyzed_topics`, `generated_count`, `approved_count`, `ai_model`, `error_message` — and every one of
 * them is written by a *stage transition*, never by a body. A caller who could set `workflow_stage`
 * could skip straight to `approved` and put unreviewed questions in the Question Bank, which is the one
 * outcome FR-AI-001 exists to prevent.
 *
 * `source_path` is refused for the reason Known Issues #26 records and seven modules now enforce: a
 * stored path comes from multer via `relativeUploadPath(req.file)`, never from a request body.
 *
 * ## Where "Select Difficulty" sits, and why the SRS and the schema disagree
 *
 * SRS:1140 and SRS:1160 both place *"Select Difficulty"* **after** *"Generate Answers"*. But
 * `question_banks.requested_difficulty` carries the comment *"'Select Difficulty' requested for
 * generation"* — i.e. an input to generation, before it.
 *
 * Both are honoured rather than one being ignored. `POST /banks/:id/generate` accepts an optional
 * `difficulty` and writes `requested_difficulty`, which is what the column says it is for; and
 * `POST /banks/:id/difficulty` is the separate transition SRS:1160 names, applying a difficulty to the
 * questions that were generated and advancing the bank to `preview`. A teacher who is happy with what
 * was generated re-states the same value; a teacher who is not changes it. Neither reading is discarded.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const {
  AI_SOURCE_TYPES,
  AI_WORKFLOW_STAGES,
  QUESTION_DIFFICULTY,
} = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const fields = {
  school_id: Joi.number().integer().min(1),
  name: Joi.string().trim().min(1).max(180),
  subject_id: Joi.number().integer().min(1).allow(null),
  class_id: Joi.number().integer().min(1).allow(null),
  topic: Joi.string().trim().max(180).empty('').allow(null),
  description: Joi.string().trim().max(5000).empty('').allow(null),
  source_type: Joi.string().valid(...Object.values(AI_SOURCE_TYPES)),
  difficulty: Joi.string().valid(...Object.values(QUESTION_DIFFICULTY)),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/**
 * The columns the workflow owns.
 *
 * Listed once and spread into every schema, with the two the review route legitimately writes lifted
 * out where they are needed — the §20.3/§20.4 lesson: a shared `forbidden()` map spread last silently
 * shadows the fields a route exists to write, and only a *positive* assertion per route can see it.
 */
const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
  created_by: forbiddenField('"created_by" is taken from the authenticated user'),
  approved_by: forbiddenField('"approved_by" is stamped when the questions are approved'),
  approved_at: forbiddenField('"approved_at" is stamped when the questions are approved'),
  workflow_stage: forbiddenField(
    '"workflow_stage" is moved by the workflow routes; a body cannot skip a step of FR-AI-001'
  ),
  source_path: forbiddenField('"source_path" is written from the uploaded file, never from a request body'),
  source_filename: forbiddenField('"source_filename" is taken from the uploaded file'),
  extracted_text: forbiddenField('"extracted_text" is produced by the Extract Content stage'),
  analyzed_topics: forbiddenField('"analyzed_topics" is produced by the Analyze Topics stage'),
  generated_count: forbiddenField('"generated_count" counts what the generator produced'),
  approved_count: forbiddenField('"approved_count" counts what the teacher approved'),
  is_ai_generated: forbiddenField('"is_ai_generated" records how the bank was filled'),
  ai_model: forbiddenField('"ai_model" records which provider answered'),
  error_message: forbiddenField('"error_message" records why a generation attempt failed'),
  requested_count: forbiddenField('"requested_count" is taken from the generate request'),
  requested_difficulty: forbiddenField('"requested_difficulty" is taken from the generate request'),
};

/* ── FR-AI-001 step 1 — "Teacher uploads a PDF, Image, or Syllabus" ── */

/**
 * The multipart create.
 *
 * `source_type` is the teacher's label for what they uploaded, not a MIME type: the `ai_source` upload
 * profile allows `application/pdf` and three image types, so a *syllabus* arrives as a PDF or a
 * photograph of one. §21 lists "Syllabus" beside "PDF" and "Image" as a kind of material, and this is
 * the only column that can carry that distinction.
 */
const createBank = Joi.object({
  school_id: fields.school_id,
  name: fields.name.required(),
  source_type: fields.source_type.required(),
  subject_id: fields.subject_id,
  class_id: fields.class_id,
  topic: fields.topic,
  description: fields.description,
  reason: fields.reason,
  ...owned,
});

/* ── steps 2 and 3 — the system extracts, then analyses ── */

/** Neither transition takes anything: the input is the row, and the work is the driver's. */
const stageOnly = Joi.object({
  school_id: fields.school_id,
  reason: fields.reason,
  ...owned,
});

/* ── steps 4 and 5 — the MCQs and their answers, in one metered call ── */

const generate = Joi.object({
  school_id: fields.school_id,
  /* §11.2's AI Limit counts requests, not questions, so this bounds the work of one request. */
  count: Joi.number().integer().min(1).max(50),
  /* The column's own comment calls this "requested for generation" — see the header. */
  difficulty: fields.difficulty,
  reason: fields.reason,
  ...owned,
});

/* ── step 6 — "Teacher selects difficulty" ── */

const { requested_difficulty: _lifted, ...ownedExceptDifficulty } = owned;

const setDifficulty = Joi.object({
  school_id: fields.school_id,
  difficulty: fields.difficulty.required(),
  reason: fields.reason,
  ...ownedExceptDifficulty,
});

/* ── steps 8 and 9 — "Teacher approves", and the Question Bank ── */

/**
 * Approval names the questions explicitly, in both directions.
 *
 * A body that only said "approve" and let silence mean rejection would turn an unreviewed question into
 * an irreversible `rejected` — §21 names one verb, *approve*, and gives no un-reject step. So a question
 * the teacher did not name stays `pending_review` and can be decided later.
 */
const review = Joi.object({
  school_id: fields.school_id,
  approve: Joi.array().items(Joi.number().integer().min(1)).unique().default([]),
  reject: Joi.array().items(Joi.number().integer().min(1)).unique().default([]),
  review_note: Joi.string().trim().max(500).empty('').allow(null),
  reason: fields.reason,
  ...owned,
})
  .custom((value, helpers) => {
    if (!value.approve.length && !value.reject.length) {
      return helpers.error('any.invalid', { message: 'name at least one question to approve or reject' });
    }
    const both = value.approve.filter((id) => value.reject.includes(id));
    if (both.length) {
      return helpers.error('any.invalid', { message: `question ${both[0]} is in both approve and reject` });
    }
    return value;
  })
  .messages({
    'any.invalid': 'A review must {{#message}}',
  });

/* ── the reads ── */

const listBanks = listQuery(
  Joi.object({
    school_id: fields.school_id,
    subject_id: fields.subject_id,
    class_id: fields.class_id,
    workflow_stage: Joi.string().valid(...Object.values(AI_WORKFLOW_STAGES)),
    is_ai_generated: Joi.boolean(),
  })
);

const listQuestions = listQuery(
  Joi.object({
    school_id: fields.school_id,
    status: Joi.string().valid('pending_review', 'approved', 'rejected'),
    difficulty: fields.difficulty,
  })
);

/**
 * `extracted_text` is `TEXT('long')`, so it is omitted from every response unless asked for. The
 * opt-in query flag is the shape `documents` and `homework` use for their own show queries.
 */
const showQuery = Joi.object({
  school_id: fields.school_id,
  include_text: Joi.boolean().default(false),
});

const usageQuery = Joi.object({ school_id: fields.school_id });

module.exports = {
  schemas: {
    createBank,
    stageOnly,
    generate,
    setDifficulty,
    review,
    listBanks,
    listQuestions,
    showQuery,
    usageQuery,
    idParam: commonSchemas.idParam,
  },
  fields,
};
