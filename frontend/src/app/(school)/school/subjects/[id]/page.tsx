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
 * `DELETE /subjects/:id` is a real delete, which is why it sits behind a `ConfirmDialog` whose copy
 * says so rather than saying "this cannot be undone". A subject with assignments or marks against it
 * is refused by the service with a 409, and that message is shown in the dialog: the answer to it is
 * to deactivate instead, which the form above already offers.
 */

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
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

/** `config/constants.js` SUBJECT_TYPES, worded as the create form words them. */
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

export default function SubjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const subjectId = params.id;
  const canManage = can('subjects.manage');

  const [subject, setSubject] = useState<Subject | null>(null);
  const [classes, setClasses] = useState<ClassAssignment[]>([]);
  const [teachers, setTeachers] = useState<TeacherAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /* The three reads settle together: the two assignment lists are panels of this record, not
     independent screens, and a half-rendered detail page is worse than a moment of skeleton. */
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
      if (!(caught instanceof ApiError)) throw caught;
      const perField = caught.fieldErrors();
      setFieldErrors(perField);
      setSaveError(Object.keys(perField).length ? null : caught.message);
      if (Object.keys(perField).length) {
        focusFirstInvalidField();
      }
    } finally {
      setSaving(false);
    }
  }

  /* ── deleting the subject ── */

  const [deleting, setDeleting] = useState(false);
  const [deleteConflict, setDeleteConflict] = useState<string | null>(null);

  async function onDelete() {
    setDeleteConflict(null);
    try {
      await api.delete(`/subjects/${subjectId}`);
      success(`${subject?.name ?? 'Subject'} deleted`);
      router.replace('/school/subjects');
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      /* 409 means something references it. The remedy is to deactivate, which the form offers. */
      setDeleteConflict(caught.message);
    }
  }

  /* ── the two assignment collections ── */

  const [pickers, setPickers] = useState<{
    classes: ClassOption[];
    teachers: TeacherOption[];
    failed: boolean;
  }>({ classes: [], teachers: [], failed: false });

  /* Loaded once, and only for somebody who can act: a reader cannot open either form. */
  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();

    (async () => {
      try {
        const [klasses, staff] = await Promise.all([
          api.page<ClassOption[]>('/classes', {
            query: { limit: OPTION_LIMIT },
            signal: controller.signal,
          }),
          api.page<TeacherOption[]>('/teachers', {
            query: { limit: OPTION_LIMIT },
            signal: controller.signal,
          }),
        ]);
        if (controller.signal.aborted) return;
        setPickers({ classes: klasses.data, teachers: staff.data, failed: false });
      } catch {
        if (!controller.signal.aborted) {
          setPickers({ classes: [], teachers: [], failed: true });
        }
      }
    })();

    return () => controller.abort();
  }, [canManage]);

  const unassignClass = useRowAction<ClassAssignment>({
    perform: (row) => api.delete(`/subjects/${subjectId}/classes/${row.id}`),
    success: (row) => `Removed from ${row.class?.name ?? `class #${row.class_id}`}`,
    failure: 'Could not remove that class assignment',
    onDone: reload,
  });

  const unassignTeacher = useRowAction<TeacherAssignment>({
    perform: (row) => api.delete(`/subjects/${subjectId}/teachers/${row.id}`),
    success: (row) => `${row.teacher ? teacherLabel(row.teacher) : 'Teacher'} unassigned`,
    failure: 'Could not remove that teacher assignment',
    onDone: reload,
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
        description={`Subject code ${subject.code}. Edit the record, and set which classes it is taught in and which teachers can teach it.`}
        action={
          <Link href="/school/subjects" className="btn btn-secondary">
            <Icon name="chevron-left" size={15} />
            All subjects
          </Link>
        }
      />

      {saveError ? <Notice tone="error">{saveError}</Notice> : null}

      <form onSubmit={onSave} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The subject"
          description="What it is called, its code, and the kind of subject it is."
        >
          <Field
            id="name"
            label="Name"
            required
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
            maxLength={40}
            value={values.code}
            onChange={set('code')}
            error={fieldErrors.code}
            hint="Up to 40 characters, unique within this school. Stored in upper case."
          />

          <SelectField
            id="type"
            label="Type"
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
            checked={isElective}
            onChange={(event) => setIsElective(event.target.checked)}
            error={fieldErrors.is_elective}
            hint="An optional subject rather than one every student takes. Electives can be excluded from result aggregation."
          />

          <CheckboxField
            id="is_active"
            label="Active"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
            error={fieldErrors.is_active}
            hint="Subjects are not soft-deleted, so this flag is the whole of a subject's lifecycle. This is where a subject entered ahead of its session is switched on."
          />
        </FormSection>

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

        <FormActions
          cancelHref="/school/subjects"
          cancelLabel="Back to subjects"
          destructive={
            canManage ? (
              <button
                type="button"
                onClick={() => setDeleting(true)}
                className="btn btn-danger btn-lg w-full sm:w-auto"
              >
                <Icon name="trash" size={15} />
                Delete subject
              </button>
            ) : undefined
          }
        >
          <SubmitButton busy={saving} busyLabel="Saving…" fullWidth={false}>
            Save changes
          </SubmitButton>
        </FormActions>
      </form>

      {/* ─────────────── class assignments ─────────────── */}

      <section className="mt-12 border-t border-border-soft pt-8">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <h2 className="text-base font-semibold tracking-tight text-ink">Taught in</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              The classes this subject is on the timetable for, with the marks it carries and how
              many periods a week it takes.
            </p>
          </div>
          {canManage ? (
            <button type="button" onClick={() => setAddingClass(true)} className="btn btn-primary">
              <Icon name="plus" size={15} />
              Assign to a class
            </button>
          ) : null}
        </div>

        {classes.length === 0 ? (
          <EmptyNotice>
            This subject is not assigned to any class yet, so it will not appear on a timetable or in
            a mark sheet.
          </EmptyNotice>
        ) : (
          <DataTable
            columns={classColumns}
            rows={classes}
            rowKey={(row) => row.id}
            caption="Class assignments"
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
          />
        )}
      </section>

      {/* ─────────────── the overlays ─────────────── */}

      <ConfirmDialog
        open={deleting}
        onCancel={() => {
          setDeleting(false);
          setDeleteConflict(null);
        }}
        onConfirm={onDelete}
        title={`Delete ${subject.name}?`}
        description={
          deleteConflict ??
          'This subject has no deleted state — the row is removed outright. If it has been taught, deactivate it instead: the record and its marks are kept, and it stops appearing on new timetables.'
        }
        confirmLabel="Delete subject"
      />

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
        pickersFailed={pickers.failed}
        onClose={() => setAddingClass(false)}
        onDone={() => {
          setAddingClass(false);
          success('Subject assigned to the class');
          reload();
        }}
      />

      <AssignTeacherDialog
        open={addingTeacher}
        subjectId={subjectId}
        subjectName={subject.name}
        classes={pickers.classes}
        teachers={pickers.teachers}
        pickersFailed={pickers.failed}
        onClose={() => setAddingTeacher(false)}
        onDone={() => {
          setAddingTeacher(false);
          success('Teacher assigned to the subject');
          reload();
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
 */
function AssignClassDialog({
  open,
  subjectId,
  subjectName,
  classes,
  teachers,
  pickersFailed,
  onClose,
  onDone,
}: {
  open: boolean;
  subjectId: string;
  subjectName: string;
  classes: ClassOption[];
  teachers: TeacherOption[];
  pickersFailed: boolean;
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
      if (!(caught instanceof ApiError)) throw caught;
      const perField = caught.fieldErrors();
      setFieldErrors(perField);
      setFailure(Object.keys(perField).length ? null : caught.message);
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
        {pickersFailed ? (
          <Notice tone="warn">
            The class and teacher lists could not be loaded, so there is nothing to choose from. That
            needs `classes.view` and `teachers.view`, which are separate from `subjects.manage`.
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
          hint="Optional. Who teaches this subject to this class — naming them here also lists them under “Taught by”."
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
          hint="Optional. The paper's total, used when marks are entered for this class."
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
  pickersFailed,
  onClose,
  onDone,
}: {
  open: boolean;
  subjectId: string;
  subjectName: string;
  classes: ClassOption[];
  teachers: TeacherOption[];
  pickersFailed: boolean;
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
      if (!(caught instanceof ApiError)) throw caught;
      const perField = caught.fieldErrors();
      setFieldErrors(perField);
      setFailure(Object.keys(perField).length ? null : caught.message);
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
        {pickersFailed ? (
          <Notice tone="warn">
            The teacher and class lists could not be loaded, so there is nothing to choose from.
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
          hint="Optional. Narrows the assignment to one class."
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
