'use client';

/**
 * One exam — SRS §19, and the home of the module's seven write routes that had no caller.
 *
 * `PATCH /exams/:id` here; the papers (`POST`/`PATCH /exams/:id/subjects…`) in `papers.tsx`; marks
 * (`POST /exams/marks`, `POST /exams/marks/submit`) in `marks.tsx`. The two grade-scale routes are
 * school-wide rather than per exam and live at `/school/exams/grade-scales`.
 *
 * ## Why the exam list keeps its two actions and this screen does not repeat them
 *
 * `POST /:id/results` (calculate) and `POST /:id/publish` already have callers on the list screen,
 * as row actions, and they are correct there: each is one confirmation on one row. Repeating them
 * here would give the same operation two homes and two sets of copy to keep in step. What this
 * screen adds is the work that has to happen *before* either can succeed — the papers, and the marks
 * on them — which is why it links back rather than duplicating.
 *
 * ## Status is not on the edit form
 *
 * `updateExam` forbids `status`, `published_at`, `announced_at` and `created_by` by name, each with
 * a message saying where the value really comes from: the lifecycle routes, the publish route, the
 * §23 notification job and the authenticated user. A control for any of them would be a control
 * whose only outcome is that message.
 *
 * ## The three permissions this screen spans
 *
 * `exams.view` to read it, `exams.manage` for the details form and the papers, `marks.enter` for the
 * marks tab. They are three distinct keys in `config/permissions.js` and a teacher typically holds
 * the third without the first two — so the tabs are gated independently rather than on one flag, and
 * a teacher sees the marks tab with the others read-only.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import {
  Field,
  FormGrid,
  FormSection,
  Notice,
  SubmitButton,
  TextAreaField,
} from '@/components/form';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
import { useToast } from '@/components/toast';
import {
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

import { MarksPanel } from './marks';
import { PapersPanel } from './papers';
import { formatDate, humanise, useExamDetail } from './detail';
import type { ExamDetail } from './detail';

const TABS = [
  { key: 'details', label: 'Details' },
  { key: 'papers', label: 'Papers' },
  { key: 'marks', label: 'Marks' },
];

interface FormValues {
  name: string;
  exam_type: string;
  start_date: string;
  end_date: string;
  grade_scale: string;
  description: string;
  reason: string;
}

function toValues(exam: ExamDetail): FormValues {
  return {
    name: exam.name,
    exam_type: exam.exam_type,
    /* DATEONLY columns arrive as ISO strings; `<input type="date">` wants the day alone. */
    start_date: exam.start_date ? exam.start_date.slice(0, 10) : '',
    end_date: exam.end_date ? exam.end_date.slice(0, 10) : '',
    grade_scale: exam.grade_scale ?? '',
    description: exam.description ?? '',
    reason: '',
  };
}

/**
 * `PATCH /exams/:id`.
 *
 * `class_id` and `section_id` are accepted by the schema and are **not offered**. Moving an exam to
 * another class after its papers have been marked would leave every `marks` row pointing at students
 * who are no longer in it — the API allows it because it has no way to know whether marking has
 * started, and this screen does: it is showing the papers on the next tab. The field set here is
 * therefore what can be corrected without invalidating anything already recorded.
 */
