'use strict';

/**
 * Assignments — SRS §20.3, FR-ASG-001.
 *
 * FR-ASG-001 is a three-step lifecycle with two actors: *"Teacher creates an assignment. Student submits
 * the assignment. Teacher reviews the submission."* §29 lists **no submissions table**, so both shapes
 * live in `assignments` and `record_type` tells them apart — `assignment` for the teacher's task,
 * `submission` for a student's answer, the latter carrying `parent_assignment_id` and `student_id`.
 * The model's own `shapeMatchesRecordType` validator enforces the pairing from underneath.
 *
 * The table carries `school_id` **and** `organization_id`, so `tenantWhere()` is safe on it. That is
 * worth stating because it is the trap this project has shipped three times (§5a defects 12, 31, 47).
 *
 * ## The unique index is doing its job here, and that is the unusual part
 *
 * `assignments_submission_unique (parent_assignment_id, student_id)` is the **fourth** sighting of this
 * index shape in the schema, and the first where nothing is wrong with it. In `class_subjects`,
 * `timetables` and `fee_structures` the pair contains a nullable column that is legitimately NULL in
 * ordinary use, MySQL treats NULL as distinct inside a UNIQUE index, and the index therefore rejects
 * none of the duplicates it was written to reject — three separate defects, each needing a locking read
 * as the only available backstop.
 *
 * Here both columns are **NOT NULL on every row the index is meant to constrain**: a submission row
 * cannot exist without both, because the model validator refuses it. So the index really does enforce
 * one submission per student per assignment, at the database, and a concurrent double-submit loses at
 * the index rather than at a guard. On an `assignment` row both columns are NULL, so NULL-distinctness
 * lets any number of assignments coexist — which is exactly what is wanted. The permissiveness that was
 * a hole in the other three tables is the feature that makes the single-table design work in this one.
 *
 * The duplicate is still translated to a 409 rather than escaping as a 500, and the resubmission path
 * takes a locking read — not to substitute for the index, but because it is a read-then-write.
 *
 * ## `returned` is what makes a second attempt possible
 *
 * The index permits exactly one submission row per student per assignment, and `SUBMISSION_STATUS` has
 * three values — `submitted`, `reviewed`, `returned`. A returned submission is one the teacher handed
 * back, and the only way that value can mean anything is if the student may then submit again. So a
 * submit against a `returned` row **replaces it in place**: the text and file are overwritten,
 * `submitted_at` is re-stamped, `is_late` is recomputed, and the previous review is cleared so a stale
 * mark cannot survive against new work. A submit against a `submitted` or `reviewed` row is refused.
 *
 * Replacing in place rather than inserting is what the index requires; the alternative would be a second
 * row the database will not accept.
 *
 * ## Who may see what
 *
 * `assignments.view` reaches staff, students and parents, with no `assignments.self.view` to tell them
 * apart — the same catalogue shape §20.2 had. So the service narrows: a student sees their own class's
 * assignments and their own submissions, a parent sees their children's, and everyone else sees the
 * school's. The narrowing holds on a read by id as well as on a list, because a list-only narrowing is
 * one an id guess steps around.
 *
 * Both the student and the parent profile are consulted, never the first one found — one account can be
 * both, and resolving only the student half would silently hide their children's work. That was a real
 * defect in §19's `myResults()` (§5a session 19).
 *
 * ## What FR-ASG-001 does not get
 *
 * There is **no download route**. There is no file-serving anywhere in this application, and §20.3's
 * outcome — *"Assignment lifecycle from creation to review is completed"* — is reached without one: the
 * teacher sees that a file was submitted and what it was called. This is the same deferral FR-EXAM-005
 * and FR-HW-001 took, now three requirements deep, and §20.5's FR-DOC-001 is where the shared plumbing
 * has to be built, together with Known Issues #26.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const dates = require('../../utils/dates');
const { cleanupUploads, relativeUploadPath } = require('../../middlewares/upload');
const {
  resolveSchool,
  loadClassInSchool,
  loadSectionOfClass,
  loadSessionInSchool,
  loadTeacherInSchool,
} = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const {
  ASSIGNMENT_RECORD_TYPES,
  ASSIGNMENT_STATUS,
  SUBMISSION_STATUS,
} = require('../../config/constants');

const SORTABLE = Object.freeze(['id', 'due_date', 'assigned_date', 'title', 'created_at']);
const SUBMISSION_SORTABLE = Object.freeze(['id', 'submitted_at', 'reviewed_at', 'created_at']);
const DATE_COLUMNS = Object.freeze(['assigned_date', 'due_date']);
const EDITABLE = Object.freeze([
  'class_id',
  'section_id',
  'subject_id',
  'teacher_id',
  'academic_session_id',
  'title',
  'description',
  'assigned_date',
  'due_date',
  'total_marks',
  'status',
]);

/** `parent_students` has no `organization_id`, so it is scoped by its parent's school. */
function childScope(parent, where) {
  return { ...where, school_id: parent.school_id };
}

