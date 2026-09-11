'use strict';

/**
 * AI module — SRS §21, FR-AI-001 (the workflow) and FR-AI-002 (the usage limit).
 *
 * Two tables, both of which have existed since the schema was written and neither of which anything has
 * ever read or written: `question_banks` and `questions` (`models/exams.js`). Every column this module
 * needs is already there, so nothing is added — §29 fixes the schema at 64 tables and §35 forbids a 65th.
 *
 * ## The workflow is a state machine on one column
 *
 * §21 states its order twice, identically — as an arrow chain and as nine Functional Behavior bullets —
 * and `AI_WORKFLOW_STAGES` freezes seven values to hold it. So `question_banks.workflow_stage` is the
 * server's record of where a bank sits, and each transition refuses to run out of order:
 *
 *     (create) → uploaded → extracted → analyzed → generated → preview → approved
 *                                                                      ↘ rejected
 *
 * A caller cannot set the column — it is `forbidden()` in every schema — because a body that could set
 * it could jump to `approved` and put unreviewed questions in the Question Bank, which is precisely what
 * FR-AI-001's preview-and-approve half exists to prevent.
 *
 * ## Exactly one of those transitions is an AI request
 *
 * FR-AI-002 counts requests against `ai_limit`, and §21's example is *"Plan: 1000 AI Requests — Usage:
 * 750 / 1000"*. If extract, analyze and generate each counted, a 1000-request plan would buy 333
 * question sets and the number on the invoice would mean something no one wrote down. So
 * **`generate()` is the metered call** and the only one. Its route carries `enforceLimit(LIMITS.AI_LIMIT)`,
 * and since the owner's decision D32 so do extract and analyze — checked at the cap, never counted.
 *
 * ### Where the increment sits, and why that is not a detail
 *
 * `usageService.recordUsage()` has had **zero call sites in `src/`** since it was written; this is its
 * first. Three properties, each chosen against something the codebase already records:
 *
 * - **A blocked request costs nothing.** `enforceLimit` runs as route middleware, before this service,
 *   so a school at its cap never reaches the driver.
 * - **A failed generation is not charged.** The increment happens *after* the transaction commits.
 *   `entitlement.js` states the same rule for its own case — a check that incremented "would charge a
 *   school for an action that failed validation two middlewares later".
 * - **The increment is awaited and its failure is not swallowed.** `syncHeadcount` may swallow, because
 *   headcount is counted live from its source table and `usage_records` is only a reporting mirror.
 *   `ai_limit` is the opposite: `checkLimit` *reads* that row, so a dropped increment is a school
 *   generating free for the rest of the period.
 *
 * ## What the driver is, and what it is not
 *
 * `src/ai/` owns extraction, analysis and generation, selected by `AI_DRIVER`. `.env` ships `mock`, and
 * the verification suite pins it — so the whole workflow is exercised offline and deterministically.
 * The `anthropic` adapter is written against the same contract and **has never been executed**;
 * checklist row 5.2 owns that and stays open. This module is identical either way, which is the point of
 * the seam.
 */

const path = require('path');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const config = require('../../config/env');
const logger = require('../../config/logger');
const aiDriver = require('../../ai');
const usageService = require('../../services/usageService');
const { resolveSchool } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { cleanupUploads, relativeUploadPath } = require('../../middlewares/upload');
const {
  AI_WORKFLOW_STAGES,
  QUESTION_STATUS,
  QUESTION_SOURCES,
  QUESTION_TYPES,
  QUESTION_DIFFICULTY,
  LIMITS,
  UPLOAD_EXTENSION_MIME,
} = require('../../config/constants');

const BANK_SORTABLE = Object.freeze(['id', 'name', 'workflow_stage', 'created_at']);
const QUESTION_SORTABLE = Object.freeze(['id', 'difficulty', 'status', 'created_at']);