function DetailsForm({
  exam,
  canEdit,
  onSaved,
}: {
  exam: ExamDetail;
  canEdit: boolean;
  onSaved: (exam: ExamDetail) => void;
}) {
  const { success } = useToast();

  const [values, setValues] = useState<FormValues>(() => toValues(exam));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setValues(toValues(exam));
  }, [exam]);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  const base = toValues(exam);
  const changed: Record<string, unknown> = {};
  if (values.name !== base.name) changed.name = values.name.trim();
  if (values.exam_type !== base.exam_type) changed.exam_type = values.exam_type.trim();
  if (values.start_date !== base.start_date) changed.start_date = values.start_date || null;
  if (values.end_date !== base.end_date) changed.end_date = values.end_date || null;
  if (values.grade_scale !== base.grade_scale) changed.grade_scale = values.grade_scale.trim() || null;
  if (values.description !== base.description) changed.description = values.description.trim() || null;
  const nothingChanged = Object.keys(changed).length === 0;

  async function save() {
    if (busy || nothingChanged) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const body = { ...changed };
      if (values.reason.trim()) body.reason = values.reason.trim();
      const result = await api.patch<{ exam: ExamDetail }>(`/exams/${exam.id}`, body);
      onSaved(result.exam);
      success('Exam updated');
      set('reason', '');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setError(
          caught.bannerFor(['name', 'exam_type', 'start_date', 'end_date', 'grade_scale', 'description'])
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) {
    return (
      <Notice tone="info">
        Editing an exam needs the exam management permission, which this account does not hold. The
        marks tab is gated separately and may still be open to you.
      </Notice>
    );
  }

  return (
    <FormSection
      title="Details"
      description="What this exam is called, when it runs, and which grade scale its results are read against."
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}

        <FormGrid>
          <Field
            id="name"
            label="Name"
            required
            value={values.name}
            error={fieldErrors.name}
            onChange={(event) => set('name', event.target.value)}
          />
          <Field
            id="exam_type"
            label="Type"
            required
            value={values.exam_type}
            error={fieldErrors.exam_type}
            onChange={(event) => set('exam_type', event.target.value)}
            hint="Free text — SRS §19 fixes no vocabulary of exam types, so the school's own words are used."
          />
        </FormGrid>

        <FormGrid>
          <Field
            id="start_date"
            label="Starts"
            type="date"
            value={values.start_date}
            error={fieldErrors.start_date}
            onChange={(event) => set('start_date', event.target.value)}
          />
          <Field
            id="end_date"
            label="Ends"
            type="date"
            value={values.end_date}
            error={fieldErrors.end_date}
            onChange={(event) => set('end_date', event.target.value)}
          />
        </FormGrid>

        <Field
          id="grade_scale"
          label="Grade scale"
          value={values.grade_scale}
          error={fieldErrors.grade_scale}
          onChange={(event) => set('grade_scale', event.target.value)}
          hint="The scale name whose bands this exam's results are read against. Manage the bands on the Grade scales screen."
        />

        <TextAreaField
          id="description"
          label="Description"
          rows={3}
          value={values.description}
          error={fieldErrors.description}
          onChange={(event) => set('description', event.target.value)}
        />

        <TextAreaField
          id="exam-reason"
          label="Reason"
          rows={2}
          value={values.reason}
          onChange={(event) => set('reason', event.target.value)}
          hint="Recorded in the audit trail beside the fields that changed."
        />

        <SubmitButton busy={busy} busyLabel="Saving…" fullWidth={false} disabled={nothingChanged}>
          Save changes
        </SubmitButton>
      </form>
    </FormSection>
  );
}

export default function ExamDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const { can } = useAuth();
  const [tab, setTab] = useActiveTab(TABS);

  const { exam, subjects, loading, error, refusal, reload, adoptExam } = useExamDetail(id);

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (error) return <ErrorNotice message={error} onRetry={reload} />;
  if (loading || !exam) return <LoadingBlock />;

  const canManage = can('exams.manage');
  const canEnterMarks = can('marks.enter');

  const submitted = subjects.filter((row) => row.marks_submitted_at !== null).length;

  return (
    <div>
      <PageHeader
        title={exam.name}
        description={`${humanise(exam.exam_type)}${exam.class ? ` · ${exam.class.name}` : ''}${
          formatDate(exam.start_date) ? ` · from ${formatDate(exam.start_date)}` : ''
        }`}
        action={
          <Link href="/school/exams" className="btn btn-secondary">
            Back to exams
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={exam.status} />
        <span className="text-sm text-muted">
          {subjects.length === 0
            ? 'No papers yet'
            : `${submitted} of ${subjects.length} papers submitted`}
        </span>
        {/*
          * Said here rather than only on the list screen, because this is where the work that
          * unblocks it happens: the calculation reads submitted papers, so an exam whose papers are
          * still open produces a result nobody expected.
          */}
        {subjects.length > 0 && submitted < subjects.length ? (
          <span className="text-sm text-warn">
            Results calculated now would not include the papers still open for entry.
          </span>
        ) : null}
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} label="Exam sections" />

      <TabPanel tabKey={tab}>
        {tab === 'details' ? (
          <DetailsForm exam={exam} canEdit={canManage} onSaved={adoptExam} />
        ) : tab === 'papers' ? (
          <PapersPanel
            examId={exam.id}
            subjects={subjects}
            canManage={canManage}
            onChanged={reload}
          />
        ) : (
          <MarksPanel
            exam={exam}
            subjects={subjects}
            canEnter={canEnterMarks}
            onSubmitted={reload}
          />
        )}
      </TabPanel>
    </div>
  );
}