function dateOnly(value) {
  return value === undefined || value === null || value === '' ? value : dates.toDateOnly(value);
}

function normaliseDates(payload) {
  const next = { ...payload };
  for (const column of DATE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(next, column)) next[column] = dateOnly(next[column]);
  }
  return next;
}

function pick(payload) {
  const next = {};
  for (const key of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  return next;
}

/**
 * What a caller is shown.
 *
 * The stored path never leaves the service — only whether there is a file and what it was called, the
 * shape `payments` and `homework` both use. A path in a response is a directory layout in a response,
 * and there is nothing a caller could fetch with it anyway.
 */
function present(row) {
  const json = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  delete json.attachment_path;
  const shaped = { ...json, has_attachment: Boolean(row.attachment_path) };
  if (Array.isArray(json.submissions)) shaped.submissions = json.submissions.map(present);
  return shaped;
}

function rethrow(err) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    /*
     * `assignments_submission_unique`. Unlike the other three sightings of this index shape, both of its
     * columns are non-null on the rows it constrains, so this really is the database refusing a second
     * submission — not a guard that happened to notice.
     */
    throw ApiError.conflict('That student has already submitted this assignment', {
      code: 'SUBMISSION_ALREADY_EXISTS',
    });
  }
  if (err instanceof db.Sequelize.ValidationError) {
    /* `shapeMatchesRecordType` lives on the model; surfaced as a 422 rather than escaping as a 500. */
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  if (err instanceof db.Sequelize.ForeignKeyConstraintError) {
    throw ApiError.validation('A referenced record does not exist', [
      { field: 'body', message: 'One of the records this assignment refers to no longer exists' },
    ]);
  }
  throw err;
}

/**
 * Every optional reference on an assignment row must point inside the same school.
 *
 * The model carries no date validator of its own — unlike `homework`, which has `dueNotBeforeAssigned` —
 * so the ordering is checked here. An assignment due before it was set is a data-entry slip that would
 * otherwise mark every submission late from the moment it was created.
 */
async function assertReferences(payload, schoolId, existing = null) {
  const classId = payload.class_id !== undefined ? payload.class_id : existing && existing.class_id;
  if (payload.class_id !== undefined) await loadClassInSchool(payload.class_id, schoolId);
  if (payload.section_id) await loadSectionOfClass(payload.section_id, classId);
  /*
   * Moving the assignment to another class without naming a section would leave the section it kept
   * pointing at the class it used to belong to — a pairing the create path refuses. §5a session 19
   * found exactly this on `PATCH /exams/:id`, and §20.2 carries the same check.
   */
  if (payload.class_id !== undefined && payload.section_id === undefined && existing && existing.section_id) {
    await loadSectionOfClass(existing.section_id, payload.class_id);
  }
  if (payload.academic_session_id) await loadSessionInSchool(payload.academic_session_id, schoolId);
  if (payload.teacher_id) await loadTeacherInSchool(payload.teacher_id, schoolId);
  if (payload.subject_id) {
    const subject = await db.Subject.findOne({ where: { id: payload.subject_id, school_id: schoolId } });
    if (!subject) {
      throw ApiError.validation('That subject is not in this school', [
        { field: 'subject_id', message: 'Unknown subject for this school' },
      ]);
    }
  }

  const assigned = payload.assigned_date !== undefined
    ? dateOnly(payload.assigned_date)
    : existing && existing.assigned_date;
  const due = payload.due_date !== undefined ? dateOnly(payload.due_date) : existing && existing.due_date;
  if (assigned && due && String(due) < String(assigned)) {
    throw ApiError.validation('The due date is before the assigned date', [
      { field: 'due_date', message: 'due_date cannot be earlier than assigned_date' },
    ]);
  }
}

