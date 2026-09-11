'use strict';

/**
 * Examinations & Results — SRS §19, FR-EXAM-001 … FR-EXAM-005.
 *
 * Five tables: `grades` (the Grade System), `exams`, `exam_subjects` (Subjects / Marks / Passing
 * Marks), `marks`, and `results` — the persisted answers to §19.2's calculation and §19.3's Position.
 *
 * ## The one scoping rule that matters here
 *
 * **`exam_subjects` has no `organization_id` column, so `tenantWhere()` must never touch it.** That
 * exact mistake has shipped twice in this project (§5a defect 16, on `class_subjects` and
 * `teacher_subjects`) and produces a 500 reading `Unknown column 'ExamSubject.organization_id'`. Every
 * child query here is scoped by the **parent exam's** `school_id` through `childScope()`, the shape
 * `subjects` and `parents` already use. `parent_students`, used by the self-service view, is the same
 * kind of table.
 *
 * `grades` is the opposite shape: its `school_id` is **nullable**, because a null-school row is a
 * platform-provided default scale that any school may use. `tenantWhere()` would hide exactly those
 * rows, so `gradeScope()` reads "this school's bands **or** the system's".
 *
 * ## FR-EXAM-003, the calculation, stated once
 *
 * `recalculate()` is the only writer of `results.total_*`, `percentage`, `grade_name`, `grade_point`,
 * `outcome`, `subjects_count`, `subjects_failed`, `subject_breakdown` and `calculated_at`, and of
 * `marks.grade_name` / `marks.outcome`. It requires a transaction, re-derives every figure from the
 * exam's own rows, and never increments — the shape `invoices.applyPayment()` and `fees.applyPayment()`
 * both use, for the same reason.
 *
 *     subject_full     = full_marks + (practical_full_marks ?? 0)
 *     subject_obtained = is_absent ? 0 : (marks_obtained ?? 0) + (practical_marks_obtained ?? 0)
 *     total_full_marks     = Σ subject_full      over the exam's submitted papers
 *     total_marks_obtained = Σ subject_obtained
 *     percentage           = total_full == 0 ? 0 : round3(obtained ÷ full × 100)
 *
 * Arithmetic runs in **integer hundredths**, matching the `DECIMAL(_,2)` mark columns, for the reason
 * `utils/money.js` exists: a float comparison at 33.33 is how a pass goes missing. `money.js` is reused
 * rather than copied — its scale is the same — with the one exception that a percentage needs three
 * decimals, which `round3()` does locally.
 *
 * **Weighting is not applied.** `exam_subjects.weightage` exists and is commented as an aggregation
 * weight, but §19 states Total, Percentage, Grade and Pass/Fail and never mentions weighting. The
 * column is `forbidden()` in both request schemas, so it holds its NOT NULL default of 1 for every
 * exam this system can create — at which the weighted and plain sums are the same number. Turning it
 * on would be a §19 decision, not a silent one.
 *
 * **Practical marks are aggregated, on both sides.** The line against `weightage` is that weighting
 * changes the *formula*; a practical paper is simply more marks, and §19.1 names "Marks" and "Passing
 * Marks" without saying a subject has one paper. Including the numerator without the denominator would
 * let a percentage exceed 100, which no grade band can match — so both halves, or neither. Both.
 *
 * ## Pass/Fail — two signals, and any failing signal wins
 *
 * §19.2 names "Pass/Fail" once and the schema offers two independent tests. Both govern:
 *
 *  - **Per subject** (`marks.outcome`): a paper is passed only if the student was not absent, scored
 *    at least `passing_marks`, and — when the paper has a practical bar — at least
 *    `practical_passing_marks`. Two gates, not one combined threshold: `practical_passing_marks` is
 *    its own column and the model validator compares it to `practical_full_marks`, so a school that
 *    sets it means a child cannot compensate with theory.
 *  - **Per exam** (`results.outcome`): `fail` if any subject failed; otherwise `fail` if the matched
 *    grade band is marked `is_failing`; otherwise `pass`.
 *
 * The order resolves the case the source leaves open — a student who passes every paper but lands in a
 * failing band. `grades.is_failing`'s own column comment states its rule unconditionally and cites the
 * source (*"A band marked is_failing yields Pass/Fail = fail (SRS §19.2)"*), and `results.subjects_failed`
 * is a persisted counter that exists so a card can say *why*. A reading in which either signal could
 * override the other would make one of them decorative.
 *
 * ## Completeness is enforced at submission, not at calculation
 *
 * A forgotten mark row and a deliberately absent child must not produce the same card — one is missing
 * information, the other is a positive assertion. So `submitMarks()` refuses to submit a paper unless
 * every student in the exam's cohort has a row on it. After that, within a submitted paper there are no
 * missing rows by construction, and `is_absent` carries its real meaning.
 *
 * The calculation therefore runs over **submitted papers only**, and `results` is provisional until
 * every paper is in. `generateResults()` (FR-EXAM-004) refuses while any paper is outstanding, so no
 * Position is computed and no card is published from a partial exam.
 *
 * The mirror of that rule: a student with **no** mark on any counted paper gets no result row at all.
 * `cohortOf()` asks who is active in the class, which is right while marks are entered and wrong at
 * calculation time — a child who enrolled after the exam was sat would otherwise be scored 0%, ranked
 * last, counted in everyone else's `position_out_of`, and published to their parent as a result for an
 * exam they never took. Found by audit, not by a failing check (§5a session 19).
 *
 * ## FR-EXAM-005, delivered in half, and the half is named
 *
 * §19.3 says results include "PDF support and Print support" and FR-EXAM-005 asks for export as PDF
 * and printing, reaching Parent and Student. **This module produces the complete Result Card payload
 * and does not render a PDF.** `results.result_card_path` stays NULL and is `forbidden()` in every
 * schema.
 *
 * That is a deferral, recorded rather than disguised. Rendering would mean building, inside one feature
 * module, the three things this codebase does not have: a document generator (`pdfkit` is installed and
 * imported nowhere), a place to put the bytes (a seventh upload profile, where six exist and adding one
 * is a recorded constraint), and a way to serve them back — there is **no** `res.download`,
 * `res.sendFile`, `express.static` or streamed response anywhere in the application. It would also make
 * this module a writer of stored bytes outside the upload chain, the one place `LIMITS.STORAGE_LIMIT` is
 * charged (`upload.verifyStorage()`). And SRS §22 is a separate Reports section that owns PDF/Excel/Print for
 * seven report types including Exam Reports, with an actor list matching FR-EXAM-005's.
 *
 * So the server-side half is built and the presentation half is left to the module that owns it. The
 * test of whether that is honest rather than convenient: a renderer must be able to draw the card from
 * one response with no follow-up call. `resultCard()` is written to that standard — school, exam,
 * student, per-subject rows, totals, grade, outcome and position, in one payload.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const money = require('../../utils/money');
const { renderTable } = require('../../utils/pdf');
const dates = require('../../utils/dates');
const {
  resolveSchool,
  loadClassInSchool,
  loadSectionOfClass,
  loadSessionInSchool,
  loadTeacherInSchool,
  assertOpenForNew,
  schoolBrand,
} = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { EXAM_STATUS, MARK_STATUS, RESULT_OUTCOME, STUDENT_STATUS } = require('../../config/constants');

const GRADE_SORTABLE = Object.freeze(['id', 'scale_name', 'min_percentage', 'name', 'created_at']);
const EXAM_SORTABLE = Object.freeze(['id', 'name', 'exam_type', 'start_date', 'status', 'created_at']);
const MARK_SORTABLE = Object.freeze(['id', 'student_id', 'marks_obtained', 'status', 'created_at']);
const RESULT_SORTABLE = Object.freeze(['id', 'position', 'percentage', 'total_marks_obtained', 'created_at']);

const GRADE_EDITABLE = Object.freeze([
  'scale_name', 'name', 'min_percentage', 'max_percentage', 'grade_point', 'is_failing', 'remarks', 'is_active',
]);
const EXAM_EDITABLE = Object.freeze([
  'name', 'exam_type', 'class_id', 'section_id', 'academic_session_id',
  'start_date', 'end_date', 'grade_scale', 'description',
]);
const EXAM_SUBJECT_EDITABLE = Object.freeze([
  'subject_id', 'teacher_id', 'full_marks', 'passing_marks',
  'practical_full_marks', 'practical_passing_marks', 'exam_date', 'start_time', 'end_time', 'room',
]);

const EXAM_DATE_COLUMNS = Object.freeze(['start_date', 'end_date']);
const SUBJECT_DATE_COLUMNS = Object.freeze(['exam_date']);

/* ─────────────────────────── scoping ─────────────────────────── */

