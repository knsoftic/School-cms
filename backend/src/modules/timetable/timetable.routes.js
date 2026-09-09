'use strict';

/**
 * Timetable routes — mounted at `/api/v1/timetable`.
 *
 * | SRS  | FR        | Route                      | Permission          |
 * |------|-----------|----------------------------|---------------------|
 * | 20.1 | FR-TT-001 | `GET /class/:classId`      | `timetable.view`    |
 * | 20.1 | FR-TT-001 | `GET /teacher/:teacherId`  | `timetable.view`    |
 * | 20.1 | FR-TT-001 | `GET /`                    | `timetable.view`    |
 * | 20.1 | FR-TT-001 | `POST /`                   | `timetable.manage`  |
 * | 20.1 | FR-TT-001 | `GET /:id`                 | `timetable.view`    |
 * | 20.1 | FR-TT-002 | `PATCH /:id`               | `timetable.manage`  |
 *
 * `/class/...` and `/teacher/...` are declared **before** `/:id`, because `/class` would otherwise
 * match `GET /:id` as an entry whose id is the word "class". The suite asserts the ordering.
 *
 * ## Two named views, because §20.1 names two things
 *
 * §20.1 lists a **Class Timetable** and a **Teacher Timetable** as separate items, and §29 gives one
 * table. They are two views of the same rows — the same week asked two different questions: *what does
 * this class do* and *where is this teacher*. Giving each the name the source uses makes both findable,
 * and each carries only the filters its question needs. `exams` does the same thing with `results`,
 * which it reads through three differently-shaped endpoints for three different questions.
 *
 * Both return **rows in week order**, not a grid. A grid is a shape §20.1 never names, and
 * `day_of_week` is an ENUM declared Monday-first — MySQL orders an ENUM by declaration order — so the
 * rows arrive as a week for free and a client can pivot them.
 *
 * ## Writes are one entry at a time
 *
 * FR-TT-002 checks "the new/edited entry", singular, and reports which existing entry it collides
 * with. A bulk week-replace would have to attribute a pile of conflicts to a pile of rows, which is a
 * worse answer to the question the FR actually asks. `attendance` and `fees` write in bulk because
 * their sources describe a register and a class-wide assignment; §20.1 describes neither.
 *
 * ## No DELETE, and `is_active` does not free a slot
 *
 * §20.1 names no deletion, and `is_active` is the retirement mechanism this project already uses for
 * a fee structure and a grade band. But it is worth being exact about what it does **not** do here:
 * `timetables_section_day_period_unique` counts inactive rows too, so deactivating an entry leaves its
 * `(section, day, period)` slot claimed. A section's grid is therefore one living plan rather than a
 * per-session history — the index carries no session column — and rearranging it means editing the
 * rows that are already there. That is the schema's choice and the service header explains why the
 * conflict checks deliberately match it rather than being cleverer.
 *
 * ## `timetable.view` is granted to almost everyone, deliberately
 *
 * The seeded catalogue gives `timetable.view` to Super Admin, Principal, School Admin, Teacher,
 * Receptionist, Staff, **Student and Parent** — and `timetable.manage` to Principal, School Admin and
 * Super Admin only, an exact match for FR-TT-001's actor list. There is **no** `timetable.self.view`
 * permission at all, unlike `results.self.view` and `attendance.self.view`, so no self-service route
 * is mounted: a student reads their class's timetable through the ordinary `GET /class/:classId` with
 * the same permission everyone else uses. The catalogue's judgement is that a timetable is not
 * sensitive, and with no narrower key to mount there is nothing to narrow it to.
 *
 * `requireModule(MODULES.TIMETABLE)` is mounted router-level. **No `enforceLimit`**: §11.2's eight
 * limits contain nothing timetable-shaped, and a period is not a headcount. Asserted by reading the
 * router's source rather than a handler name.
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

const controller = require('./timetable.controller');
const { schemas } = require('./timetable.validation');

const router = createRouter();

router.use(requireModule(MODULES.TIMETABLE));

/* ── §20.1's two named views — literal paths first ── */

router.get(
  '/class/:classId',
  requirePermission('timetable.view'),
  validate({ params: schemas.classParam, query: schemas.classView }),
  asyncHandler(controller.classView)
);

router.get(
  '/teacher/:teacherId',
  requirePermission('timetable.view'),
  validate({ params: schemas.teacherParam, query: schemas.teacherView }),
  asyncHandler(controller.teacherView)
);

/* ── FR-TT-001 / FR-TT-002 ── */

router.get(
  '/',
  requirePermission('timetable.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.post(
  '/',
  requirePermission('timetable.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'timetable', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('timetable.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('timetable.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'timetable', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

module.exports = router;
