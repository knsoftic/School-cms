'use strict';

/**
 * AI routes — mounted at `/api/v1/ai`. SRS §21, FR-AI-001 and FR-AI-002.
 *
 * | SRS step | Route | Permission |
 * |---|---|---|
 * | FR-AI-002 | `GET /usage` | `ai.usage.view` |
 * | — | `GET /banks` | `question_bank.view` |
 * | 1 Upload | `POST /banks` | `ai.generate` |
 * | — | `GET /banks/:id` | `question_bank.view` |
 * | 2 Extract Content | `POST /banks/:id/extract` | `ai.generate` |
 * | 3 Analyze Topics | `POST /banks/:id/analyze` | `ai.generate` |
 * | 4+5 MCQs & Answers | `POST /banks/:id/generate` | `ai.generate` |
 * | 6 Select Difficulty | `POST /banks/:id/difficulty` | `ai.approve` |
 * | 7 Preview | `GET /banks/:id/questions` | `question_bank.view` |
 * | 8+9 Approve → Bank | `POST /banks/:id/approve` | `ai.approve` |
 *
 * `requireModule(MODULES.AI)` router-level — FR-AI-001's precondition is *"School's subscription
 * includes the AI module"*, which is exactly what that guard checks.
 *
 * ## Nine SRS steps, ten routes, three collapses — each forced by something that already exists
 *
 * - **Steps 4 and 5 are one call.** `AI_WORKFLOW_STAGES` has a single `generated` for both, and
 *   `correct_option` and `answer_explanation` live on the same row as `question_text` under a validator
 *   that refuses an MCQ without its answer. A separate "generate answers" call would have no row to
 *   write and no stage to move to.
 * - **Step 7 (Preview) is a GET, not a transition.** Previewing changes nothing; it is the teacher
 *   reading what step 5 produced. `AI_WORKFLOW_STAGES.PREVIEW` is reached by step 6, which is the last
 *   thing that happens before the teacher looks.
 * - **Step 9 (Question Bank) is the outcome of step 8, not a step.** SRS:1164's Expected Outcome is
 *   *"Approved AI-generated questions are stored in the Question Bank"* — the approve transition is what
 *   stores them; there is nothing left to call.
 *
 * ## Exactly one route is metered, and it is the only one that could be
 *
 * `enforceLimit(LIMITS.AI_LIMIT)` sits on `POST /banks/:id/generate` and nowhere else, and the service
 * calls `usageService.recordUsage` there and nowhere else. §21's example is *"Plan: 1000 AI Requests"*;
 * if extract and analyze were counted too, that plan would buy 333 question sets. The service header
 * explains where the increment sits relative to the commit and why it is neither swallowed nor early.
 *
 * **`aiLimiter` guards the three driver routes.** It has existed in `rateLimit.js` since that file was
 * written and been mounted nowhere; these are its first callers. It answers a different question from
 * `enforceLimit` — a burst against the provider, rather than whether the school has paid — which is why
 * extract and analyze carry the rate limit but not the meter.
 *
 * ## Middleware order, and why the upload route differs from the metered one
 *
 * The metered route follows the three shipped `enforceLimit` sites verbatim:
 * `requirePermission → validate → enforceLimit → logActivity`. The upload route follows the three
 * shipped `uploadSingle` sites verbatim: `requirePermission → uploadSingle → validate → logActivity`.
 *
 * The two never meet, and that is deliberate rather than lucky. `enforceLimit` resolves the gated school
 * by reading the raw request, `req.body` included — and `req.body` is empty before multer has run, so
 * `enforceLimit` ahead of `uploadSingle` would refuse an org-scoped caller who named their school in a
 * multipart field. The upload route carries no limit and the metered route carries no upload, so the
 * ordering question never arises here.
 *
 * ## `question_bank.manage` is deliberately unused
 *
 * The catalogue grants five AI keys; this router mounts four. `question_bank.manage` ("Manage question
 * banks & questions") would guard editing or deleting a bank by hand, and §21 documents no such thing —
 * it says twice that *"Only the AI workflow provided in the source is documented"* and *"No other AI
 * functionality is documented in the source."* Mounting a route for it would be inventing a
 * requirement. Recorded so the unused key reads as a decision rather than an oversight.
 *
 * ## No DELETE
 *
 * §21 names none. A bank whose questions were all rejected ends at `AI_WORKFLOW_STAGES.REJECTED`, which
 * is the enum's own way of saying the same thing.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
  enforceLimit,
  uploadSingle,
  aiLimiter,
} = require('../../middlewares');
const { MODULES, LIMITS, UPLOAD_PROFILES } = require('../../config/constants');

const controller = require('./ai.controller');
const { schemas } = require('./ai.validation');

const router = createRouter();

router.use(requireModule(MODULES.AI));

/* ── FR-AI-002 — the counter, and the block/warning a client renders from it ── */

