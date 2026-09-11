'use strict';

/**
 * Students — SRS §15.1, FR-STUDENT-001 (admission) and FR-STUDENT-002 (promotion / transfer /
 * leaving).
 *
 * ## The ceiling
 *
 * `student_limit` counts `Student where status = 'active'` (`usageService.HEADCOUNT_SOURCES`), so
 * *every* status change is a usage event, not just admission. `enforceLimit` on `POST /` covers the
 * admission path; the three lifecycle routes re-sync afterwards. Nothing here moves a student *back*
 * into `active` — see the transition table — so there is no second place a ceiling has to be
 * asserted, which is the deliberate answer to §5a defect 21 rather than an omission.
 *
 * As in `teachers/`: for a headcount limit `enforceLimit` counts **live** from this table, so
 * `syncHeadcount` maintains the `usage_records` mirror that §9.1 and §13 report from, not the
 * enforcement path.
 *
 * ## One ambiguity in §15.1, named rather than silently resolved
 *
 * `students.status` is `active|promoted|transferred|left|graduated|inactive`, and FR-STUDENT-002 says
 * only "System updates the student's status/class/section accordingly". It does not say which status
 * a *promoted* student holds, and the two readings differ materially:
 *
 *   - Promotion sets `status = 'promoted'`. Then a school that promotes its whole cohort at year end
 *     drops to **zero** active students, its `student_limit` usage falls to nothing, and the ceiling
 *     stops meaning anything — a school on a 100-student plan could hold any number of children by
 *     promoting them. That cannot be what §11.2 intends.
 *   - Promotion keeps `status = 'active'` and records the movement in `promoted_at` and
 *     `previous_class_id` — columns §29 provides for exactly that. The student is still enrolled,
 *     because they are: they are in the next class.
 *
 * The second is taken. It is the reading consistent with §11.2's limit and with the columns the
 * schema already carries, and it is the safer of the two if it is wrong — a school is over-counted,
 * not under-charged. `promoted` is therefore a value this module never writes, and that is recorded
 * here rather than left for a later session to "fix" by making promotion set it.
 *
 * `graduated` and `inactive` are likewise never written: FR-STUDENT-002 names Promotion, Transfer and
 * Leaving, and inventing a fourth and fifth operation to reach them would be exactly what §35 forbids.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const dates = require('../../utils/dates');
const {
  resolveSchool,
  loadClassInSchool,
  loadSectionOfClass,
  loadSessionInSchool,
  assertOpenForNew,
} = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { cleanupUploads, relativeUploadPath, uploadedFiles } = require('../../middlewares/upload');
const usageService = require('../../services/usageService');
const selfScope = require('../../services/selfScope');
const usersService = require('../users/users.service');
const { LIMITS, STUDENT_STATUS, DOCUMENT_OWNER_TYPES } = require('../../config/constants');

const SORTABLE = Object.freeze([
  'id',
  'student_id',
  'roll_number',
  'first_name',
  'last_name',
  'admission_date',
  'status',
  'created_at',
]);

const EDITABLE = Object.freeze([
  'student_id',
  'user_id',
  'roll_number',
  'admission_number',
  'admission_date',
  'admission_session_id',
  'first_name',
  'last_name',
  'gender',
  'date_of_birth',
  'blood_group',
  'religion',
  'nationality',
  'email',
  'phone',
  'address',
  'city',
  'guardian_name',
  'guardian_phone',
  'guardian_relation',
  'emergency_contact',
  /*
   * `photo_path` is deliberately NOT here — Known Issues #26. It is written only by `setPhoto()` from
   * an uploaded file, never copied off a request body by `pickEditable()`.
   */
  'class_id',
  'section_id',
  'academic_session_id',
  'uses_transport',
  'notes',
  'metadata',
]);

const DATE_ONLY_FIELDS = Object.freeze(['admission_date', 'date_of_birth']);

/**
 * Sentinel meaning "allocate this inside the transaction".
 *
 * A `Symbol` rather than `null` or `undefined`, because both of those are legitimate roll numbers to
 * write — `null` clears it — and a sentinel that collides with a real value is how a "no value"
 * marker turns into a silent data bug.
 */