/**
 * A child row belongs to its parent's school.
 *
 * `exam_subjects`, `marks` and `parent_students` are reached through their parent, and
 * `exam_subjects` has no `organization_id` at all — so `tenantWhere()` on any of them is either
 * wrong or a 500. This is the `subjects.childScope()` shape.
 */
function childScope(parent, where) {
  return { ...where, school_id: parent.school_id };
}

/**
 * Grade bands visible to a school: its own, plus the platform's.
 *
 * `grades.school_id` is nullable precisely so a platform-provided scale can be shared, and
 * `tenantWhere()` would filter those rows out. Written as an explicit OR so the intent is legible.
 */
function gradeScope(schoolId, where = {}) {
  return { ...where, [Op.or]: [{ school_id: schoolId }, { school_id: null }] };
}

function dateOnly(value) {
  return value === undefined || value === null || value === '' ? value : dates.toDateOnly(value);
}

function normaliseDates(columns, payload) {
  const next = { ...payload };
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(next, column)) next[column] = dateOnly(next[column]);
  }
  return next;
}

function pick(allowed, payload) {
  const next = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  return next;
}

function rethrow(err) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    const fields = Object.keys(err.fields || {});
    const name = fields.join(',');
    if (name.includes('exam_subjects_unique')) {
      throw ApiError.conflict('That subject is already on this exam', {
        code: 'EXAM_SUBJECT_EXISTS',
        details: {},
      });
    }
    if (name.includes('marks_examsubject_student')) {
      throw ApiError.conflict('That student already has a mark on this paper', {
        code: 'MARK_EXISTS',
        details: {},
      });
    }
    if (name.includes('results_exam_student')) {
      throw ApiError.conflict('That student already has a result for this exam', {
        code: 'RESULT_EXISTS',
        details: {},
      });
    }
    throw ApiError.conflict('That record already exists', { code: 'DUPLICATE_RECORD', details: {} });
  }
  if (err instanceof db.Sequelize.ValidationError) {
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  if (err instanceof db.Sequelize.ForeignKeyConstraintError) {
    /* The constraint's own name is a database identifier; it tells a caller nothing they can act on. */
    throw ApiError.validation('A referenced record does not exist', [
      { field: 'body', message: 'One of the records this refers to no longer exists' },
    ]);
  }
  throw err;
}

/* ─────────────────────────── §19.1 the Grade System ─────────────────────────── */

async function findGrade(req, id, namedSchoolId = undefined) {
  const school = await resolveSchool(req, namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id);
  const row = await db.Grade.findOne({ where: gradeScope(school.id, { id }) });
  if (!row) throw ApiError.notFound('Grade band not found', { code: 'GRADE_NOT_FOUND' });
  return { row, school };
}

async function listGrades(req, query, pagination) {
  const school = await resolveSchool(req, query.school_id);
  const where = gradeScope(school.id, {});
  if (query.scale_name) where.scale_name = query.scale_name;
  if (query.is_active !== undefined) where.is_active = query.is_active;

  return paginateQuery(
    db.Grade,
    { where, order: getSort({ query }, GRADE_SORTABLE, ['min_percentage', 'DESC']) },
    pagination
  );
}

/**
 * Would this band overlap one the school already has on the same scale?
 *
 * Ambiguity is refused at write time rather than resolved at read time, because a percentage sitting
 * in two bands has no defensible answer once a card has been printed from it. `grades` carries no
 * unique index and §35 forbids adding one, so this is the only place the rule can live — the same
 * position `fees.alreadyAssigned()` is in.
 */
async function assertNoBandOverlap(schoolId, scaleName, min, max, excludeId, transaction) {
  const where = gradeScope(schoolId, {
    scale_name: scaleName,
    is_active: true,
    /*
     * Inclusive on both sides, because `matchBand()` is. A half-open test let A(80..100) and B(60..80)
     * coexist, and a percentage of exactly 80 then matched both - which is the case the header claimed
     * could not happen.
     */
    min_percentage: { [Op.lte]: max },
    max_percentage: { [Op.gte]: min },
  });
  if (excludeId) where.id = { [Op.ne]: excludeId };

  /* Ordered, so a band overlapping two names the same one every time — the lower of them. */
  const clash = await db.Grade.findOne({ where, order: [['min_percentage', 'ASC'], ['id', 'ASC']], transaction });
  if (clash) {
    /* The band is named in the message too: a screen that shows only the message still says which. */
    throw ApiError.conflict(
      `That band overlaps "${clash.name}" (${Number(clash.min_percentage)}–${Number(clash.max_percentage)}%) on the ${scaleName} grade scale`,
      {
        code: 'GRADE_BAND_OVERLAP',
        details: {
          scale_name: scaleName,
          conflicts_with: { id: clash.id, name: clash.name, min_percentage: clash.min_percentage, max_percentage: clash.max_percentage },
        },
      }
    );
  }
}

async function createGrade(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const next = pick(GRADE_EDITABLE, payload);
  const scaleName = next.scale_name || 'default';

  let row;
  try {
    row = await db.sequelize.transaction(async (transaction) => {
      await assertNoBandOverlap(
        school.id,
        scaleName,
        Number(next.min_percentage),
        Number(next.max_percentage),
        null,
        transaction
      );
      return db.Grade.create(
        { school_id: school.id, organization_id: school.organization_id, ...next, scale_name: scaleName },
        { transaction }
      );
    });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'grades', recordId: row.id, event: 'create', before: null, after: snapshot(row), reason: payload.reason || null,
  });
  return row;
}

async function updateGrade(req, id, payload) {
  const { row, school } = await findGrade(req, id, payload.school_id);

  /* A platform-provided scale is shared by every school; one school may not edit it for everyone. */
  if (row.is_system || row.school_id === null) {
    throw ApiError.forbidden('A platform-provided grade band cannot be edited by a school', {
      code: 'GRADE_IS_SYSTEM',
      details: { id: row.id, scale_name: row.scale_name },
    });
  }

  const before = snapshot(row);
  const next = pick(GRADE_EDITABLE, payload);
  if (!Object.keys(next).length) {
    throw ApiError.validation('No grade fields to update', [{ field: 'body', message: 'Send at least one field' }]);
  }

  try {
    await db.sequelize.transaction(async (transaction) => {
      const scaleName = next.scale_name !== undefined ? next.scale_name : row.scale_name;
      const min = next.min_percentage !== undefined ? Number(next.min_percentage) : Number(row.min_percentage);
      const max = next.max_percentage !== undefined ? Number(next.max_percentage) : Number(row.max_percentage);
      const active = next.is_active !== undefined ? next.is_active : row.is_active;
      if (active) await assertNoBandOverlap(school.id, scaleName, min, max, row.id, transaction);
      row.set(next);
      await row.save({ transaction });
    });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'grades', recordId: row.id, event: 'update', before, after: snapshot(row), reason: payload.reason || null,
  });
  return row;
}

/* ─────────────────────────── §19.1 the examination ─────────────────────────── */

/**
 * The class and section an exam names, for a screen to show by name. Only on reads: every other caller
 * of `findExam()` updates and snapshots the row, and an included association would ride into the audit.
 */
const EXAM_PLACEMENT_INCLUDE = Object.freeze([
  { model: db.Class, as: 'class', attributes: ['id', 'name'] },
  { model: db.Section, as: 'section', attributes: ['id', 'name'] },
]);

async function findExam(req, id, namedSchoolId = undefined, { detail = false } = {}) {
  const where = tenantWhere(req.tenant, { id });
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  /* Record and entitlement guard resolved from the same school — §5a defects 22 and 35. */
  if (named) {
    const school = await resolveSchool(req, named);
    where.school_id = school.id;
  }
  const row = await db.Exam.findOne({ where, ...(detail ? { include: [...EXAM_PLACEMENT_INCLUDE] } : {}) });
  if (!row) throw ApiError.notFound('Exam not found', { code: 'EXAM_NOT_FOUND' });
  return row;
}

