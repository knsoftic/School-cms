'use client';

/**
 * One teacher — SRS §15.3, FR-TEACHER-001: *"User creates/edits Teacher Profile including
 * Qualification and Joining Date"*, with the outcome *"Teacher record reflects their profile, subjects,
 * and classes."*
 *
 * ## Why this screen exists
 *
 * `GET /teachers/:id` and `GET /teachers/:id/assignments` had no caller, and `PATCH /teachers/:id` had
 * one, which sent `is_active` and `left_at` and nothing else: the list's Deactivate. So a teacher
 * could be created and then never corrected — a mistyped name, a qualification earned since, a changed phone number were
 * all permanent — and the half of FR-TEACHER-001's outcome that is "subjects and classes" was shown
 * nowhere a school could look. The list's own header deferred both to "the detail screen"; this is it.
 *
 * ## Three things on one record, and where each is written
 *
 *   - **The profile** is the form — `teachers.validation.js` `update`, field for field, less the two
 *     the dialogs below own.
 *   - **Subjects and classes** are read from `/assignments` and written elsewhere, and the service
 *     says why in its own voice: `teacher_subjects` already has a writer in §14.4's
 *     `POST /subjects/:id/teachers`, and being class teacher is `classes.class_teacher_id`. One
 *     invariant, one implementation — so this screen says where each is set rather than growing a
 *     second control for it.
 *   - **The login** is a `users` row. `user_id` links it and is a field on this form; whether it may
 *     sign in is FR-AUTH-007's `status`, set through `PATCH /users/:id` on `users.manage` in the Login
 *     section, which a staff member's record shares (`settings/admins.tsx`).
 *
 * ## Somebody who can only read gets a record, not a form
 *
 * `GET` takes `teachers.view` and `PATCH` takes `teachers.manage`. The Librarian and the Organization
 * Admin hold the first and not the second, so without `teachers.manage` every field is disabled and
 * there is no Save — the line `subjects/[id]` draws, for the same reason.
 *
 * **Salary is the exception: it is not rendered at all without `teachers.manage`.** The controller has
 * no `present()`, so the figure is in the payload for every holder of `teachers.view` — and the list's
 * header has already made the argument that settles it: that permission is not a payroll permission,
 * and a wage is a question for a single record behind the narrower key.
 *
 * ## The employment status is the list's pair of dialogs, reused
 *
 * `is_active` and `left_at` are on the update schema and are not on the form, because they are set
 * together: `teachers.validation.js` models a departure as an edit of both, and `DeactivateDialog`
 * already asks for the leaving date rather than guessing it. Reactivation can be refused —
 * `teacher_limit` counts active teachers and `teachers.service.update()` asserts it on that transition
 * — and the dialog says so before the button is pressed.
 *
 * The same edit moves the login (the owner's decision D19, `usersService.followProfile()`): an active
 * Teacher login goes `inactive` with the teacher and comes back on reactivation, while one an
 * administrator suspended stays suspended. So both actions re-read the Login section when they land.
 *
 * ## What the save sends
 *
 * The whole editable set rather than a diff, as `students/[id]` sends it: a diff has to decide whether
 * a cleared field is "set to null" or "unchanged", and getting that wrong drops an edit silently.
 * Three fields are the exception, each for a reason of its own:
 *
 *   - `gender` is omitted when blank. It is a bare `Joi.string().valid(...)` with no `.allow(null)`,
 *     so a null is a 422; once set, it can be changed but not returned to "not recorded".
 *   - `user_id` is sent only when it changed. Without `users.view` the picker cannot be drawn, and a
 *     form that then sent its empty value would unlink a login nobody touched.
 *   - `metadata` is sent only when its text changed, because the textarea holds a re-serialisation
 *     of the stored object and not the object itself.
 *
 * `salary` and `experience_years` go as the text that was typed — `validate()` converts, and a stray
 * character comes back as a 422 on the field. They are text inputs with a decimal keypad, not
 * `type="number"`, for the reason `staff/new` records: a number input hands back `''` for anything it
 * cannot parse, which here would have saved a mistyped salary as *no salary*, over the old one.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { useRowAction } from '@/lib/useRowAction';
import { useClassSections } from '@/lib/useTimetablePickers';
import { DeactivateDialog, ReactivateDialog } from '@/components/deactivate';
import {
  Field,
  FormActions,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { useToast } from '@/components/toast';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';
import {
  LinkedAccountField,
  LinkedLoginPanel,
  useLinkedAccount,
} from '@/app/(school)/school/settings/admins';

/** `GENDERS` in `config/constants.js`. */
const GENDERS = ['male', 'female', 'other'];