/**
 * The classes and students a self-service caller may see, or `null` for a caller who is neither a
 * student nor a parent and therefore sees the whole school.
 *
 * Two sets, not one, because the two record types are narrowed by different columns: an assignment is
 * reached through `class_id`, a submission through `student_id`. Narrowing submissions by class would
 * show one student every classmate's work.
 */
async function selfScope(req) {
  if (!req.user || !req.user.id) return null;

  const classIds = new Set();
  const studentIds = new Set();
  let isSelfCaller = false;

  const student = await db.Student.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (student) {
    isSelfCaller = true;
    studentIds.add(Number(student.id));
    if (student.class_id) classIds.add(Number(student.class_id));
  }

  const parent = await db.Parent.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (parent) {
    isSelfCaller = true;
    if (parent.is_active) {
      const links = await db.ParentStudent.findAll({
        where: childScope(parent, { parent_id: parent.id }),
        attributes: ['student_id'],
      });
      if (links.length) {
        const children = await db.Student.findAll({
          where: { id: { [Op.in]: links.map((l) => l.student_id) }, school_id: parent.school_id },
          attributes: ['id', 'class_id'],
        });
        for (const child of children) {
          studentIds.add(Number(child.id));
          if (child.class_id) classIds.add(Number(child.class_id));
        }
      }
    }
  }

  return isSelfCaller ? { classIds: [...classIds], studentIds: [...studentIds] } : null;
}

/** An empty `IN ()` — a self-service caller with no class or child resolves to nothing, never to all. */
const NONE = Object.freeze({ [Op.in]: [0] });
const inList = (values) => (values.length ? { [Op.in]: values } : NONE);

/**
 * A student or parent is shown a `draft` assignment by nobody: §20.3's first step is that the teacher
 * *creates* it, and a draft has not been set yet. A `closed` one stays visible, because it is work the
 * student did and a mark they were given — hiding it would hide their own record.
 */
const VISIBLE_TO_CLASS = Object.freeze([ASSIGNMENT_STATUS.PUBLISHED, ASSIGNMENT_STATUS.CLOSED]);

async function narrowSchool(req, namedSchoolId, where) {
  if (namedSchoolId) {
    const school = await resolveSchool(req, namedSchoolId);
    where.school_id = school.id;
  }
  return where;
}

/* ── the assignment half ─────────────────────────────────────────────────────────────────────── */

async function findById(req, id, namedSchoolId = undefined) {
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  /* Record and entitlement guard resolved from the same school — §5a defects 22 and 35. */
  const where = await narrowSchool(
    req,
    named,
    tenantWhere(req.tenant, { id, record_type: ASSIGNMENT_RECORD_TYPES.ASSIGNMENT })
  );

  const row = await db.Assignment.findOne({ where });
  if (!row) throw ApiError.notFound('Assignment not found', { code: 'ASSIGNMENT_NOT_FOUND' });

  const own = await selfScope(req);
  if (own && (!own.classIds.includes(Number(row.class_id)) || !VISIBLE_TO_CLASS.includes(row.status))) {
    throw ApiError.notFound('Assignment not found', { code: 'ASSIGNMENT_NOT_FOUND' });
  }
  return row;
}

async function list(req, query, pagination) {
  const where = await narrowSchool(
    req,
    query.school_id,
    tenantWhere(req.tenant, { record_type: ASSIGNMENT_RECORD_TYPES.ASSIGNMENT })
  );
  for (const field of ['class_id', 'section_id', 'subject_id', 'teacher_id', 'academic_session_id', 'status']) {
    if (query[field] !== undefined) where[field] = query[field];
  }
  if (query.due_from || query.due_to) {
    where.due_date = {
      ...(query.due_from ? { [Op.gte]: dateOnly(query.due_from) } : {}),
      ...(query.due_to ? { [Op.lte]: dateOnly(query.due_to) } : {}),
    };
  }
  if (query.q) {
    where[Op.or] = [
      { title: { [Op.like]: `%${query.q}%` } },
      { description: { [Op.like]: `%${query.q}%` } },
    ];
  }

  const own = await selfScope(req);
  if (own) {
    where.class_id = inList(own.classIds);
    /*
     * Applied after the caller's own `status` filter, so a student asking for `status=draft` is
     * answered with nothing rather than with the school's drafts.
     */
    where.status = query.status && VISIBLE_TO_CLASS.includes(query.status)
      ? query.status
      : { [Op.in]: query.status ? [] : VISIBLE_TO_CLASS };
  }

  const result = await paginateQuery(
    db.Assignment,
    {
      where,
      include: [
        { model: db.Class, as: 'class', attributes: ['id', 'name'] },
        { model: db.Subject, as: 'subject', attributes: ['id', 'name', 'code'] },
      ],
      order: getSort({ query }, SORTABLE, ['due_date', 'ASC']),
    },
    pagination
  );
  return { rows: result.rows.map(present), count: result.count };
}

