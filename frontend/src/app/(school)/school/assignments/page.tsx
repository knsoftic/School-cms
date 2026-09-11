'use client';

/**
 * Assignments — SRS §20.3, and four write routes with no caller and no screen at all.
 *
 * `POST /assignments`, `PATCH /assignments/:id`, `POST /assignments/:id/submissions` and
 * `PATCH /assignments/submissions/:id/review`. §20.3 is implemented, verified by 196 backend
 * assertions, gated on its own module — and had no way in from the product.
 *
 * ## §33 does not list this screen, and §20.3 does require the capability
 *
 * The same shape as school settings and academic sessions: §33's School list is fixed at seventeen
 * entries and `verify-frontend.js` asserts the count in both directions, so this is reached from the
 * **school dashboard**'s shortcuts (for `assignments.view`) and from the **student dashboard** (for
 * `assignments.submit`) rather than from the sidebar. Adding an eighteenth nav entry would be this
 * product editing a list the source fixes. (This used to say it was reached from Homework; Homework
 * has never linked here.)
 *
 * ## One table, two record types
 *
 * `assignments` holds both the assignment and each submission against it: `record_type` separates
 * them and `parent_assignment_id` links a submission to its assignment. That is §29's design and it
 * is why the two tabs read from two different endpoints — `GET /assignments` and
 * `GET /assignments/submissions` — rather than from one list filtered here.
 *
 * ## Three permissions, three different people
 *
 * `assignments.manage` sets the work, `assignments.submit` hands it in, `assignments.review` marks
 * it. A teacher typically holds the first and third and a student the second, so each control is
 * gated on its own key and the tabs render for whoever can use them.
 *
 * ## Handing in once, and again only when it is returned
 *
 * `assignments_submission_unique (parent_assignment_id, student_id)` allows one submission per
 * student per assignment, and `submit()` refuses a second with 409 unless the first was **returned**
 * — in which case it replaces it. So "Submit work" is offered only where the student has not handed
 * in, "Resubmit" where the work came back, and neither where it is waiting to be marked or has been.
 * It used to be offered on every published assignment, and pressing it a second time was a 409.
 *
 * ## Marking a submission is where the care is
 *
 * `review` takes `marks_obtained`, `feedback` and an `outcome` of **reviewed** or **returned** —
 * those two and no others, because §20.3 offers no third verdict. `marks_obtained` is nullable and
 * that is not the same as zero: a returned submission is one sent back to be done again, and giving
 * it a zero would record a mark the student was never given. The form says so.
 *
 * The dialog shows the work being marked — which assignment, out of how much, the written answer and
 * the file. It used to show none of it: a teacher was asked for a mark with nothing to mark, although
 * the list response carries all of it and `GET /assignments/submissions/:id/attachment` serves the
 * file.
 *
 * The feedback it records is shown on the Submissions tab, to whoever can see the row — the student
 * whose work it is, above all, which is what the dialog's own hint promised and nothing delivered.
 * A blank feedback is sent as `null`, the way a blank mark is: the review schema accepts `null`, and
 * leaving it out when blank kept the old feedback in place — which that column would now show.
 *
 * ## The description is read from the row the list already holds
 *
 * An assignment's `description` is the work being set, and it was captured at creation and shown
 * nowhere — a student could hand in against a title. `present()` returns every column but the path,
 * so it is on each list row already and the Details dialog reads that row. `GET /assignments/:id` is
 * still not called: `findById()` answers the same row with less on it — no `class` or `subject`
 * join — so a second request would learn nothing.
 *
 * ## Setting work for one section, and for a subject
 *
 * `create` accepts `section_id` and `subject_id`, and the form now offers both, as `homework/new`
 * does. A section confines the assignment to it — `list()` and `findById()` show a sectioned
 * assignment only to that section's students, and `submit()` refuses anyone else — so the list says
 * which section. Its name comes from the class list's nested `sections`, because `list()` joins no
 * `Section`.
 *
 * The subject is narrowed to the chosen class's curriculum — the owner's decision D30. `assertReferences()`
 * runs `homework.service.assertOnCurriculum()`, which refuses with a 422 on `subject_id` a subject that
 * has no active `class_subjects` row for the class, whole-class or — when a section is named — that
 * section's. So the picker offers those subjects only — `useCurriculum`, one
 * `GET /subjects?class_id=&section_id=`, which answers by the same rule — waits for a class, is cleared
 * when the class changes, and is cleared when a change of section takes the chosen subject off the
 * curriculum. If the curriculum cannot be read, no subject can be named here and the assignment can
 * still be set without one.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api, saveFile } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { useCurriculum } from '@/lib/useTimetablePickers';
import { EditDialog } from '@/components/editDialog';
import {
  Field,
  FileField,
  FilterBar,
  FilterSelect,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { Modal } from '@/components/overlay';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';
import { useToast } from '@/components/toast';

const TABS = [
  { key: 'assignments', label: 'Assignments' },
  { key: 'submissions', label: 'Submissions' },
];

/** One `record_type: 'assignment'` row. */
interface Assignment {
  id: number;
  title: string;
  /** The work being set — up to 5000 characters, nullable. See the header. */
  description: string | null;
  class_id: number;
  /** Null is the whole class; a section confines the work to it. Named via `ClassOption.sections`. */
  section_id: number | null;
  assigned_date: string | null;
  due_date: string | null;
  total_marks: number | string | null;
  status: string;
  class?: { id: number; name: string } | null;
  subject?: { id: number; name: string } | null;
}