/** Every field this form renders. Anything else a 422 names goes to the banner. */
const FORM_FIELDS = new Set([
  'employee_id',
  'first_name',
  'last_name',
  'joining_date',
  'designation',
  'qualification',
  'specialization',
  'experience_years',
  'salary',
  'gender',
  'date_of_birth',
  'email',
  'phone',
  'address',
  'user_id',
  'notes',
  'metadata',
  'reason',
]);

const NETWORK_FAILURE = 'Could not reach the server. Check your connection and try again.';

/**
 * `GET /teachers/:id` — the raw model row, since the controller has no `present()`.
 *
 * Declared from what this screen reads. `photo_path` is on the row and deliberately absent: §15.3
 * names no teacher photo and the column has no writer (`teachers.validation.js`).
 */
interface Teacher {
  id: number;
  employee_id: string;
  first_name: string;
  last_name: string | null;
  gender: string | null;
  /** `DATEONLY` — `YYYY-MM-DD`. */
  date_of_birth: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  qualification: string | null;
  specialization: string | null;
  /** `DECIMAL(5, 2)`, a number with `decimalNumbers` on — the list's note on the union applies. */
  experience_years: number | string | null;
  /** `DATEONLY`, NOT NULL. */
  joining_date: string;
  /** `money()`. Read only for a holder of `teachers.manage` — see the header. */
  salary: number | null;
  designation: string | null;
  is_active: boolean;
  /** `DATE` — an instant, unlike the two above. See `leftOn()`. */
  left_at: string | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  user_id: number | null;
}

/** One `teacher_subjects` row, with the three `include`s `teachers.service.assignments()` adds. */
interface SubjectAssignment {
  id: number;
  subject_id: number;
  class_id: number | null;
  section_id: number | null;
  is_primary: boolean;
  is_active: boolean;
  subject: { id: number; name: string; code: string; type: string } | null;
  class: { id: number; name: string } | null;
  section: { id: number; name: string } | null;
}

/** `classTeacherOf` and `sectionTeacherOf` are flat — `findAll` with `attributes`, no `include`. */
interface ClassTeacherOf {
  id: number;
  name: string;
  is_active: boolean;
}

interface SectionTeacherOf {
  id: number;
  name: string;
  class_id: number;
  is_active: boolean;
}

interface Assignments {
  subjects: SubjectAssignment[];
  classTeacherOf: ClassTeacherOf[];
  sectionTeacherOf: SectionTeacherOf[];
}

/** One row of the class-teacher table — a whole class, or one section of one. */
interface ClassTeacherLine {
  key: string;
  className: string | null;
  sectionName: string | null;
  is_active: boolean;
}

/** `''` for a null column, so an untouched control does not post a value it never had. */
const text = (value: string | null | undefined) => value ?? '';
const num = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));

/** `''` → `null` for a nullable column: clearing a field means clearing the value. */
const orNull = (value: string) => (value.trim() ? value.trim() : null);

/** The stored object as the textarea shows it — and as the save compares it. */
function metadataText(value: Record<string, unknown> | null): string {
  return value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : '';
}

/** `male` → `Male`. */
function humanise(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

/** `teachers.controller.js` `label()` — the name the activity log writes, composed the same way. */
function fullName(row: Teacher): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ');
}

/**
 * The day a teacher left, as it was entered.
 *
 * `left_at` is a `DATE`, not a `DATEONLY`, and it arrives as an instant. But every writer sends a
 * calendar day — `DeactivateDialog` posts `YYYY-MM-DD`, which Joi reads as UTC midnight — so the UTC
 * day of the stored instant **is** the day that was entered. `localDay()` would be wrong here in the
 * other direction: west of Greenwich it would show the day before.
 */