router.get(
  '/usage',
  requirePermission('ai.usage.view'),
  validate({ query: schemas.usageQuery }),
  asyncHandler(controller.usage)
);

/* ── the banks ── */

router.get(
  '/banks',
  requirePermission('question_bank.view'),
  validate({ query: schemas.listBanks }),
  asyncHandler(controller.listBanks)
);

/* FR-AI-001 step 1 — "Teacher uploads a PDF, Image, or Syllabus". */
router.post(
  '/banks',
  requirePermission('ai.generate'),
  uploadSingle(UPLOAD_PROFILES.AI_SOURCE, 'source'),
  validate({ body: schemas.createBank }),
  logActivity({ action: 'create', entityType: 'question_banks', onlyOnSuccess: true }),
  asyncHandler(controller.createBank)
);

router.get(
  '/banks/:id',
  requirePermission('question_bank.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.showBank)
);

/* Step 2 — "System extracts content from the upload." */
router.post(
  '/banks/:id/extract',
  requirePermission('ai.generate'),
  aiLimiter,
  validate({ params: schemas.idParam, body: schemas.stageOnly }),
  logActivity({ action: 'update', entityType: 'question_banks', onlyOnSuccess: true }),
  asyncHandler(controller.extract)
);

/* Step 3 — "System analyzes topics within the extracted content." */
router.post(
  '/banks/:id/analyze',
  requirePermission('ai.generate'),
  aiLimiter,
  validate({ params: schemas.idParam, body: schemas.stageOnly }),
  logActivity({ action: 'update', entityType: 'question_banks', onlyOnSuccess: true }),
  asyncHandler(controller.analyze)
);

/*
 * Steps 4 and 5 — the MCQs and their answers. THE metered AI request: the only route in the
 * application carrying `enforceLimit(LIMITS.AI_LIMIT)`, and the only caller of `recordUsage`.
 */
router.post(
  '/banks/:id/generate',
  requirePermission('ai.generate'),
  aiLimiter,
  validate({ params: schemas.idParam, body: schemas.generate }),
  enforceLimit(LIMITS.AI_LIMIT),
  logActivity({ action: 'update', entityType: 'question_banks', onlyOnSuccess: true }),
  asyncHandler(controller.generate)
);

/* Step 6 — "Teacher selects difficulty." */
router.post(
  '/banks/:id/difficulty',
  requirePermission('ai.approve'),
  validate({ params: schemas.idParam, body: schemas.setDifficulty }),
  logActivity({ action: 'update', entityType: 'question_banks', onlyOnSuccess: true }),
  asyncHandler(controller.setDifficulty)
);

/* Step 7 — "Teacher previews the generated questions." A read; it moves nothing. */
router.get(
  '/banks/:id/questions',
  requirePermission('question_bank.view'),
  validate({ params: schemas.idParam, query: schemas.listQuestions }),
  asyncHandler(controller.listQuestions)
);

/* Steps 8 and 9 — "Teacher approves", and the approved questions are stored in the Question Bank. */
router.post(
  '/banks/:id/approve',
  requirePermission('ai.approve'),
  validate({ params: schemas.idParam, body: schemas.review }),
  logActivity({ action: 'update', entityType: 'question_banks', onlyOnSuccess: true }),
  asyncHandler(controller.review)
);

module.exports = router;