const ROLL_NUMBER_PENDING = Symbol('roll_number:allocate');

/**
 * FR-STUDENT-002 as a table rather than scattered conditionals — the shape `schools.setStatus()`
 * uses. `from` is the set of statuses the operation may be applied to; `columns()` returns exactly
 * what the operation writes.
 *
 * All three start from `active` only. A student who has left is not transferable, and a transferred
 * student is not promotable — and because nothing here returns a student *to* `active`, the ceiling
 * cannot be re-entered without a fresh admission, which is guarded.
 */
const TRANSITIONS = Object.freeze({
  promote: {
    from: [STUDENT_STATUS.ACTIVE],
    verb: 'Promoted',
    event: 'promote',
  },
  transfer: {
    from: [STUDENT_STATUS.ACTIVE],
    verb: 'Transferred',
    event: 'transfer',
    columns: (row, payload) => ({
      status: STUDENT_STATUS.TRANSFERRED,
      transferred_at: new Date(),
      transfer_to: payload.transfer_to || null,
    }),
  },
  leave: {
    from: [STUDENT_STATUS.ACTIVE],
    verb: 'Marked as left',
    event: 'leave',
    columns: (row, payload) => ({
      status: STUDENT_STATUS.LEFT,
      left_at: new Date(),
      leaving_reason: payload.leaving_reason || null,
    }),
  },
});

function dateOnly(value) {
  return value === undefined || value === null || value === '' ? value : dates.toDateOnly(value);
}

function pickEditable(payload) {
  const next = {};
  for (const key of EDITABLE) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    next[key] = DATE_ONLY_FIELDS.includes(key) ? dateOnly(payload[key]) : payload[key];
  }
  return next;
}

function rethrow(err, payload) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    throw ApiError.conflict('A student with this student id already exists at this school', {
      code: 'STUDENT_ID_TAKEN',
      details: { student_id: payload && payload.student_id },
    });
  }
  if (err instanceof db.Sequelize.ValidationError) {
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  throw err;
}

/**
 * Resolve and cross-check the placement a body asks for.
 *
 * A section must belong to the class, and the class, section and session must all belong to the
 * school — none of which the body may be trusted for. Returns the normalised trio so a caller writes
 * the checked values rather than the submitted ones.
 */
async function resolvePlacement(payload, schoolId, current = {}) {
  const classId = Object.prototype.hasOwnProperty.call(payload, 'class_id')
    ? payload.class_id
    : current.class_id;

  /*
   * A section is never inherited across a change of class.
   *
   * `sections.class_id` is NOT NULL and a section belongs to exactly one class, so the student's
   * current section is by definition not a section of the class they are moving into. Carrying it
   * forward and then validating it against the new class made **every** promotion of a sectioned
   * student fail with `section_id must name a section of this class` — naming a field the caller
   * never sent and could not remove. That is the ordinary shape §15.1's "Section Assignment"
   * produces, so it made FR-STUDENT-002's headline operation unusable; the suite missed it because
   * its one successful promotion always named a destination section.
   *
   * So: an omitted `section_id` means "keep the current section" only while the class is unchanged,
   * and means "leave the old section behind" when the class moves.
   */
  const classChanged =
    Object.prototype.hasOwnProperty.call(payload, 'class_id') &&
    String(payload.class_id ?? '') !== String(current.class_id ?? '');

  const sectionId = Object.prototype.hasOwnProperty.call(payload, 'section_id')
    ? payload.section_id
    : (classChanged ? null : current.section_id);

  const klass = classId ? await loadClassInSchool(classId, schoolId) : null;

  /*
   * The session follows the class when the class moves, for the same reason the section does not.
   *
   * A class belongs to one academic session (`classes.academic_session_id`), and §15.1's promotion is
   * "to a new class/session" (SRS:821). Keeping the old session made a student promoted into next
   * year's class carry last year's, which `fees.service` then stamped on every fee row assigned to them
   * and `documents.service` printed on their certificates. A caller may still name a session; an
   * unchanged class keeps the one the student has; a destination class with no session changes nothing.
   */
  const sessionId = Object.prototype.hasOwnProperty.call(payload, 'academic_session_id')
    ? payload.academic_session_id
    : (classChanged && klass && klass.academic_session_id
      ? klass.academic_session_id
      : current.academic_session_id);

  if (sectionId) {
    if (!classId) {
      throw ApiError.validation('section_id requires class_id', [
        { field: 'class_id', message: 'Name the class this section belongs to' },
      ]);
    }
    await loadSectionOfClass(sectionId, classId);
  }
  if (sessionId) await loadSessionInSchool(sessionId, schoolId);

  /*
   * `admission_session_id` is a second FK to `academic_sessions` and was going straight from the body
   * into the insert while its sibling was checked — the docstring above claimed "the class, section
   * and session must all belong to the school" and one of the two sessions did not. A school could
   * pin its student to another tenant's admission session, which
   * `Student.belongsTo(AcademicSession, { as: 'admissionSession' })` would then eager-load into its
   * own responses.
   */
  if (Object.prototype.hasOwnProperty.call(payload, 'admission_session_id') && payload.admission_session_id) {
    await loadSessionInSchool(payload.admission_session_id, schoolId, 'admission_session_id');
  }

  return { classId: classId || null, sectionId: sectionId || null, sessionId: sessionId || null };
}