/** FR-ASG-001, step one — the teacher creates. */
async function create(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  await assertReferences(payload, school.id);

  const next = normaliseDates(pick(payload));
  try {
    const row = await db.Assignment.create({
      school_id: school.id,
      organization_id: school.organization_id,
      created_by: req.user ? req.user.id : null,
      record_type: ASSIGNMENT_RECORD_TYPES.ASSIGNMENT,
      /* §20.3 names an assigned date beside the due date; today is the only sensible default. */
      assigned_date: next.assigned_date || dates.toDateOnly(new Date()),
      /*
       * The column defaults to NULL, which would leave every created assignment in a state that is
       * neither draft nor published and would have to be special-cased by every reader. The lifecycle
       * starts at `draft` unless the caller publishes on creation.
       */
      status: next.status || ASSIGNMENT_STATUS.DRAFT,
      ...next,
    });

    await recordAudit(req, {
      tableName: 'assignments',
      recordId: row.id,
      event: 'create',
      before: null,
      after: snapshot(row),
      reason: payload.reason || null,
    });
    return row;
  } catch (err) {
    return rethrow(err);
  }
}

async function update(req, id, payload) {
  const row = await findById(req, id, payload.school_id);
  await assertReferences(payload, row.school_id, row);

  /*
   * Moving an assignment to a different class after students have answered it would leave their
   * submissions attached to work their class was never set. The submissions cannot follow — they belong
   * to students in the old class — so the move is refused rather than silently stranding them.
   */
  if (payload.class_id !== undefined && Number(payload.class_id) !== Number(row.class_id)) {
    const answered = await db.Assignment.count({
      where: { parent_assignment_id: row.id, record_type: ASSIGNMENT_RECORD_TYPES.SUBMISSION },
    });
    if (answered) {
      throw ApiError.conflict('This assignment has submissions and cannot be moved to another class', {
        code: 'ASSIGNMENT_HAS_SUBMISSIONS',
      });
    }
  }

  const before = snapshot(row);
  const next = normaliseDates(pick(payload));
  if (!Object.keys(next).length) {
    throw ApiError.validation('No assignment fields to update', [
      { field: 'body', message: 'Send at least one field' },
    ]);
  }

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'assignments',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  return row;
}

/* ── the submission half ─────────────────────────────────────────────────────────────────────── */

async function findSubmissionById(req, id, namedSchoolId = undefined) {
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  const where = await narrowSchool(
    req,
    named,
    tenantWhere(req.tenant, { id, record_type: ASSIGNMENT_RECORD_TYPES.SUBMISSION })
  );

  const row = await db.Assignment.findOne({ where });
  if (!row) throw ApiError.notFound('Submission not found', { code: 'SUBMISSION_NOT_FOUND' });

  const own = await selfScope(req);
  if (own && !own.studentIds.includes(Number(row.student_id))) {
    throw ApiError.notFound('Submission not found', { code: 'SUBMISSION_NOT_FOUND' });
  }
  return row;
}