/** One `record_type: 'submission'` row, as `GET /assignments/submissions` returns it. */
interface Submission {
  id: number;
  parent_assignment_id: number;
  student_id: number;
  submission_status: string;
  submitted_at: string | null;
  is_late: boolean;
  marks_obtained: number | string | null;
  feedback: string | null;
  /** The written answer, up to 20000 characters (`submit` schema). Null when only a file came. */
  submission_text: string | null;
  /** `present()` swaps the stored path for this boolean; the original filename stays. */
  has_attachment: boolean;
  attachment_name: string | null;
  /**
   * The assignment it answers. `listSubmissions()` includes it as `parentAssignment` (not
   * `assignment` — MySQL's case-insensitive aliases, see the service) with `id`, `title`,
   * `due_date`, `total_marks`, `class_id` and `subject_id`.
   */
  parentAssignment?: {
    id: number;
    title: string;
    due_date: string | null;
    total_marks: number | string | null;
  } | null;
  /**
   * The student, as the include selects it. The names are optional on purpose: the include carried
   * only `id`, `admission_number` and `roll_number` for a while, and this row printed
   * "undefined undefined" for every student. `studentName()` joins whatever is there.
   */
  student?: {
    id: number;
    admission_number?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    roll_number: string | null;
  } | null;
}

/**
 * A class as `GET /classes` returns it, with the sections `list()` nests in every row — which is what
 * feeds the section picker and names a sectioned assignment's section, with no second request.
 */
interface ClassOption {
  id: number;
  name: string;
  sections?: { id: number; name: string; is_active: boolean }[] | null;
}

const STATUSES = ['draft', 'published', 'closed'];

/** A student's name, or the most identifying thing the row does carry. Never "undefined". */
function studentName(row: Submission): string {
  const name = row.student
    ? [row.student.first_name, row.student.last_name].filter(Boolean).join(' ')
    : '';
  if (name) return name;
  if (row.student?.admission_number) return `Admission no. ${row.student.admission_number}`;
  return `Student #${row.student_id}`;
}

/**
 * `submitted_at` — an instant, not a calendar day — in the viewer's zone.
 *
 * It used to be `slice(0, 10)` of the ISO string, which is the **UTC** date: work handed in just
 * after midnight anywhere east of UTC read as the day before. The time is shown too, because on the
 * due date the time is the question. Rows only exist after the client fetch, so the server render
 * never formats one and there is no hydration mismatch.
 */
const HANDED_IN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function handedIn(value: string | null): string | null {
  if (!value) return null;
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? null : HANDED_IN.format(when);
}