/** How many questions one generate request produces when the caller names no count. */
const DEFAULT_QUESTION_COUNT = 10;

/**
 * The stage each transition requires, and the stage it leaves behind.
 *
 * Written as data rather than as a chain of `if`s so the machine is readable in one place and so the
 * suite can assert the table itself rather than inferring it from six separate refusals.
 */
const TRANSITIONS = Object.freeze({
  extract: { from: AI_WORKFLOW_STAGES.UPLOADED, to: AI_WORKFLOW_STAGES.EXTRACTED },
  analyze: { from: AI_WORKFLOW_STAGES.EXTRACTED, to: AI_WORKFLOW_STAGES.ANALYZED },
  generate: { from: AI_WORKFLOW_STAGES.ANALYZED, to: AI_WORKFLOW_STAGES.GENERATED },
  difficulty: { from: AI_WORKFLOW_STAGES.GENERATED, to: AI_WORKFLOW_STAGES.PREVIEW },
  review: { from: AI_WORKFLOW_STAGES.PREVIEW, to: AI_WORKFLOW_STAGES.APPROVED },
});

/**
 * A bank as a caller sees it.
 *
 * `source_path` never leaves the service — the doctrine seven modules now enforce, and the one Known
 * Issues #26 was closed to establish. `extracted_text` is `TEXT('long')` and is omitted unless asked
 * for, because a list of twenty banks would otherwise carry twenty documents.
 */
function presentBank(row, { includeText = false } = {}) {
  if (!row) return row;
  const json = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  delete json.source_path;
  if (!includeText) delete json.extracted_text;
  return {
    ...json,
    has_source: Boolean(row.source_path),
    has_extracted_text: Boolean(row.extracted_text),
  };
}