/**
 * A `user_id` may only name a `users` row of the same school, and only one student may hold it.
 *
 * `students.user_id` carries a plain index, not a unique one, and `User.hasOne(Student)` resolves the
 * profile by that column — so a duplicate link makes the association answer with whichever row the
 * optimiser returns first, and a cross-school link binds a student to another tenant's login. The
 * teachers module makes the identical check for the identical reason (§5a defect 23); this is the
 * second copy, and `schoolScope.js` already carries the note about converging the duplicated helpers.
 */
async function loadUserInSchool(userId, schoolId, exceptStudentId = null) {
  if (userId === undefined || userId === null || userId === '') return null;

  const user = await db.User.findOne({ where: { id: userId, school_id: schoolId } });
  if (!user) {
    throw ApiError.validation('user_id must name a user of this school', [
      { field: 'user_id', message: 'Name a users row of the same school' },
    ]);
  }

  const taken = await db.Student.findOne({
    where: {
      user_id: userId,
      school_id: schoolId,
      ...(exceptStudentId ? { id: { [Op.ne]: exceptStudentId } } : {}),
    },
  });
  if (taken) {
    throw ApiError.conflict('That account is already linked to a student', {
      code: 'STUDENT_USER_TAKEN',
      details: { user_id: Number(userId), student_id: taken.id },
    });
  }

  return user;
}

/**
 * FR-STUDENT-001 — "System assigns a Student ID and Roll Number."
 *
 * The SRS asks for the assignment but names no format, so one is chosen here and recorded rather
 * than invented silently: `S-<admission year>-<zero-padded sequence within the school>`. A caller
 * that already has a scheme may still send its own `student_id`, which is why the schema accepts it.
 *
 * Allocated inside the caller's transaction with a locking read, because a plain `MAX + 1` is the
 * check-then-insert race §5a defect 19 documents — and here the unique index *would* catch it
 * (`(school_id, student_id)` has no nullable half), so without the lock a concurrent admission would
 * surface as a spurious `STUDENT_ID_TAKEN` on a value the caller never supplied.
 */