async function listExams(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  for (const field of ['class_id', 'section_id', 'academic_session_id', 'exam_type', 'status']) {
    if (query[field] !== undefined) where[field] = query[field];
  }
  if (query.q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.q}%` } },
      { exam_type: { [Op.like]: `%${query.q}%` } },
    ];
  }

  return paginateQuery(
    db.Exam,
    {
      where,
      include: [...EXAM_PLACEMENT_INCLUDE],
      order: getSort({ query }, EXAM_SORTABLE, ['start_date', 'DESC']),
    },
    pagination
  );
}

/**
 * Every optional reference on an exam must point inside the same school.
 *
 * `grade_scale` is checked too, and it is the interesting one: it is a `STRING(90)` matching
 * `grades.scale_name`, **not** a foreign key, so nothing in the database stops an exam naming a scale
 * that does not exist. An exam graded against a scale with no bands would calculate every percentage
 * and then match no grade at all — a result card with a blank grade and no explanation.
 */
async function assertExamReferences(payload, schoolId, existing = null) {
  const classId = payload.class_id !== undefined ? payload.class_id : existing && existing.class_id;
  if (payload.class_id !== undefined) await loadClassInSchool(payload.class_id, schoolId);
  if (payload.section_id) await loadSectionOfClass(payload.section_id, classId);

  /*
   * Moving an exam to another class without naming a section leaves the EXISTING section pointing at the
   * class it used to belong to - a pairing POST refuses and PATCH would otherwise allow. Re-check it.
   */
  if (payload.class_id !== undefined && payload.section_id === undefined && existing && existing.section_id) {
    await loadSectionOfClass(existing.section_id, payload.class_id);
  }
  if (payload.academic_session_id) await loadSessionInSchool(payload.academic_session_id, schoolId);

  if (payload.grade_scale !== undefined && payload.grade_scale !== null) {
    const bands = await db.Grade.count({
      where: gradeScope(schoolId, { scale_name: payload.grade_scale, is_active: true }),
    });
    if (bands === 0) {
      throw ApiError.validation('That grade scale has no active bands', [
        { field: 'grade_scale', message: `No active grade band exists on scale "${payload.grade_scale}"` },
      ]);
    }
  }
}

async function createExam(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  await assertExamReferences(payload, school.id);
  /* D20 — a closed session takes no new exam: neither the one named nor its class's own. */
  await assertOpenForNew({ sessionId: payload.academic_session_id, classId: payload.class_id }, 'exam');

  let row;
  try {
    row = await db.Exam.create({
      school_id: school.id,
      organization_id: school.organization_id,
      created_by: req.user ? req.user.id : null,
      ...normaliseDates(EXAM_DATE_COLUMNS, pick(EXAM_EDITABLE, payload)),
    });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'exams', recordId: row.id, event: 'create', before: null, after: snapshot(row), reason: payload.reason || null,
  });
  return row;
}

/** Statuses in which an exam's own definition may still be rewritten. */
const EXAM_MUTABLE = Object.freeze([EXAM_STATUS.DRAFT, EXAM_STATUS.SCHEDULED, EXAM_STATUS.ONGOING, EXAM_STATUS.MARKS_ENTRY]);

async function updateExam(req, id, payload) {
  const row = await findExam(req, id, payload.school_id);

  /*
   * Once results are published the exam's definition is history: changing a class or a grade scale
   * afterwards would restate a card a parent has already read. The same reasoning `invoices` gives for
   * `MUTABLE_STATUSES` — "once money has arrived, the figures are history".
   */
  if (!EXAM_MUTABLE.includes(row.status)) {
    throw ApiError.conflict('This exam can no longer be edited', {
      code: 'EXAM_NOT_MUTABLE',
      details: { status: row.status },
    });
  }

  /*
   * Once results exist the cohort is settled. Moving the exam to another class or section would strand
   * every result row that was computed for the old cohort: they stay in `results`, keep their figures,
   * and are ranked against a population they are no longer part of.
   */
  const movesCohort =
    (payload.class_id !== undefined && Number(payload.class_id) !== Number(row.class_id)) ||
    (payload.section_id !== undefined && Number(payload.section_id || 0) !== Number(row.section_id || 0));
  if (movesCohort) {
    const settled = await db.Result.count({ where: childScope(row, { exam_id: row.id }) });
    if (settled) {
      throw ApiError.conflict('This exam already has results, so its class and section are settled', {
        code: 'EXAM_COHORT_SETTLED',
        details: { exam_id: row.id, results: settled },
      });
    }
  }

  await assertExamReferences(payload, row.school_id, row);

  const before = snapshot(row);
  const next = normaliseDates(EXAM_DATE_COLUMNS, pick(EXAM_EDITABLE, payload));
  if (!Object.keys(next).length) {
    throw ApiError.validation('No exam fields to update', [{ field: 'body', message: 'Send at least one field' }]);
  }

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'exams', recordId: row.id, event: 'update', before, after: snapshot(row), reason: payload.reason || null,
  });
  return row;
}

/* ─────────────────────────── §19.1 Subjects, Marks, Passing Marks ─────────────────────────── */

async function listExamSubjects(req, examId, query) {
  const exam = await findExam(req, examId, query && query.school_id);
  const rows = await db.ExamSubject.findAll({
    /* childScope, never tenantWhere — this table has no organization_id (§5a defect 16). */
    where: childScope(exam, { exam_id: exam.id }),
    include: [
      { model: db.Subject, as: 'subject', attributes: ['id', 'name', 'code'] },
      { model: db.Teacher, as: 'teacher', attributes: ['id', 'first_name', 'last_name', 'employee_id'] },
    ],
    order: [['id', 'ASC']],
  });
  return { exam, rows };
}

async function assertSubjectReferences(payload, exam) {
  if (payload.subject_id) {
    const subject = await db.Subject.findOne({ where: { id: payload.subject_id, school_id: exam.school_id } });
    if (!subject) {
      throw ApiError.validation('That subject is not in this school', [
        { field: 'subject_id', message: 'Unknown subject for this school' },
      ]);
    }
  }
  if (payload.teacher_id) await loadTeacherInSchool(payload.teacher_id, exam.school_id);
}

/**
 * A practical bar without a practical paper is a rule that can never be met, and a practical mark with
 * no paper to hold it has nowhere to go. Checked here because the model validates the pair's ordering
 * but not its existence.
 */
function assertPracticalCoherent(next) {
  const full = next.practical_full_marks;
  const passing = next.practical_passing_marks;
  if ((passing !== undefined && passing !== null) && (full === undefined || full === null)) {
    throw ApiError.validation('A practical passing mark needs a practical paper', [
      { field: 'practical_passing_marks', message: 'Set practical_full_marks, or leave both unset' },
    ]);
  }
}

async function addExamSubject(req, examId, payload) {
  const exam = await findExam(req, examId, payload.school_id);
  if (!EXAM_MUTABLE.includes(exam.status)) {
    throw ApiError.conflict('Papers cannot be added to this exam any more', {
      code: 'EXAM_NOT_MUTABLE', details: { status: exam.status },
    });
  }
  await assertSubjectReferences(payload, exam);
  const next = normaliseDates(SUBJECT_DATE_COLUMNS, pick(EXAM_SUBJECT_EDITABLE, payload));
  assertPracticalCoherent(next);

  let row;
  try {
    row = await db.ExamSubject.create({ school_id: exam.school_id, exam_id: exam.id, ...next });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'exam_subjects', recordId: row.id, event: 'create', before: null, after: snapshot(row), reason: payload.reason || null,
  });
  return { exam, row };
}

async function updateExamSubject(req, examId, examSubjectId, payload) {
  const exam = await findExam(req, examId, payload.school_id);
  const row = await db.ExamSubject.findOne({ where: childScope(exam, { id: examSubjectId, exam_id: exam.id }) });
  if (!row) throw ApiError.notFound('Exam subject not found', { code: 'EXAM_SUBJECT_NOT_FOUND' });

  /*
   * A submitted paper's marks have been calculated into every student's result. Re-pricing the paper
   * afterwards would silently restate those figures without recalculating them.
   */
  if (row.marks_submitted_at) {
    throw ApiError.conflict('This paper\'s marks have been submitted and it can no longer be changed', {
      code: 'EXAM_SUBJECT_SUBMITTED',
      details: { id: row.id, marks_submitted_at: row.marks_submitted_at },
    });
  }

  /*
   * The paper figures are frozen as soon as a single mark exists on it, not merely once the paper is
   * submitted. Cutting `full_marks` from 100 to 50 under an already-entered 90 gives a numerator with
   * no denominator: 180%, matching no band, graded null. The scheduling fields stay editable, because
   * moving a room or a date changes no arithmetic.
   */
  const PRICING = ['full_marks', 'passing_marks', 'practical_full_marks', 'practical_passing_marks'];
  const repricing = PRICING.filter((f) => Object.prototype.hasOwnProperty.call(payload, f));
  if (repricing.length) {
    const entered = await db.Mark.count({ where: childScope(exam, { exam_subject_id: row.id }) });
    if (entered) {
      throw ApiError.conflict('This paper already has marks on it, so its marks cannot be changed', {
        code: 'EXAM_SUBJECT_HAS_MARKS',
        details: { id: row.id, marks_entered: entered, fields: repricing },
      });
    }
  }

  await assertSubjectReferences(payload, exam);
  const before = snapshot(row);
  const next = normaliseDates(SUBJECT_DATE_COLUMNS, pick(EXAM_SUBJECT_EDITABLE, payload));
  if (!Object.keys(next).length) {
    throw ApiError.validation('No exam subject fields to update', [{ field: 'body', message: 'Send at least one field' }]);
  }
  assertPracticalCoherent({
    practical_full_marks: next.practical_full_marks !== undefined ? next.practical_full_marks : row.practical_full_marks,
    practical_passing_marks: next.practical_passing_marks !== undefined ? next.practical_passing_marks : row.practical_passing_marks,
  });

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'exam_subjects', recordId: row.id, event: 'update', before, after: snapshot(row), reason: payload.reason || null,
  });
  return { exam, row };
}

/* ─────────────────────────── §19.2 Marks ─────────────────────────── */

/** Three decimals, because `results.percentage` is `DECIMAL(6,3)`. `money.js` only scales to two. */
function round3(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

/**
 * The students expected to sit this exam.
 *
 * `exams.class_id` is NOT NULL and `section_id` is nullable, whose column comment reads "Null = all
 * sections of the class sit the exam" — so the exam row declares its own cohort and nothing else has
 * to decide it. Only active students: a child who has left is not absent from a paper, they are not in
 * the cohort at all.
 */
async function cohortOf(exam, transaction) {
  const where = {
    school_id: exam.school_id,
    class_id: exam.class_id,
    status: STUDENT_STATUS.ACTIVE,
  };
  if (exam.section_id) where.section_id = exam.section_id;
  return db.Student.findAll({
    where,
    attributes: ['id', 'student_id', 'roll_number', 'first_name', 'last_name', 'class_id', 'section_id'],
    order: [['id', 'ASC']],
    transaction,
  });
}

async function loadExamSubject(exam, examSubjectId, transaction) {
  const row = await db.ExamSubject.findOne({
    where: childScope(exam, { id: examSubjectId, exam_id: exam.id }),
    include: [{ model: db.Subject, as: 'subject', attributes: ['id', 'name', 'code'] }],
    transaction,
  });
  if (!row) throw ApiError.notFound('Exam subject not found', { code: 'EXAM_SUBJECT_NOT_FOUND' });
  return row;
}

/**
 * FR-EXAM-002 — enter marks, and edit them while the paper is still open.
 *
 * One bulk upsert on `(exam_subject_id, student_id)`, both NOT NULL, so re-posting a row **corrects**
 * it rather than duplicating — which is exactly "Teacher may edit entered marks prior to submission",
 * and the same mechanism attendance uses to correct a register.
 */
async function enterMarks(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const examSubject = await db.ExamSubject.findOne({
    where: { id: payload.exam_subject_id, school_id: school.id },
  });
  if (!examSubject) throw ApiError.notFound('Exam subject not found', { code: 'EXAM_SUBJECT_NOT_FOUND' });
  const exam = await findExam(req, examSubject.exam_id, payload.school_id);

  /* "prior to submission" is the whole of the rule — a submitted paper is closed. */
  if (examSubject.marks_submitted_at) {
    throw ApiError.conflict('These marks have been submitted and can no longer be edited', {
      code: 'MARKS_ALREADY_SUBMITTED',
      details: { exam_subject_id: examSubject.id, marks_submitted_at: examSubject.marks_submitted_at },
    });
  }

  const unique = [...new Set(payload.entries.map((e) => Number(e.student_id)))];
  if (unique.length !== payload.entries.length) {
    throw ApiError.validation('The same student may not be marked twice in one request', [
      { field: 'entries', message: 'Remove the repeated student_id' },
    ]);
  }

  /*
   * An entry has to say something. A row carrying only a `student_id` recorded neither a mark nor an
   * absence, yet it satisfied the submission-completeness rule and was then scored as a real zero on
   * the card - the exact confusion between "forgotten" and "absent" that the completeness rule exists
   * to prevent, arriving through the front door instead.
   */
  const silent = payload.entries
    .filter((e) => !e.is_absent && (e.marks_obtained === undefined || e.marks_obtained === null))
    .map((e) => e.student_id);
  if (silent.length) {
    throw ApiError.validation('Every entry must record a mark or an absence', [
      { field: 'entries', message: `Neither a mark nor is_absent for: ${silent.join(', ')}` },
    ]);
  }

  const cohort = await cohortOf(exam);
  const inCohort = new Set(cohort.map((s) => Number(s.id)));
  const strangers = unique.filter((id) => !inCohort.has(id));
  if (strangers.length) {
    throw ApiError.validation('Every student must be sitting this exam', [
      { field: 'entries', message: `Not in this exam's class or section: ${strangers.join(', ')}` },
    ]);
  }

  const full = money.toMinor(examSubject.full_marks);
  const practicalFull = examSubject.practical_full_marks === null ? null : money.toMinor(examSubject.practical_full_marks);

  const rows = payload.entries.map((entry) => {
    const absent = Boolean(entry.is_absent);
    /* The model refuses marks on an absent row; blanking them here makes the refusal unreachable. */
    const theory = absent ? null : entry.marks_obtained ?? null;
    const practical = absent ? null : entry.practical_marks_obtained ?? null;

    if (theory !== null && money.toMinor(theory) > full) {
      throw ApiError.validation('A mark cannot exceed the paper it was scored on', [
        { field: 'entries', message: `student ${entry.student_id}: marks_obtained above full_marks (${examSubject.full_marks})` },
      ]);
    }
    if (practical !== null) {
      if (practicalFull === null) {
        throw ApiError.validation('This paper has no practical component', [
          { field: 'entries', message: `student ${entry.student_id}: practical_marks_obtained given but the paper has no practical_full_marks` },
        ]);
      }
      if (money.toMinor(practical) > practicalFull) {
        throw ApiError.validation('A practical mark cannot exceed the practical paper', [
          { field: 'entries', message: `student ${entry.student_id}: practical_marks_obtained above practical_full_marks` },
        ]);
      }
    }

    return {
      school_id: exam.school_id,
      organization_id: exam.organization_id,
      exam_id: exam.id,
      exam_subject_id: examSubject.id,
      student_id: entry.student_id,
      marks_obtained: theory,
      practical_marks_obtained: practical,
      is_absent: absent,
      remarks: entry.remarks ?? null,
      status: MARK_STATUS.DRAFT,
      entered_by: req.user ? req.user.id : null,
    };
  });

  try {
    await db.Mark.bulkCreate(rows, {
      updateOnDuplicate: [
        'marks_obtained', 'practical_marks_obtained', 'is_absent', 'remarks', 'entered_by', 'updated_at',
      ],
    });
  } catch (err) {
    rethrow(err);
  }

  const saved = await db.Mark.findAll({
    where: childScope(exam, { exam_subject_id: examSubject.id, student_id: { [Op.in]: unique } }),
    order: [['student_id', 'ASC']],
  });

  /* An exam being marked is no longer merely scheduled. */
  if (exam.status === EXAM_STATUS.DRAFT || exam.status === EXAM_STATUS.SCHEDULED || exam.status === EXAM_STATUS.ONGOING) {
    await exam.update({ status: EXAM_STATUS.MARKS_ENTRY });
  }

  return { exam, examSubject, rows: saved };
}

