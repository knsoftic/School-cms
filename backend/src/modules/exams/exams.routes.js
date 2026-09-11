'use strict';

/**
 * Exam routes — mounted at `/api/v1/exams`.
 *
 * | SRS | FR         | Route                                  | Permission         |
 * |-----|------------|----------------------------------------|--------------------|
 * | 19.1| FR-EXAM-001| `GET /grade-scales`                    | `exams.view`       |
 * | 19.1| FR-EXAM-001| `POST /grade-scales`                   | `exams.manage`     |
 * | 19.1| FR-EXAM-001| `PATCH /grade-scales/:id`              | `exams.manage`     |
 * | 19.3| FR-EXAM-005| `GET /my-results`                      | `results.self.view`|
 * | 19.2| FR-EXAM-002| `GET /marks`                           | `exams.view`       |
 * | 19.2| FR-EXAM-002| `POST /marks`                          | `marks.enter`      |
 * | 19.2| FR-EXAM-002| `POST /marks/submit`                   | `marks.enter`      |
 * | 19.3| FR-EXAM-004| `GET /results`                         | `results.view`     |
 * | 19.3| FR-EXAM-004| `GET /results/:id`                     | `results.view`     |
 * | 19.1| FR-EXAM-001| `GET /`                                | `exams.view`       |
 * | 19.1| FR-EXAM-001| `POST /`                               | `exams.manage`     |
 * | 19.1| FR-EXAM-001| `GET /:id`                             | `exams.view`       |
 * | 19.1| FR-EXAM-001| `PATCH /:id`                           | `exams.manage`     |
 * | 19.1| FR-EXAM-001| `GET /:id/subjects`                    | `exams.view`       |
 * | 19.1| FR-EXAM-001| `POST /:id/subjects`                   | `exams.manage`     |
 * | 19.1| FR-EXAM-001| `PATCH /:id/subjects/:examSubjectId`   | `exams.manage`     |
 * | 19.3| FR-EXAM-004| `GET /:id/results`                     | `results.view`     |
 * | 19.3| FR-EXAM-004| `POST /:id/results`                    | `results.generate` |
 * | 19.3| FR-EXAM-004| `POST /:id/publish`                    | `results.generate` |
 *
 * Every literal path is declared **before** the `/:id` family, because `GET /marks` and `GET /:id`
 * both match `/marks` and Express takes the first. That ordering is load-bearing here, not cosmetic,
 * and the suite asserts it.
 *
 * ## One module, because §19 is one subscribable key
 *
 * The rule in this codebase is one router per `MODULES` key, not one per SRS section — §14 became four
 * routers and §15 four more, because §11.1 defines four keys for each; §16 is a single module despite
 * two tables and a five-way permission seam, because there is one `ATTENDANCE` key. §19 has one key,
 * `MODULES.EXAMS`, so it is one router with one `requireModule()` guard. A permission seam is not a
 * module boundary.
 *
 * **No `enforceLimit`** — §11.2's eight limits contain nothing exam-shaped, and neither an exam nor a
 * mark is a headcount. Asserted by reading the router's source, not a handler name.
 *
 * ## The Teacher actor mismatch, stated rather than resolved
 *
 * FR-EXAM-001 and FR-EXAM-004 both name **Teacher** among their actors. The seeded catalogue — fixed
 * by §29/§30, and unchangeable — gives the `teacher` role `exams.view`, `marks.enter` and
 * `results.view`, and withholds `exams.manage` and `results.generate`. So a teacher may read an exam,
 * enter and submit its marks, and read the results, but may not create the exam or generate the
 * results.
 *
 * The catalogue is taken as authoritative, the same reading §16 reached when FR-ATT-003 named Teacher
 * while the catalogue withheld `attendance.teacher.mark`. Two reasons, and the second is the stronger:
 * widening a grant means editing one of the 109 fixed permissions on an inference, which §35 does not
 * license; and the narrower reading is the safer one, since `marks.enter` is precisely the FR-EXAM-002
 * actor list — the part of §19 that names a teacher alone — while creating exams and publishing results
 * are the acts a school holds its principal accountable for. The mismatch is recorded here and in the
 * progress log rather than silently resolved either way.
 *
 * ## No DELETE anywhere
 *
 * §19 names no deletion, and every table here cascades — verified against the live schema:
 * `exam_subjects`, `marks` and `results` are all `ON DELETE CASCADE` from `exams`, and `marks` cascades
 * from `exam_subjects` too. So deleting one exam would take a published result card out from under a
 * parent. A grade band is retired with `is_active: false` instead.
 *
 * **An exam has no retirement path, and that is a recorded gap rather than a claim.** `EXAM_STATUS`
 * carries a `cancelled` value and **nothing in this module sets it**: §19 describes creating an exam,
 * marking it, calculating and publishing — never cancelling one. The status is left unwritten for the
 * same reason `student_fees.waived` is, and inventing a cancel edge would be inventing a requirement.
 *
 * ## `results.self.view` is mounted here
 *
 * The first of the four self-view keys to be mounted — §16 and §17's followed with the owner's decision
 * D17 (`GET /attendance/mine`, `GET /fees/mine`, `GET /students/mine`). §19.3 names "Student Result"
 * outright and FR-EXAM-005's actor list is
 * *"Principal / School Admin / Teacher / Parent / Student"* — the source asks for it, so `GET
 * /my-results` exists and serves only **published** results, confined to the caller's own record or
 * their own children.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
} = require('../../middlewares');
const { MODULES, REPORT_FORMATS } = require('../../config/constants');
const { respondsWithFile } = require('../../utils/routeMeta');

const controller = require('./exams.controller');
const { schemas } = require('./exams.validation');

const router = createRouter();

router.use(requireModule(MODULES.EXAMS));

/* ── §19.1 the Grade System — literal paths first ── */

