'use client';

/**
 * One subject — SRS §14.4 "Subject Creation" (FR-SCHOOL-004), and the four routes that had no caller.
 *
 * ## Why this screen exists
 *
 * `subjects.routes.js` mounts eleven routes. The list screen reached one of them and the create form
 * reached a second; the other nine were unreachable from anywhere in the product. So a subject could
 * be created and then never renamed, never corrected, never activated, never deleted, and never
 * attached to the class or the teacher that teaches it — which is what
 * `POST /subjects/:id/classes` and `POST /subjects/:id/teachers` exist for, and what the create
 * form's own docblock says needs "the subject to exist first".
 *
 * The `is_active` flag was the sharpest edge: the create form tells the operator to leave it off for
 * a subject "entered ahead of a session it is not yet taught in", and there was no screen anywhere
 * that could later turn it on. This is that screen.
 *
 * ## Three panels, because there are three different things on this record
 *
 * The subject's own columns are a form. The class assignments and the teacher assignments are
 * **collections** with their own POST and DELETE, their own referential rules, and their own empty
 * states — `class_subjects` and `teacher_subjects` are separate tables, and a subject taught in a
 * class is a different fact from a teacher qualified to teach it.
 *
 * ## What the two assignment forms do *not* filter
 *
 * The teacher picker is not narrowed to teachers already assigned to the class, and the class picker
 * is not narrowed by session. `subjects.service.js` checks each reference independently — the class
 * belongs to this school, the teacher belongs to this school — and requires nothing of them
 * together. Filtering here would enforce a rule the module does not have and would make a legitimate
 * assignment uncreatable. Inactive rows are annotated rather than withheld, the way every other
 * picker in this product annotates them.
 *
 * ## Deleting a subject is offered, and is the one destructive control here
 *
 * `subjects` carries no `deleted_at` — `modelOptions()` without `softDeleteOptions()` — so
 * `DELETE /subjects/:id` is a real delete, which is why it sits behind a confirmation whose copy
 * says so rather than saying "this cannot be undone". A subject with class or teacher assignments or
 * exam papers against it is refused with a 409 `SUBJECT_IN_USE` whose `details.blocking` counts each
 * — kept on `ApiError.context`. The dialog then names what is holding the subject, says to deactivate
 * it instead (which the form above offers), and withdraws the delete button: pressing it again could
 * only be refused identically. That is why it is a `Modal` of its own rather than `ConfirmDialog`,
 * whose confirm button cannot be disabled.
 *
 * ## Somebody who can only read gets a record, not a form
 *
 * The routes put every write behind `subjects.manage`, and a teacher holds `subjects.view` alone —
 * but the list links every name here, so a teacher used to land on an editable form whose Save could
 * only answer 403. Without the permission the fields are disabled and there is no Save.
 *
 * ## Assigning or removing refreshes the two lists, not the page
 *
 * Both used to call the page's own reload, which put the whole screen back to its skeleton and then
 * re-seeded the subject's form from the server — discarding anything typed into it and not yet saved.
 * They now re-read only the two assignment lists, dimming the tables in place meanwhile.
 */

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { useRowAction } from '@/lib/useRowAction';
import {
  CheckboxField,
  Field,
  FormActions,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { ConfirmDialog, Modal } from '@/components/overlay';
import { Icon, Spinner } from '@/components/icon';
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

/**
 * `SUBJECT_TYPES` from `subjects.validation.js`, worded as the create form words them. There is no
 * `SUBJECT_*` entry in `config/constants.js` — the enum lives in the model and the schema.
 */
const TYPES: { value: string; label: string }[] = [
  { value: 'theory', label: 'Theory' },
  { value: 'practical', label: 'Practical' },
  { value: 'both', label: 'Theory & practical' },
];

/** `PAGINATION.MAX_LIMIT` — the most one page of a picker list can hold. */
const OPTION_LIMIT = 100;

interface Subject {
  id: number;
  name: string;
  code: string;
  type: string;
  is_elective: boolean;
  is_active: boolean;
  description: string | null;
}

/** A named row on an assignment, as the endpoint's `include` returns it. */
interface Named {
  id: number;
  name: string;
}

interface TeacherNamed {
  id: number;
  employee_id: string;
  first_name: string;
  last_name: string | null;
}

/** One `class_subjects` row. */
interface ClassAssignment {
  id: number;
  class_id: number;
  section_id: number | null;
  teacher_id: number | null;
  full_marks: number | null;
  passing_marks: number | null;
  weekly_periods: number | null;
  is_active: boolean;
  class?: Named | null;
  section?: Named | null;
  teacher?: TeacherNamed | null;
}

/** One `teacher_subjects` row. */
interface TeacherAssignment {
  id: number;
  teacher_id: number;
  class_id: number | null;
  section_id: number | null;
  is_primary: boolean;
  is_active: boolean;
  teacher?: TeacherNamed | null;
  class?: Named | null;
  section?: Named | null;
}

interface ClassOption {
  id: number;
  name: string;
  is_active: boolean;
  sections?: { id: number; name: string; is_active: boolean }[];
}

interface TeacherOption {
  id: number;
  employee_id: string;
  first_name: string;
  last_name: string | null;
  is_active: boolean;
}

function teacherLabel(teacher: TeacherNamed | TeacherOption): string {
  const name = [teacher.first_name, teacher.last_name].filter(Boolean).join(' ');
  return `${name} (${teacher.employee_id})`;
}

/** An absent optional field, drawn so it reads as "nothing recorded" rather than as a value. */
function Blank() {
  return <span className="text-muted-soft">—</span>;
}

/** A number for the body, or the raw text when it is not one — the create screens' convention. */
function numeric(text: string): number | string | undefined {
  if (!text.trim()) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : text;
}

const NETWORK_FAILURE = 'Could not reach the server. Check your connection and try again.';

/*
 * The inputs each form renders, for `splitApiErrors`. A 422 naming anything else — `school_id` from
 * `resolveSchool()`, `body` from a rethrown foreign key, a model validator's own name — used to be
 * filed under a key no input draws, and the non-empty map then hid the banner too: a rejected submit
 * that showed nothing at all.
 */
const SUBJECT_FIELDS = new Set(['name', 'code', 'type', 'description', 'is_elective', 'is_active', 'reason']);
const CLASS_ASSIGN_FIELDS = new Set([
  'class_id',
  'section_id',
  'teacher_id',
  'full_marks',
  'passing_marks',
  'weekly_periods',
]);
const TEACHER_ASSIGN_FIELDS = new Set(['teacher_id', 'class_id', 'section_id', 'is_primary']);

/**
 * `SUBJECT_IN_USE`'s `details.blocking`, as a sentence — `{ class_subjects: 2, exam_subjects: 1 }`
 * becomes "2 class assignments and 1 exam paper". The keys are `SUBJECT_DEPENDENTS`' table names in
 * `subjects.service.js`; one this does not know is left out rather than printed raw.
 */
function blockingSentence(blocking: unknown): string | null {
  if (!blocking || typeof blocking !== 'object') return null;
  const NOUNS: Record<string, [string, string]> = {
    class_subjects: ['class assignment', 'class assignments'],
    teacher_subjects: ['teacher assignment', 'teacher assignments'],
    exam_subjects: ['exam paper', 'exam papers'],
  };
  const parts = Object.entries(blocking as Record<string, unknown>)
    .filter(([table, count]) => NOUNS[table] && typeof count === 'number' && count > 0)
    .map(([table, count]) => `${count} ${NOUNS[table][count === 1 ? 0 : 1]}`);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * How a picker list failed, so each dialog can say which list and why.
 *
 * `'module'` is the one refusal worth naming: `teachers.routes.js` mounts
 * `requireModule(MODULES.TEACHERS)`, so a school whose plan leaves out the Teachers module is refused
 * the teacher list whatever this account holds. Anything else is a permission or a fault, and the
 * remedy — ask someone who can — is the same for both.
 */
type PickerFailure = 'module' | 'other' | null;

function pickerFailure(result: PromiseSettledResult<unknown>): PickerFailure {
  if (result.status === 'fulfilled') return null;
  const reason = result.reason;
  return reason instanceof ApiError && reason.code === 'MODULE_NOT_SUBSCRIBED' ? 'module' : 'other';
}

export default function SubjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useAuth();
  const { success, error: errorToast } = useToast();

  const subjectId = params.id;
  const canManage = can('subjects.manage');

  const [subject, setSubject] = useState<Subject | null>(null);
  const [classes, setClasses] = useState<ClassAssignment[]>([]);
  const [teachers, setTeachers] = useState<TeacherAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  /* The first load, and Try again after it failed — never an assignment change; see `refreshAssignments`. */
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /* The three reads settle together on the first load: the two assignment lists are panels of this
     record, not independent screens, and a half-rendered detail page is worse than a moment of
     skeleton. After that, only the two lists are ever re-read. */
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        const [one, klasses, staff] = await Promise.all([
          api.get<{ subject: Subject }>(`/subjects/${subjectId}`, { signal: controller.signal }),
          api.get<{ assignments: ClassAssignment[] }>(`/subjects/${subjectId}/classes`, {
            signal: controller.signal,
          }),
          api.get<{ assignments: TeacherAssignment[] }>(`/subjects/${subjectId}/teachers`, {
            signal: controller.signal,
          }),
        ]);
        if (controller.signal.aborted) return;
        setSubject(one.subject);
        setClasses(klasses.assignments ?? []);
        setTeachers(staff.assignments ?? []);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [subjectId, attempt]);

  /*
   * Re-read the two assignment lists and nothing else — see the header. The subject row is not
   * touched, so its form keeps whatever is being typed into it; the tables dim while this runs.
   */
  const [refreshing, setRefreshing] = useState(false);
  const refreshAssignments = useCallback(async () => {
    setRefreshing(true);
    try {
      const [klasses, staff] = await Promise.all([
        api.get<{ assignments: ClassAssignment[] }>(`/subjects/${subjectId}/classes`),
        api.get<{ assignments: TeacherAssignment[] }>(`/subjects/${subjectId}/teachers`),
      ]);
      setClasses(klasses.assignments ?? []);
      setTeachers(staff.assignments ?? []);
    } catch (caught) {
      /* The change itself succeeded and was toasted; only the re-read failed, so say that. */
      errorToast(
        'Could not refresh the assignments',
        caught instanceof ApiError ? caught.message : NETWORK_FAILURE
      );
    } finally {
      setRefreshing(false);
    }
  }, [subjectId, errorToast]);

  /* ── the subject's own fields ── */

  const [values, setValues] = useState({
    name: '',
    code: '',
    type: '',
    description: '',
    reason: '',
  });
  const [isElective, setIsElective] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* Seed the form from the record once it arrives, and again after every successful save. */
  useEffect(() => {
    if (!subject) return;
    setValues({
      name: subject.name,
      code: subject.code,
      type: subject.type,
      description: subject.description ?? '',
      reason: '',
    });
    setIsElective(subject.is_elective);
    setIsActive(subject.is_active);
  }, [subject]);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  async function onSave(event: FormEvent) {
    event.preventDefault();
    /* Unreachable without the permission — no Save, every field disabled — and kept that way on purpose. */
    if (!canManage) return;
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});

    try {
      /*
       * The whole editable set is sent, not a diff. `schemas.update` is `.min(1)` so a diff would
       * also be accepted, but computing one means deciding whether a field cleared to "" is a change
       * to null or no change at all — and getting that wrong silently drops an edit. Sending
       * everything makes the request say exactly what the form says.
       */
      const result = await api.patch<{ subject: Subject }>(`/subjects/${subjectId}`, {
        name: values.name,
        code: values.code,
        type: values.type || undefined,
        is_elective: isElective,
        is_active: isActive,
        description: values.description.trim() || null,
        reason: values.reason.trim() || undefined,
      });
      setSubject(result.subject);
      success('Subject updated');
    } catch (caught) {
      /* A failed `fetch` is not an ApiError; rethrowing it left the button idle and nothing said. */
      if (!(caught instanceof ApiError)) {
        setSaveError(NETWORK_FAILURE);
        return;
      }
      const { perField, banner } = splitApiErrors(caught, SUBJECT_FIELDS);
      setFieldErrors(perField);
      setSaveError(banner);
      if (Object.keys(perField).length) {
        focusFirstInvalidField();
      }
    } finally {
      setSaving(false);
    }
  }

  /* ── deleting the subject ── */

  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /*
   * The refusal, kept whole rather than as a bare message: "This subject is still in use" alone had
   * replaced the dialog's advice to deactivate, and said nothing about what was using it.
   */
  const [deleteRefusal, setDeleteRefusal] = useState<{ message: string; blocking: string | null } | null>(
    null
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function closeDelete() {
    if (deleteBusy) return;
    setDeleting(false);
    setDeleteRefusal(null);
    setDeleteError(null);
  }

  async function onDelete() {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.delete(`/subjects/${subjectId}`);
      success(`${subject?.name ?? 'Subject'} deleted`);
      router.replace('/school/subjects');
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setDeleteError(NETWORK_FAILURE);
      } else if (caught.status === 409) {
        /* `{ id, blocking }` — see the header. The remedy is to deactivate, which the form offers. */
        setDeleteRefusal({
          message: caught.message,
          blocking: blockingSentence(caught.context?.blocking),
        });
      } else {
        setDeleteError(caught.message);
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  /* ── the two assignment collections ── */

  const [pickers, setPickers] = useState<{
    classes: ClassOption[];
    teachers: TeacherOption[];
    classesFailed: PickerFailure;
    teachersFailed: PickerFailure;
  }>({ classes: [], teachers: [], classesFailed: null, teachersFailed: null });

  /*
   * Loaded once, and only for somebody who can act: a reader cannot open either form.
   *
   * `allSettled`, not `all` — the reasoning `lib/useTimetablePickers.ts` gives for its own four lists.
   * The grants are separate (`classes.view`, `teachers.view`) and the teacher list is behind the
   * Teachers module as well, so a school without that module was refused `/teachers` — and an `all`
   * let that one refusal empty the class list too, leaving "Assign to a class", which needs no
   * teacher at all, with nothing to choose from.
   */
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;

    (async () => {
      const [klasses, staff] = await Promise.allSettled([
        api.page<ClassOption[]>('/classes', { query: { limit: OPTION_LIMIT } }),
        api.page<TeacherOption[]>('/teachers', { query: { limit: OPTION_LIMIT } }),
      ]);
      if (cancelled) return;
      setPickers({
        classes: klasses.status === 'fulfilled' ? (klasses.value.data ?? []) : [],
        teachers: staff.status === 'fulfilled' ? (staff.value.data ?? []) : [],
        classesFailed: pickerFailure(klasses),
        teachersFailed: pickerFailure(staff),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [canManage]);

  const unassignClass = useRowAction<ClassAssignment>({
    perform: (row) => api.delete(`/subjects/${subjectId}/classes/${row.id}`),
    success: (row) => `Removed from ${row.class?.name ?? `class #${row.class_id}`}`,
    failure: 'Could not remove that class assignment',
    onDone: () => void refreshAssignments(),
  });

  const unassignTeacher = useRowAction<TeacherAssignment>({
    perform: (row) => api.delete(`/subjects/${subjectId}/teachers/${row.id}`),
    success: (row) => `${row.teacher ? teacherLabel(row.teacher) : 'Teacher'} unassigned`,
    failure: 'Could not remove that teacher assignment',
    onDone: () => void refreshAssignments(),
  });

  const [addingClass, setAddingClass] = useState(false);
  const [addingTeacher, setAddingTeacher] = useState(false);

  const classColumns = useMemo<Column<ClassAssignment>[]>(() => {
    const base: Column<ClassAssignment>[] = [
      {
        key: 'class',
        header: 'Class',
        primary: true,
        cell: (row) => (
          <span className="font-medium">{row.class?.name ?? `class #${row.class_id}`}</span>
        ),
      },
      {
        key: 'section',
        header: 'Section',
        /* Null means every section of the class, which is a real answer rather than a blank. */
        cell: (row) =>
          row.section?.name ?? <span className="text-muted-soft">All sections</span>,
      },
      {
        key: 'teacher',
        header: 'Teacher',
        cell: (row) => (row.teacher ? teacherLabel(row.teacher) : <Blank />),
      },
      {
        key: 'marks',
        header: 'Marks',
        numeric: true,
        hideOnMobile: true,
        cell: (row) =>
          row.full_marks === null ? (
            <Blank />
          ) : (
            <span className="tabular-nums">
              {row.passing_marks ?? '—'} / {row.full_marks}
            </span>
          ),
      },
      {
        key: 'periods',
        header: 'Periods',
        numeric: true,
        hideOnMobile: true,
        cell: (row) => row.weekly_periods ?? <Blank />,
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} />,
      },
    ];

    if (!canManage) return base;
    return [
      ...base,
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) => (
          <button
            type="button"
            onClick={() => unassignClass.ask(row)}
            className="btn btn-ghost btn-sm"
          >
            <Icon name="trash" size={14} />
            Remove
          </button>
        ),
      },
    ];
  }, [canManage, unassignClass]);

  const teacherColumns = useMemo<Column<TeacherAssignment>[]>(() => {
    const base: Column<TeacherAssignment>[] = [
      {
        key: 'teacher',
        header: 'Teacher',
        primary: true,
        cell: (row) => (
          <span className="font-medium">
            {row.teacher ? teacherLabel(row.teacher) : `teacher #${row.teacher_id}`}
          </span>
        ),
      },
      {
        key: 'class',
        header: 'Class',
        /* Null is school-wide — the teacher may teach this subject to any class. */
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
            <Blank />
          ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} />,
      },
    ];

    if (!canManage) return base;
    return [
      ...base,
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) => (
          <button
            type="button"
            onClick={() => unassignTeacher.ask(row)}
            className="btn btn-ghost btn-sm"
          >
            <Icon name="trash" size={14} />
            Remove
          </button>
        ),
      },
    ];
  }, [canManage, unassignTeacher]);

  if (refusal) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Subject" />
        <RefusalNotice refusal={refusal} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Subject" />
        <ErrorNotice message={error} onRetry={reload} />
      </div>
    );
  }

  if (loading || !subject) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Subject" />
        <LoadingBlock />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={subject.name}
        description={
          canManage
            ? `Subject code ${subject.code}. Edit the record, and set which classes it is taught in and which teachers can teach it.`
            : `Subject code ${subject.code}. The record, the classes it is taught in and the teachers who can teach it.`
        }
        action={
          <Link href="/school/subjects" className="btn btn-secondary">
            <Icon name="chevron-left" size={15} />
            All subjects
          </Link>
        }
      />

      {saveError ? <Notice tone="error">{saveError}</Notice> : null}
      {/* Said once, so a disabled form does not read as a broken one. See the header. */}
      {!canManage ? (
        <Notice tone="info">
          You can view this subject but not change it — editing subjects needs a permission this
          account does not hold.
        </Notice>
      ) : null}

      <form onSubmit={onSave} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The subject"
          description="What it is called, its code, and the kind of subject it is."
        >
          <Field
            id="name"
            label="Name"
            required
            disabled={!canManage}
            maxLength={120}
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="Up to 120 characters, e.g. Mathematics."
          />

          <Field
            id="code"
            label="Code"
            required
            disabled={!canManage}
            maxLength={40}
            value={values.code}
            onChange={set('code')}
            error={fieldErrors.code}
            hint="Up to 40 characters, unique within this school. Stored in upper case."
          />

          <SelectField
            id="type"
            label="Type"
            disabled={!canManage}
            value={values.type}
            onChange={set('type')}
            error={fieldErrors.type}
            hint="Whether the subject is taught as theory, as practical work, or as both."
          >
            {TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>

          <TextAreaField
            id="description"
            label="Description"
            rows={3}
            disabled={!canManage}
            maxLength={255}
            value={values.description}
            onChange={set('description')}
            error={fieldErrors.description}
            hint="Up to 255 characters. The only free text on the row, so it is what tells two similarly named subjects apart on the list."
          />
        </FormSection>

        <FormSection
          title="Options"
          description="Whether the subject is elective, and whether it is currently in use."
        >
          <CheckboxField
            id="is_elective"
            label="Elective"
            disabled={!canManage}
            checked={isElective}
            onChange={(event) => setIsElective(event.target.checked)}
            error={fieldErrors.is_elective}
            hint="An optional subject rather than one every student takes. Electives can be excluded from result aggregation."
          />

          <CheckboxField
            id="is_active"
            label="Active"
            disabled={!canManage}
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            error={fieldErrors.is_active}
            hint="Subjects are not soft-deleted, so this flag is the whole of a subject's lifecycle. This is where a subject entered ahead of its session is switched on."
          />
        </FormSection>

        {/* A reason explains an edit, and a reader makes none. */}
        {canManage ? (
          <FormSection
            title="Internal notes"
            description="Kept on the audit entry for this change."
          >
            <Field
              id="reason"
              label="Reason"
              maxLength={255}
              value={values.reason}
              onChange={set('reason')}
              error={fieldErrors.reason}
              hint="Up to 255 characters, recorded against this edit rather than on the subject. Optional."
            />
          </FormSection>
        ) : null}

        <FormActions
          cancelHref="/school/subjects"
          cancelLabel="Back to subjects"
          destructive={
            canManage ? (
              <button
                type="button"
                onClick={() => {
                  setDeleteRefusal(null);
                  setDeleteError(null);
                  setDeleting(true);
                }}
                className="btn btn-danger btn-lg w-full sm:w-auto"
              >
                <Icon name="trash" size={15} />
                Delete subject
              </button>
            ) : undefined
          }
        >
          {canManage ? (
            <SubmitButton busy={saving} busyLabel="Saving…" fullWidth={false}>
              Save changes
            </SubmitButton>
          ) : null}
        </FormActions>
      </form>

      {/* ─────────────── class assignments ─────────────── */}

      <section className="mt-12 border-t border-border-soft pt-8">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <h2 className="text-base font-semibold tracking-tight text-ink">Taught in</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              The classes this subject is taught in, with the marks it carries and how many periods
              a week it takes.
            </p>
          </div>
          {canManage ? (
            <button type="button" onClick={() => setAddingClass(true)} className="btn btn-primary">
              <Icon name="plus" size={15} />
              Assign to a class
            </button>
          ) : null}
        </div>

        {/*
          * This used to warn that an unassigned subject "will not appear on a timetable or in a mark
          * sheet", and the delete dialog that deactivating one takes it off new timetables. Neither is
          * so: `timetable.service.js` and `exams.service.js` check only that a subject belongs to the
          * school — not whether it is active, and not whether it is assigned to the class. The copy now
          * says what this list is, rather than what it prevents.
          */}
        {classes.length === 0 ? (
          <EmptyNotice>
            This subject is not assigned to any class yet. Assigning one records where it is taught
            and the marks it carries there.
          </EmptyNotice>
        ) : (
          <DataTable
            columns={classColumns}
            rows={classes}
            rowKey={(row) => row.id}
            caption="Class assignments"
            busy={refreshing}
          />
        )}
      </section>

      {/* ─────────────── teacher assignments ─────────────── */}

      <section className="mt-10 border-t border-border-soft pt-8">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <h2 className="text-base font-semibold tracking-tight text-ink">Taught by</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              The teachers qualified to teach it. A teacher with no class named may teach it to any
              class.
            </p>
          </div>
          {canManage ? (
            <button type="button" onClick={() => setAddingTeacher(true)} className="btn btn-primary">
              <Icon name="plus" size={15} />
              Assign a teacher
            </button>
          ) : null}
        </div>

        {teachers.length === 0 ? (
          <EmptyNotice>No teacher is assigned to this subject yet.</EmptyNotice>
        ) : (
          <DataTable
            columns={teacherColumns}
            rows={teachers}
            rowKey={(row) => row.id}
            caption="Teacher assignments"
            busy={refreshing}
          />
        )}
      </section>

      {/* ─────────────── the overlays ─────────────── */}

      <Modal
        open={deleting}
        onClose={closeDelete}
        title={`Delete ${subject.name}?`}
        description={
          deleteRefusal
            ? undefined
            : 'This subject has no deleted state — the row is removed outright. If it has been taught, deactivate it instead: the record, its assignments and its marks are all kept.'
        }
        size="sm"
        busy={deleteBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={deleteBusy}
              onClick={closeDelete}
            >
              {deleteRefusal ? 'Close' : 'Cancel'}
            </button>
            {/* Withdrawn once refused: a second press could only be refused identically. */}
            {deleteRefusal ? null : (
              <button
                type="button"
                className="btn btn-danger"
                disabled={deleteBusy}
                aria-busy={deleteBusy}
                onClick={() => void onDelete()}
              >
                {deleteBusy ? <Spinner size={14} /> : null}
                Delete subject
              </button>
            )}
          </>
        }
      >
        {deleteRefusal ? (
          <Notice tone="warn">
            {deleteRefusal.blocking
              ? `${subject.name} cannot be deleted: it still has ${deleteRefusal.blocking}.`
              : deleteRefusal.message}{' '}
            Deactivate it instead: untick Active above and save. The record, its assignments and its
            marks are all kept.
          </Notice>
        ) : deleteError ? (
          <Notice tone="error">{deleteError}</Notice>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={unassignClass.target !== null}
        onCancel={unassignClass.cancel}
        onConfirm={() => unassignClass.confirm()}
        title="Remove this class assignment?"
        description={
          unassignClass.conflict ??
          `${subject.name} will no longer be taught in ${
            unassignClass.target?.class?.name ?? 'that class'
          }. Marks already recorded are not affected.`
        }
        confirmLabel="Remove"
      />

      <ConfirmDialog
        open={unassignTeacher.target !== null}
        onCancel={unassignTeacher.cancel}
        onConfirm={() => unassignTeacher.confirm()}
        title="Remove this teacher assignment?"
        description={
          unassignTeacher.conflict ??
          `${
            unassignTeacher.target?.teacher
              ? teacherLabel(unassignTeacher.target.teacher)
              : 'That teacher'
          } will no longer be listed as able to teach ${subject.name}.`
        }
        confirmLabel="Remove"
      />

      <AssignClassDialog
        open={addingClass}
        subjectId={subjectId}
        subjectName={subject.name}
        classes={pickers.classes}
        teachers={pickers.teachers}
        classesFailed={pickers.classesFailed}
        teachersFailed={pickers.teachersFailed}
        onClose={() => setAddingClass(false)}
        onDone={() => {
          setAddingClass(false);
          success('Subject assigned to the class');
          /* Both lists: naming a teacher here adds a "Taught by" row too — see the dialog. */
          void refreshAssignments();
        }}
      />

      <AssignTeacherDialog
        open={addingTeacher}
        subjectId={subjectId}
        subjectName={subject.name}
        classes={pickers.classes}
        teachers={pickers.teachers}
        classesFailed={pickers.classesFailed}
        teachersFailed={pickers.teachersFailed}
        onClose={() => setAddingTeacher(false)}
        onDone={() => {
          setAddingTeacher(false);
          success('Teacher assigned to the subject');
          void refreshAssignments();
        }}
      />
    </div>
  );
}

/* ─────────────────────────────── assign to a class ─────────────────────────────── */

/**
 * `POST /subjects/:id/classes`.
 *
 * `class_id` is the only required field. The three numbers are optional on the schema and are sent
 * as typed rather than coerced, for the reason every create screen in this product gives: `Number('')`
 * is `0` and `Number('abc')` is `NaN`, and `NaN` serialises to `null` — which several of these
 * columns accept as a *meaning* rather than as "invalid".
 *
 * ## Passing marks above full marks arrives under a name no input has
 *
 * Joi checks each mark on its own; the comparison is `class_subjects`' model-level
 * `passingNotAboveFull()`, and `rethrow()` reports a model validator under **its own name** —
 * `field: "passingNotAboveFull"`. Handed to the fields as it came, that filled the error map with a key
 * nothing renders, the non-empty map suppressed the banner, and the likeliest mistake on this form
 * produced no message at all. It is moved onto Passing marks, where the mistake is.
 */
function AssignClassDialog({
  open,
  subjectId,
  subjectName,
  classes,
  teachers,
  classesFailed,
  teachersFailed,
  onClose,
  onDone,
}: {
  open: boolean;
  subjectId: string;
  subjectName: string;
  classes: ClassOption[];
  teachers: TeacherOption[];
  classesFailed: PickerFailure;
  teachersFailed: PickerFailure;
  onClose: () => void;
  onDone: () => void;
}) {
  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [fullMarks, setFullMarks] = useState('');
  const [passingMarks, setPassingMarks] = useState('');
  const [weeklyPeriods, setWeeklyPeriods] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setClassId('');
    setSectionId('');
    setTeacherId('');
    setFullMarks('');
    setPassingMarks('');
    setWeeklyPeriods('');
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [open]);

  /* The class list carries its own sections, so choosing a class needs no second request. */
  const sections = useMemo(
    () => classes.find((row) => String(row.id) === classId)?.sections ?? [],
    [classes, classId]
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      await api.post(`/subjects/${subjectId}/classes`, {
        class_id: numeric(classId),
        section_id: sectionId ? numeric(sectionId) : undefined,
        teacher_id: teacherId ? numeric(teacherId) : undefined,
        full_marks: numeric(fullMarks),
        passing_marks: numeric(passingMarks),
        weekly_periods: numeric(weeklyPeriods),
      });
      onDone();
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setFailure(NETWORK_FAILURE);
        return;
      }
      /* See the docblock: the model rule's own name is admitted, then moved to the field it is about. */
      const { perField, banner } = splitApiErrors(
        caught,
        new Set([...CLASS_ASSIGN_FIELDS, 'passingNotAboveFull'])
      );
      if (perField.passingNotAboveFull) {
        if (!perField.passing_marks) {
          perField.passing_marks = 'Passing marks cannot be more than the full marks.';
        }
        delete perField.passingNotAboveFull;
      }
      setFieldErrors(perField);
      setFailure(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Assign ${subjectName} to a class`}
      description="A section is optional — leave it unset and the subject applies to the whole class."
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="assign-class" busy={busy} busyLabel="Assigning…">
            Assign
          </SubmitButton>
        </>
      }
    >
      <form id="assign-class" onSubmit={submit} className="space-y-4" noValidate>
        {failure ? <Notice tone="error">{failure}</Notice> : null}
        {/* Only the class list is essential here; a missing teacher list costs one optional field. */}
        {classesFailed ? (
          <Notice tone="warn">
            The class list could not be loaded, so there is no class to choose. Viewing classes is a
            separate permission from managing subjects — ask someone who holds it, or try again later.
          </Notice>
        ) : null}

        <SelectField
          id="class_id"
          label="Class"
          required
          value={classId}
          onChange={(event) => {
            setClassId(event.target.value);
            /* A section from the previous class is a guaranteed 422 the user cannot see coming. */
            setSectionId('');
          }}
          error={fieldErrors.class_id}
        >
          <option value="">Choose a class</option>
          {classes.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
              {row.is_active ? '' : ' — inactive'}
            </option>
          ))}
        </SelectField>

        <SelectField
          id="section_id"
          label="Section"
          value={sectionId}
          onChange={(event) => setSectionId(event.target.value)}
          error={fieldErrors.section_id}
          disabled={!classId}
          hint={classId ? undefined : 'Choose a class first.'}
        >
          <option value="">All sections</option>
          {sections.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
              {row.is_active ? '' : ' — inactive'}
            </option>
          ))}
        </SelectField>

        {/*
          * Naming a teacher here also adds them to "Taught by", and that is the server's doing, not
          * a second request from this dialog: `subjects.service.js` `assign()` calls
          * `upsertTeacherSubject()` when the body carries a `teacher_id`. Measured — one
          * `class_subjects` row and one `teacher_subjects` row from a single submit. The hint says so
          * because a panel gaining a row nobody asked for otherwise reads as a bug.
          */}
        <SelectField
          id="teacher_id"
          label="Teacher"
          value={teacherId}
          onChange={(event) => setTeacherId(event.target.value)}
          error={fieldErrors.teacher_id}
          disabled={teachersFailed !== null}
          hint={
            teachersFailed === 'module'
              ? 'The Teachers module is not part of this school’s plan, so no teacher can be named. The subject can still be assigned to the class.'
              : teachersFailed
                ? 'The teacher list could not be loaded, so nobody can be named here. The subject can still be assigned to the class.'
                : 'Optional. Who teaches this subject to this class — naming them here also lists them under “Taught by”.'
          }
        >
          <option value="">Nobody named</option>
          {teachers.map((row) => (
            <option key={row.id} value={row.id}>
              {teacherLabel(row)}
              {row.is_active ? '' : ' — inactive'}
            </option>
          ))}
        </SelectField>

        <Field
          id="full_marks"
          label="Full marks"
          type="number"
          min={0}
          value={fullMarks}
          onChange={(event) => setFullMarks(event.target.value)}
          error={fieldErrors.full_marks}
          /*
           * It used to say this total is "used when marks are entered for this class". It is not: an
           * exam paper carries its own full marks, and nothing in the exams module reads
           * `class_subjects`. Recorded on the assignment, and described as that.
           */
          hint="Optional. The subject's total in this class, recorded on the assignment. An exam paper sets its own full marks."
        />

        <Field
          id="passing_marks"
          label="Passing marks"
          type="number"
          min={0}
          value={passingMarks}
          onChange={(event) => setPassingMarks(event.target.value)}
          error={fieldErrors.passing_marks}
          hint="Optional, and must not exceed the full marks."
        />

        <Field
          id="weekly_periods"
          label="Periods a week"
          type="number"
          min={0}
          value={weeklyPeriods}
          onChange={(event) => setWeeklyPeriods(event.target.value)}
          error={fieldErrors.weekly_periods}
          hint="Optional. How many timetable slots this subject needs for the class."
        />
      </form>
    </Modal>
  );
}

/* ─────────────────────────────── assign a teacher ─────────────────────────────── */

/**
 * `POST /subjects/:id/teachers`.
 *
 * `teacher_id` is the only required field. `class_id` is `allow(null)` on this schema rather than
 * merely optional, and the difference is meaning: a teacher with no class named may teach the
 * subject to **any** class, which is a real answer and what the empty option says.
 */
function AssignTeacherDialog({
  open,
  subjectId,
  subjectName,
  classes,
  teachers,
  classesFailed,
  teachersFailed,
  onClose,
  onDone,
}: {
  open: boolean;
  subjectId: string;
  subjectName: string;
  classes: ClassOption[];
  teachers: TeacherOption[];
  classesFailed: PickerFailure;
  teachersFailed: PickerFailure;
  onClose: () => void;
  onDone: () => void;
}) {
  const [teacherId, setTeacherId] = useState('');
  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setTeacherId('');
    setClassId('');
    setSectionId('');
    setIsPrimary(false);
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [open]);

  const sections = useMemo(
    () => classes.find((row) => String(row.id) === classId)?.sections ?? [],
    [classes, classId]
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      await api.post(`/subjects/${subjectId}/teachers`, {
        teacher_id: numeric(teacherId),
        class_id: classId ? numeric(classId) : null,
        section_id: sectionId ? numeric(sectionId) : undefined,
        is_primary: isPrimary,
      });
      onDone();
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setFailure(NETWORK_FAILURE);
        return;
      }
      const { perField, banner } = splitApiErrors(caught, TEACHER_ASSIGN_FIELDS);
      setFieldErrors(perField);
      setFailure(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Assign a teacher to ${subjectName}`}
      description="Leave the class unset for a teacher who may teach this subject to any class."
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="assign-teacher" busy={busy} busyLabel="Assigning…">
            Assign
          </SubmitButton>
        </>
      }
    >
      <form id="assign-teacher" onSubmit={submit} className="space-y-4" noValidate>
        {failure ? <Notice tone="error">{failure}</Notice> : null}
        {/* The teacher is the one required choice here, so its list is the one worth a notice. */}
        {teachersFailed === 'module' ? (
          <Notice tone="warn">
            The Teachers module is not part of this school’s plan, so there is no teacher to assign.
          </Notice>
        ) : teachersFailed ? (
          <Notice tone="warn">
            The teacher list could not be loaded, so there is nobody to choose. Viewing teachers is a
            separate permission from managing subjects — ask someone who holds it, or try again later.
          </Notice>
        ) : null}

        <SelectField
          id="teacher_id"
          label="Teacher"
          required
          value={teacherId}
          onChange={(event) => setTeacherId(event.target.value)}
          error={fieldErrors.teacher_id}
        >
          <option value="">Choose a teacher</option>
          {teachers.map((row) => (
            <option key={row.id} value={row.id}>
              {teacherLabel(row)}
              {row.is_active ? '' : ' — inactive'}
            </option>
          ))}
        </SelectField>

        <SelectField
          id="class_id"
          label="Class"
          value={classId}
          onChange={(event) => {
            setClassId(event.target.value);
            setSectionId('');
          }}
          error={fieldErrors.class_id}
          disabled={classesFailed !== null}
          hint={
            classesFailed
              ? 'The class list could not be loaded, so the assignment can only be made for any class.'
              : 'Optional. Narrows the assignment to one class.'
          }
        >
          <option value="">Any class</option>
          {classes.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
              {row.is_active ? '' : ' — inactive'}
            </option>
          ))}
        </SelectField>

        <SelectField
          id="section_id"
          label="Section"
          value={sectionId}
          onChange={(event) => setSectionId(event.target.value)}
          error={fieldErrors.section_id}
          disabled={!classId}
          hint={classId ? undefined : 'Choose a class first.'}
        >
          <option value="">All sections</option>
          {sections.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
              {row.is_active ? '' : ' — inactive'}
            </option>
          ))}
        </SelectField>

        <CheckboxField
          id="is_primary"
          label="Primary teacher for this subject"
          checked={isPrimary}
          onChange={(event) => setIsPrimary(event.target.checked)}
          error={fieldErrors.is_primary}
          hint="Marks this teacher as the one responsible, where more than one can teach it."
        />
      </form>
    </Modal>
  );
}