/**
 * FR-EXAM-002 "Teacher submits marks" — and the completeness rule that makes the card honest.
 *
 * A paper may not be submitted while any student in the cohort has no row on it. A forgotten row and a
 * deliberately absent child would otherwise reach the calculation as the same thing, and the forgotten
 * one would quietly shrink a student's denominator and improve their percentage. `is_absent` is a
 * positive assertion; silence is not.
 */
async function submitMarks(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const examSubject = await db.ExamSubject.findOne({ where: { id: payload.exam_subject_id, school_id: school.id } });
  if (!examSubject) throw ApiError.notFound('Exam subject not found', { code: 'EXAM_SUBJECT_NOT_FOUND' });
  const exam = await findExam(req, examSubject.exam_id, payload.school_id);

  if (examSubject.marks_submitted_at) {
    throw ApiError.conflict('These marks have already been submitted', {
      code: 'MARKS_ALREADY_SUBMITTED',
      details: { exam_subject_id: examSubject.id, marks_submitted_at: examSubject.marks_submitted_at },
    });
  }

  const cohort = await cohortOf(exam);
  if (!cohort.length) {
    throw ApiError.validation('No active student is sitting this exam', [
      { field: 'exam_subject_id', message: 'The exam\'s class or section has no active students' },
    ]);
  }

  const existing = await db.Mark.findAll({
    where: childScope(exam, { exam_subject_id: examSubject.id }),
    attributes: ['student_id'],
  });
  const marked = new Set(existing.map((m) => Number(m.student_id)));
  const missing = cohort.filter((s) => !marked.has(Number(s.id))).map((s) => Number(s.id));
  if (missing.length) {
    throw ApiError.validation('Every student needs a mark before this paper can be submitted', [
      {
        field: 'entries',
        message: `Missing a mark (enter one, or record the student absent): ${missing.join(', ')}`,
      },
    ]);
  }

  const before = snapshot(examSubject);
  let outcome;
  try {
    outcome = await db.sequelize.transaction(async (transaction) => {
      /*
       * The guards above ran outside this transaction, so re-take them here behind a locking read.
       * Without it two teachers submitting two papers of the same exam at the same moment both pass
       * their checks, both call `recalculate()`, and the later commit overwrites the earlier one's
       * figures with a total computed before the other paper existed - a result that is silently short
       * by a whole paper, on every student. `LOCK.UPDATE` serialises them on the exam row, which is the
       * shape `payments.decide()` and `fees.pay()` both use before deciding.
       */
      const locked = await db.Exam.findOne({
        where: { id: exam.id, school_id: exam.school_id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!locked) throw ApiError.notFound('Exam not found', { code: 'EXAM_NOT_FOUND' });

      const paper = await db.ExamSubject.findOne({
        where: childScope(exam, { id: examSubject.id }),
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!paper) throw ApiError.notFound('Exam subject not found', { code: 'EXAM_SUBJECT_NOT_FOUND' });
      if (paper.marks_submitted_at) {
        throw ApiError.conflict('These marks have already been submitted', {
          code: 'MARKS_ALREADY_SUBMITTED',
          details: { exam_subject_id: paper.id, marks_submitted_at: paper.marks_submitted_at },
        });
      }

      const at = new Date();
      await db.Mark.update(
        { status: MARK_STATUS.SUBMITTED, submitted_by: req.user ? req.user.id : null, submitted_at: at },
        { where: childScope(exam, { exam_subject_id: examSubject.id }), transaction }
      );
      await examSubject.update({ marks_submitted_at: at }, { transaction });
      /* FR-EXAM-003: "calculates aggregate results once marks are submitted". */
      return recalculate(exam, transaction);
    });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'exam_subjects', recordId: examSubject.id, event: 'update', before, after: snapshot(examSubject), reason: payload.reason || null,
  });

  return { exam, examSubject, ...outcome };
}

async function listMarks(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  for (const field of ['exam_id', 'exam_subject_id', 'student_id', 'status']) {
    if (query[field] !== undefined) where[field] = query[field];
  }

  return paginateQuery(
    db.Mark,
    {
      where,
      include: [
        { model: db.Student, as: 'student', attributes: ['id', 'student_id', 'roll_number', 'first_name', 'last_name'] },
      ],
      order: getSort({ query }, MARK_SORTABLE, ['student_id', 'ASC']),
    },
    pagination
  );
}

/* ─────────────────────────── FR-EXAM-003 the calculation ─────────────────────────── */

/**
 * Match a percentage to a band on the exam's grade scale.
 *
 * Inclusive at both ends — the only reading in which 100.000 lands in a top band, because the model's
 * `bandInRange` validator forbids a max above 100. Overlaps are refused at write time by
 * `assertNoBandOverlap()`, so at most one band can match; the highest floor is taken if one somehow
 * slips through a band created before that guard existed.
 */
function matchBand(bands, percentage) {
  const p = Math.round(Number(percentage) * 1000);
  const hits = bands.filter(
    (b) => Math.round(Number(b.min_percentage) * 1000) <= p && p <= Math.round(Number(b.max_percentage) * 1000)
  );
  if (!hits.length) return null;
  return hits.sort((a, b) => Number(b.min_percentage) - Number(a.min_percentage))[0];
}

/** Per-paper pass/fail: two independent gates, and the absent student clears neither. */
function subjectOutcome(examSubject, mark) {
  if (mark.is_absent) return RESULT_OUTCOME.FAIL;
  const theory = money.toMinor(mark.marks_obtained ?? 0);
  if (theory < money.toMinor(examSubject.passing_marks)) return RESULT_OUTCOME.FAIL;

  const bar = examSubject.practical_passing_marks;
  if (bar !== null && bar !== undefined) {
    const practical = money.toMinor(mark.practical_marks_obtained ?? 0);
    if (practical < money.toMinor(bar)) return RESULT_OUTCOME.FAIL;
  }
  return RESULT_OUTCOME.PASS;
}

/**
 * Re-derive every calculated figure for one exam, from that exam's own rows.
 *
 * Must run inside the caller's transaction — the guard is deliberate and matches
 * `invoices.applyPayment()` and `fees.applyPayment()`. Position is **not** written here: FR-EXAM-004
 * owns it, because a position is a property of the whole cohort rather than of one student's marks.
 */
async function recalculate(exam, transaction) {
  if (!transaction) throw new Error('recalculate() must run inside the caller transaction');

  const papers = await db.ExamSubject.findAll({
    where: childScope(exam, { exam_id: exam.id }),
    include: [{ model: db.Subject, as: 'subject', attributes: ['id', 'name', 'code'] }],
    order: [['id', 'ASC']],
    transaction,
  });
  /* Only submitted papers count — an unsubmitted one is still being edited. */
  const counted = papers.filter((p) => Boolean(p.marks_submitted_at));

  const bands = await db.Grade.findAll({
    where: gradeScope(exam.school_id, { scale_name: exam.grade_scale, is_active: true }),
    transaction,
  });

  const cohort = await cohortOf(exam, transaction);
  const marks = counted.length
    ? await db.Mark.findAll({
        where: childScope(exam, { exam_id: exam.id, exam_subject_id: { [Op.in]: counted.map((p) => p.id) } }),
        transaction,
      })
    : [];

  const byStudent = new Map();
  for (const mark of marks) {
    const key = Number(mark.student_id);
    if (!byStudent.has(key)) byStudent.set(key, new Map());
    byStudent.get(key).set(Number(mark.exam_subject_id), mark);
  }

  const markUpdates = [];
  const written = [];

  for (const student of cohort) {
    const own = byStudent.get(Number(student.id)) || new Map();

    let fullMinor = 0;
    let obtainedMinor = 0;
    let failed = 0;
    const breakdown = [];

    for (const paper of counted) {
      const mark = own.get(Number(paper.id));
      if (!mark) continue; /* Unreachable: submission requires a row for every cohort student. */

      const theoryFull = money.toMinor(paper.full_marks);
      const practicalFull = paper.practical_full_marks === null ? 0 : money.toMinor(paper.practical_full_marks);
      const theoryGot = mark.is_absent ? 0 : money.toMinor(mark.marks_obtained ?? 0);
      const practicalGot = mark.is_absent ? 0 : money.toMinor(mark.practical_marks_obtained ?? 0);

      const paperFull = theoryFull + practicalFull;
      const paperGot = theoryGot + practicalGot;
      fullMinor += paperFull;
      obtainedMinor += paperGot;

      const outcome = subjectOutcome(paper, mark);
      if (outcome === RESULT_OUTCOME.FAIL) failed += 1;

      /* Per-paper grade, from the same scale, on the paper's own percentage. */
      const paperPct = paperFull === 0 ? 0 : round3((paperGot / paperFull) * 100);
      const paperBand = matchBand(bands, paperPct);
      markUpdates.push({ id: mark.id, grade_name: paperBand ? paperBand.name : null, outcome });

      /*
       * A copy, not a join. `exam_subjects` and `grades` stay editable, and a published card must not
       * silently restate itself when a subject is renamed or a band is retired — the reasoning
       * `invoices` gives for denormalising its line items.
       */
      breakdown.push({
        exam_subject_id: paper.id,
        subject_id: paper.subject_id,
        subject_name: paper.subject ? paper.subject.name : null,
        subject_code: paper.subject ? paper.subject.code : null,
        full_marks: money.toMajor(theoryFull),
        passing_marks: money.round(paper.passing_marks),
        practical_full_marks: paper.practical_full_marks === null ? null : money.toMajor(practicalFull),
        practical_passing_marks: paper.practical_passing_marks === null ? null : money.round(paper.practical_passing_marks),
        marks_obtained: mark.is_absent ? null : money.round(mark.marks_obtained ?? 0),
        practical_marks_obtained: mark.is_absent || mark.practical_marks_obtained === null ? null : money.round(mark.practical_marks_obtained),
        is_absent: Boolean(mark.is_absent),
        grade_name: paperBand ? paperBand.name : null,
        outcome,
      });
    }

    /*
     * A student with no mark on any counted paper did not sit this exam, and must not appear on it.
     *
     * `cohortOf()` asks "who is active in this class", which is the right question while marks are
     * being entered and the wrong one here: a child who enrolled after the exam was sat would
     * otherwise be given a result row of 0 marks, ranked last, counted in everyone else's
     * `position_out_of`, and — once the exam is published — shown to their parent as a 0% result for
     * an exam they never took. Skipping them leaves the merit list to the people who actually sat it.
     *
     * This cannot hide a real sitter: `submitMarks()` refuses to submit a paper until every student
     * in the cohort has a row on it, so anyone present at submission has marks by construction.
     */
    if (!breakdown.length) continue;

    const totalFull = money.toMajor(fullMinor);
    const totalObtained = money.toMajor(obtainedMinor);
    const percentage = fullMinor === 0 ? 0 : round3((obtainedMinor / fullMinor) * 100);
    const band = matchBand(bands, percentage);

    /* Any failing signal wins: a failed paper, or a band the school marked as failing. */
    let outcome = null;
    if (breakdown.length) {
      if (failed > 0) outcome = RESULT_OUTCOME.FAIL;
      else if (band && band.is_failing) outcome = RESULT_OUTCOME.FAIL;
      else if (band) outcome = RESULT_OUTCOME.PASS;
      /*
       * No band matched: the scale has a gap at this percentage, and the exam-level verdict is
       * genuinely undetermined. Leaving `outcome` null says so. Defaulting to `pass` would be the worst
       * available answer - a student in the gap would pass while a LOWER-scoring student inside the
       * failing band failed. `generateResults()` refuses to rank an exam with any ungraded result, so a
       * misconfigured scale is reported rather than published.
       */
    }

    const values = {
      school_id: exam.school_id,
      organization_id: exam.organization_id,
      academic_session_id: exam.academic_session_id,
      exam_id: exam.id,
      student_id: student.id,
      class_id: student.class_id,
      section_id: student.section_id,
      total_full_marks: totalFull,
      total_marks_obtained: totalObtained,
      percentage,
      grade_name: band ? band.name : null,
      grade_point: band && band.grade_point !== null ? money.round(band.grade_point) : null,
      outcome,
      subjects_count: breakdown.length,
      subjects_failed: failed,
      subject_breakdown: breakdown,
      calculated_at: new Date(),
    };

    const [row] = await db.Result.findOrCreate({
      where: { exam_id: exam.id, student_id: student.id },
      defaults: values,
      transaction,
    });
    /* `findOrCreate` returns the existing row untouched, so the recompute has to be applied. */
    row.set(values);
    await row.save({ transaction });
    written.push(row);
  }

  for (const update of markUpdates) {
    // eslint-disable-next-line no-await-in-loop
    await db.Mark.update(
      { grade_name: update.grade_name, outcome: update.outcome },
      { where: { id: update.id }, transaction }
    );
  }

  return {
    papers: papers.length,
    papersCounted: counted.length,
    papersOutstanding: papers.length - counted.length,
    results: written.length,
  };
}

/* ─────────────────────────── FR-EXAM-004 Results and Position ─────────────────────────── */

/**
 * Rank the exam's cohort.
 *
 * Ranked on the **stored `percentage`**, compared in integer thousandths — the column's own
 * `DECIMAL(6,3)` scale. Two cards printing 87.500 must not print different positions, and a bare
 * float comparison on two decimals is the equality trap `money.js` exists to avoid.
 *
 * Ties share a position and the next position skips (1, 1, 3), which is what a merit list means.
 * `position_out_of` is the size of the ranked cohort, so the two columns are always read together.
 *
 * The population is the exam's own result set and nothing narrower. `exams.section_id` already
 * declares the scope — set means one section sat the paper, null means the whole class did — so
 * `results.class_id` / `section_id`, which are per-student copies, are for filtering and for the card,
 * never for partitioning the ranking. There is one `position` column and nothing recording which
 * population it was measured in, so measuring it in two different populations would be unreadable.
 */
function rankResults(rows) {
  const ordered = [...rows].sort(
    (a, b) => Math.round(Number(b.percentage) * 1000) - Math.round(Number(a.percentage) * 1000)
  );
  const outOf = ordered.length;
  const ranked = [];
  let previous = null;
  let position = 0;

  ordered.forEach((row, index) => {
    const key = Math.round(Number(row.percentage) * 1000);
    if (previous === null || key !== previous) position = index + 1;
    previous = key;
    ranked.push({ row, position, outOf });
  });

  return ranked;
}

/**
 * FR-EXAM-004 — generate the exam's results.
 *
 * Refuses while any paper is outstanding. FR-EXAM-004's precondition is "Marks have been calculated",
 * and a position computed over a partial exam would be a merit list of an exam nobody has finished
 * sitting — a number that looks authoritative and is not.
 */
async function generateResults(req, examId, payload) {
  const exam = await findExam(req, examId, payload.school_id);

  const papers = await db.ExamSubject.findAll({ where: childScope(exam, { exam_id: exam.id }) });
  if (!papers.length) {
    throw ApiError.validation('This exam has no subjects', [
      { field: 'exam_id', message: 'Add at least one subject before generating results' },
    ]);
  }
  /*
   * A published exam is finished. Re-running the calculation would rewrite cards parents have already
   * read and regress the status from `published` back to `completed` - the "every edge has exactly one
   * writer" rule broken in the most visible way.
   */
  if (exam.status === EXAM_STATUS.PUBLISHED) {
    throw ApiError.conflict('These results are published and cannot be regenerated', {
      code: 'EXAM_ALREADY_PUBLISHED',
      details: { status: exam.status, published_at: exam.published_at },
    });
  }

  const outstanding = papers.filter((p) => !p.marks_submitted_at);
  if (outstanding.length) {
    throw ApiError.conflict('Every paper\'s marks must be submitted before results are generated', {
      code: 'EXAM_MARKS_OUTSTANDING',
      details: { outstanding: outstanding.map((p) => ({ exam_subject_id: p.id, subject_id: p.subject_id })) },
    });
  }

  let summary;
  try {
    summary = await db.sequelize.transaction(async (transaction) => {
      const computed = await recalculate(exam, transaction);

      const rows = await db.Result.findAll({
        where: childScope(exam, { exam_id: exam.id }),
        transaction,
      });

      /*
       * A merit list is of the people who sat the exam, and `subjects_count` is the record of how many
       * papers each of them actually has a mark on. Every paper is submitted by the time this runs, so
       * anyone with a mark on all of them sat the whole exam and is ranked; anyone with fewer did not.
       *
       * That single test covers three ways a `results` row can drift out of the cohort, all of which
       * were reachable and none of which a status filter would have caught:
       *   - a child who TRANSFERRED OUT after one paper - previously kept a stale row scored over that
       *     one paper, which could out-rank the students who sat everything and take first place;
       *   - a child who was PROMOTED or whose section was edited mid-exam - `students.promote()` leaves
       *     `status` untouched, so they stay `active` and simply stop matching the exam's class;
       *   - a child who ENROLLED after a paper was submitted - scored over a partial denominator.
       * Their rows are kept, because they are a true record of what was marked, but they are left
       * unranked and unpublished. `position` null means "not on this merit list", which is the honest
       * answer rather than a place they did not earn.
       */
      const ungraded = rows.filter((r) => r.outcome === null && Number(r.subjects_count) > 0);
      if (ungraded.length) {
        throw ApiError.conflict("Some results could not be graded on this exam's grade scale", {
          code: 'EXAM_SCALE_HAS_GAP',
          details: {
            grade_scale: exam.grade_scale,
            students: ungraded.map((r) => ({ student_id: r.student_id, percentage: Number(r.percentage) })),
          },
        });
      }

      const paperCount = papers.length;
      const sat = rows.filter((r) => Number(r.subjects_count) === paperCount);
      const partial = rows.filter((r) => Number(r.subjects_count) !== paperCount);

      for (const { row, position, outOf } of rankResults(sat)) {
        // eslint-disable-next-line no-await-in-loop
        await row.update({ position, position_out_of: outOf }, { transaction });
      }
      for (const row of partial) {
        // eslint-disable-next-line no-await-in-loop
        await row.update({ position: null, position_out_of: null }, { transaction });
      }

      await exam.update({ status: EXAM_STATUS.COMPLETED }, { transaction });
      return { ...computed, ranked: sat.length, unranked: partial.length };
    });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'exams', recordId: exam.id, event: 'update', before: null, after: snapshot(exam), reason: payload.reason || null,
  });
  return { exam, summary };
}

/**
 * Publish — the edge that makes results visible to a parent or student (§19.3, §23).
 *
 * Refused unless results exist, so publishing cannot announce an empty exam.
 */
async function publishResults(req, examId, payload) {
  const exam = await findExam(req, examId, payload.school_id);

  if (exam.status === EXAM_STATUS.PUBLISHED) {
    throw ApiError.conflict('These results are already published', {
      code: 'EXAM_ALREADY_PUBLISHED',
      details: { status: exam.status, published_at: exam.published_at },
    });
  }
  if (exam.status !== EXAM_STATUS.COMPLETED) {
    throw ApiError.conflict('Results must be generated before they can be published', {
      code: 'EXAM_NOT_COMPLETED',
      details: { status: exam.status },
    });
  }

  const before = snapshot(exam);
  let count;
  try {
    count = await db.sequelize.transaction(async (transaction) => {
      const at = new Date();

      /*
       * Only a ranked result is published. `position` is non-null exactly for the students who sat every
       * paper, so a partial or stranded row is never released to a parent as though it were a result.
       *
       * Existence is asked with COUNT, not inferred from the UPDATE's return. MySQL reports rows
       * *changed*, not rows *matched*, so re-publishing rows that already carried `is_published: true`
       * returns 0 - which the previous code read as "this exam has no results" and refused with
       * EXAM_NO_RESULTS on an exam that plainly had them.
       */
      const publishable = childScope(exam, { exam_id: exam.id, position: { [Op.ne]: null } });
      const total = await db.Result.count({ where: publishable, transaction });
      if (!total) {
        throw ApiError.conflict('This exam has no ranked results to publish', {
          code: 'EXAM_NO_RESULTS',
          details: { exam_id: exam.id },
        });
      }
      await db.Result.update({ is_published: true, published_at: at }, { where: publishable, transaction });
      const updated = total;
      await exam.update({ status: EXAM_STATUS.PUBLISHED, published_at: at }, { transaction });
      return updated;
    });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'exams', recordId: exam.id, event: 'update', before, after: snapshot(exam), reason: payload.reason || null,
  });
  return { exam, published: count };
}

