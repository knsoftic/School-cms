'use strict';

/**
 * Attendance routes — mounted at `/api/v1/attendance`.
 *
 * | SRS | FR          | Route                        | Permission                 |
 * |-----|-------------|------------------------------|----------------------------|
 * | §16 | FR-ATT-001  | `POST /students`             | `attendance.mark`          |
 * | §16 | FR-ATT-001  | `GET /students`              | `attendance.view`          |
 * | §16 | FR-ATT-002  | `GET /students/report`       | `attendance.view`          |
 * | §16 | FR-ATT-003  | `POST /teachers`             | `attendance.teacher.mark`  |
 * | §16 | FR-ATT-003  | `GET /teachers`              | `attendance.teacher.view`  |
 *
 * **The permission split is the SRS's, and one part of it is narrower than the FR's actor list —
 * named here rather than silently resolved.** FR-ATT-001's actor is "Teacher", and the seeded
 * `teacher` role holds `attendance.mark`; FR-ATT-002's actors are Principal / School Admin / Teacher,
 * and all three hold `attendance.view`. But FR-ATT-003 also lists Teacher, and the seeded `teacher`
 * role holds **neither** `attendance.teacher.mark` nor `attendance.teacher.view` — only
 * `attendance.self.view`.
 *
 * The seeded catalogue is taken as authoritative, because it is part of the §29-fixed 109
 * permissions and because it is the safer reading: a teacher seeing *their own* record is what
 * `attendance.self.view` is for, and letting every teacher record the whole staff's attendance is a
 * wider grant than §16 anywhere asks for. Widening it would mean editing the seeded catalogue, which
 * §35 does not license on an inference.
 *
 * `attendance.self.view` has **no endpoint**, deliberately: §16 names no self-service view, and
 * `students.self.view` was left the same way in §15 for the same reason. Both are recorded rather
 * than quietly mounted.
 *
 * `GET /students/report` is declared **before** `GET /students` cannot matter — they are different
 * paths, not a literal-versus-parameter collision — but it is declared first anyway so the reading
 * order matches the FR order.
 *
 * `requireModule(MODULES.ATTENDANCE)` is mounted router-level, as in all four Phase 3.J modules.
 * **No `enforceLimit`**: SRS §11.2's eight limits contain nothing attendance-shaped, and attendance
 * rows are not a headcount — `usageService.HEADCOUNT_SOURCES` covers students, teachers, staff and
 * admins only. Asserted in the suite so a later reader does not add one.
 *
 * There is no DELETE and no PATCH: re-posting a register **corrects** it, because the unique index on
 * `(student_id, attendance_date)` makes the write an upsert. A teacher fixing a mistake marks the
 * register again, which is the operation §16 describes.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
} = require('../../middlewares');
const { MODULES } = require('../../config/constants');

const controller = require('./attendance.controller');
const { schemas } = require('./attendance.validation');

const router = createRouter();

router.use(requireModule(MODULES.ATTENDANCE));

router.get(
  '/students/report',
  requirePermission('attendance.view'),
  validate({ query: schemas.report }),
  asyncHandler(controller.report)
);

router.post(
  '/students',
  requirePermission('attendance.mark'),
  validate({ body: schemas.markStudents }),
  logActivity({ action: 'create', entityType: 'student_attendance', onlyOnSuccess: true }),
  asyncHandler(controller.markStudents)
);

router.get(
  '/students',
  requirePermission('attendance.view'),
  validate({ query: schemas.listStudents }),
  asyncHandler(controller.listStudents)
);

router.post(
  '/teachers',
  requirePermission('attendance.teacher.mark'),
  validate({ body: schemas.markTeachers }),
  logActivity({ action: 'create', entityType: 'teacher_attendance', onlyOnSuccess: true }),
  asyncHandler(controller.markTeachers)
);

router.get(
  '/teachers',
  requirePermission('attendance.teacher.view'),
  validate({ query: schemas.listTeachers }),
  asyncHandler(controller.listTeachers)
);

module.exports = router;
