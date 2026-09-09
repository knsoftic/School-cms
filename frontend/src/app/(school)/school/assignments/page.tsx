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
 * entries and `verify-frontend.js` asserts the count in both directions, so this is reached from
 * **Homework** — its nearest sibling, and the other half of §20's student work — rather than from
 * the sidebar. Adding an eighteenth nav entry would be this product editing a list the source fixes.
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
 * ## Marking a submission is where the care is
 *
 * `review` takes `marks_obtained`, `feedback` and an `outcome` of **reviewed** or **returned** —
 * those two and no others, because §20.3 offers no third verdict. `marks_obtained` is nullable and
 * that is not the same as zero: a returned submission is one sent back to be done again, and giving
 * it a zero would record a mark the student was never given. The form says so.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
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
  class_id: number;
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
  student?: { id: number; first_name: string; last_name: string; roll_number: string | null } | null;
}

interface ClassOption {
  id: number;
  name: string;
}

const STATUSES = ['draft', 'published', 'closed'];

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

  /* create */
  const [title, setTitle] = useState('');
  const [classId, setClassId] = useState('');
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
            ? caught.bannerFor(['title', 'class_id', 'due_date', 'total_marks', 'description', 'status'])
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
      if (feedback.trim()) body.feedback = feedback.trim();

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

  const columns = useMemo<Column<Assignment>[]>(
    () => [
      {
        key: 'title',
        header: 'Assignment',
        cell: (row) => (
          <div>
            <span className="font-medium">{row.title}</span>
            {row.subject ? (
              <span className="block text-xs text-muted-soft">{row.subject.name}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'class',
        header: 'Class',
        cell: (row) => row.class?.name ?? <span className="text-muted-soft">—</span>,
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
      ...(canManage || canSubmit
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: Assignment) => (
                <div className="flex flex-wrap gap-1">
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
                      Submit work
                    </button>
                  ) : null}
                </div>
              ),
            } as Column<Assignment>,
          ]
        : []),
    ],
    [canManage, canSubmit]
  );

  const submissionColumns = useMemo<Column<Submission>[]>(
    () => [
      {
        key: 'student',
        header: 'Student',
        cell: (row) => (
          <div>
            <span className="font-medium">
              {row.student
                ? `${row.student.first_name} ${row.student.last_name}`
                : `Student #${row.student_id}`}
            </span>
            {row.student?.roll_number ? (
              <span className="block text-xs text-muted-soft">roll {row.student.roll_number}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'submitted',
        header: 'Handed in',
        cell: (row) => (
          <div className="text-xs text-muted">
            <span className="block">
              {row.submitted_at ? row.submitted_at.slice(0, 10) : 'not yet'}
            </span>
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
        key: 'status',
        header: 'Status',
        cell: (row) => <StatusBadge status={row.submission_status} />,
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
            onChange={(event) => setClassId(event.target.value)}
            hint={classes.loading ? 'Loading classes…' : 'Every student of the class can hand work in.'}
          >
            <option value="">Choose a class…</option>
            {classes.rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
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
          due_date: row.due_date ?? '',
          total_marks: row.total_marks === null ? '' : String(row.total_marks),
          status: row.status,
        })}
        fields={[
          { name: 'title', label: 'Title', required: true },
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

      <Modal
        open={submitting !== null}
        onClose={() => {
          if (!busy) setSubmitting(null);
        }}
        title={submitting ? `Hand in ${submitting.title}` : ''}
        description="Text, a file, or both. Handing in after the due date is recorded as late rather than refused."
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
            value={marks}
            onChange={(event) => setMarks(event.target.value)}
            hint="Leave blank for work that is not being given a mark — returned work usually is not, and a zero would record a mark the student was never given."
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