async function listResults(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  for (const field of ['exam_id', 'student_id', 'class_id', 'section_id', 'is_published']) {
    if (query[field] !== undefined) where[field] = query[field];
  }

  return paginateQuery(
    db.Result,
    {
      where,
      /*
       * The exam is included as well as the student. This query accepts an `exam_id` filter and
       * applies it, but sent back no exam at all — so a result row could not say which exam it came
       * from, and two results for the same student from two different exams were indistinguishable
       * in a list ordered by position. Narrow attributes: the name, its type, and the date the
       * student and parent screens render as "Held".
       */
      include: [
        { model: db.Student, as: 'student', attributes: ['id', 'student_id', 'roll_number', 'first_name', 'last_name'] },
        { model: db.Exam, as: 'exam', attributes: ['id', 'name', 'exam_type', 'start_date'] },
      ],
      order: unrankedLast(getSort({ query }, RESULT_SORTABLE, ['position', 'ASC'])),
    },
    pagination
  );
}

/**
 * A merit list puts the unranked at its foot, whichever way it runs.
 *
 * MariaDB sorts NULL first in ascending order, so the list served every unranked result — a student
 * absent from a paper, a result not yet computed — above first place, while `classResultPdf()` put them
 * last. A screen and its export disagreeing about who is at the top of the class is the one ordering
 * defect a family would notice; only an order on `position` is changed.
 *
 * @param {Array<Array>} order  from `getSort()`
 * @returns {Array<Array>}
 */