async function listSubmissions(req, query, pagination) {
  const where = await narrowSchool(
    req,
    query.school_id,
    tenantWhere(req.tenant, { record_type: ASSIGNMENT_RECORD_TYPES.SUBMISSION })
  );
  if (query.assignment_id !== undefined) where.parent_assignment_id = query.assignment_id;
  if (query.student_id !== undefined) where.student_id = query.student_id;
  if (query.submission_status !== undefined) where.submission_status = query.submission_status;
  if (query.is_late !== undefined) where.is_late = query.is_late;

  const own = await selfScope(req);
  if (own) {
    /*
     * By student, not by class. A student narrowed to their own class would be shown every classmate's
     * answer to the same assignment, which is the disclosure this narrowing exists to prevent. A
     * `student_id` filter naming somebody else's child intersects to nothing rather than overriding it.
     */
    const asked = query.student_id !== undefined ? [Number(query.student_id)] : own.studentIds;
    where.student_id = inList(asked.filter((s) => own.studentIds.includes(s)));
  }

  const result = await paginateQuery(
    db.Assignment,
    {
      where,
      include: [
        {
          /*
           * `parentAssignment`, not `assignment`: MySQL compares table aliases case-insensitively, so
           * a self-join aliased `assignment` is "not unique" against Sequelize's own `Assignment` alias
           * for the base table. The association was renamed in `models/index.js` for this reason.
           */
          model: db.Assignment,
          as: 'parentAssignment',
          attributes: ['id', 'title', 'due_date', 'total_marks', 'class_id', 'subject_id'],
        },
        /* The name as well: a reviewer marks a person, and the screen has nothing else to call one by. */
        {
          model: db.Student,
          as: 'student',
          attributes: ['id', 'admission_number', 'roll_number', 'first_name', 'last_name'],
        },
      ],
      order: getSort({ query }, SUBMISSION_SORTABLE, ['submitted_at', 'DESC']),
    },
    pagination
  );
  return { rows: result.rows.map(present), count: result.count };
}

/**
 * FR-ASG-001, step two — the student submits.
 *
 * The submitting student is resolved from the authenticated user, never from the body, so a caller
 * cannot answer on somebody else's behalf. `assignments.submit` is granted to Student and to Super
 * Admin; a Super Admin holds the key by the catalogue's construction but has no student profile, so the
 * route refuses them here. That is a property of a fixed catalogue, not a gap.
 */
