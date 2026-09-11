'use strict';

/**
 * Homework — SRS §20.2, FR-HW-001.
 *
 * One table, `homework`, which carries both `school_id` and `organization_id`, so `tenantWhere()` is
 * safe on it. It has no unique index, and none is wanted: a class can legitimately be set two pieces of
 * homework for the same subject on the same day.
 *
 * ## The file, which is the first upload this application actually performs
 *
 * `middlewares/upload.js` has carried a `homework` profile since it was written — PDF/JPEG/PNG/WebP, one
 * file, cited in its own rules table to *"§20.2 / FR-HW-001 — “Upload File” (format not specified)"* — and
 * until now nothing called it. The payment screenshot was the only upload in the whole application. So
 * this module is the second caller, and it uses the profile that was reserved for it rather than adding
 * a seventh.
 *
 * `relativeUploadPath()` moved out of `payments.service.js` for this: a school-side module reaching into
 * a billing service for a path helper would be the wrong dependency, and the helper belongs beside
 * `cleanupUploads()`, which every upload caller needs anyway. `payments` re-exports it, so nothing that
 * already imported it had to change.
 *
 * **A failed insert deletes the file.** `cleanupUploads(req)` runs on any error after the upload, for
 * the reason `payments` gives: a stored file that no row points at is disk the school never got a
 * record for, and nothing would ever collect it.
 *
 * **The stored path is never returned to a caller.** `present()` reduces it to a name and a boolean, the
 * way `payments` reduces its screenshot. A path in a response is a directory layout in a response.
 *
 * ## What FR-HW-001 does NOT get, and why it is recorded rather than hidden
 *
 * There is **no download route**, because there is no file-serving anywhere in this application — no
 * `res.download`, no `res.sendFile`, no `express.static`, no streamed response. §20.2's outcome is that
 * *"Homework is available to the relevant class/students"*, and the homework — title, description, due
 * date, and the name of the attached file — is. The bytes are not yet retrievable.
 *
 * That is the same deferral FR-EXAM-005 took and for the same reason: serving files is shared plumbing
 * that §20.5's FR-DOC-001 will have to build properly, together with Known Issues #26, which records
 * five columns elsewhere that still accept a caller-supplied path and which become reachable the moment
 * a download route exists. Building a one-off reader here would either be thrown away or become the
 * thing three later modules copy.
 *
 * ## Who sees which homework
 *
 * The seeded catalogue gives `homework.view` to staff **and** to students and parents, and there is no
 * separate `homework.self.view` to distinguish them — unlike §19, where `results.self.view` exists and
 * carries its own endpoint. So the narrowing has to happen in the service: a caller who resolves to a
 * student sees their own class's homework, a parent sees their children's, and everyone else sees the
 * school's.
 *
 * Without that, a student holding the same `homework.view` as a teacher would list every class's
 * homework in the school. §20.2's outcome names "the relevant class/students", which is the sentence
 * this implements; the alternative is not a narrower reading of the requirement, it is a disclosure the
 * requirement does not ask for.
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

const SORTABLE = Object.freeze(['id', 'due_date', 'assigned_date', 'title', 'created_at']);
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
  'is_published',
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
 * The stored path never leaves the service — only whether there is a file and what it was called. That
 * is the shape `payments` uses for its screenshot, and the reason is the same: the path describes the
 * server's directory layout, and a caller has no use for it while there is nothing to fetch it with.
 */
function present(row) {
  const json = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  delete json.attachment_path;
  return { ...json, has_attachment: Boolean(row.attachment_path) };
}

function rethrow(err) {
  if (err instanceof db.Sequelize.ValidationError) {
    /* `dueNotBeforeAssigned` lives on the model; surfaced as a 422 rather than escaping as a 500. */
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  if (err instanceof db.Sequelize.ForeignKeyConstraintError) {
    throw ApiError.validation('A referenced record does not exist', [
      { field: 'body', message: 'One of the records this homework refers to no longer exists' },
    ]);
  }
  throw err;
}

/** Every optional reference on a homework row must point inside the same school. */
async function assertReferences(payload, schoolId, existing = null) {
  const classId = payload.class_id !== undefined ? payload.class_id : existing && existing.class_id;
  if (payload.class_id !== undefined) await loadClassInSchool(payload.class_id, schoolId);
  if (payload.section_id) await loadSectionOfClass(payload.section_id, classId);
  /*
   * Moving the homework to another class without naming a section would leave the section it kept
   * pointing at the class it used to belong to — a pairing the create path refuses. §5a session 19
   * found exactly this on `PATCH /exams/:id`.
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
  await assertOnCurriculum(payload, schoolId, existing);
}

/**
 * FR-HW-001's precondition, "Class/subject assignment exists" (SRS:1099) — the owner's decision D30.
 *
 * The subject stays optional; when one is named it must be on the class's curriculum, which §14.4 keeps
 * in `class_subjects`. Re-checked whenever either half of the pair moves, so moving homework to a class
 * that does not teach its subject is refused like naming the wrong subject. Teachers are not narrowed to
 * their own classes — D30 decided that too. Shared with `assignments.service`, whose FR-ASG-001 carries
 * the same precondition (SRS:1108).
 *
 * The section counts. A `class_subjects` row with a section is that section's curriculum only
 * (`models/academic.js`), so work set for a section may name a subject of the whole class or of that
 * section, and work set for the whole class a subject of the whole class.
 */
async function assertOnCurriculum(payload, schoolId, existing = null) {
  if (payload.subject_id === undefined && payload.class_id === undefined && payload.section_id === undefined) return;
  const classId = payload.class_id !== undefined ? payload.class_id : existing && existing.class_id;
  const subjectId = payload.subject_id !== undefined ? payload.subject_id : existing && existing.subject_id;
  const sectionId = payload.section_id !== undefined ? payload.section_id : existing && existing.section_id;
  if (!classId || !subjectId) return;
  const onCurriculum = await db.ClassSubject.count({
    where: {
      school_id: schoolId,
      class_id: classId,
      subject_id: subjectId,
      is_active: true,
      [Op.or]: [{ section_id: null }, ...(sectionId ? [{ section_id: sectionId }] : [])],
    },
  });
  if (!onCurriculum) {
    throw ApiError.validation('That subject is not taught in this class', [
      { field: 'subject_id', message: "Name a subject on this class's curriculum (its class subjects)" },
    ]);
  }
}

/**
 * The placements — class, and section where the student has one — a self-service caller may see
 * homework for, or `null` for a caller who is neither a student nor a parent and therefore sees the
 * whole school.
 *
 * Both profiles are consulted rather than the first one found — one account can be both a student and a
 * parent, and resolving only the student half would silently hide their children's homework. That was a
 * real defect in §19's `myResults()` (§5a session 19), and repeating it here would be repeating a
 * mistake this project has already paid for.
 *
 * The section is part of the placement because homework can be set for one section: §20.2's "the
 * relevant class/students", and the form's own promise that naming a section confines the homework to
 * it. Narrowing by class alone showed a section's homework to every other section of the class.
 */
async function selfScopePlacements(req) {
  if (!req.user || !req.user.id) return null;

  const placements = [];
  let isSelfCaller = false;
  const place = (student) => {
    if (student.class_id) {
      placements.push({ classId: Number(student.class_id), sectionId: student.section_id ? Number(student.section_id) : null });
    }
  };

  const student = await db.Student.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (student) {
    isSelfCaller = true;
    place(student);
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
          attributes: ['class_id', 'section_id'],
        });
        children.forEach(place);
      }
    }
  }

  return isSelfCaller ? placements : null;
}