function unrankedLast(order) {
  if (!order.length || order[0][0] !== 'position') return order;
  return [[db.sequelize.literal('`Result`.`position` IS NULL'), 'ASC'], ...order];
}

/**
 * The Result Card payload — FR-EXAM-004's "Result Card" and "Student Result", and the half of
 * FR-EXAM-005 this module delivers.
 *
 * Card-complete by design: everything a renderer needs in one response, with no follow-up call. If a
 * renderer would have to fetch the school's name or the exam's type separately, this payload is
 * unfinished — that is the standard the service header holds it to.
 */
async function resultCard(req, result) {
  const [exam, student, school, brand] = await Promise.all([
    db.Exam.findByPk(result.exam_id),
    db.Student.findByPk(result.student_id),
    db.School.findByPk(result.school_id),
    schoolBrand(result.school_id),
  ]);

  return {
    /* The name the school uses (D35), which is the one a card handed to a family should carry. */
    school: school ? { id: school.id, name: brand ? brand.name : school.name, code: school.code } : null,
    exam: exam
      ? {
          id: exam.id,
          name: exam.name,
          exam_type: exam.exam_type,
          grade_scale: exam.grade_scale,
          start_date: exam.start_date,
          end_date: exam.end_date,
          status: exam.status,
        }
      : null,
    student: student
      ? {
          id: student.id,
          student_id: student.student_id,
          roll_number: student.roll_number,
          first_name: student.first_name,
          last_name: student.last_name,
        }
      : null,
    totals: {
      total_full_marks: money.round(result.total_full_marks),
      total_marks_obtained: money.round(result.total_marks_obtained),
      percentage: Number(result.percentage),
      grade_name: result.grade_name,
      grade_point: result.grade_point === null ? null : money.round(result.grade_point),
      outcome: result.outcome,
      subjects_count: result.subjects_count,
      subjects_failed: result.subjects_failed,
    },
    position: { position: result.position, out_of: result.position_out_of },
    subjects: Array.isArray(result.subject_breakdown) ? result.subject_breakdown : [],
    published: { is_published: Boolean(result.is_published), published_at: result.published_at },
    /*
     * Named rather than omitted: FR-EXAM-005's PDF is not rendered by this module, and the column that
     * would hold it is deliberately null. See the service header.
     */
    result_card_path: null,
  };
}

