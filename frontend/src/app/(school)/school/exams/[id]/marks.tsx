'use client';

/**
 * Marks entry — SRS §19.2, FR-EXAM-002 *"Teacher enters marks per student"*.
 *
 * `POST /exams/marks` and `POST /exams/marks/submit`, neither of which had a caller. This is the
 * screen §19 is actually about: an exam with papers but no way to mark them is a timetable.
 *
 * ## One paper at a time, and the reason is not screen space
 *
 * `GET /exams/marks` accepts `exam_id` as well as `exam_subject_id`, so a single table spanning the
 * whole exam is available and is not offered. Marks are only comparable within a paper: 80 out of
 * 100 and 80 out of 200 are the same number and not the same result, and a column headed "Marks"
 * carrying both is a column that invites the wrong comparison. `enterMarks` is also **per paper** —
 * `exam_subject_id` is a required scalar, not one field per row — so a mixed table could not be
 * saved in one request anyway.
 *
 * ## Absent is not zero, and the form makes that structural
 *
 * §19's absence rule appears in three places already (`subjectRows()` in the PDF renderer, the
 * result calculation, and the mark schema's own `is_absent`). Zero is a mark a student can earn by
 * answering everything wrongly; absence is the absence of a mark. So ticking **Absent** clears and
 * disables the mark inputs rather than sending `0`, and a blank mark is sent as `null` — *not
 * entered* — which is a third state again.
 *
 * ## Submission is the one-way door, and it is the only thing here that is
 *
 * Re-posting marks **corrects** them: the unique index over `(exam_subject_id, student_id)` makes
 * the write an upsert, which is what §19's *"Teacher may edit entered marks prior to submission"*
 * asks for. `POST /exams/marks/submit` ends that — it stamps `marks_submitted_at`, and the result
 * calculation reads only submitted papers. The confirmation says both halves, because an operator
 * who believes submission is a save will press it after every row.
 *
 * ## What this screen does not derive
 *
 * `grade_name` and `outcome` are `forbidden()` in the schema and absent from every request here.
 * They are computed from the paper's passing marks by the service, which is also what the result
 * calculation and the PDF read. A second opinion in the browser is how two of them come to disagree.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { Notice, SelectField, SubmitButton, TextAreaField } from '@/components/form';
import { Modal } from '@/components/overlay';
import { EmptyNotice, ErrorNotice, LoadingBlock } from '@/components/table';
import { useToast } from '@/components/toast';

import { markLabel, paperName, studentName } from './detail';
import type { ExamSubjectRow, MarkRow } from './detail';

/** One row of `GET /students`, which is where the roll for an unmarked paper comes from. */
interface StudentOption {
  id: number;
  student_id: string | null;
  roll_number: string | null;
  first_name: string;
  last_name: string;
}

/** What the editor holds per student while it is being filled in. */
interface Entry {
  student_id: number;
  label: string;
  roll: string | null;
  marks: string;
  practical: string;
  absent: boolean;
  remarks: string;
  /** From the server, so a row that has already been marked shows what it was given. */
  grade: string | null;
  outcome: string | null;
  status: string;
}