function leftOn(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

function seed(row: Teacher) {
  return {
    employee_id: row.employee_id,
    first_name: row.first_name,
    last_name: text(row.last_name),
    joining_date: row.joining_date.slice(0, 10),
    designation: text(row.designation),
    qualification: text(row.qualification),
    specialization: text(row.specialization),
    /* `String(Number('7.50'))` is `'7.5'` — the storage precision means nothing to a reader. */
    experience_years:
      row.experience_years === null || row.experience_years === '' ? '' : String(Number(row.experience_years)),
    salary: num(row.salary),
    gender: text(row.gender),
    date_of_birth: row.date_of_birth ? row.date_of_birth.slice(0, 10) : '',
    email: text(row.email),
    phone: text(row.phone),
    address: text(row.address),
    user_id: num(row.user_id),
    notes: text(row.notes),
    metadata: metadataText(row.metadata),
    reason: '',
  };
}

type Values = ReturnType<typeof seed>;

export default function TeacherDetailPage() {
  const params = useParams<{ id: string }>();
  const { can } = useAuth();
  const { success } = useToast();

  const teacherId = params.id;
  /* `teachers.manage` is what `PATCH /teachers/:id` is mounted behind. */
  const canManage = can('teachers.manage');

  const [teacher, setTeacher] = useState<Teacher | null>(null);
  const [assignments, setAssignments] = useState<Assignments | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const [values, setValues] = useState<Values | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveRefusal, setSaveRefusal] = useState<Refusal | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /*
   * The record and its assignments settle together on the first load, as `subjects/[id]`'s do: both
   * are behind the same guard, and a half-drawn record is worse than a moment of skeleton.
   */
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setRefusal(null);

    (async () => {
      try {
        const [one, taught] = await Promise.all([
          api.get<{ teacher: Teacher }>(`/teachers/${teacherId}`, { signal: controller.signal }),
          api.get<Assignments>(`/teachers/${teacherId}/assignments`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setTeacher(one.teacher);
        setValues(seed(one.teacher));
        setAssignments({
          subjects: taught.subjects ?? [],
          classTeacherOf: taught.classTeacherOf ?? [],
          sectionTeacherOf: taught.sectionTeacherOf ?? [],
        });
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setLoadError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setLoadError(NETWORK_FAILURE);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [teacherId, attempt]);

  /*
   * Re-read the record alone, after something outside the form changed it — a login created from the
   * Login section. Only `user_id` is carried into the form: re-seeding everything would discard what
   * is being typed, and leaving the old empty `user_id` would make the next save unlink the login
   * that was just created.
   */
  const refreshTeacher = useCallback(async () => {
    try {
      const one = await api.get<{ teacher: Teacher }>(`/teachers/${teacherId}`);
      setTeacher(one.teacher);
      setValues((prev) => (prev ? { ...prev, user_id: num(one.teacher.user_id) } : prev));
    } catch {
      /* The change itself succeeded and said so; the record catches up on the next visit. */
    }
  }, [teacherId]);

  const { linked, reload: reloadLinked, replace: replaceLinked } = useLinkedAccount(teacher?.user_id ?? null);

  /*
   * A section's class is a bare `class_id` — `sectionTeacherOf` has no `include`. Usually the class is
   * already named elsewhere in the same payload; only when it is not is the class list read, and only
   * for somebody holding `classes.view`, which the Librarian and the Organization Admin do not.
   */
  const payloadClassNames = useMemo(() => {
    const names = new Map<number, string>();
    for (const row of assignments?.classTeacherOf ?? []) names.set(row.id, row.name);
    for (const row of assignments?.subjects ?? []) if (row.class) names.set(row.class.id, row.class.name);
    return names;
  }, [assignments]);
  const needsClassList = (assignments?.sectionTeacherOf ?? []).some((row) => !payloadClassNames.has(row.class_id));
  const { classes: classList } = useClassSections('', needsClassList && can('classes.view'));

  const classTeacherLines = useMemo<ClassTeacherLine[]>(() => {
    const listed = classList.state === 'ready' ? classList.rows : [];
    const nameOf = (id: number) => payloadClassNames.get(id) ?? listed.find((row) => row.id === id)?.name ?? null;
    return [
      ...(assignments?.classTeacherOf ?? []).map((row) => ({
        key: `class-${row.id}`,
        className: row.name,
        sectionName: null,
        is_active: row.is_active,
      })),
      ...(assignments?.sectionTeacherOf ?? []).map((row) => ({
        key: `section-${row.id}`,
        className: nameOf(row.class_id),
        sectionName: row.name,
        is_active: row.is_active,
      })),
    ];
  }, [assignments, payloadClassNames, classList]);

  const canViewSubjects = can('subjects.view');

  const subjectColumns = useMemo<Column<SubjectAssignment>[]>(
    () => [
      {
        key: 'subject',
        header: 'Subject',
        primary: true,
        /* A link for somebody who can open the subject, which is also where this assignment is changed. */
        cell: (row) =>
          row.subject ? (
            canViewSubjects ? (
              <Link
                href={`/school/subjects/${row.subject.id}`}
                className="font-medium text-brand-text underline-offset-4 hover:underline"
              >
                {row.subject.name}
              </Link>
            ) : (
              <span className="font-medium">{row.subject.name}</span>
            )
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      {
        key: 'code',
        header: 'Code',
        cell: (row) => (row.subject ? <code className="text-xs text-muted">{row.subject.code}</code> : null),
      },
      {
        key: 'class',
        header: 'Class',
        /* A null class is school-wide — the subject screen words it the same way. */
        cell: (row) => row.class?.name ?? <span className="text-muted-soft">Any class</span>,
      },
      {
        key: 'section',
        header: 'Section',
        cell: (row) => row.section?.name ?? <span className="text-muted-soft">All sections</span>,
      },
      {
        key: 'primary',
        header: 'Primary',
        cell: (row) =>
          row.is_primary ? (
            <span className="inline-flex items-center gap-1 text-sm text-brand-text">
              <Icon name="check" size={14} />
              Primary
            </span>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} />,
      },
    ],
    [canViewSubjects]
  );

  const classTeacherColumns = useMemo<Column<ClassTeacherLine>[]>(
    () => [
      {
        key: 'class',
        header: 'Class',
        primary: true,
        /*
         * Unnamed only when the class is outside this payload and the class list could not be read
         * for this account — a recorded class this screen cannot put a name to, not a missing one.
         */
        cell: (row) =>
          row.className ? (
            <span className="font-medium">{row.className}</span>
          ) : (
            <span className="text-muted-soft">Not named for this account</span>
          ),
      },
      {
        key: 'section',
        header: 'Section',
        cell: (row) => row.sectionName ?? <span className="text-muted-soft">Whole class</span>,
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} />,
      },
    ],
    []
  );

  /*
   * The list's two lifecycle actions, on the record. `perform` keeps the server's copy of the row so
   * the status line moves at once — without re-running the whole load, which would put the page back
   * to its skeleton and re-seed the form over anything typed into it.
   *
   * `onDone` re-reads the linked login, because the same PATCH moved it too — the owner's decision D19:
   * deactivating the teacher takes an active Teacher login to `inactive` in the same transaction, and
   * reactivating restores one that is `inactive` (a suspended one stays suspended). The record's
   * `user_id` does not change, so nothing else would make the Login section read it again.
   */
  const deactivate = useRowAction<Teacher, string | null>({
    perform: async (row, leftAt) => {
      const body = await api.patch<{ teacher: Teacher }>(`/teachers/${row.id}`, { is_active: false, left_at: leftAt });
      setTeacher(body.teacher);
    },
    success: (row) => `${fullName(row)} deactivated`,
    failure: 'Could not deactivate that teacher',
    onDone: reloadLinked,
  });

  const reactivate = useRowAction<Teacher>({
    perform: async (row) => {
      const body = await api.patch<{ teacher: Teacher }>(`/teachers/${row.id}`, { is_active: true, left_at: null });
      setTeacher(body.teacher);
    },
    success: (row) => `${fullName(row)} reactivated`,
    failure: 'Could not reactivate that teacher',
    onDone: reloadLinked,
  });

  const set = (key: keyof Values) => (event: { target: { value: string } }) =>
    setValues((prev) => (prev ? { ...prev, [key]: event.target.value } : prev));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    /* Unreachable without the permission — no Save, every field disabled — and kept that way. */
    if (!canManage || !teacher || !values) return;
    setSaving(true);
    setError(null);
    setSaveRefusal(null);
    setFieldErrors({});

    const stored = seed(teacher);
    const body: Record<string, unknown> = {
      employee_id: values.employee_id.trim(),
      first_name: values.first_name.trim(),
      last_name: orNull(values.last_name),
      joining_date: values.joining_date,
      designation: orNull(values.designation),
      qualification: orNull(values.qualification),
      specialization: orNull(values.specialization),
      experience_years: orNull(values.experience_years),
      salary: orNull(values.salary),
      /* See the header: omitted when blank, because the schema has no null for it. */
      ...(values.gender ? { gender: values.gender } : {}),
      date_of_birth: values.date_of_birth || null,
      email: orNull(values.email),
      phone: orNull(values.phone),
      address: orNull(values.address),
      notes: orNull(values.notes),
      reason: values.reason.trim() || undefined,
    };

    /* See the header: only a link somebody actually moved. */
    if (values.user_id !== stored.user_id) {
      body.user_id = values.user_id ? Number(values.user_id) : null;
    }

    if (values.metadata !== stored.metadata) {
      if (!values.metadata.trim()) {
        body.metadata = null;
      } else {
        /* A transport concern, as on the create screen: the text has to become an object to be JSON at all. */
        try {
          body.metadata = JSON.parse(values.metadata) as unknown;
        } catch {
          setFieldErrors({
            metadata: 'This is not valid JSON. A JSON object looks like {"timetable_code": "PHY-A"}.',
          });
          focusFirstInvalidField();
          setSaving(false);
          return;
        }
      }
    }

    try {
      const result = await api.patch<{ teacher: Teacher }>(`/teachers/${teacher.id}`, body);
      setTeacher(result.teacher);
      /* Re-seeded from what was stored: the server lowercases the email and trims every string. */
      setValues(seed(result.teacher));
      success('Teacher updated');
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setError(NETWORK_FAILURE);
        return;
      }
      if (EXPLAINED_CODES.has(caught.code)) {
        setSaveRefusal({ code: caught.code, message: caught.message });
        return;
      }
      /*
       * `TEACHER_EMPLOYEE_ID_TAKEN` and `TEACHER_USER_TAKEN` send an object where the field list goes;
       * `ApiError` drops it, and their own sentence reaches the banner through `splitApiErrors`.
       */
      const { perField, banner } = splitApiErrors(caught, FORM_FIELDS);
      setFieldErrors(perField);
      setError(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setSaving(false);
    }
  }

  if (refusal) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Teacher" />
        <RefusalNotice refusal={refusal} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Teacher" />
        <ErrorNotice message={loadError} onRetry={reload} />
      </div>
    );
  }

  if (loading || !teacher || !values || !assignments) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Teacher" />
        <LoadingBlock />
      </div>
    );
  }

  const name = fullName(teacher);
  const departed = leftOn(teacher.left_at);
  const nothingAssigned =
    assignments.subjects.length === 0
    && assignments.classTeacherOf.length === 0
    && assignments.sectionTeacherOf.length === 0;

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={name}
        description={`Employee ID ${teacher.employee_id}. Joined ${teacher.joining_date.slice(0, 10)}.`}
        action={
          <Link href="/school/teachers" className="btn btn-secondary">
            <Icon name="chevron-left" size={15} />
            All teachers
          </Link>
        }
      />

      {/*
        * The employment status, and the one pair of controls that moves it. See the header: shown
        * rather than put on the form, because it is set together with a leaving date.
        */}
      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm text-muted">
        <StatusBadge status={teacher.is_active ? 'active' : 'inactive'} />
        <span>
          {teacher.is_active
            ? 'Counted against the teacher allowance.'
            : departed
              ? `Left on ${departed}. Not counted against the teacher allowance.`
              : 'Not counted against the teacher allowance.'}
        </span>
        {canManage ? (
          <button
            type="button"
            onClick={() => (teacher.is_active ? deactivate.ask(teacher) : reactivate.ask(teacher))}
            className="btn btn-ghost btn-sm"
          >
            {teacher.is_active ? 'Deactivate' : 'Reactivate'}
          </button>
        ) : null}
      </div>

      {saveRefusal ? <RefusalNotice refusal={saveRefusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {/* Said once, so a disabled form does not read as a broken one. See the header. */}
      {!canManage ? (
        <Notice tone="info">
          You can view this teacher but not change the record — editing teachers needs a permission this
          account does not hold.
        </Notice>
      ) : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="Employment"
          description="The teacher’s position at the school and the terms of their appointment."
        >
          <Field
            id="employee_id"
            label="Employee ID"
            required
            disabled={!canManage}
            maxLength={60}
            value={values.employee_id}
            onChange={set('employee_id')}
            error={fieldErrors.employee_id}
            hint="Unique within this school — the identifier on the payroll line or the ID card."
          />
          <Field
            id="first_name"
            label="First name"
            required
            disabled={!canManage}
            maxLength={90}
            value={values.first_name}
            onChange={set('first_name')}
            error={fieldErrors.first_name}
          />
          <Field
            id="last_name"
            label="Last name"
            disabled={!canManage}
            maxLength={90}
            value={values.last_name}
            onChange={set('last_name')}
            error={fieldErrors.last_name}
            hint="Optional — the column is nullable, and the Teachers list joins the two names without leaving a gap."
          />
          <Field
            id="joining_date"
            label="Joining date"
            type="date"
            required
            disabled={!canManage}
            value={values.joining_date}
            onChange={set('joining_date')}
            error={fieldErrors.joining_date}
            hint="SRS §15.3’s Joining Date. A plain date, with no time of day."
          />
          <Field
            id="designation"
            label="Designation"
            disabled={!canManage}
            maxLength={120}
            value={values.designation}
            onChange={set('designation')}
            error={fieldErrors.designation}
            /* `?designation=` is an equality in `teachers.service.list()`, not a `LIKE`. */
            hint="The job title — Head of Department, Senior Teacher. Matched exactly when filtered, so keep the wording consistent between records."
          />
          <Field
            id="qualification"
            label="Qualification"
            disabled={!canManage}
            maxLength={255}
            value={values.qualification}
            onChange={set('qualification')}
            error={fieldErrors.qualification}
            hint="SRS §15.3’s Qualification — the degrees, as they should read on a profile."
          />
          <Field
            id="specialization"
            label="Specialization"
            disabled={!canManage}
            maxLength={160}
            value={values.specialization}
            onChange={set('specialization')}
            error={fieldErrors.specialization}
            hint="The subject area this teacher teaches; this is the column the Teachers list shows."
          />
          <Field
            id="experience_years"
            label="Years of experience"
            type="text"
            inputMode="decimal"
            disabled={!canManage}
            value={values.experience_years}
            onChange={set('experience_years')}
            error={fieldErrors.experience_years}
            hint="0 to 80, to two decimal places. Blank leaves it unrecorded rather than zero."
          />
          {canManage ? (
            <Field
              id="salary"
              label="Salary"
              type="text"
              inputMode="decimal"
              value={values.salary}
              onChange={set('salary')}
              error={fieldErrors.salary}
              hint="Two decimal places, digits only. Feeds the Salaries expense category in §18. Blank leaves it unrecorded rather than zero."
            />
          ) : null}
        </FormSection>

        <FormSection title="Personal details" description="Profile information held on the record." columns={2}>
          <SelectField
            id="gender"
            label="Gender"
            disabled={!canManage}
            value={values.gender}
            onChange={set('gender')}
            error={fieldErrors.gender}
            hint="Once set this cannot be returned to “not recorded” — the schema accepts the three values and nothing else."
          >
            <option value="">Not recorded</option>
            {GENDERS.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>
          <Field
            id="date_of_birth"
            label="Date of birth"
            type="date"
            disabled={!canManage}
            value={values.date_of_birth}
            onChange={set('date_of_birth')}
            error={fieldErrors.date_of_birth}
          />
        </FormSection>

        <FormSection title="Contact" description="How the school reaches the teacher.">
          <Field
            id="email"
            label="Email"
            type="email"
            disabled={!canManage}
            maxLength={180}
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
            hint="Stored in lower case. This is the profile address, not the login — the login has its own, in the Login section below."
          />
          <Field
            id="phone"
            label="Phone"
            disabled={!canManage}
            maxLength={40}
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
          />
          <Field
            id="address"
            label="Address"
            disabled={!canManage}
            maxLength={255}
            value={values.address}
            onChange={set('address')}
            error={fieldErrors.address}
          />
        </FormSection>

        {/* The link is a teacher column and a manager's edit; a reader sees the login itself below. */}
        {canManage ? (
          <FormSection
            title="Sign-in account"
            description="Which existing login is this teacher’s. It is what makes the teacher dashboard answer for them."
          >
            <LinkedAccountField
              value={values.user_id}
              onChange={(next) => setValues((prev) => (prev ? { ...prev, user_id: next } : prev))}
              error={fieldErrors.user_id}
              stored={linked.state === 'ready' ? linked.account : null}
              noun="teacher"
            />
          </FormSection>
        ) : null}

        <FormSection title="Internal notes" description="Kept on the record.">
          <TextAreaField
            id="notes"
            label="Notes"
            rows={4}
            disabled={!canManage}
            maxLength={2000}
            value={values.notes}
            onChange={set('notes')}
            error={fieldErrors.notes}
          />
          <TextAreaField
            id="metadata"
            label="Metadata"
            rows={3}
            disabled={!canManage}
            value={values.metadata}
            onChange={set('metadata')}
            placeholder='{"timetable_code": "PHY-A"}'
            error={fieldErrors.metadata}
            hint="A JSON object, for something outside the system that needs to find this record by a reference of its own. Clear it to remove it."
          />
          {/* A reason explains an edit, and a reader makes none. */}
          {canManage ? (
            <Field
              id="reason"
              label="Reason"
              maxLength={255}
              value={values.reason}
              onChange={set('reason')}
              error={fieldErrors.reason}
              hint="Recorded against this edit's audit entry rather than on the teacher. Optional."
            />
          ) : null}
        </FormSection>

        <FormActions cancelHref="/school/teachers" cancelLabel="Back to teachers">
          {canManage ? (
            <SubmitButton busy={saving} busyLabel="Saving…" fullWidth={false}>
              Save changes
            </SubmitButton>
          ) : null}
        </FormActions>
      </form>

      {/* ─────────────── the login, outside the form ─────────────── */}

      <LinkedLoginPanel
        noun="teacher"
        linked={linked}
        onRetry={reloadLinked}
        onStatusSaved={replaceLinked}
        createTarget={
          teacher.is_active
            ? { role: 'teacher', person: name, profileId: teacher.id, email: teacher.email }
            : null
        }
        onCreated={() => void refreshTeacher()}
      />

      {/* ─────────────── FR-TEACHER-001's "Subjects and Classes" ─────────────── */}

      <section aria-labelledby="teaching-heading" className="mt-12 border-t border-border-soft pt-8">
        <div className="mb-4 max-w-2xl">
          <h2 id="teaching-heading" className="text-base font-semibold tracking-tight text-ink">
            Subjects and classes
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            What this teacher teaches, and the classes they look after. A teacher is assigned to a
            subject on{' '}
            {canViewSubjects ? (
              <Link href="/school/subjects" className="text-brand-text underline-offset-4 hover:underline">
                the subject&apos;s own screen
              </Link>
            ) : (
              'the subject’s own screen'
            )}
            , and chosen as class teacher on{' '}
            {can('classes.view') ? (
              <Link href="/school/classes" className="text-brand-text underline-offset-4 hover:underline">
                the class
              </Link>
            ) : (
              'the class'
            )}
            ; this record reads both and writes neither.
          </p>
        </div>

        {nothingAssigned ? (
          <EmptyNotice>No subject or class is assigned to this teacher yet.</EmptyNotice>
        ) : (
          <div className="space-y-8">
            {assignments.subjects.length > 0 ? (
              <DataTable
                columns={subjectColumns}
                rows={assignments.subjects}
                rowKey={(row) => row.id}
                caption="Subjects this teacher teaches"
              />
            ) : (
              <p className="text-sm text-muted">No subject is assigned to this teacher yet.</p>
            )}

            {classTeacherLines.length > 0 ? (
              <div>
                <h3 className="mb-3 text-sm font-semibold text-ink">Class teacher of</h3>
                <DataTable
                  columns={classTeacherColumns}
                  rows={classTeacherLines}
                  rowKey={(row) => row.key}
                  caption="Classes and sections this teacher is class teacher of"
                />
              </div>
            ) : (
              <p className="text-sm text-muted">This teacher is not class teacher of any class or section.</p>
            )}
          </div>
        )}
      </section>

      <DeactivateDialog
        open={deactivate.target !== null}
        person={deactivate.target ? fullName(deactivate.target) : null}
        noun="teacher"
        allowance="teacher allowance"
        busy={deactivate.busy}
        conflict={deactivate.conflict}
        onCancel={deactivate.cancel}
        onConfirm={(date) => deactivate.confirm(date)}
      />

      <ReactivateDialog
        open={reactivate.target !== null}
        person={reactivate.target ? fullName(reactivate.target) : null}
        noun="teacher"
        allowance="teacher allowance"
        busy={reactivate.busy}
        conflict={reactivate.conflict}
        onCancel={reactivate.cancel}
        onConfirm={() => reactivate.confirm()}
      />
    </div>
  );
}