export default function AssignmentsPage() {
  const { can } = useAuth();
  const { success } = useToast();
  const [tab, setTab] = useActiveTab(TABS);

  const canManage = can('assignments.manage');
  const canSubmit = can('assignments.submit');
  const canReview = can('assignments.review');

  /* ── the assignments list ── */
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const query = useMemo(
    () => ({ page, limit: 20, status: status || undefined }),
    [page, status]
  );
  const list = useCollection<Assignment>('/assignments', query);
  /* 100 is `PAGINATION.MAX_LIMIT`; anything above it is a 422 and renders as an empty select. */
  const classes = useCollection<ClassOption>('/classes', useMemo(() => ({ limit: 100 }), []));

  const [creating, setCreating] = useState(false);

  const [editing, setEditing] = useState<Assignment | null>(null);
  const [submitting, setSubmitting] = useState<Assignment | null>(null);
  /* The row whose Details dialog is open — see the header on why it is not fetched again. */
  const [viewing, setViewing] = useState<Assignment | null>(null);

  /* create */
  const [title, setTitle] = useState('');
  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [totalMarks, setTotalMarks] = useState('');
  const [description, setDescription] = useState('');
  const [createStatus, setCreateStatus] = useState('draft');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* submit */
  const [submissionText, setSubmissionText] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);

  /* ── the submissions list ── */
  const [subPage, setSubPage] = useState(1);
  const submissions = useCollection<Submission>(
    '/assignments/submissions',
    useMemo(() => ({ page: subPage, limit: 20 }), [subPage])
  );
  const [reviewing, setReviewing] = useState<Submission | null>(null);
  const [marks, setMarks] = useState('');
  const [feedback, setFeedback] = useState('');
  const [outcome, setOutcome] = useState('reviewed');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  /*
   * What this caller has already handed in, by assignment — for the "Submit work" button.
   *
   * Read only for a caller who submits and does not review. `listSubmissions()` narrows to the
   * caller's own rows for a student (`selfScope()`), and to nobody's for staff — so for anyone who
   * can also review (a Super Admin holds `assignments.submit` by the catalogue's construction) the
   * list is the whole school's, and cross-checking against it would hide the button wherever *any*
   * student had answered. Such a caller keeps the button and meets the service's own `NOT_A_STUDENT`.
   *
   * One page of a hundred, newest first. A student with more submissions than that sees "Submit
   * work" on an old one it already answered, and the 409 says so — the failure it was before, now
   * confined to the edge.
   */
  const ownSubmissions = canSubmit && !canReview;
  const [mine, setMine] = useState<Map<number, string>>(() => new Map());
  const [mineAttempt, setMineAttempt] = useState(0);

  useEffect(() => {
    if (!ownSubmissions) return;
    const controller = new AbortController();
    (async () => {
      try {
        const result = await api.page<Submission[]>('/assignments/submissions', {
          query: { limit: 100 },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setMine(new Map((result.data ?? []).map((row) => [row.parent_assignment_id, row.submission_status])));
      } catch {
        /* Without it the button shows as it always did, and a duplicate is still refused with a 409. */
      }
    })();
    return () => controller.abort();
  }, [ownSubmissions, mineAttempt]);

  /* The chosen class's sections, nested in its own row — see `ClassOption`. */
  const sections = useMemo(
    () => classes.rows.find((row) => String(row.id) === classId)?.sections ?? [],
    [classes.rows, classId]
  );

  /*
   * D30 — the subjects the create form offers: the chosen class's curriculum, narrowed to the chosen
   * section, read while the dialog is open. `GET /subjects` needs `subjects.view`, which is not the
   * `assignments.manage` that opened the form, so it can fail on its own — the field then says so and
   * the assignment is still settable without one. See the header.
   */
  const curriculum = useCurriculum(classId, sectionId, canManage && creating);
  const offeredSubjects = curriculum.state === 'ready' ? curriculum.rows : [];

  /*
   * A subject of the whole class stays on the curriculum whichever section is named; one that is on it
   * only for the section being left does not. The section's curriculum is read afresh, so the test runs
   * once it arrives: a chosen subject it does not hold is cleared rather than sent to be refused.
   */
  useEffect(() => {
    if (curriculum.state !== 'ready') return;
    setSubjectId((prev) => (prev && !curriculum.rows.some((row) => String(row.id) === prev) ? '' : prev));
  }, [curriculum]);

  /*
   * Every section's name by id, for the Class column and the Details dialog. Empty for a caller who
   * cannot read the class list — a student or parent holds no `classes.view` — and the cell then says
   * "one section", never the id.
   */
  const sectionNames = useMemo(() => {
    const byId = new Map<number, string>();
    for (const klass of classes.rows) {
      for (const section of klass.sections ?? []) byId.set(section.id, section.name);
    }
    return byId;
  }, [classes.rows]);

  /** "all sections", the section's name, or "one section" where the name cannot be read. */
  const scopeOf = useCallback(
    (row: Assignment) =>
      row.section_id === null ? 'all sections' : sectionNames.get(row.section_id) ?? 'one section',
    [sectionNames]
  );

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        class_id: classId,
        status: createStatus,
      };
      /* Both optional and both nullable, so left out when blank: no section is the whole class. */
      if (sectionId) body.section_id = sectionId;
      if (subjectId) body.subject_id = subjectId;
      if (dueDate) body.due_date = dueDate;
      if (totalMarks.trim()) body.total_marks = totalMarks.trim();
      if (description.trim()) body.description = description.trim();

      await api.post('/assignments', body);
      success(
        'Assignment created',
        createStatus === 'draft'
          ? 'It is a draft — students cannot see it until it is published.'
          : 'Students can see it now.'
      );
      setCreating(false);
      setTitle('');
      setClassId('');
      setSectionId('');
      setSubjectId('');
      setDueDate('');
      setTotalMarks('');
      setDescription('');
      setCreateStatus('draft');
      list.reload();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(Array.isArray(caught.details) ? caught.fieldErrors() : {});
        setError(
          Array.isArray(caught.details)
            ? caught.bannerFor([
                'title',
                'class_id',
                'section_id',
                'subject_id',
                'due_date',
                'total_marks',
                'description',
                'status',
              ])
            : caught.message
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitWork() {
    if (!submitting || busy) return;
    setBusy(true);
    setError(null);
    try {
      /*
       * Multipart, because §20.3's submission may carry a file and `uploadSingle` parses the body
       * before `validate()` sees it — so every scalar travels as a form field even when no file is
       * attached.
       */
      const form = new FormData();
      if (submissionText.trim()) form.append('submission_text', submissionText.trim());
      if (attachment) form.append('attachment', attachment);
      await api.post(`/assignments/${submitting.id}/submissions`, undefined, { formData: form });
      success('Work submitted');
      setSubmitting(null);
      setSubmissionText('');
      setAttachment(null);
      submissions.reload();
      setMineAttempt((n) => n + 1);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function review() {
    if (!reviewing || reviewBusy) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const body: Record<string, unknown> = { outcome };
      /* Blank is null — *not marked* — and is a different answer from a mark of zero. */
      body.marks_obtained = marks.trim() === '' ? null : marks.trim();
      /*
       * Blank is null here too, so clearing the box clears the feedback. It used to be left out when
       * blank, and `review()` keeps a field it is not sent — so feedback cleared in this dialog
       * stayed on the submission, where the Submissions tab now shows it to the student.
       */
      body.feedback = feedback.trim() === '' ? null : feedback.trim();

      await api.patch(`/assignments/submissions/${reviewing.id}/review`, body);
      success(
        outcome === 'reviewed' ? 'Submission marked' : 'Submission returned',
        outcome === 'returned' ? 'The student can hand it in again.' : undefined
      );
      setReviewing(null);
      setMarks('');
      setFeedback('');
      setOutcome('reviewed');
      submissions.reload();
    } catch (caught) {
      setReviewError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setReviewBusy(false);
    }
  }

  /*
   * The submitted file, through the authenticated client — an `<a href>` would carry no bearer token
   * and 401. The API exposes `Content-Disposition` to the browser (`app.js` CORS `exposedHeaders`), so
   * the server's filename is used; the original filename is passed as the fallback for a response that
   * carries none.
   */
  async function downloadSubmission(row: Submission) {
    if (downloading) return;
    setDownloading(true);
    setReviewError(null);
    try {
      const file = await api.download(
        `/assignments/submissions/${row.id}/attachment`,
        {},
        row.attachment_name ?? `submission-${row.id}`
      );
      saveFile(file);
    } catch (caught) {
      setReviewError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setDownloading(false);
    }
  }

  const columns = useMemo<Column<Assignment>[]>(
    () => [
      {
        key: 'title',
        header: 'Assignment',
        /* The description's first line under the title; the whole of it is in Details. */
        cell: (row) => (
          <div className="max-w-sm">
            <span className="font-medium">{row.title}</span>
            {row.subject ? (
              <span className="block text-xs text-muted-soft">{row.subject.name}</span>
            ) : null}
            {row.description ? (
              <span className="mt-0.5 block text-xs text-muted line-clamp-1">{row.description}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'class',
        header: 'Class',
        /* With the section, because naming one confines the work to it — see the header. */
        cell: (row) => (
          <span className="whitespace-nowrap">
            {row.class?.name ?? <span className="text-muted-soft">—</span>}
            <span className="ml-2 text-xs text-muted-soft">{scopeOf(row)}</span>
          </span>
        ),
      },
      {
        key: 'due',
        header: 'Due',
        /* DATEONLY, printed as sent — giving a calendar date an instant shifts the day. */
        cell: (row) => row.due_date ?? <span className="text-muted-soft">no date</span>,
      },
      {
        key: 'marks',
        header: 'Out of',
        numeric: true,
        cell: (row) =>
          row.total_marks === null ? <span className="text-muted-soft">unmarked</span> : row.total_marks,
      },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
      {
        /*
         * Details for everyone who can see the row — the student about to hand in is the one who
         * most needs the description — then Edit and Submit, each behind its own key.
         */
        key: 'actions',
        header: 'Actions',
        cell: (row: Assignment) => {
          /* What this student has already done with it — see `mine`. Undefined: nothing yet. */
          const handed = mine.get(row.id);
          return (
            <div className="flex flex-wrap gap-1">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setViewing(row)}>
                Details
                <span className="sr-only"> of {row.title}</span>
              </button>
              {canManage ? (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => setEditing(row)}
                >
                  Edit
                </button>
              ) : null}
              {/* Only published work can be handed in; a draft is not visible to a student. */}
              {canSubmit && row.status === 'published' ? (
                handed !== undefined && handed !== 'returned' ? (
                  <span className="inline-flex items-center px-2 text-xs text-muted-soft">
                    {handed === 'reviewed' ? 'Handed in · marked' : 'Handed in'}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      setSubmitting(row);
                      setSubmissionText('');
                      setAttachment(null);
                      setError(null);
                    }}
                  >
                    {handed === 'returned' ? 'Resubmit' : 'Submit work'}
                  </button>
                )
              ) : null}
            </div>
          );
        },
      },
    ],
    [canManage, canSubmit, mine, scopeOf]
  );

  const submissionColumns = useMemo<Column<Submission>[]>(
    () => [
      {
        key: 'student',
        header: 'Student',
        cell: (row) => (
          <div>
            <span className="font-medium">{studentName(row)}</span>
            {row.student?.roll_number ? (
              <span className="block text-xs text-muted-soft">roll {row.student.roll_number}</span>
            ) : null}
          </div>
        ),
      },
      {
        /* Which piece of work this is — without it a teacher's list is names and marks for nothing. */
        key: 'assignment',
        header: 'Assignment',
        cell: (row) =>
          row.parentAssignment ? (
            <span>{row.parentAssignment.title}</span>
          ) : (
            <span className="text-muted-soft">assignment #{row.parent_assignment_id}</span>
          ),
      },
      {
        key: 'submitted',
        header: 'Handed in',
        cell: (row) => (
          <div className="text-xs text-muted">
            <span className="block whitespace-nowrap">{handedIn(row.submitted_at) ?? 'not yet'}</span>
            {/* Derived by the service from the due date, and read here rather than recomputed. */}
            {row.is_late ? <span className="block text-warn">late</span> : null}
          </div>
        ),
      },
      {
        key: 'marks',
        header: 'Marks',
        numeric: true,
        cell: (row) =>
          row.marks_obtained === null ? (
            <span className="text-muted-soft">not marked</span>
          ) : (
            row.marks_obtained
          ),
      },
      {
        /*
         * The reviewer's feedback, in full — "Shown to the student with the result" is what the review
         * dialog tells the teacher writing it, and this column is where that becomes true. Wrapped
         * inside a bounded width rather than cut to a line: feedback is the part of a result a
         * student is meant to read, and a clipped sentence would hide the end of it.
         *
         * `listSubmissions()` returns it on every row (`present()` drops only the path), and narrows
         * a student to their own rows and a parent to their children's — so nobody reads a
         * classmate's feedback here.
         */
        key: 'feedback',
        header: 'Feedback',
        cell: (row) =>
          row.feedback ? (
            <p className="max-w-xs whitespace-pre-wrap break-words text-sm text-ink-soft">
              {row.feedback}
            </p>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      {
        key: 'status',
        header: 'Status',
        /*
         * `returned` is attention, not good news: here it means the work was sent back to be done
         * again. The shared map files the word under good because a *returned library book* is, and
         * `StatusBadge`'s `tone` is how this screen says which meaning it has.
         */
        cell: (row) => (
          <StatusBadge
            status={row.submission_status}
            tone={row.submission_status === 'returned' ? 'attention' : undefined}
          />
        ),
      },
      ...(canReview
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: Submission) => (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => {
                    setReviewing(row);
                    setMarks(row.marks_obtained === null ? '' : String(row.marks_obtained));
                    setFeedback(row.feedback ?? '');
                    setOutcome('reviewed');
                    setReviewError(null);
                  }}
                >
                  Mark
                </button>
              ),
            } as Column<Submission>,
          ]
        : []),
    ],
    [canReview]
  );

  /* The paper the submission under review answers, and its ceiling — `review()` refuses a mark above it. */
  const reviewTotal = reviewing?.parentAssignment?.total_marks ?? null;
  const resubmitting = submitting ? mine.get(submitting.id) === 'returned' : false;

  return (
    <div>
      <PageHeader
        title="Assignments"
        description="SRS §20.3 — work set for a class, handed in by students, and marked."
        action={
          <div className="flex gap-2">
            <Link href="/school/homework" className="btn btn-secondary">
              Homework
            </Link>
            {canManage ? (
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Set an assignment
              </button>
            ) : null}
          </div>
        }
      />

      <Tabs tabs={TABS} active={tab} onChange={setTab} label="Assignment sections" />

      <TabPanel tabKey={tab}>
        {tab === 'assignments' ? (
          <>
            <FilterBar
              activeCount={status ? 1 : 0}
              onClear={() => {
                setStatus('');
                setPage(1);
              }}
            >
              <div>
                <FilterSelect
                  id="assignment-status"
                  label="Status"
                  labelVisible
                  value={status}
                  onChange={(value) => {
                    setStatus(value);
                    setPage(1);
                  }}
                >
                  <option value="">All</option>
                  {STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </FilterSelect>
              </div>
            </FilterBar>

            {list.refusal ? (
              <RefusalNotice refusal={list.refusal} />
            ) : list.error ? (
              <ErrorNotice message={list.error} onRetry={list.reload} />
            ) : list.loading && list.rows.length === 0 ? (
              <LoadingBlock />
            ) : list.rows.length === 0 ? (
              <EmptyNotice>
                {status
                  ? 'No assignment has this status.'
                  : 'No assignment has been set. A draft is invisible to students until it is published.'}
              </EmptyNotice>
            ) : (
              <>
                <DataTable
                  columns={columns}
                  rows={list.rows}
                  rowKey={(row) => row.id}
                  caption="Assignments"
                  busy={list.loading}
                />
                {list.meta ? <Pagination meta={list.meta} onPage={setPage} /> : null}
              </>
            )}
          </>
        ) : submissions.refusal ? (
          <RefusalNotice refusal={submissions.refusal} />
        ) : submissions.error ? (
          <ErrorNotice message={submissions.error} onRetry={submissions.reload} />
        ) : submissions.loading && submissions.rows.length === 0 ? (
          <LoadingBlock />
        ) : submissions.rows.length === 0 ? (
          <EmptyNotice>
            Nothing has been handed in yet. A submission appears here once a student submits against a
            published assignment.
          </EmptyNotice>
        ) : (
          <>
            <DataTable
              columns={submissionColumns}
              rows={submissions.rows}
              rowKey={(row) => row.id}
              caption="Submissions"
              busy={submissions.loading}
            />
            {submissions.meta ? <Pagination meta={submissions.meta} onPage={setSubPage} /> : null}
          </>
        )}
      </TabPanel>

      <Modal
        open={creating}
        onClose={() => {
          if (!busy) setCreating(false);
        }}
        title="Set an assignment"
        description="A draft is invisible to students. Publishing is what makes it something they can hand work in against."
        size="lg"
        busy={busy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
            <SubmitButton form="create-assignment" busy={busy} busyLabel="Creating…" fullWidth={false}>
              Create
            </SubmitButton>
          </>
        }
      >
        <form
          id="create-assignment"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          {error ? <Notice tone="error">{error}</Notice> : null}

          <Field
            id="title"
            label="Title"
            required
            value={title}
            error={fieldErrors.title}
            onChange={(event) => setTitle(event.target.value)}
          />

          <SelectField
            id="class_id"
            label="Class"
            required
            value={classId}
            error={fieldErrors.class_id}
            onChange={(event) => {
              /*
               * The section and the subject go with the class: `assertReferences()` refuses a section
               * of another class and a subject off this one's curriculum, and a choice carried over
               * from the previous class is a 422 nobody can see coming.
               */
              setClassId(event.target.value);
              setSectionId('');
              setSubjectId('');
            }}
            hint={
              classes.loading
                ? 'Loading classes…'
                : 'Every student of the class can hand work in — or of one section, if you name it below.'
            }
          >
            <option value="">Choose a class…</option>
            {classes.rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="section_id"
            label="Section"
            value={sectionId}
            error={fieldErrors.section_id}
            /* The subject is re-tested against the section's curriculum once it arrives — see above. */
            onChange={(event) => setSectionId(event.target.value)}
            disabled={!classId || sections.length === 0}
            hint="Naming a section confines the assignment to it: only that section’s students see it and can hand work in. Left blank, the whole class owes it."
          >
            {/* The empty option carries the reason the select is disabled, and is an answer when it is not. */}
            <option value="">
              {!classId
                ? 'Choose a class first'
                : sections.length === 0
                  ? 'This class has no sections'
                  : 'All sections of this class'}
            </option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.name}
                {section.is_active ? '' : ' — inactive'}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="subject_id"
            label="Subject"
            value={subjectId}
            error={fieldErrors.subject_id}
            onChange={(event) => setSubjectId(event.target.value)}
            disabled={!classId || curriculum.state !== 'ready'}
            /* D30 — see the header. The server refuses a subject the chosen class does not teach. */
            hint={
              curriculum.state === 'failed'
                ? 'The class’s subjects could not be loaded, so a subject cannot be chosen here. Reading them needs the separate “View subjects” permission. The assignment can be set without one.'
                : classId && curriculum.state === 'ready' && offeredSubjects.length === 0
                  ? 'No subject is on this class’s curriculum yet, so none can be named. Subjects are added to a class on the subject’s own screen; the assignment can be set without one.'
                  : `Optional. Only subjects on the chosen class’s curriculum are offered — one added for a single section counts only when that section is named — because the server refuses any other.${
                      curriculum.state === 'ready' && curriculum.total > curriculum.rows.length
                        ? ` Showing the first ${curriculum.rows.length} of ${curriculum.total}.`
                        : ''
                    }`
            }
          >
            <option value="">
              {!classId
                ? 'Choose a class first'
                : curriculum.state === 'loading'
                  ? 'Loading the class’s subjects…'
                  : curriculum.state === 'failed'
                    ? 'Unavailable'
                    : 'No subject'}
            </option>
            {classId
              ? offeredSubjects.map((subject) => (
                  /* Retired subjects are marked, not withheld — the service does not test `is_active`. */
                  <option key={subject.id} value={subject.id}>
                    {subject.name} ({subject.code})
                    {subject.is_active ? '' : ' — inactive'}
                  </option>
                ))
              : null}
          </SelectField>

          <Field
            id="due_date"
            label="Due"
            type="date"
            value={dueDate}
            error={fieldErrors.due_date}
            onChange={(event) => setDueDate(event.target.value)}
            hint="What decides whether a submission is recorded as late."
          />

          <Field
            id="total_marks"
            label="Out of"
            type="number"
            step="0.01"
            min={0}
            value={totalMarks}
            error={fieldErrors.total_marks}
            onChange={(event) => setTotalMarks(event.target.value)}
            hint="Leave blank for work that is not marked out of anything."
          />

          <TextAreaField
            id="description"
            label="Description"
            rows={4}
            value={description}
            error={fieldErrors.description}
            onChange={(event) => setDescription(event.target.value)}
          />

          <SelectField
            id="create-status"
            label="Publish"
            value={createStatus}
            error={fieldErrors.status}
            onChange={(event) => setCreateStatus(event.target.value)}
            hint="Only draft and published can be set at creation; closing is a later edit."
          >
            <option value="draft">Keep as a draft</option>
            <option value="published">Publish to the class</option>
          </SelectField>
        </form>
      </Modal>

      <EditDialog
        row={editing}
        title={editing ? `Edit ${editing.title}` : ''}
        description="The work as it is set. Which class it belongs to is fixed once students have started handing it in."
        success="Assignment updated"
        onClose={() => setEditing(null)}
        onSaved={list.reload}
        save={(row, body) => api.patch(`/assignments/${row.id}`, body)}
        initial={(row) => ({
          title: row.title,
          description: row.description ?? '',
          due_date: row.due_date ?? '',
          total_marks: row.total_marks === null ? '' : String(row.total_marks),
          status: row.status,
        })}
        fields={[
          { name: 'title', label: 'Title', required: true },
          {
            /* Nullable: the schema's `.allow(null)` is what lets a description be cleared. */
            name: 'description',
            label: 'Description',
            kind: 'textarea',
            rows: 6,
            nullable: true,
            hint: 'The work itself, up to 5000 characters. The students it is set for see it once it is published.',
          },
          { name: 'due_date', label: 'Due', kind: 'date', nullable: true },
          {
            name: 'total_marks',
            label: 'Out of',
            kind: 'number',
            step: '0.01',
            min: 0,
            nullable: true,
          },
          {
            name: 'status',
            label: 'Status',
            kind: 'select',
            required: true,
            options: STATUSES.map((value) => ({ value, label: value })),
            hint: 'Closed work can no longer be handed in. Submissions already made are kept and can still be marked.',
          },
        ]}
      />

      {/* The Details dialog — the row as the list holds it, with the whole description. See the header. */}
      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing ? viewing.title : ''}
        size="lg"
        footer={
          <button type="button" className="btn btn-secondary" onClick={() => setViewing(null)}>
            Close
          </button>
        }
      >
        {viewing ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted">Class</dt>
              <dd>
                {viewing.class?.name ?? <span className="text-muted-soft">—</span>}
                <span className="ml-2 text-xs text-muted-soft">{scopeOf(viewing)}</span>
              </dd>
              <dt className="text-muted">Subject</dt>
              <dd>{viewing.subject?.name ?? <span className="text-muted-soft">—</span>}</dd>
              <dt className="text-muted">Due</dt>
              {/* DATEONLY, printed as sent — as in the Due column. */}
              <dd>{viewing.due_date ?? <span className="text-muted-soft">no date</span>}</dd>
              <dt className="text-muted">Out of</dt>
              <dd>
                {viewing.total_marks === null ? (
                  <span className="text-muted-soft">not marked out of anything</span>
                ) : (
                  viewing.total_marks
                )}
              </dd>
              <dt className="text-muted">Status</dt>
              <dd>
                <StatusBadge status={viewing.status} />
              </dd>
            </dl>

            <section aria-label="The description" className="rounded-lg border border-border p-3">
              {viewing.description ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                  {viewing.description}
                </p>
              ) : (
                <p className="text-sm text-muted">No description was written for this assignment.</p>
              )}
            </section>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={submitting !== null}
        onClose={() => {
          if (!busy) setSubmitting(null);
        }}
        title={submitting ? `${resubmitting ? 'Resubmit' : 'Hand in'} ${submitting.title}` : ''}
        description={
          resubmitting
            ? 'This replaces the work that was returned, and clears its mark and feedback. Text, a file, or both.'
            : 'Text, a file, or both. Handing in after the due date is recorded as late rather than refused.'
        }
        size="lg"
        busy={busy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setSubmitting(null)}
            >
              Cancel
            </button>
            <SubmitButton form="submit-work" busy={busy} busyLabel="Submitting…" fullWidth={false}>
              Hand in
            </SubmitButton>
          </>
        }
      >
        <form
          id="submit-work"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitWork();
          }}
        >
          {error ? <Notice tone="error">{error}</Notice> : null}
          <TextAreaField
            id="submission_text"
            label="Your answer"
            rows={6}
            value={submissionText}
            onChange={(event) => setSubmissionText(event.target.value)}
          />
          <FileField
            id="attachment"
            label="Attachment"
            file={attachment}
            onChange={(file) => setAttachment(file)}
            hint="Optional. One file."
          />
        </form>
      </Modal>

      <Modal
        open={reviewing !== null}
        onClose={() => {
          if (!reviewBusy) setReviewing(null);
        }}
        title="Mark this submission"
        description="Marking records the result. Returning it sends the work back to be done again — the student can hand it in a second time."
        size="lg"
        busy={reviewBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={reviewBusy}
              onClick={() => setReviewing(null)}
            >
              Cancel
            </button>
            <SubmitButton form="review-submission" busy={reviewBusy} busyLabel="Saving…" fullWidth={false}>
              {outcome === 'reviewed' ? 'Record mark' : 'Return it'}
            </SubmitButton>
          </>
        }
      >
        <form
          id="review-submission"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void review();
          }}
        >
          {reviewError ? <Notice tone="error">{reviewError}</Notice> : null}

          {/* The work being marked — see the header. */}
          {reviewing ? (
            <section
              aria-label="The submitted work"
              className="space-y-3 rounded-lg border border-border p-3"
            >
              <div>
                <p className="text-sm font-medium text-ink">
                  {reviewing.parentAssignment?.title ?? `Assignment #${reviewing.parent_assignment_id}`}
                </p>
                <p className="mt-0.5 text-xs text-muted-soft">
                  {studentName(reviewing)}
                  {handedIn(reviewing.submitted_at) ? ` · handed in ${handedIn(reviewing.submitted_at)}` : ''}
                  {reviewing.is_late ? ' · late' : ''}
                  {reviewTotal === null ? ' · not marked out of anything' : ` · out of ${reviewTotal}`}
                </p>
              </div>

              {reviewing.submission_text ? (
                <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                  {reviewing.submission_text}
                </p>
              ) : (
                <p className="text-sm text-muted">
                  No written answer{reviewing.has_attachment ? ' — the work is in the file.' : ', and no file.'}
                </p>
              )}

              {reviewing.has_attachment ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={downloading}
                  aria-busy={downloading}
                  onClick={() => void downloadSubmission(reviewing)}
                >
                  <Icon name="download" size={14} />
                  {downloading
                    ? 'Downloading…'
                    : `Download ${reviewing.attachment_name ?? 'the file'}`}
                </button>
              ) : null}
            </section>
          ) : null}

          <SelectField
            id="outcome"
            label="Outcome"
            required
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            hint="The two §20.3 offers. There is no third verdict."
          >
            <option value="reviewed">Marked</option>
            <option value="returned">Returned to be done again</option>
          </SelectField>

          <Field
            id="marks_obtained"
            label="Marks"
            type="number"
            step="0.01"
            min={0}
            max={reviewTotal === null ? undefined : Number(reviewTotal)}
            value={marks}
            onChange={(event) => setMarks(event.target.value)}
            hint={`${reviewTotal === null ? '' : `Out of ${reviewTotal}. `}Leave blank for work that is not being given a mark — returned work usually is not, and a zero would record a mark the student was never given.`}
          />

          <TextAreaField
            id="feedback"
            label="Feedback"
            rows={4}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            hint="Shown to the student with the result."
          />
        </form>
      </Modal>
    </div>
  );
}