/** Whether a homework row is set for one of `placements`: its class, and either no section or theirs. */
function reaches(placements, row) {
  return placements.some((p) => p.classId === Number(row.class_id) &&
    (!row.section_id || p.sectionId === Number(row.section_id)));
}

/** The same test as a `WHERE` fragment. An empty set resolves to nothing, never to the whole school. */
function placementWhere(placements) {
  if (!placements.length) return { class_id: { [Op.in]: [0] } };
  return {
    [Op.or]: placements.map((p) => ({
      class_id: p.classId,
      [Op.or]: [{ section_id: null }, ...(p.sectionId ? [{ section_id: p.sectionId }] : [])],
    })),
  };
}

async function findById(req, id, namedSchoolId = undefined) {
  const where = tenantWhere(req.tenant, { id });
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  /* Record and entitlement guard resolved from the same school — §5a defects 22 and 35. */
  if (named) {
    const school = await resolveSchool(req, named);
    where.school_id = school.id;
  }
  const row = await db.Homework.findOne({ where });
  if (!row) throw ApiError.notFound('Homework not found', { code: 'HOMEWORK_NOT_FOUND' });

  /*
   * A student or parent reading one row by id is confined the same way the list is. Without this the
   * narrowing would be a list-only courtesy that any caller could step around by guessing an id, and
   * an unpublished draft would be readable by the class it has not been set for yet.
   */
  const own = await selfScopePlacements(req);
  if (own !== null && (!reaches(own, row) || !row.is_published)) {
    throw ApiError.notFound('Homework not found', { code: 'HOMEWORK_NOT_FOUND' });
  }
  return row;
}

async function list(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  for (const field of ['class_id', 'section_id', 'subject_id', 'teacher_id', 'academic_session_id', 'is_published']) {
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

  const own = await selfScopePlacements(req);
  if (own !== null) {
    /*
     * A student or parent with no class resolves to an empty set, never to the whole school. Added
     * beside the caller's own filters rather than over them, so `class_id=` or `q=` can only narrow.
     */
    where[Op.and] = [...(where[Op.and] || []), placementWhere(own)];
    /* Unpublished homework is a draft; §20.2 makes it "available" only once it is published. */
    where.is_published = true;
  }

  const result = await paginateQuery(
    db.Homework,
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

/** FR-HW-001 — create, with the file and the due date in one request. */
async function create(req, payload) {
  try {
    const school = await resolveSchool(req, payload.school_id);
    await assertReferences(payload, school.id);

    const next = normaliseDates(pick(payload));
    const row = await db.Homework.create({
      school_id: school.id,
      organization_id: school.organization_id,
      created_by: req.user ? req.user.id : null,
      attachment_path: relativeUploadPath(req.file),
      attachment_name: req.file ? req.file.originalname : null,
      /* §20.2 names an assigned date beside the due date; today is the only sensible default. */
      assigned_date: next.assigned_date || dates.toDateOnly(new Date()),
      ...next,
    });

    await recordAudit(req, {
      tableName: 'homework',
      recordId: row.id,
      event: 'create',
      before: null,
      after: snapshot(row),
      reason: payload.reason || null,
    });
    return row;
  } catch (err) {
    /* A file with no row behind it is disk nobody will ever collect. */
    await cleanupUploads(req);
    return rethrow(err);
  }
}

async function update(req, id, payload) {
  const row = await findById(req, id, payload.school_id);
  await assertReferences(payload, row.school_id, row);

  const before = snapshot(row);
  const next = normaliseDates(pick(payload));
  if (!Object.keys(next).length) {
    throw ApiError.validation('No homework fields to update', [
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
    tableName: 'homework',
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
  present,
  selfScopePlacements,
  assertOnCurriculum,
  childScope,
  EDITABLE,
  SORTABLE,
};
