'use client';

/**
 * The papers an exam is made of — SRS §19.1's "Subjects, Marks, Passing Marks".
 *
 * `POST /exams/:id/subjects` and `PATCH /exams/:id/subjects/:examSubjectId`, neither of which had a
 * caller. Without them an exam could be created and could never be given a single subject to
 * examine, which also made FR-EXAM-002 (marks) and FR-EXAM-003 (the calculation) unreachable: both
 * start from an `exam_subjects` row.
 *
 * ## "Paper", not "subject"
 *
 * The API calls the row an exam *subject*; the school calls it a paper, and the distinction is load-
 * bearing on this screen. `subjects` is also the name of the school-wide catalogue at
 * `/school/subjects`, and a screen with an "Add subject" button that does **not** add to that
 * catalogue is a screen people press by mistake. So the noun here is the thing being configured —
 * this exam's paper in a subject — and the subject picker says which catalogue it draws from.
 *
 * ## The one field an edit refuses, and why it is not a gap
 *
 * `updateExamSubject` forbids `subject_id` by name: *"remove the paper and add the other subject"*.
 * Its reason is that every `marks` row points at the `exam_subjects` row, not at the subject, so
 * moving a paper to a different subject would silently rewrite marks that were entered against the
 * old one. The edit form therefore shows the subject as text rather than as a disabled select — a
 * disabled control invites the question "why can I not change this?", and the answer is that this is
 * a different paper.
 *
 * ## Practical marks come in pairs or not at all
 *
 * `practical_full_marks` and `practical_passing_marks` are both nullable and independent in the
 * schema, so the API accepts one without the other. That combination has no meaning — a practical
 * component with a ceiling and no pass mark cannot be passed or failed — so the form sends both or
 * neither, and says so. This is the screen being **stricter than the API in a place the API has no
 * opinion**, which is different from forbidding something the API supports.
 */

import { useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useCollection } from '@/lib/useCollection';
import {
  Field,
  FormGrid,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import { Column, DataTable, EmptyNotice } from '@/components/table';
import { useToast } from '@/components/toast';

import { formatDate, paperName } from './detail';
import type { ExamSubjectRow } from './detail';

/** One row of `GET /subjects` — the school-wide catalogue a paper is drawn from. */
interface SubjectOption {
  id: number;
  name: string;
  code: string | null;
}

/** One row of `GET /teachers`. */
interface TeacherOption {
  id: number;
  first_name: string;
  last_name: string;
  employee_id: string | null;
}

interface PaperResponse {
  subject: ExamSubjectRow;
}

/** The form's fields, all as typed strings — see the create screens on why nothing is coerced. */
interface PaperValues {
  subject_id: string;
  full_marks: string;
  passing_marks: string;
  practical_full_marks: string;
  practical_passing_marks: string;
  teacher_id: string;
  exam_date: string;
  start_time: string;
  end_time: string;
  room: string;
  reason: string;
}

const EMPTY: PaperValues = {
  subject_id: '',
  full_marks: '',
  passing_marks: '',
  practical_full_marks: '',
  practical_passing_marks: '',
  teacher_id: '',
  exam_date: '',
  start_time: '',
  end_time: '',
  room: '',
  reason: '',
};

function toValues(row: ExamSubjectRow): PaperValues {
  return {
    subject_id: String(row.subject_id),
    full_marks: String(row.full_marks),
    passing_marks: String(row.passing_marks),
    practical_full_marks: row.practical_full_marks === null ? '' : String(row.practical_full_marks),
    practical_passing_marks:
      row.practical_passing_marks === null ? '' : String(row.practical_passing_marks),
    teacher_id: row.teacher_id === null ? '' : String(row.teacher_id),
    /* `exam_date` is a DATEONLY but arrives as an ISO string; `<input type="date">` wants the day. */
    exam_date: row.exam_date ? row.exam_date.slice(0, 10) : '',
    start_time: row.start_time ?? '',
    end_time: row.end_time ?? '',
    room: row.room ?? '',
    reason: '',
  };
}

export function PapersPanel({
  examId,
  subjects,
  canManage,
  onChanged,
}: {
  examId: number;
  subjects: ExamSubjectRow[];
  /** `exams.manage`. The API re-checks it; hiding the form is a courtesy. */
  canManage: boolean;
  onChanged: () => void;
}) {
  const { success } = useToast();

  const catalogue = useCollection<SubjectOption>('/subjects', { limit: 200 });
  const teachers = useCollection<TeacherOption>('/teachers', { limit: 200, is_active: 'true' });

  const [editing, setEditing] = useState<ExamSubjectRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [values, setValues] = useState<PaperValues>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const open = adding || editing !== null;

  function set<K extends keyof PaperValues>(key: K, value: PaperValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function openAdd() {
    setValues(EMPTY);
    setAdding(true);
    setEditing(null);
    setError(null);
    setFieldErrors({});
  }

  function openEdit(row: ExamSubjectRow) {
    setValues(toValues(row));
    setEditing(row);
    setAdding(false);
    setError(null);
    setFieldErrors({});
  }

  function close() {
    if (busy) return;
    setAdding(false);
    setEditing(null);
  }

  /* Already-configured subjects, so the picker cannot offer one this exam already examines. */
  const taken = useMemo(() => new Set(subjects.map((row) => row.subject_id)), [subjects]);

  async function save() {
    if (busy) return;

    /*
     * The one rule this form adds to the schema's. Checked before the request rather than after,
     * because the API accepts the half-configured pair and would store something meaningless.
     */
    const hasPracticalCeiling = values.practical_full_marks.trim() !== '';
    const hasPracticalPass = values.practical_passing_marks.trim() !== '';
    if (hasPracticalCeiling !== hasPracticalPass) {
      setError(
        'A practical component needs both a full mark and a passing mark, or neither. One without the other cannot be passed or failed.'
      );
      return;
    }

    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = {
        full_marks: values.full_marks.trim(),
        passing_marks: values.passing_marks.trim(),
      };
      /* Only on create: the update schema forbids it by name, and says why. */
      if (adding) body.subject_id = values.subject_id;
      body.teacher_id = values.teacher_id.trim() === '' ? null : values.teacher_id.trim();
      body.practical_full_marks = hasPracticalCeiling ? values.practical_full_marks.trim() : null;
      body.practical_passing_marks = hasPracticalPass ? values.practical_passing_marks.trim() : null;
      body.exam_date = values.exam_date === '' ? null : values.exam_date;
      body.start_time = values.start_time === '' ? null : values.start_time;
      body.end_time = values.end_time === '' ? null : values.end_time;
      body.room = values.room.trim() === '' ? null : values.room.trim();
      if (values.reason.trim()) body.reason = values.reason.trim();

      if (adding) {
        await api.post<PaperResponse>(`/exams/${examId}/subjects`, body);
        success('Paper added');
      } else if (editing) {
        await api.patch<PaperResponse>(`/exams/${examId}/subjects/${editing.id}`, body);
        success('Paper updated');
      }
      close();
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setError(
          caught.bannerFor([
            'subject_id',
            'full_marks',
            'passing_marks',
            'practical_full_marks',
            'practical_passing_marks',
            'teacher_id',
            'exam_date',
            'start_time',
            'end_time',
            'room',
          ])
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<Column<ExamSubjectRow>[]>(
    () => [
      {
        key: 'paper',
        header: 'Paper',
        cell: (row) => (
          <div>
            <span className="font-medium">{paperName(row)}</span>
            {row.room ? <span className="block text-xs text-muted-soft">Room {row.room}</span> : null}
          </div>
        ),
      },
      {
        key: 'marks',
        header: 'Marks',
        numeric: true,
        cell: (row) => (
          <div>
            <span>
              {row.passing_marks} / {row.full_marks}
            </span>
            {row.practical_full_marks === null ? null : (
              <span className="block text-xs text-muted-soft">
                practical {row.practical_passing_marks} / {row.practical_full_marks}
              </span>
            )}
          </div>
        ),
      },
      {
        key: 'when',
        header: 'Sat on',
        cell: (row) => (
          <div className="text-xs text-muted">
            <span className="block">{formatDate(row.exam_date) ?? 'no date set'}</span>
            {row.start_time ? (
              <span className="block text-muted-soft">
                {row.start_time}
                {row.end_time ? `–${row.end_time}` : ''}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'teacher',
        header: 'Examiner',
        cell: (row) =>
          row.teacher ? (
            <span className="text-muted">
              {row.teacher.first_name} {row.teacher.last_name}
            </span>
          ) : (
            <span className="text-muted-soft">unassigned</span>
          ),
      },
      {
        key: 'marks_state',
        header: 'Marks',
        cell: (row) =>
          row.marks_submitted_at ? (
            <span className="text-success">submitted {formatDate(row.marks_submitted_at)}</span>
          ) : (
            <span className="text-muted-soft">open for entry</span>
          ),
      },
      ...(canManage
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: ExamSubjectRow) => (
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => openEdit(row)}>
                  Edit
                </button>
              ),
            } as Column<ExamSubjectRow>,
          ]
        : []),
    ],
    [canManage]
  );

  return (
    <div className="space-y-6">
      {subjects.length === 0 ? (
        <EmptyNotice>
          This exam has no papers yet. Nothing can be marked until at least one subject is added — the
          marks and the result calculation both start from a paper.
        </EmptyNotice>
      ) : (
        <DataTable
          columns={columns}
          rows={subjects}
          rowKey={(row) => row.id}
          caption="Papers in this exam"
        />
      )}

      {canManage ? (
        <div>
          <button type="button" className="btn btn-primary" onClick={openAdd}>
            Add a paper
          </button>
        </div>
      ) : null}

      <Modal
        open={open}
        onClose={close}
        title={adding ? 'Add a paper to this exam' : `Edit ${editing ? paperName(editing) : 'paper'}`}
        description={
          adding
            ? 'The subject, what it is marked out of, and what counts as a pass. Everything else can be filled in later.'
            : 'The subject cannot be changed — every mark already entered points at this paper, so moving it would rewrite them. Remove the paper and add the other subject instead.'
        }
        size="lg"
        busy={busy}
        footer={
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>
              Cancel
            </button>
            <SubmitButton
              form="exam-paper"
              busy={busy}
              busyLabel={adding ? 'Adding…' : 'Saving…'}
              fullWidth={false}
            >
              {adding ? 'Add paper' : 'Save changes'}
            </SubmitButton>
          </>
        }
      >
        <form
          id="exam-paper"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {error ? <Notice tone="error">{error}</Notice> : null}

          {adding ? (
            <SelectField
              id="paper-subject"
              label="Subject"
              required
              value={values.subject_id}
              error={fieldErrors.subject_id}
              onChange={(event) => set('subject_id', event.target.value)}
              hint={
                catalogue.loading
                  ? 'Loading the subject catalogue…'
                  : 'From this school’s subject catalogue. A subject this exam already examines is not offered twice.'
              }
            >
              <option value="">Choose a subject…</option>
              {catalogue.rows
                .filter((subject) => !taken.has(subject.id))
                .map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.code ? `${subject.name} (${subject.code})` : subject.name}
                  </option>
                ))}
            </SelectField>
          ) : (
            <Notice tone="info">
              Subject: <strong>{editing ? paperName(editing) : ''}</strong>
            </Notice>
          )}

          <FormGrid>
            <Field
              id="full_marks"
              label="Full marks"
              type="number"
              min={1}
              step="0.01"
              required
              value={values.full_marks}
              error={fieldErrors.full_marks}
              onChange={(event) => set('full_marks', event.target.value)}
              hint="What the paper is out of. A paper out of zero is not a paper, so the API refuses it."
            />
            <Field
              id="passing_marks"
              label="Passing marks"
              type="number"
              min={0}
              step="0.01"
              required
              value={values.passing_marks}
              error={fieldErrors.passing_marks}
              onChange={(event) => set('passing_marks', event.target.value)}
              hint="At or above this is a pass. The grade and the pass/fail outcome are both derived from it."
            />
          </FormGrid>

          <FormGrid>
            <Field
              id="practical_full_marks"
              label="Practical full marks"
              type="number"
              min={1}
              step="0.01"
              value={values.practical_full_marks}
              error={fieldErrors.practical_full_marks}
              onChange={(event) => set('practical_full_marks', event.target.value)}
              hint="Leave both practical fields blank if the paper has no practical component."
            />
            <Field
              id="practical_passing_marks"
              label="Practical passing marks"
              type="number"
              min={0}
              step="0.01"
              value={values.practical_passing_marks}
              error={fieldErrors.practical_passing_marks}
              onChange={(event) => set('practical_passing_marks', event.target.value)}
            />
          </FormGrid>

          <SelectField
            id="paper-teacher"
            label="Examiner"
            value={values.teacher_id}
            error={fieldErrors.teacher_id}
            onChange={(event) => set('teacher_id', event.target.value)}
            hint={
              teachers.loading
                ? 'Loading teachers…'
                : 'Optional. Recorded on the paper; it does not by itself decide who may enter the marks — that is the marks.enter permission.'
            }
          >
            <option value="">Unassigned</option>
            {teachers.rows.map((teacher) => (
              <option key={teacher.id} value={teacher.id}>
                {teacher.first_name} {teacher.last_name}
                {teacher.employee_id ? ` (${teacher.employee_id})` : ''}
              </option>
            ))}
          </SelectField>

          <FormGrid>
            <Field
              id="paper-date"
              label="Sat on"
              type="date"
              value={values.exam_date}
              error={fieldErrors.exam_date}
              onChange={(event) => set('exam_date', event.target.value)}
            />
            <Field
              id="paper-room"
              label="Room"
              value={values.room}
              error={fieldErrors.room}
              onChange={(event) => set('room', event.target.value)}
            />
          </FormGrid>

          <FormGrid>
            <Field
              id="paper-start"
              label="Starts"
              type="time"
              value={values.start_time}
              error={fieldErrors.start_time}
              onChange={(event) => set('start_time', event.target.value)}
            />
            <Field
              id="paper-end"
              label="Ends"
              type="time"
              value={values.end_time}
              error={fieldErrors.end_time}
              onChange={(event) => set('end_time', event.target.value)}
            />
          </FormGrid>

          <TextAreaField
            id="paper-reason"
            label="Reason"
            rows={2}
            value={values.reason}
            onChange={(event) => set('reason', event.target.value)}
            hint="Recorded in the audit trail."
          />
        </form>
      </Modal>
    </div>
  );
}