async function allocateStudentId(school, admissionDate, transaction) {
  const schoolId = school.id;
  const year = String(admissionDate || dates.toDateOnly(new Date())).slice(0, 4);
  /* `schools.code` is documented as the student-ID prefix (src/models/core.js:145). An earlier
     revision hardcoded "S-", which made two schools in one organization both issue `S-2025-0001` —
     visible to an organization admin listing across schools, since the unique index is only
     (school_id, student_id). */
  const scope = `${school.code}-${year}-`;

  /*
   * The maximum is computed **numerically in JS**, not by `ORDER BY student_id DESC LIMIT 1`.
   *
   * A column sort here is lexicographic, and both ways it goes wrong were measured rather than
   * imagined:
   *
   *   - `'S-2025-9999'` sorts ABOVE `'S-2025-10000'` (digit-by-digit, `'9' > '1'`). So the first time
   *     a school passes ten thousand admissions in one year the DESC read keeps returning `…-9999`,
   *     the allocator keeps proposing `…-10000`, and every subsequent auto-allocated admission fails
   *     with `STUDENT_ID_TAKEN` — a permanent wedge, not a one-off collision.
   *   - `'A'` is ASCII 65 and `'9'` is 57, so a caller-supplied `'S-2025-ABCD'` sorts above every
   *     generated id. `Number('ABCD')` is `NaN`, the fallback reset the sequence to 1, and the next
   *     admission collided with `…-0001` on an id the caller never supplied. The schema accepts a
   *     caller's own `student_id` deliberately, so this is reachable, not theoretical.
   *
   * Filtering to `/^\d+$/` ignores any suffix a school's own scheme introduces, and `Math.max` over
   * the parsed values is correct at any width. `paranoid: false` is deliberate: the unique index is
   * `(school_id, student_id)` and knows nothing about `deleted_at`, so a soft-deleted student still
   * owns its id.
   */
  const rows = await db.Student.findAll({
    where: { school_id: schoolId, student_id: { [Op.like]: `${scope}%` } },
    attributes: ['student_id'],
    paranoid: false,
    transaction,
    lock: transaction.LOCK.UPDATE,
  });

  const highest = rows.reduce((max, r) => {
    const suffix = String(r.student_id).slice(scope.length);
    if (!/^\d+$/.test(suffix)) return max;
    const n = Number(suffix);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  return `${scope}${String(highest + 1).padStart(4, '0')}`;
}

/** Next roll number within the class/section, on the same reasoning as the student id. */
async function allocateRollNumber(schoolId, classId, sectionId, transaction) {
  if (!classId) return null;
  const rows = await db.Student.findAll({
    where: {
      school_id: schoolId,
      class_id: classId,
      ...(sectionId ? { section_id: sectionId } : { section_id: { [Op.is]: null } }),
    },
    attributes: ['roll_number'],
    paranoid: false,
    transaction,
    lock: transaction.LOCK.UPDATE,
  });

  const highest = rows.reduce((max, r) => {
    const n = Number(r.roll_number);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return String(highest + 1);
}

async function findById(req, id, namedSchoolId = undefined) {
  const where = tenantWhere(req.tenant, { id });
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;

  /*
   * Keep the record and the entitlement guard on the same school — §5a defect 22.
   *
   * The platform caller is deliberately **not** excluded. `named` is only truthy when the caller named
   * a school themselves and `resolveSchool()` already handles all three scopes, so the exclusion
   * relaxed nothing — it discarded the one scope declaration a Super Admin can make, letting a request
   * that named school A read or write a row belonging to school B instead of answering 404.
   */
  if (named) {
    const school = await resolveSchool(req, named);
    where.school_id = school.id;
  }

  const row = await db.Student.findOne({ where });
  if (!row) throw ApiError.notFound('Student not found', { code: 'STUDENT_NOT_FOUND' });
  return row;
}

async function list(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.status) where.status = query.status;
  if (query.class_id) where.class_id = query.class_id;
  if (query.section_id) where.section_id = query.section_id;
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;
  if (query.uses_transport !== undefined) where.uses_transport = query.uses_transport;
  if (query.q) {
    where[Op.or] = [
      { first_name: { [Op.like]: `%${query.q}%` } },
      { last_name: { [Op.like]: `%${query.q}%` } },
      { student_id: { [Op.like]: `%${query.q}%` } },
      { roll_number: { [Op.like]: `%${query.q}%` } },
    ];
  }

  return paginateQuery(
    db.Student,
    { where, order: getSort({ query }, SORTABLE, ['first_name', 'ASC']) },
    pagination
  );
}

/** FR-STUDENT-001. */
async function create(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const placement = await resolvePlacement(payload, school.id);
  /*
   * D20 — a closed session takes no new admission, whether the session was named or came with the
   * class (`resolvePlacement`).
   */
  await assertOpenForNew({ sessionId: placement.sessionId, classId: placement.classId }, 'admission');
  await loadUserInSchool(payload.user_id, school.id);

  let row;
  try {
    row = await db.sequelize.transaction(async (t) => {
      /*
       * The limit check, **inside this transaction and before anything else reads** — Known Issues
       * #21.
       *
       * `enforceLimit` has already checked on the way in, and that check is still worth having: it
       * refuses cheaply and phrases the refusal for the school. But it is middleware, it returns
       * before this transaction exists, and two concurrent admissions can both pass it. Measured
       * with `student_limit = 1` and eight concurrent admissions: eight were admitted.
       *
       * `reserveHeadcount()` locks the `schools` row and counts under that lock, which makes the
       * check and the insert below one atomic step. It must be first: a plain read before it would
       * fix this transaction's snapshot ahead of the lock and the count would miss the very row it
       * exists to see. `allocateStudentId` and `allocateRollNumber` therefore run after it, not
       * before.
       */
      await usageService.reserveHeadcount(school.id, LIMITS.STUDENT_LIMIT, 1, t);

      const fields = pickEditable(payload);
      const admissionDate = dateOnly(payload.admission_date);

      if (!fields.student_id) {
        fields.student_id = await allocateStudentId(school, admissionDate, t);
      }
      if (!fields.roll_number) {
        fields.roll_number = await allocateRollNumber(school.id, placement.classId, placement.sectionId, t);
      }

      return db.Student.create(
        {
          school_id: school.id,
          organization_id: school.organization_id,
          ...fields,
          class_id: placement.classId,
          section_id: placement.sectionId,
          academic_session_id: placement.sessionId,
          status: STUDENT_STATUS.ACTIVE,
        },
        { transaction: t }
      );
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'students',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  await syncStudentHeadcount(school.id);
  return row;
}

async function update(req, id, payload) {
  const row = await findById(req, id, payload.school_id);
  const placement = await resolvePlacement(payload, row.school_id, row);
  if (Object.prototype.hasOwnProperty.call(payload, 'user_id') && payload.user_id) {
    await loadUserInSchool(payload.user_id, row.school_id, row.id);
  }

  const before = snapshot(row);
  const next = pickEditable(payload);
  if (!Object.keys(next).length) {
    throw ApiError.validation('No student fields to update', [
      { field: 'body', message: 'Send at least one profile field' },
    ]);
  }

  /*
   * Write the checked placement rather than the submitted one — and when the class moves, the section
   * and session that `resolvePlacement()` resolved for it, whether or not the body named them. Writing
   * only the keys the body carried left a student moved by `PATCH` into another class still holding a
   * section of the old one.
   */
  const classMoved =
    Object.prototype.hasOwnProperty.call(next, 'class_id') &&
    String(placement.classId ?? '') !== String(row.class_id ?? '');
  if (Object.prototype.hasOwnProperty.call(next, 'class_id')) next.class_id = placement.classId;
  if (classMoved || Object.prototype.hasOwnProperty.call(next, 'section_id')) {
    next.section_id = placement.sectionId;
  }
  if (classMoved || Object.prototype.hasOwnProperty.call(next, 'academic_session_id')) {
    next.academic_session_id = placement.sessionId;
  }
  /*
   * D20 — moving a student into a closed session's class, or onto a closed session, is an admission
   * into it by another door: refusing only the create let a student be admitted to an open year and
   * then patched into a closed one. Edits that leave the placement where it is are unaffected.
   */
  const sessionMoved = Object.prototype.hasOwnProperty.call(next, 'academic_session_id') &&
    String(next.academic_session_id ?? '') !== String(row.academic_session_id ?? '');
  if (classMoved || sessionMoved) {
    await assertOpenForNew({
      sessionId: sessionMoved ? next.academic_session_id : null,
      classId: classMoved ? placement.classId : null,
    }, 'student');
  }

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'students',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  /* A profile edit never changes `status`, so the headcount cannot have moved — see the schema. */
  return row;
}

/**
 * The one place FR-STUDENT-002's three operations are applied.
 *
 * `promote` is the only one that needs the placement resolved first, so it supplies its columns here
 * rather than in the table; the other two are pure status stamps.
 */
async function applyTransition(req, id, operation, payload) {
  const transition = TRANSITIONS[operation];
  if (!transition) {
    /* Boot-level mistake, not a client one — the routes pass literals. */
    throw new Error(`students.service.applyTransition(): unsupported operation '${operation}'`);
  }

  const row = await findById(req, id, payload.school_id);

  if (!transition.from.includes(row.status)) {
    throw ApiError.conflict(`A student with status '${row.status}' cannot be ${transition.verb.toLowerCase()}`, {
      code: 'STUDENT_STATUS_INVALID',
      details: { id: row.id, status: row.status, allowedFrom: transition.from },
    });
  }

  let columns;
  if (operation === 'promote') {
    const placement = await resolvePlacement(payload, row.school_id, row);
    if (Number(placement.classId) === Number(row.class_id)) {
      throw ApiError.validation('A promotion must name a different class', [
        { field: 'class_id', message: 'Name the class the student moves into' },
      ]);
    }
    /* D20 — a promotion is into next year's class, and a closed year takes nobody new. */
    await assertOpenForNew({ sessionId: placement.sessionId, classId: placement.classId }, 'student');
    columns = {
      previous_class_id: row.class_id,
      class_id: placement.classId,
      section_id: placement.sectionId,
      academic_session_id: placement.sessionId,
      promoted_at: new Date(),
      /* `status` is deliberately untouched — see the header. A promoted student is still enrolled. */
    };

    /*
     * The roll number is re-allocated for the destination, not carried across.
     *
     * `allocateRollNumber` scopes by school + class + section, so a number issued in the old class
     * means nothing in the new one — and `people.js` documents `roll_number` as "unique within
     * class+section+session" while the index backing it (`section_id, roll_number`) is **not**
     * unique. Keeping the old number therefore silently produced duplicates: promote a cohort from
     * 1A into 2B and every number already in 2B is issued twice, with nothing to reject it and
     * attendance and mark sheets keyed on a value that now addresses two children.
     *
     * FR-STUDENT-001 makes roll-number assignment the system's job; there is no reason that stops
     * applying the moment the student changes class. A caller may still name one explicitly.
     */
    columns.roll_number =
      payload.roll_number !== undefined ? payload.roll_number : ROLL_NUMBER_PENDING;
  } else {
    columns = transition.columns(row, payload);
  }

  const before = snapshot(row);

  /*
   * D19 — a student who transfers or leaves takes their login with them, in the same transaction, as a
   * deactivated teacher or staff member does. Promotion keeps the student enrolled, so it moves nothing.
   */
  let moved = null;
  await db.sequelize.transaction(async (t) => {
    if (columns.roll_number === ROLL_NUMBER_PENDING) {
      columns.roll_number = await allocateRollNumber(
        row.school_id,
        columns.class_id,
        columns.section_id,
        t
      );
    }
    row.set(columns);
    await row.save({ transaction: t });
    if (operation !== 'promote') moved = await usersService.followProfile(row.user_id, false, t, 'Student');
  });

  await recordAudit(req, {
    tableName: 'students',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  await usersService.auditFollowed(req, moved, `Student ${transition.verb.toLowerCase()}`);

  /* Transfer and leaving take the student out of the active count; promotion does not. */
  await syncStudentHeadcount(row.school_id);
  return row;
}

/**
 * What a caller is shown — Known Issues #26.
 *
 * The stored path never leaves the service. Only whether there is a photo and what the file was
 * called, which is the shape `payments`, `homework`, `assignments`, `library` and `documents` all use,
 * and for the same reason: a path in a response is a directory layout in a response, and a caller has
 * nothing to fetch it with while no route in this application serves a file.
 *
 * The other three people modules deliberately do NOT get this. Their `photo_path` is refused from the
 * body and has no writer at all, so the column is permanently null and there is nothing to suppress.
 * If a later session gives one of them a writer, it must add `present()` in the same change.
 */
function present(row) {
  if (!row) return row;
  const json = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  delete json.photo_path;
  return { ...json, has_photo: Boolean(row.photo_path) };
}

/**
 * FR-STUDENT-001 — *"System captures Student Photo and Documents."*
 *
 * The first caller `UPLOAD_PROFILES.PERSON_PHOTO` has ever had. It has cited
 * `'§15.1 / FR-STUDENT-001 — "Photo"'` in its own rules table since `upload.js` was written, with
 * nothing calling it — the same situation `homework` and `submission` were in before §20.2 and §20.3.
 *
 * A replacement leaves the previous file on disk. Nothing in this application collects an orphaned
 * file — `cleanupUploads()` only unwinds a *failed* request — and collecting one would mean
 * dereferencing a stored path, which is the very thing Known Issues #26 exists to prevent while no
 * route serves a file. §20.2 recorded the identical trade for homework and chose the same way.
 */
async function setPhoto(req, id) {
  if (!req.file) {
    throw ApiError.validation('No photo was uploaded', [
      { field: 'photo', message: 'Attach the image as the "photo" field of a multipart request' },
    ]);
  }

  try {
    const row = await findById(req, id, req.body && req.body.school_id);
    const before = snapshot(row);

    row.set({ photo_path: relativeUploadPath(req.file) });
    await row.save();

    await recordAudit(req, {
      tableName: 'students',
      recordId: row.id,
      event: 'update',
      before,
      after: snapshot(row),
      reason: (req.body && req.body.reason) || null,
    });
    return row;
  } catch (err) {
    /* A stored file with no row pointing at it is disk nobody will ever collect. */
    await cleanupUploads(req);
    throw err;
  }
}

/* ────────── FR-STUDENT-001 "Documents" — the owner's decision D13; see the routes file ────────── */

/** An uploaded document as a caller sees it: never the stored path, which is the server's business. */
function presentDocument(row) {
  const json = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  delete json.file_path;
  delete json.generation_payload;
  return json;
}

/** Where this student's uploads are, and nothing generated — §20.5's documents are its own module's. */
function documentsOf(student) {
  return {
    school_id: student.school_id,
    owner_type: DOCUMENT_OWNER_TYPES.STUDENT,
    owner_id: student.id,
    is_generated: false,
  };
}

/**
 * Attach uploaded files to a student — `POST /students/:id/documents`.
 *
 * One `documents` row per file, in one transaction, so a batch lands whole or not at all; the files are
 * already on disk by the time this runs, so a failure removes them again. Titled by the caller's
 * `title` when there is one file, prefixed by it when there are several, and by the file's own name
 * otherwise. `storage_limit` is charged by the upload chain itself (`upload.verifyStorage()`), and
 * refunded there when this fails, as it is for every upload.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @returns {Promise<{student: object, documents: object[]}>}
 */
async function addDocuments(req, id) {
  const files = uploadedFiles(req);
  if (!files.length) {
    throw ApiError.validation('No document was uploaded', [
      { field: 'documents', message: 'Attach one or more files as the "documents" field of a multipart request' },
    ]);
  }
  const body = req.body || {};

  try {
    const student = await findById(req, id, body.school_id);
    const titleFor = (file) => {
      if (!body.title) return String(file.originalname).slice(0, 255);
      return (files.length === 1 ? body.title : `${body.title} — ${file.originalname}`).slice(0, 255);
    };

    const rows = await db.sequelize.transaction((transaction) =>
      db.Document.bulkCreate(
        files.map((file) => ({
          ...documentsOf(student),
          organization_id: student.organization_id,
          document_type: null,
          title: titleFor(file),
          file_path: relativeUploadPath(file),
          file_name: String(file.originalname).slice(0, 255),
          mime_type: file.mimetype,
          file_size_bytes: file.size,
          uploaded_by: req.user ? req.user.id : null,
          description: body.description || null,
        })),
        { validate: true, transaction }
      )
    );

    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await recordAudit(req, {
        tableName: 'documents',
        recordId: row.id,
        event: 'create',
        after: snapshot(row),
        reason: body.reason || `Uploaded to student ${student.student_id}`,
      });
    }
    return { student, documents: rows.map(presentDocument) };
  } catch (err) {
    await cleanupUploads(req);
    throw err;
  }
}

/**
 * The documents uploaded to a student — `GET /students/:id/documents`. Loaded through `findById`, so
 * the tenant rule that decides which students a caller may see decides which documents too.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {number|string} [schoolId]
 * @returns {Promise<{student: object, documents: object[]}>}
 */
async function listDocuments(req, id, schoolId) {
  const student = await findById(req, id, schoolId);
  const rows = await db.Document.findAll({ where: documentsOf(student), order: [['id', 'DESC']] });
  return { student, documents: rows.map(presentDocument) };
}

/**
 * One uploaded document of one student, with its stored path, for the controller to serve. A document
 * of another student, a generated document, or one that does not exist are all the same 404.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {number|string} documentId
 * @param {number|string} [schoolId]
 * @returns {Promise<{student: object, document: object}>}
 */
async function findDocument(req, id, documentId, schoolId) {
  const student = await findById(req, id, schoolId);
  const document = await db.Document.findOne({ where: { id: documentId, ...documentsOf(student) } });
  if (!document || !document.file_path) {
    throw ApiError.notFound('Document not found', { code: 'DOCUMENT_NOT_FOUND' });
  }
  return { student, document };
}

const promote = (req, id, payload) => applyTransition(req, id, 'promote', payload);
const transfer = (req, id, payload) => applyTransition(req, id, 'transfer', payload);
const leave = (req, id, payload) => applyTransition(req, id, 'leave', payload);

/**
 * Recount `student_limit` from the `students` table.
 *
 * A failure must not fail the request: the row is already committed and the mirror is reporting data
 * the next sync repairs. A null return is normal for a school with no resolvable billing period.
 */
async function syncStudentHeadcount(schoolId) {
  try {
    return await usageService.syncHeadcount(schoolId, LIMITS.STUDENT_LIMIT);
  } catch (err) {
    require('../../config/logger').warn('student headcount sync failed', {
      schoolId,
      limitKey: LIMITS.STUDENT_LIMIT,
      error: err.message,
    });
    return null;
  }
}

/**
 * What a student and their parents are shown of the record: the record itself, not the office's working
 * notes about it. `notes`, `metadata` and `leaving_reason` are written by staff for staff, and `user_id`
 * is the account's internal link; the self view names its columns rather than taking the staff row.
 */
const SELF_ATTRIBUTES = Object.freeze([
  'id', 'school_id', 'student_id', 'roll_number', 'admission_number', 'admission_date', 'admission_session_id',
  'first_name', 'last_name', 'gender', 'date_of_birth', 'blood_group', 'religion', 'nationality',
  'email', 'phone', 'address', 'city', 'guardian_name', 'guardian_phone', 'guardian_relation', 'emergency_contact',
  'photo_path', 'class_id', 'section_id', 'academic_session_id', 'status', 'promoted_at', 'transferred_at',
  'transfer_to', 'left_at', 'uses_transport',
]);

/**
 * The student record for the people it is about — `students.self.view`, the owner's decision D17.
 *
 * A student gets their own record and a parent each linked child's (`services/selfScope`), read-only,
 * with the class, section and session by name — neither holds `classes.view` or `sessions.view` to look
 * them up. Shown through `present()`, so the stored photo path stays behind as it does for staff.
 *
 * @param {import('express').Request} req
 * @returns {Promise<object[]>}
 */
async function mine(req) {
  const ids = await selfScope.linkedStudentIds(req);
  if (!ids.length) return [];
  const rows = await db.Student.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: SELF_ATTRIBUTES,
    include: [
      { model: db.Class, as: 'class', attributes: ['id', 'name'] },
      { model: db.Section, as: 'section', attributes: ['id', 'name'] },
      { model: db.AcademicSession, as: 'academicSession', attributes: ['id', 'name'] },
    ],
    order: [['first_name', 'ASC'], ['id', 'ASC']],
  });
  return rows.map(present);
}

module.exports = {
  list,
  findById,
  mine,
  create,
  update,
  setPhoto,
  addDocuments,
  listDocuments,
  findDocument,
  presentDocument,
  present,
  promote,
  transfer,
  leave,
  EDITABLE,
  TRANSITIONS,
};