function rethrow(err) {
  if (err instanceof db.Sequelize.ValidationError) {
    /* `mcqNeedsOptionsAndAnswer` lives on the model; surfaced as a 422 rather than escaping as a 500. */
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  if (err instanceof db.Sequelize.ForeignKeyConstraintError) {
    throw ApiError.validation('A referenced record does not exist', [
      { field: 'body', message: 'One of the records this bank refers to no longer exists' },
    ]);
  }
  throw err;
}

async function narrowSchool(req, namedSchoolId, where) {
  if (namedSchoolId) {
    const school = await resolveSchool(req, namedSchoolId);
    where.school_id = school.id;
  }
  return where;
}

async function findBankById(req, id, namedSchoolId = undefined) {
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  const where = await narrowSchool(req, named, tenantWhere(req.tenant, { id }));
  const row = await db.QuestionBank.findOne({ where });
  if (!row) throw ApiError.notFound('Question bank not found', { code: 'QUESTION_BANK_NOT_FOUND' });
  return row;
}

/**
 * The stage guard.
 *
 * Refused with 409 and a code that names both stages, because "this bank is at `uploaded` and you asked
 * to generate" is a different problem from "this bank does not exist", and a client that cannot tell
 * them apart cannot show the teacher what to do next.
 */
function assertStage(bank, transition) {
  const rule = TRANSITIONS[transition];
  if (bank.workflow_stage !== rule.from) {
    throw ApiError.conflict(
      `This bank is at "${bank.workflow_stage}" — ${transition} requires "${rule.from}"`,
      { code: 'AI_STAGE_INVALID', details: { stage: bank.workflow_stage, requires: rule.from, transition } }
    );
  }
  return rule;
}

/** Every optional reference on a bank must point inside the same school. */
async function assertReferences(payload, schoolId) {
  if (payload.subject_id) {
    const subject = await db.Subject.findOne({ where: { id: payload.subject_id, school_id: schoolId } });
    if (!subject) {
      throw ApiError.validation('That subject is not in this school', [
        { field: 'subject_id', message: 'Unknown subject for this school' },
      ]);
    }
  }
  if (payload.class_id) {
    const klass = await db.Class.findOne({ where: { id: payload.class_id, school_id: schoolId } });
    if (!klass) {
      throw ApiError.validation('That class is not in this school', [
        { field: 'class_id', message: 'Unknown class for this school' },
      ]);
    }
  }
}

/* ══════════════════ FR-AI-001 step 1 — the teacher uploads ══════════════════ */

async function createBank(req, payload) {
  try {
    const school = await resolveSchool(req, payload.school_id);
    await assertReferences(payload, school.id);

    if (!req.file) {
      throw ApiError.validation('No file was uploaded', [
        { field: 'source', message: 'Attach the PDF or image as the "source" field of a multipart request' },
      ]);
    }

    const row = await db.QuestionBank.create({
      school_id: school.id,
      organization_id: school.organization_id,
      name: payload.name,
      subject_id: payload.subject_id || null,
      class_id: payload.class_id || null,
      topic: payload.topic || null,
      description: payload.description || null,
      source_type: payload.source_type,
      source_path: relativeUploadPath(req.file),
      source_filename: req.file.originalname,
      /* SRS:1155 is the first step, so the bank enters the workflow at its first stage. */
      workflow_stage: AI_WORKFLOW_STAGES.UPLOADED,
      is_ai_generated: true,
      created_by: req.user ? req.user.id : null,
    });

    await recordAudit(req, {
      tableName: 'question_banks',
      recordId: row.id,
      event: 'create',
      before: null,
      after: snapshot(row),
      reason: payload.reason || null,
    });
    return row;
  } catch (err) {
    /* A stored file with no row behind it is disk nobody will ever collect. */
    await cleanupUploads(req);
    return rethrow(err);
  }
}

/* ══════════════════ steps 2 and 3 — the system extracts, then analyses ══════════════════ */

/**
 * Neither of these is a metered AI request.
 *
 * They call the driver, so they carry `aiLimiter` on the route — a rate limit is about protecting the
 * provider from a burst, which is a different question from whether the school has paid for the work.
 * §21's counted unit is a generation; see the header.
 */
async function runStage(req, id, transition, payload, work) {
  const bank = await findBankById(req, id, payload.school_id);
  const rule = assertStage(bank, transition);
  const before = snapshot(bank);

  let produced;
  try {
    produced = await work(bank);
  } catch (err) {
    /* The failure is recorded on the row so the teacher can see why, and the stage does not move. */
    bank.set({ error_message: String(err.message).slice(0, 500) });
    await bank.save();
    logger.error('AI stage failed', { transition, bankId: bank.id, driver: aiDriver.driverName(), error: err.message });
    /*
     * A 422 rather than a 5xx: `ApiError` offers no gateway status, and the failure a teacher will
     * actually hit is content the provider could not use — a scan with no readable text — which is a
     * problem with the request, not with this server. The provider's own message is carried in the
     * detail and is also on the row as `error_message`, so the teacher can see it without the trail.
     */
    throw ApiError.validation(`The AI provider could not ${transition} this content`, [
      { field: 'source', message: err.message },
    ]);
  }

  bank.set({ ...produced, workflow_stage: rule.to, error_message: null });
  try {
    await bank.save();
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'question_banks',
    recordId: bank.id,
    event: 'update',
    before,
    after: snapshot(bank),
    reason: payload.reason || null,
  });
  return bank;
}