async function submit(req, assignmentId, payload) {
  let result;
  try {
    result = await db.sequelize.transaction(async (transaction) => {
      const named = payload.school_id;
      const where = await narrowSchool(
        req,
        named,
        tenantWhere(req.tenant, { id: assignmentId, record_type: ASSIGNMENT_RECORD_TYPES.ASSIGNMENT })
      );
      const assignment = await db.Assignment.findOne({ where, transaction });
      if (!assignment) throw ApiError.notFound('Assignment not found', { code: 'ASSIGNMENT_NOT_FOUND' });

      const student = await db.Student.findOne({
        where: tenantWhere(req.tenant, { user_id: req.user.id, school_id: assignment.school_id }),
        transaction,
      });
      if (!student) {
        throw ApiError.forbidden('Only a student of this school can submit an assignment', {
          code: 'NOT_A_STUDENT',
        });
      }
      if (Number(student.class_id) !== Number(assignment.class_id)) {
        throw ApiError.forbidden('This assignment was not set for your class', {
          code: 'ASSIGNMENT_NOT_FOR_STUDENT',
        });
      }
      /* A sectioned assignment reaches one section of the class, not the whole class. */
      if (assignment.section_id && Number(student.section_id) !== Number(assignment.section_id)) {
        throw ApiError.forbidden('This assignment was not set for your section', {
          code: 'ASSIGNMENT_NOT_FOR_STUDENT',
        });
      }
      /*
       * A draft has not been set yet and a closed assignment no longer takes work. Only `published`
       * accepts a submission, which is what makes the three-value lifecycle mean anything.
       */
      if (assignment.status !== ASSIGNMENT_STATUS.PUBLISHED) {
        throw ApiError.conflict(`An assignment with status "${assignment.status}" does not accept submissions`, {
          code: 'ASSIGNMENT_NOT_OPEN',
        });
      }

      /*
       * A locking read, because what follows is a read-then-write. The index would still refuse a
       * concurrent duplicate insert; the lock is what stops two requests from both deciding to replace
       * the same returned row.
       */
      const existing = await db.Assignment.findOne({
        where: {
          parent_assignment_id: assignment.id,
          student_id: student.id,
          record_type: ASSIGNMENT_RECORD_TYPES.SUBMISSION,
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      const today = dates.toDateOnly(new Date());
      const isLate = Boolean(assignment.due_date) && String(today) > String(assignment.due_date);
      const answer = {
        submission_text: payload.submission_text !== undefined ? payload.submission_text : null,
        attachment_path: relativeUploadPath(req.file),
        attachment_name: req.file ? req.file.originalname : null,
        submitted_at: new Date(),
        submission_status: SUBMISSION_STATUS.SUBMITTED,
        is_late: isLate,
      };

      if (existing) {
        if (existing.submission_status !== SUBMISSION_STATUS.RETURNED) {
          throw ApiError.conflict('You have already submitted this assignment', {
            code: 'SUBMISSION_ALREADY_EXISTS',
          });
        }
        /*
         * A returned submission is one the teacher handed back for another attempt, and the index
         * permits only one row per student per assignment, so the second attempt replaces the first.
         * The previous review is cleared: a mark given for work that has since been replaced would be
         * a mark for something nobody can read any more.
         */
        const before = snapshot(existing);
        existing.set({ ...answer, marks_obtained: null, feedback: null, reviewed_by: null, reviewed_at: null });
        await existing.save({ transaction });
        return { row: existing, before, event: 'update' };
      }

      const row = await db.Assignment.create(
        {
          school_id: assignment.school_id,
          organization_id: assignment.organization_id,
          academic_session_id: assignment.academic_session_id,
          record_type: ASSIGNMENT_RECORD_TYPES.SUBMISSION,
          parent_assignment_id: assignment.id,
          student_id: student.id,
          /* Copied so a submission can be listed and scoped without a join back to its parent. */
          class_id: assignment.class_id,
          section_id: assignment.section_id,
          subject_id: assignment.subject_id,
          created_by: req.user.id,
          ...answer,
        },
        { transaction }
      );
      return { row, before: null, event: 'create' };
    });
  } catch (err) {
    /* A stored file with no row behind it is disk nobody will ever collect. */
    await cleanupUploads(req);
    return rethrow(err);
  }

  /*
   * After the commit, never inside it — the convention `fees.pay()` established. An audit row written
   * inside the transaction would survive a rollback only if the audit write were outside it, and would
   * be lost with the transaction if it were in; `recordAudit` takes no transaction at all, so writing
   * it here is the only placement where the row and its audit agree.
   */
  await recordAudit(req, {
    tableName: 'assignments',
    recordId: result.row.id,
    event: result.event,
    before: result.before,
    after: snapshot(result.row),
    reason: payload.reason || (result.event === 'update' ? 'Resubmitted after being returned' : null),
  });
  /*
   * `isNew` so the route can answer 201 for a first submission and 200 for a replacement. The index
   * permits one row, so a second attempt genuinely is not a creation, and saying 201 twice would tell a
   * client a resource was made when the previous one was overwritten.
   */
  return { row: result.row, isNew: result.event === 'create' };
}

/**
 * FR-ASG-001, step three — the teacher reviews.
 *
 * `outcome` chooses between the two review results the enum offers: `reviewed` closes the submission,
 * `returned` hands it back and is what re-opens the submit route for that student.
 */
async function review(req, submissionId, payload) {
  const row = await findSubmissionById(req, submissionId, payload.school_id);

  if (payload.marks_obtained !== undefined && payload.marks_obtained !== null) {
    const parent = await db.Assignment.findOne({
      where: { id: row.parent_assignment_id, school_id: row.school_id },
      attributes: ['id', 'total_marks'],
    });
    /*
     * `total_marks` crosses the wire as a number (`config/database.js` sets `decimalNumbers: true`), so
     * this is a numeric comparison and not a string one. A mark above the paper's total is the §19
     * defect that made a result card add up to more than it could.
     */
    if (parent && parent.total_marks !== null && Number(payload.marks_obtained) > Number(parent.total_marks)) {
      throw ApiError.validation('The mark is above the assignment total', [
        {
          field: 'marks_obtained',
          message: `marks_obtained cannot exceed the assignment's total_marks (${parent.total_marks})`,
        },
      ]);
    }
  }

  const before = snapshot(row);
  row.set({
    ...(payload.marks_obtained !== undefined ? { marks_obtained: payload.marks_obtained } : {}),
    ...(payload.feedback !== undefined ? { feedback: payload.feedback } : {}),
    submission_status: payload.outcome || SUBMISSION_STATUS.REVIEWED,
    reviewed_by: req.user ? req.user.id : null,
    reviewed_at: new Date(),
  });

  try {
    await row.save();
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'assignments',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  return row;
}

module.exports = {
  list,
  findById,
  create,
  update,
  submit,
  review,
  listSubmissions,
  findSubmissionById,
  present,
  selfScope,
  childScope,
  assertReferences,
  EDITABLE,
  SORTABLE,
  SUBMISSION_SORTABLE,
  VISIBLE_TO_CLASS,
};
