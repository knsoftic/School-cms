'use strict';

/**
 * Document routes — mounted at `/api/v1/documents`.
 *
 * | SRS  | FR         | Route      | Permission           |
 * |------|------------|------------|----------------------|
 * | 20.5 | FR-DOC-001 | `GET /`    | `documents.view`     |
 * | 20.5 | FR-DOC-001 | `GET /:id` | `documents.view`     |
 * | 20.5 | FR-DOC-001 | `POST /`   | `documents.generate` |
 *
 * ## This router mounts `requireActiveSubscription()`, not `requireModule()` — and that is the point
 *
 * Every other module router in this application mounts `requireModule(MODULES.X)`, because a module has
 * one subscribable key. §20.5 has **seven document types across four modules**: `DOCUMENT_TYPE_MODULE`
 * sends the two ID cards to `id_cards`, the admission form and the two certificates to `certificates`,
 * the fee receipt to `fees` and the result card to `exams`.
 *
 * So the module cannot be known until the request names a type. The router-level guard is therefore the
 * subscription-state half — `requireActiveSubscription()`, which is what
 * `requireModule` checks *first* anyway — and `documents.service.assertModuleForType()` does the module
 * half per request, through the same `loadSnapshot` the guards use, and in the same order (state, then
 * module) so a lapsed subscription is never reported as a missing module.
 *
 * A school subscribed to Certificates but not ID Cards can therefore issue a leaving certificate and not
 * a student ID card — which is exactly what §11.1 sells. A single router-level key could only have been
 * wrong: too strict for six types or too lax for one.
 *
 * Reads are **not** gated by type. A document already generated is the school's own record of something
 * it did, and §20.5 gives no reason for a later downgrade to hide it.
 *
 * ## The permissions match FR-DOC-001's four actors exactly
 *
 * FR-DOC-001 names **Principal / School Admin / Accountant / Receptionist**, and `documents.generate` is
 * granted to precisely those four plus Super Admin — the closest match between an FR's actor list and
 * the fixed catalogue anywhere in §20, and worth stating because §16 and §19 both had to record the
 * opposite. `documents.view` additionally reaches Teacher, Student and Parent, and the service narrows
 * each of those three to their own documents — three self-audiences rather than §20.2's two, because a
 * teacher is an **owner** here as well as a reader.
 *
 * ## No DELETE, and no bytes
 *
 * §20.5 names neither. Rendering is checklist row 5.4 (Phase 5.4), so `file_path`, `file_name`,
 * `mime_type` and `file_size_bytes` stay null, `storage_limit` is not incremented — mounting
 * `enforceLimit(LIMITS.STORAGE_LIMIT)` here would be a guard that could never fire — and there is still
 * no download route anywhere in this application. What §20.5 delivers is the record: which document was
 * generated, for whom, by whom, when, and the assembled `generation_payload` that reproduces it.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireActiveSubscription,
} = require('../../middlewares');

const controller = require('./documents.controller');
const { schemas } = require('./documents.validation');

const router = createRouter();

router.use(requireActiveSubscription());

router.get(
  '/',
  requirePermission('documents.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/* FR-DOC-001 — the generation itself. The module is checked per document type in the service. */
router.post(
  '/',
  requirePermission('documents.generate'),
  validate({ body: schemas.generate }),
  logActivity({ action: 'create', entityType: 'documents', onlyOnSuccess: true }),
  asyncHandler(controller.generate)
);

router.get(
  '/:id',
  requirePermission('documents.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

module.exports = router;