/** SRS:1156 — *"System extracts content from the upload."* */
async function extract(req, id, payload) {
  return runStage(req, id, 'extract', payload, async (bank) => {
    const absolutePath = bank.source_path ? path.join(config.uploads.dir, bank.source_path) : null;
    /*
     * The MIME type is derived from the filename, and passing `null` here was a defect that made
     * extraction **unreachable** with the real driver.
     *
     * `ai/anthropic.js` dispatches entirely on this argument: `application/pdf` is parsed locally with
     * `pdf-parse`, `IMAGE_MIME` (`/^image\/(jpeg|png|webp)$/`) goes to the model as an image block, and
     * anything else throws `Cannot extract text from "<file>" (<mime>)`. With `null` hardcoded, neither
     * branch could ever be taken, so every PDF, image and syllabus upload threw before doing any work.
     * Measured directly with the caller's own arguments:
     *
     *     extract({ sourceType:'pdf', mimeType:null, filename:'syllabus.pdf' })
     *       -> THREW: Cannot extract text from "syllabus.pdf" (null)
     *
     * It went unnoticed because `.env` sets `AI_DRIVER=mock`, and the mock ignores both the path and
     * the type by design — so the whole workflow passed end to end through a driver that never looks
     * at the argument that was wrong.
     *
     * The extension is the honest source: `question_banks` has no MIME column and §35 forbids adding
     * one, and `uploadSingle` has already refused any file whose extension is outside
     * `UPLOAD_MIME_EXTENSIONS`, so the lookup cannot miss for a row that exists. `source_type` cannot
     * be used instead — it is §21's semantic category (PDF, Image, Syllabus) and a syllabus arrives as
     * either format.
     */
    const extension = path.extname(String(bank.source_filename || '')).toLowerCase();
    const result = await aiDriver.extract({
      sourceType: bank.source_type,
      mimeType: UPLOAD_EXTENSION_MIME[extension] || null,
      absolutePath,
      filename: bank.source_filename,
    });
    const text = String(result && result.text ? result.text : '').trim();
    if (!text) throw new Error('No text could be extracted from the upload');
    return { extracted_text: text };
  });
}

/** SRS:1157 — *"System analyzes topics within the extracted content."* */
async function analyze(req, id, payload) {
  return runStage(req, id, 'analyze', payload, async (bank) => {
    const result = await aiDriver.analyze({ text: bank.extracted_text, sourceType: bank.source_type });
    const topics = Array.isArray(result && result.topics) ? result.topics : [];
    if (!topics.length) throw new Error('No topics could be identified in the extracted content');
    return { analyzed_topics: topics };
  });
}

/* ══════════════════ steps 4 and 5 — the one metered call ══════════════════ */

/**
 * Every question is checked against the model's own rule before any of them is written.
 *
 * `mcqNeedsOptionsAndAnswer` would refuse a malformed row, but it refuses them one at a time inside a
 * bulk insert, and a provider that returns nine good questions and one bad one should not half-fill a
 * bank. So the whole set is validated first and the request fails as a unit.
 */
function assertWellFormed(questions) {
  if (!Array.isArray(questions) || !questions.length) {
    throw new Error('The AI provider returned no questions');
  }
  questions.forEach((q, i) => {
    const where = `question ${i + 1}`;
    if (!q || !String(q.question_text || '').trim()) throw new Error(`${where} has no text`);
    if (!Array.isArray(q.options) || q.options.length < 2) throw new Error(`${where} has fewer than two options`);
    const keys = q.options.map((o) => String(o && o.key));
    if (new Set(keys).size !== keys.length) throw new Error(`${where} has duplicate option keys`);
    if (!q.correct_option) throw new Error(`${where} has no correct_option`);
    if (!keys.includes(String(q.correct_option))) {
      throw new Error(`${where}'s correct_option does not match any option key`);
    }
  });
}

/**
 * SRS:1158-1159 — the MCQs and their answers.
 *
 * **This is the AI request FR-AI-002 counts.** One call, one unit, whatever `count` was asked for. The
 * route carries `enforceLimit(LIMITS.AI_LIMIT)`, so a school at its cap is refused before the driver is
 * touched; and `recordUsage` runs only after the rows are committed, so a provider failure costs
 * nothing.
 */