export function MarksPanel({
  exam,
  subjects,
  canEnter,
  onSubmitted,
}: {
  exam: { id: number; class_id: number; section_id: number | null; status: string };
  subjects: ExamSubjectRow[];
  /** `marks.enter`. The API re-checks it. */
  canEnter: boolean;
  /** Called after a submit, because it stamps `marks_submitted_at` on the paper. */
  onSubmitted: () => void;
}) {
  const { success } = useToast();

  const [paperId, setPaperId] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const paper = useMemo(
    () => subjects.find((row) => String(row.id) === paperId) ?? null,
    [subjects, paperId]
  );

  const locked = paper !== null && paper.marks_submitted_at !== null;

  /**
   * Load the roll for the chosen paper.
   *
   * Two reads, because neither alone is the roll: `GET /exams/marks` returns the students already
   * marked, and `GET /students` returns the class. A paper nobody has marked yet has **no** mark
   * rows at all, so a screen built on the first read alone would show an empty table for the case it
   * exists to serve. The two are merged by `student_id`, marks winning where both have a row.
   */
  const load = useCallback(async () => {
    if (!paper) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [marked, roll] = await Promise.all([
        api.page<MarkRow[]>('/exams/marks', {
          /* `PAGINATION.MAX_LIMIT` is 100; a larger limit is a 422, not a bigger page. */
          query: { exam_subject_id: paper.id, limit: 100 },
        }),
        api.page<StudentOption[]>('/students', {
          query: {
            class_id: exam.class_id,
            ...(exam.section_id ? { section_id: exam.section_id } : {}),
            status: 'active',
            limit: 100,
          },
        }),
      ]);

      const byStudent = new Map<number, MarkRow>();
      for (const row of marked.data) byStudent.set(row.student_id, row);

      const merged: Entry[] = roll.data.map((student) => {
        const mark = byStudent.get(student.id);
        return {
          student_id: student.id,
          label: `${student.first_name} ${student.last_name}`.trim(),
          roll: student.roll_number,
          marks: mark && mark.marks_obtained !== null ? String(mark.marks_obtained) : '',
          practical:
            mark && mark.practical_marks_obtained !== null
              ? String(mark.practical_marks_obtained)
              : '',
          absent: mark ? Boolean(mark.is_absent) : false,
          remarks: mark?.remarks ?? '',
          grade: mark?.grade_name ?? null,
          outcome: mark?.outcome ?? null,
          status: mark?.status ?? 'not entered',
        };
      });

      /*
       * A marked student who is not on the roll still has to appear. It happens when a student is
       * transferred or marked left after sitting the paper: dropping them would hide a mark that is
       * in the result calculation, and the operator would have no way to see it at all.
       */
      for (const [studentId, mark] of byStudent) {
        if (merged.some((entry) => entry.student_id === studentId)) continue;
        merged.push({
          student_id: studentId,
          label: `${studentName(mark)} (no longer on this class roll)`,
          roll: mark.student?.roll_number ?? null,
          marks: mark.marks_obtained === null ? '' : String(mark.marks_obtained),
          practical:
            mark.practical_marks_obtained === null ? '' : String(mark.practical_marks_obtained),
          absent: Boolean(mark.is_absent),
          remarks: mark.remarks ?? '',
          grade: mark.grade_name,
          outcome: mark.outcome,
          status: mark.status,
        });
      }

      setEntries(merged);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setLoading(false);
    }
  }, [paper, exam.class_id, exam.section_id]);

  useEffect(() => {
    void load();
  }, [load]);

  function update(studentId: number, patch: Partial<Entry>) {
    setEntries((current) =>
      current.map((entry) => (entry.student_id === studentId ? { ...entry, ...patch } : entry))
    );
  }

  async function save() {
    if (!paper || saving || locked) return;
    setSaving(true);
    setError(null);
    try {
      /*
       * Every row is sent, including the untouched ones. The write is an upsert keyed on
       * `(exam_subject_id, student_id)`, so re-sending an unchanged row is a no-op — and sending
       * only the changed ones would mean tracking which those are, which is the bug this avoids
       * rather than the optimisation it forgoes.
       */
      const payload = entries.map((entry) => ({
        student_id: entry.student_id,
        is_absent: entry.absent,
        /* Absent clears both marks: §19 does not let an absent student hold a score. */
        marks_obtained: entry.absent || entry.marks.trim() === '' ? null : entry.marks.trim(),
        practical_marks_obtained:
          entry.absent || entry.practical.trim() === '' ? null : entry.practical.trim(),
        remarks: entry.remarks.trim() === '' ? null : entry.remarks.trim(),
      }));

      await api.post('/exams/marks', {
        exam_subject_id: paper.id,
        entries: payload,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      success('Marks saved', 'They can still be corrected until the paper is submitted.');
      setReason('');
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    if (!paper || submitBusy) return;
    setSubmitBusy(true);
    setSubmitError(null);
    try {
      await api.post('/exams/marks/submit', {
        exam_subject_id: paper.id,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      success('Paper submitted', 'Its marks are now final and count towards the results.');
      setConfirmSubmit(false);
      setReason('');
      onSubmitted();
      await load();
    } catch (caught) {
      setSubmitError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setSubmitBusy(false);
    }
  }

  const entered = entries.filter((entry) => entry.absent || entry.marks.trim() !== '').length;

  if (subjects.length === 0) {
    return (
      <EmptyNotice>
        There is nothing to mark: this exam has no papers yet. Add one on the Papers tab first.
      </EmptyNotice>
    );
  }

  return (
    <div className="space-y-6">
      <div className="max-w-md">
        <SelectField
          id="marks-paper"
          label="Paper"
          value={paperId}
          onChange={(event) => setPaperId(event.target.value)}
          hint="Marks are entered one paper at a time — they are only comparable within a paper."
        >
          <option value="">Choose a paper…</option>
          {subjects.map((row) => (
            <option key={row.id} value={row.id}>
              {paperName(row)} — out of {row.full_marks}
              {row.marks_submitted_at ? ' (submitted)' : ''}
            </option>
          ))}
        </SelectField>
      </div>

      {!paper ? null : (
        <>
          {locked ? (
            <Notice tone="info">
              This paper’s marks were submitted and are final. They count towards the result
              calculation and can no longer be entered or corrected here.
            </Notice>
          ) : null}

          {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}

          {loading ? (
            <LoadingBlock />
          ) : entries.length === 0 ? (
            <EmptyNotice>
              No student is enrolled in this exam’s class, so there is nobody to mark. Admit or
              promote students into the class first.
            </EmptyNotice>
          ) : (
            <>
              <p className="text-sm text-muted">
                {entered} of {entries.length} marked · out of{' '}
                <strong>{paper.full_marks}</strong>, pass at <strong>{paper.passing_marks}</strong>
                {paper.practical_full_marks === null
                  ? null
                  : `, practical out of ${paper.practical_full_marks} passing at ${paper.practical_passing_marks}`}
              </p>

              {/* Wide by nature; the container scrolls rather than the page. */}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] border-collapse text-sm">
                  <caption className="sr-only">Marks for {paperName(paper)}</caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                      <th scope="col" className="py-2 pr-3">Roll</th>
                      <th scope="col" className="py-2 pr-3">Student</th>
                      <th scope="col" className="py-2 pr-3">Marks</th>
                      {paper.practical_full_marks === null ? null : (
                        <th scope="col" className="py-2 pr-3">Practical</th>
                      )}
                      <th scope="col" className="py-2 pr-3">Absent</th>
                      <th scope="col" className="py-2 pr-3">Remarks</th>
                      <th scope="col" className="py-2 pr-3">Recorded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.student_id} className="border-b border-border-soft">
                        <td className="py-2 pr-3 text-muted-soft">{entry.roll ?? '—'}</td>
                        <td className="py-2 pr-3">{entry.label}</td>
                        <td className="py-2 pr-3">
                          <label className="sr-only" htmlFor={`marks-${entry.student_id}`}>
                            Marks for {entry.label}
                          </label>
                          <input
                            id={`marks-${entry.student_id}`}
                            type="number"
                            step="0.01"
                            min={0}
                            max={Number(paper.full_marks)}
                            className="field-input w-24"
                            value={entry.marks}
                            disabled={entry.absent || locked || !canEnter}
                            onChange={(event) =>
                              update(entry.student_id, { marks: event.target.value })
                            }
                          />
                        </td>
                        {paper.practical_full_marks === null ? null : (
                          <td className="py-2 pr-3">
                            <label className="sr-only" htmlFor={`practical-${entry.student_id}`}>
                              Practical marks for {entry.label}
                            </label>
                            <input
                              id={`practical-${entry.student_id}`}
                              type="number"
                              step="0.01"
                              min={0}
                              max={Number(paper.practical_full_marks)}
                              className="field-input w-24"
                              value={entry.practical}
                              disabled={entry.absent || locked || !canEnter}
                              onChange={(event) =>
                                update(entry.student_id, { practical: event.target.value })
                              }
                            />
                          </td>
                        )}
                        <td className="py-2 pr-3">
                          <label className="sr-only" htmlFor={`absent-${entry.student_id}`}>
                            {entry.label} was absent
                          </label>
                          <input
                            id={`absent-${entry.student_id}`}
                            type="checkbox"
                            className="size-4"
                            checked={entry.absent}
                            disabled={locked || !canEnter}
                            onChange={(event) =>
                              /* Ticking absent clears the marks rather than sending 0 beside it. */
                              update(entry.student_id, {
                                absent: event.target.checked,
                                marks: event.target.checked ? '' : entry.marks,
                                practical: event.target.checked ? '' : entry.practical,
                              })
                            }
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <label className="sr-only" htmlFor={`remarks-${entry.student_id}`}>
                            Remarks for {entry.label}
                          </label>
                          <input
                            id={`remarks-${entry.student_id}`}
                            type="text"
                            className="field-input w-40"
                            value={entry.remarks}
                            disabled={locked || !canEnter}
                            onChange={(event) =>
                              update(entry.student_id, { remarks: event.target.value })
                            }
                          />
                        </td>
                        <td className="py-2 pr-3">
                          {/*
                            * What the server made of the marks last time they were saved — the
                            * grade and the pass/fail outcome, both derived there and neither
                            * recomputed here. Blank until the row has been saved once.
                            */}
                          {entry.grade || entry.outcome ? (
                            <span className="text-xs text-muted">
                              {entry.grade ?? '—'}
                              {entry.outcome ? ` · ${entry.outcome}` : ''}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-soft">
                              {markLabel(null, entry.absent)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {canEnter && !locked ? (
                <form
                  className="space-y-4"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <TextAreaField
                    id="marks-reason"
                    label="Reason"
                    rows={2}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    hint="Recorded in the audit trail — worth filling in when a mark is being corrected."
                  />
                  <div className="flex flex-wrap gap-2">
                    <SubmitButton busy={saving} busyLabel="Saving…" fullWidth={false}>
                      Save marks
                    </SubmitButton>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        setConfirmSubmit(true);
                        setSubmitError(null);
                      }}
                    >
                      Submit paper
                    </button>
                  </div>
                </form>
              ) : null}
            </>
          )}
        </>
      )}

      <Modal
        open={confirmSubmit}
        onClose={() => {
          if (!submitBusy) setConfirmSubmit(false);
        }}
        title={`Submit ${paper ? paperName(paper) : 'this paper'}?`}
        description="Submitting is what makes these marks count towards the results — and it is final. They cannot be entered or corrected here afterwards. Save first if anything is still being typed."
        size="sm"
        busy={submitBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={submitBusy}
              onClick={() => setConfirmSubmit(false)}
            >
              Go back
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={submitBusy}
              aria-busy={submitBusy}
              onClick={() => void submit()}
            >
              {submitBusy ? 'Submitting…' : 'Submit paper'}
            </button>
          </>
        }
      >
        {submitError ? <Notice tone="error">{submitError}</Notice> : null}
        {entered < entries.length ? (
          <Notice tone="warn">
            {entries.length - entered} of {entries.length} students have no mark and are not marked
            absent. Submitting now records them as unmarked.
          </Notice>
        ) : null}
      </Modal>
    </div>
  );
}