/**
 * The same result card, as a PDF — SRS §19.3, FR-EXAM-005; Phase 5.4.
 *
 * Rendered from the payload `resultCard()` already builds, not from the row, so the PDF and the JSON
 * are the same card by construction. §22's Excel/PDF pair works the same way and for the same
 * reason: two renderers reading a result separately is how a parent's printed card ends up
 * disagreeing with the one on screen.
 *
 * §19.3 names *"PDF support and Print support"* and no third format — no Excel, which §22 does name.
 * Print stays a client concern: there is no view engine here.
 *
 * `result_card_path` is still null and is not written. Streaming the Buffer is what §22 established
 * and it needs no storage story, no upload profile and none of the file-serving infrastructure this
 * application still lacks. Persisting a card is a separate decision from rendering one.
 *
 * @param {object} card  the payload from `resultCard()`
 * @returns {Promise<Buffer>}
 */
/**
 * §19's per-subject breakdown, as printable rows — the one place the absence rule lives.
 *
 * Exported because **two** documents print a result card: FR-EXAM-005's export here, and §20.5's
 * Result Card in the documents module. They read the same `subject_breakdown` array, so a private
 * copy in each was a second source of truth for one rule, and the rule is not cosmetic: §19 stores
 * `null` for an absent paper, and printing `0` would report a mark the student never received. One
 * of the two copies drifting would libel a child on a document a parent keeps.
 *
 * Lives here rather than in `utils/pdf.js` because it is §19's rule about marks, not a rendering
 * decision — the renderer has no business knowing what an absence means.
 *
 * @param {Array<object>} breakdown  `results.subject_breakdown`
 * @returns {Array<object>} rows keyed for the result-card table
 */
function subjectRows(breakdown) {
  return (Array.isArray(breakdown) ? breakdown : []).map((paper) => ({
    subject: paper.subject_code ? `${paper.subject_name} (${paper.subject_code})` : paper.subject_name,
    full: paper.full_marks,
    obtained: paper.is_absent ? 'absent' : paper.marks_obtained,
    practical: paper.practical_marks_obtained === null ? '—' : paper.practical_marks_obtained,
    grade: paper.grade_name,
    outcome: paper.outcome,
  }));
}