async function generate(req, id, payload) {
  const bank = await findBankById(req, id, payload.school_id);
  assertStage(bank, 'generate');
  const before = snapshot(bank);

  const count = Number(payload.count) || DEFAULT_QUESTION_COUNT;
  const difficulty = payload.difficulty || bank.requested_difficulty || QUESTION_DIFFICULTY.MEDIUM;

  /*
   * The allowance is taken **before** the provider is called — Known Issues #21's `ai_limit` half.
   *
   * `enforceLimit(LIMITS.AI_LIMIT)` on the route reads the counter, decides, and returns; the driver is
   * called after that, and the increment came after *that*. Two requests at 999 of 1000 both passed,
   * both generated, and the school landed at 1001. `reserveUsage()` moves the increment to the front
   * and makes it conditional in one statement, so the two are serialised against each other without
   * anything holding a lock across the provider call. The route guard stays: it refuses at the cap
   * before any of this runs, with the message a school can act on.
   *
   * Every path out of here after this line has to give the reservation back, which is what the two
   * `releaseUsage` calls below do. FR-AI-002 counts *requests that produced questions*, and the header
   * already promised a provider failure costs nothing — that promise is now kept by a refund rather
   * than by not having charged yet.
   */
  await usageService.reserveUsage(bank.school_id, LIMITS.AI_LIMIT, 1);

  let produced;
  try {
    produced = await aiDriver.generate({
      text: bank.extracted_text,
      topics: bank.analyzed_topics,
      count,
      difficulty,
      topic: bank.topic,
    });
    assertWellFormed(produced && produced.questions);
  } catch (err) {
    bank.set({ error_message: String(err.message).slice(0, 500) });
    await bank.save();
    logger.error('AI generation failed', { bankId: bank.id, driver: aiDriver.driverName(), error: err.message });
    /* The reservation goes back: nothing was produced, and the stage has not moved. */
    await usageService.releaseUsage(bank.school_id, LIMITS.AI_LIMIT, 1);
    throw ApiError.validation('The AI provider could not generate questions from this content', [
      { field: 'source', message: err.message },
    ]);
  }

  const rows = produced.questions.map((q) => ({
    school_id: bank.school_id,
    organization_id: bank.organization_id,
    question_bank_id: bank.id,
    subject_id: bank.subject_id,
    type: QUESTION_TYPES.MCQ,
    question_text: q.question_text,
    options: q.options,
    correct_option: String(q.correct_option),
    answer_explanation: q.answer_explanation || null,
    difficulty: q.difficulty || difficulty,
    topic: q.topic || bank.topic || null,
    /* SRS:1161-1162 — nothing enters the Question Bank until the teacher approves it. */
    status: QUESTION_STATUS.PENDING_REVIEW,
    source: QUESTION_SOURCES.AI,
  }));

  try {
    await db.sequelize.transaction(async (transaction) => {
      await db.Question.bulkCreate(rows, { validate: true, transaction });
      bank.set({
        workflow_stage: TRANSITIONS.generate.to,
        requested_count: count,
        requested_difficulty: difficulty,
        generated_count: rows.length,
        ai_model: produced.model || aiDriver.driverName(),
        error_message: null,
      });
      await bank.save({ transaction });
    });
  } catch (err) {
    /*
     * The questions were generated and then not stored, so the request produced nothing the school can
     * use and the reservation goes back — the same rule as the provider failure above. Released before
     * `rethrow`, which throws.
     */
    await usageService.releaseUsage(bank.school_id, LIMITS.AI_LIMIT, 1);
    return rethrow(err);
  }

  /*
   * The reservation is now settled, and reading it back is what the response reports. `recordUsage` is
   * NOT called again here: the increment happened at the reservation, and calling it a second time
   * would charge the request twice — which is the mistake this shape invites and the reason the read is
   * spelled out rather than left implied.
   */
  const settled = await usageService.getUsage(bank.school_id, LIMITS.AI_LIMIT);
  /*
   * Narrowed to the four fields `recordUsage` returned, so the response body is byte-for-byte what it
   * was before the reservation moved the increment. `getUsage` answers with eleven more — period
   * bounds, the resolution source, the measurement kind — and none of them was ever in this response.
   * Widening an API as a side effect of an internal fix is how a contract changes without a decision.
   */
  const usage = {
    used: settled.used,
    allowed: settled.allowed,
    overage: settled.overage,
    overageAmount: settled.overageAmount,
  };

  await recordAudit(req, {
    tableName: 'question_banks',
    recordId: bank.id,
    event: 'update',
    before,
    after: snapshot(bank),
    reason: payload.reason || null,
  });

  return { bank, usage };
}