router.get(
  '/grade-scales',
  requirePermission('exams.view'),
  validate({ query: schemas.listGrades }),
  asyncHandler(controller.listGrades)
);

router.post(
  '/grade-scales',
  requirePermission('exams.manage'),
  validate({ body: schemas.createGrade }),
  logActivity({ action: 'create', entityType: 'grade', onlyOnSuccess: true }),
  asyncHandler(controller.createGrade)
);

router.patch(
  '/grade-scales/:id',
  requirePermission('exams.manage'),
  validate({ params: schemas.idParam, body: schemas.updateGrade }),
  logActivity({ action: 'update', entityType: 'grade', onlyOnSuccess: true }),
  asyncHandler(controller.updateGrade)
);

/* ── §19.3 the self-service view FR-EXAM-005 names ── */

router.get(
  '/my-results',
  requirePermission('results.self.view'),
  validate({ query: schemas.myResults }),
  asyncHandler(controller.myResults)
);

/* ── §19.2 Marks ── */

router.get(
  '/marks',
  requirePermission('exams.view'),
  validate({ query: schemas.listMarks }),
  asyncHandler(controller.listMarks)
);

router.post(
  '/marks',
  requirePermission('marks.enter'),
  validate({ body: schemas.enterMarks }),
  logActivity({ action: 'create', entityType: 'mark', onlyOnSuccess: true }),
  asyncHandler(controller.enterMarks)
);

router.post(
  '/marks/submit',
  requirePermission('marks.enter'),
  validate({ body: schemas.submitMarks }),
  logActivity({ action: 'update', entityType: 'mark', onlyOnSuccess: true }),
  asyncHandler(controller.submitMarks)
);

/* ── §19.3 Results ── */

router.get(
  '/results',
  requirePermission('results.view'),
  validate({ query: schemas.listResults }),
  asyncHandler(controller.listResults)
);

router.get(
  '/results/:id',
  requirePermission('results.view'),
  validate({ params: schemas.idParam, query: schemas.resultQuery }),
  respondsWithFile(asyncHandler(controller.showResult), {
    types: [controller.PDF_MIME],
    when: `format=${REPORT_FORMATS.PDF}`,
  })
);

/* ── §19.1 the examination ── */

router.get(
  '/',
  requirePermission('exams.view'),
  validate({ query: schemas.listExams }),
  asyncHandler(controller.listExams)
);

router.post(
  '/',
  requirePermission('exams.manage'),
  validate({ body: schemas.createExam }),
  logActivity({ action: 'create', entityType: 'exam', onlyOnSuccess: true }),
  asyncHandler(controller.createExam)
);

router.get(
  '/:id',
  requirePermission('exams.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.showExam)
);

router.patch(
  '/:id',
  requirePermission('exams.manage'),
  validate({ params: schemas.idParam, body: schemas.updateExam }),
  logActivity({ action: 'update', entityType: 'exam', onlyOnSuccess: true }),
  asyncHandler(controller.updateExam)
);

router.get(
  '/:id/subjects',
  requirePermission('exams.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.listExamSubjects)
);

router.post(
  '/:id/subjects',
  requirePermission('exams.manage'),
  validate({ params: schemas.idParam, body: schemas.addExamSubject }),
  logActivity({ action: 'create', entityType: 'exam_subject', onlyOnSuccess: true }),
  asyncHandler(controller.addExamSubject)
);

router.patch(
  '/:id/subjects/:examSubjectId',
  requirePermission('exams.manage'),
  validate({ params: schemas.examSubjectParam, body: schemas.updateExamSubject }),
  logActivity({ action: 'update', entityType: 'exam_subject', onlyOnSuccess: true }),
  asyncHandler(controller.updateExamSubject)
);

router.get(
  '/:id/results',
  requirePermission('results.view'),
  validate({ params: schemas.idParam, query: schemas.classResultQuery }),
  respondsWithFile(asyncHandler(controller.classResult), {
    types: [controller.PDF_MIME],
    when: `format=${REPORT_FORMATS.PDF}`,
  })
);

router.post(
  '/:id/results',
  requirePermission('results.generate'),
  validate({ params: schemas.idParam, body: schemas.generateResults }),
  logActivity({ action: 'update', entityType: 'result', onlyOnSuccess: true }),
  asyncHandler(controller.generateResults)
);

router.post(
  '/:id/publish',
  requirePermission('results.generate'),
  validate({ params: schemas.idParam, body: schemas.publishResults }),
  logActivity({ action: 'update', entityType: 'result', onlyOnSuccess: true }),
  asyncHandler(controller.publishResults)
);

module.exports = router;