function resultCardPdf(card) {
  const student = card.student || {};
  const exam = card.exam || {};
  const school = card.school || {};
  const totals = card.totals || {};
  const position = card.position || {};

  const name = [student.first_name, student.last_name].filter(Boolean).join(' ');

  return renderTable({
    title: 'Result Card',
    subtitle: [school.name, exam.name].filter(Boolean).join('  |  ') || null,
    details: [
      { label: 'Student', value: name },
      { label: 'Student ID', value: student.student_id },
      { label: 'Roll number', value: student.roll_number },
      { label: 'Exam type', value: exam.exam_type },
      { label: 'Grade scale', value: exam.grade_scale },
      { label: 'Exam dates', value: [exam.start_date, exam.end_date].filter(Boolean).join(' to ') },
    ],
    columns: [
      { key: 'subject', header: 'Subject', width: 4 },
      { key: 'full', header: 'Full', width: 1 },
      { key: 'obtained', header: 'Obtained', width: 1 },
      { key: 'practical', header: 'Practical', width: 1 },
      { key: 'grade', header: 'Grade', width: 1 },
      { key: 'outcome', header: 'Outcome', width: 1 },
    ],
    rows: subjectRows(card.subjects),
    summary: [
      { label: 'Total marks', value: `${totals.total_marks_obtained} / ${totals.total_full_marks}` },
      { label: 'Percentage', value: totals.percentage === null ? '—' : `${totals.percentage}%` },
      { label: 'Grade', value: totals.grade_name },
      { label: 'Grade point', value: totals.grade_point },
      { label: 'Outcome', value: totals.outcome },
      { label: 'Subjects failed', value: `${totals.subjects_failed} of ${totals.subjects_count}` },
      /*
       * §19 assigns a position only to students who sat every counted paper, so a null here is a
       * fact about this student and not a missing number. Said, rather than left blank.
       */
      {
        label: 'Position',
        value: position.position === null
          ? 'not ranked (did not sit every paper)'
          : `${position.position} of ${position.out_of}`,
      },
    ],
    footer: school.name || 'School Management System',
  });
}

/**
 * FR-EXAM-004's "Class Result" as a PDF — every result of one exam, in merit order.
 *
 * The exam has already been found through the caller's tenant (`findExam`), so this reads by its id.
 * Ranked students first by position, then the unranked — §19 ranks only those who sat every counted
 * paper, and `ORDER BY position` alone would put MariaDB's NULLs first, heading a merit list with the
 * students it does not rank.
 *
 * It honours the list's filters — published or not, a section, a student — so the PDF of what a screen
 * shows filtered is that same set: one that quietly included the rows the screen hid would be a
 * different document from the one the user chose to export.
 *
 * @param {object} exam  an `Exam` row the caller may read
 * @param {{is_published?: boolean, class_id?: number, section_id?: number, student_id?: number}} [query]
 * @returns {Promise<Buffer>}
 */
async function classResultPdf(exam, query = {}) {
  const [school, rows] = await Promise.all([
    /* D35 — the school's own display name heads the page. */
    schoolBrand(exam.school_id),
    db.Result.findAll({
      where: {
        exam_id: exam.id,
        school_id: exam.school_id,
        /* The list's own filters, every one it accepts — so the PDF is the set the screen shows. */
        ...Object.fromEntries(
          ['is_published', 'class_id', 'section_id', 'student_id']
            .filter((field) => query[field] !== undefined)
            .map((field) => [field, query[field]])
        ),
      },
      include: [{ model: db.Student, as: 'student', attributes: ['student_id', 'roll_number', 'first_name', 'last_name'] }],
      order: [[db.sequelize.literal('`Result`.`position` IS NULL'), 'ASC'], ['position', 'ASC'], ['id', 'ASC']],
    }),
  ]);
  const published = rows.filter((row) => row.is_published).length;

  return renderTable({
    title: 'Class Result',
    subtitle: [school && school.name, exam.name].filter(Boolean).join('  |  ') || null,
    details: [
      { label: 'Exam type', value: exam.exam_type },
      { label: 'Exam dates', value: [exam.start_date, exam.end_date].filter(Boolean).join(' to ') },
      { label: 'Results', value: `${rows.length} (${published} published)` },
    ],
    columns: [
      { key: 'position', header: 'Pos.', width: 1 },
      { key: 'student', header: 'Student', width: 4 },
      { key: 'roll', header: 'Roll', width: 1 },
      { key: 'marks', header: 'Marks', width: 2 },
      { key: 'percentage', header: '%', width: 1 },
      { key: 'grade', header: 'Grade', width: 1 },
      { key: 'outcome', header: 'Outcome', width: 1 },
    ],
    rows: rows.map((row) => {
      const student = row.student || {};
      return {
        position: row.position === null ? '—' : row.position,
        student: [student.first_name, student.last_name].filter(Boolean).join(' ') || student.student_id,
        roll: student.roll_number,
        marks: `${row.total_marks_obtained} / ${row.total_full_marks}`,
        percentage: row.percentage === null ? '—' : row.percentage,
        grade: row.grade_name,
        outcome: row.outcome,
      };
    }),
    footer: (school && school.name) || 'School Management System',
  });
}

async function findResult(req, id, namedSchoolId = undefined) {
  const where = tenantWhere(req.tenant, { id });
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  if (named) {
    const school = await resolveSchool(req, named);
    where.school_id = school.id;
  }
  const row = await db.Result.findOne({ where });
  if (!row) throw ApiError.notFound('Result not found', { code: 'RESULT_NOT_FOUND' });
  return row;
}

/**
 * §19.3 "Student Result" for the people it is about — `results.self.view`, held by a student and a
 * parent and nobody else.
 *
 * §19.3 names "Student Result" and FR-EXAM-005's actor list includes Parent and Student outright. The
 * other three self-view keys were mounted later by the owner's decision D17, and resolve whose records
 * they are through `services/selfScope`, which states this function's rule once for all of them.
 *
 * Confinement is **not** `tenantWhere`, which would hand a parent their whole school. A parent is
 * resolved from their own account and confined through `parent_students`; a student to their own row.
 * Only published results — an unpublished result is a draft the school has not released.
 */
async function myResults(req, query, pagination) {
  if (!req.user || !req.user.id) {
    throw ApiError.unauthenticated('This view is for a signed-in student or parent');
  }

  /*
   * Both profiles are consulted, not just the first one found. Nothing stops one account being both a
   * student and a parent - a teacher's child at the same school, an adult learner with a child enrolled -
   * and resolving the student row first used to make the parent half unreachable for them, silently
   * hiding their children's results with no error to explain it.
   */
  const ids = new Set();
  const student = await db.Student.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (student) ids.add(Number(student.id));

  const parent = await db.Parent.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (parent) {
    if (!parent.is_active) {
      throw ApiError.forbidden('This parent account is no longer active', {
        code: 'PARENT_INACTIVE',
        details: { parent_id: parent.id },
      });
    }
    const links = await db.ParentStudent.findAll({
      where: childScope(parent, { parent_id: parent.id }),
      attributes: ['student_id'],
    });
    for (const l of links) ids.add(Number(l.student_id));
  }

  if (!student && !parent) {
    throw ApiError.notFound('No student or parent profile is linked to this account', {
      code: 'SELF_PROFILE_MISSING',
      details: { user_id: req.user.id },
    });
  }
  const studentIds = [...ids];

  if (!studentIds.length) return { rows: [], count: 0 };

  const where = { student_id: { [Op.in]: studentIds }, is_published: true };
  if (query.exam_id) where.exam_id = query.exam_id;
  if (query.student_id) {
    /* A parent may narrow to one child — but only to one of theirs. */
    if (!studentIds.map(Number).includes(Number(query.student_id))) {
      throw ApiError.forbidden('That student is not linked to this account', {
        code: 'STUDENT_NOT_LINKED',
        details: { student_id: query.student_id },
      });
    }
    where.student_id = query.student_id;
  }

  return paginateQuery(
    db.Result,
    {
      where,
      /*
       * `result_card_path` is a stored path, and no path leaves the server (Known Issues #26). Nothing
       * writes it yet — the card is rendered on request — so this closes a leak before its first writer.
       */
      attributes: { exclude: ['result_card_path'] },
      include: [
        { model: db.Student, as: 'student', attributes: ['id', 'student_id', 'roll_number', 'first_name', 'last_name'] },
        /*
         * `start_date` is selected because the student and parent result screens render a "Held"
         * column from it. Without it those screens showed a permanent em-dash: the field was typed
         * on the client and never sent. It is a nullable `DATEONLY` on `exams`, so a draft exam with
         * no date set still answers — the screens already render the em-dash for null.
         */
        { model: db.Exam, as: 'exam', attributes: ['id', 'name', 'exam_type', 'start_date'] },
      ],
      order: getSort({ query }, RESULT_SORTABLE, ['id', 'DESC']),
    },
    pagination
  );
}

module.exports = {
  childScope,
  gradeScope,
  round3,
  matchBand,
  subjectOutcome,
  rankResults,
  cohortOf,
  recalculate,
  findExam,
  findResult,
  resultCard,
  resultCardPdf,
  classResultPdf,
  subjectRows,
  listGrades,
  findGrade,
  createGrade,
  updateGrade,
  listExams,
  createExam,
  updateExam,
  listExamSubjects,
  addExamSubject,
  updateExamSubject,
  loadExamSubject,
  enterMarks,
  submitMarks,
  listMarks,
  generateResults,
  publishResults,
  listResults,
  myResults,
  assertNoBandOverlap,
  EXAM_MUTABLE,
  GRADE_EDITABLE,
  EXAM_EDITABLE,
  EXAM_SUBJECT_EDITABLE,
};