/* ══════════════════ step 6 — "Teacher selects difficulty" ══════════════════ */

/**
 * SRS:1160 places this after generation, and the column comment calls it an input to generation. Both
 * are honoured: `generate` accepts a difficulty hint, and this transition applies the teacher's choice
 * to the questions that came back and moves the bank to preview.
 */
async function setDifficulty(req, id, payload) {
  const bank = await findBankById(req, id, payload.school_id);
  const rule = assertStage(bank, 'difficulty');
  const before = snapshot(bank);

  /*
   * Loaded and saved one by one rather than through a bulk `Model.update()`.
   *
   * Measured: `db.Question.update({ difficulty }, { where })` raises "An MCQ must define at least two
   * options". Sequelize runs the model-level validate block against an instance built from ONLY the
   * values passed, so `mcqNeedsOptionsAndAnswer` sees no `options` and refuses a change that does not
   * touch them. `{ validate: false }` would silence it and disable a real safeguard on the one table
   * whose purpose is well-formed MCQs; a loaded instance carries the whole row, so the validator checks
   * what it was written to check. Bounded by the generate schema's ceiling of 50 questions per bank.
   */
  const pending = await db.Question.findAll({
    where: { question_bank_id: bank.id, school_id: bank.school_id, status: QUESTION_STATUS.PENDING_REVIEW },
  });
  for (const question of pending) {
    question.set({ difficulty: payload.difficulty });
    // eslint-disable-next-line no-await-in-loop
    await question.save();
  }
  const changed = pending.length;

  bank.set({ requested_difficulty: payload.difficulty, workflow_stage: rule.to });
  await bank.save();

  await recordAudit(req, {
    tableName: 'question_banks',
    recordId: bank.id,
    event: 'update',
    before,
    after: snapshot(bank),
    reason: payload.reason || null,
  });
  return { bank, changed };
}

/* ══════════════════ steps 7, 8 and 9 — preview, approve, Question Bank ══════════════════ */

async function listQuestions(req, id, query, pagination) {
  const bank = await findBankById(req, id, query.school_id);
  const where = { question_bank_id: bank.id, school_id: bank.school_id };
  if (query.status) where.status = query.status;
  if (query.difficulty) where.difficulty = query.difficulty;

  const result = await paginateQuery(
    db.Question,
    { where, order: getSort({ query }, QUESTION_SORTABLE, ['id', 'ASC']) },
    pagination
  );
  return { bank, rows: result.rows, count: result.count };
}

/**
 * SRS:1162-1164 — *"Teacher approves the questions"* and *"Approved AI-generated questions are stored in
 * the Question Bank."*
 *
 * Both lists are explicit. A question the teacher named neither way stays `pending_review`, because §21
 * names one verb and gives no way back from `rejected`: turning silence into an irreversible rejection
 * would be inventing a decision the teacher did not make.
 *
 * The bank lands on `approved` if anything was approved, and on `rejected` only if the teacher rejected
 * everything and approved nothing — which is the only reading under which that enum value is reachable.
 */
async function review(req, id, payload) {
  const bank = await findBankById(req, id, payload.school_id);
  assertStage(bank, 'review');
  const before = snapshot(bank);

  const named = [...payload.approve, ...payload.reject];
  const owned = await db.Question.findAll({
    where: { id: named, question_bank_id: bank.id, school_id: bank.school_id },
    attributes: ['id'],
  });
  const ownedIds = new Set(owned.map((q) => Number(q.id)));
  const foreign = named.filter((qid) => !ownedIds.has(Number(qid)));
  if (foreign.length) {
    throw ApiError.validation('A question named for review is not in this bank', [
      { field: 'approve', message: `question ${foreign[0]} does not belong to bank ${bank.id}` },
    ]);
  }

  const now = new Date();
  const reviewer = req.user ? req.user.id : null;

  await db.sequelize.transaction(async (transaction) => {
    const stamp = { reviewed_by: reviewer, reviewed_at: now, review_note: payload.review_note || null };
    /* Instances, not a bulk update — the model validator needs the whole row; see setDifficulty(). */
    const decided = await db.Question.findAll({
      where: { id: named, question_bank_id: bank.id, school_id: bank.school_id },
      transaction,
    });
    for (const question of decided) {
      const status = payload.approve.includes(Number(question.id))
        ? QUESTION_STATUS.APPROVED
        : QUESTION_STATUS.REJECTED;
      question.set({ status, ...stamp });
      // eslint-disable-next-line no-await-in-loop
      await question.save({ transaction });
    }

    const approved = await db.Question.count({
      where: { question_bank_id: bank.id, status: QUESTION_STATUS.APPROVED },
      transaction,
    });
    bank.set({
      approved_count: approved,
      workflow_stage: approved ? TRANSITIONS.review.to : AI_WORKFLOW_STAGES.REJECTED,
      approved_by: reviewer,
      approved_at: now,
    });
    await bank.save({ transaction });
  });

  await recordAudit(req, {
    tableName: 'question_banks',
    recordId: bank.id,
    event: 'update',
    before,
    after: snapshot(bank),
    reason: payload.reason || null,
  });
  return bank;
}

/* ══════════════════ FR-AI-002 — the display half ══════════════════ */

/**
 * SRS:1146 — *"Plan: 1000 AI Requests — Usage: 750 / 1000"*, and SRS:1147's *"the system must show a
 * block/warning"*.
 *
 * The block itself is `enforceLimit` on the generate route; this is what a client renders the counter
 * and the warning from. `at_limit` is the state §21 calls a block, and it is computed here rather than
 * left for a client to derive from two numbers and get wrong.
 */
async function usage(req, query) {
  const school = await resolveSchool(req, query.school_id);
  const row = await usageService.getUsage(school.id, LIMITS.AI_LIMIT);
  return {
    limit_key: LIMITS.AI_LIMIT,
    label: row.label,
    used: row.used,
    allowed: row.allowed,
    remaining: row.remaining,
    unlimited: row.unlimited,
    overage_allowed: row.allowOverage,
    at_limit: !row.unlimited && Number(row.remaining) <= 0,
    period_start: row.periodStart || null,
    period_end: row.periodEnd || null,
  };
}

async function listBanks(req, query, pagination) {
  const where = await narrowSchool(req, query.school_id, tenantWhere(req.tenant, {}));
  for (const field of ['subject_id', 'class_id', 'workflow_stage', 'is_ai_generated']) {
    if (query[field] !== undefined) where[field] = query[field];
  }
  if (query.q) where.name = { [db.Sequelize.Op.like]: `%${query.q}%` };

  const result = await paginateQuery(
    db.QuestionBank,
    { where, order: getSort({ query }, BANK_SORTABLE, ['id', 'DESC']) },
    pagination
  );
  return { rows: result.rows.map((r) => presentBank(r)), count: result.count };
}

module.exports = {
  listBanks,
  findBankById,
  createBank,
  extract,
  analyze,
  generate,
  setDifficulty,
  listQuestions,
  review,
  usage,
  presentBank,
  assertStage,
  TRANSITIONS,
  BANK_SORTABLE,
  QUESTION_SORTABLE,
  DEFAULT_QUESTION_COUNT,
};
