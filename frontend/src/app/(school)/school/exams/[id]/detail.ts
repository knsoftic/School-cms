'use client';

/**
 * One exam, its papers and its marks — the shapes and the fetch behind SRS §19's write routes.
 *
 * ## Why a module rather than the page's top half
 *
 * The same reason the subscription detail screen has one: three panels render parts of the same
 * record, and marks entry changes what the papers panel shows (`marks_submitted_at`) while adding a
 * paper changes what marks entry can be entered against. One loader, one `reload`, no prop drilling
 * of a setter through three components.
 *
 * ## The reads this screen is built on
 *
 * `GET /exams/:id` → `{ exam }`, `GET /exams/:id/subjects` → `{ subjects: [] }` (each with its
 * `subject` and `teacher` associations), and `GET /exams/marks` → a **paginated** list scoped by
 * `exam_subject_id`, each row carrying its `student`. Three different envelope shapes, which is why
 * each is unwrapped where it is fetched rather than by a shared helper that would have to know all
 * three.
 *
 * ## Marks are fetched per paper, not per exam
 *
 * `GET /exams/marks` accepts both `exam_id` and `exam_subject_id`. The screen always sends the
 * latter, because marks entry is per paper — a teacher marks one subject's paper for a whole class —
 * and a list spanning every paper would mix mark scales that are not comparable: 80 out of 100 and
 * 80 out of 200 are the same number and not the same result.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** `GET /exams/:id` — the `exams` columns plus the one association the service includes. */
export interface ExamDetail {
  id: number;
  name: string;
  exam_type: string;
  class_id: number;
  section_id: number | null;
  academic_session_id: number | null;
  start_date: string | null;
  end_date: string | null;
  grade_scale: string | null;
  status: string;
  published_at: string | null;
  announced_at: string | null;
  description: string | null;
  class?: { id: number; name: string } | null;
}

/** One `exam_subjects` row — a **paper**, in the language this screen uses with the user. */
export interface ExamSubjectRow {
  id: number;
  exam_id: number;
  subject_id: number;
  teacher_id: number | null;
  full_marks: number | string;
  passing_marks: number | string;
  practical_full_marks: number | string | null;
  practical_passing_marks: number | string | null;
  exam_date: string | null;
  start_time: string | null;
  end_time: string | null;
  room: string | null;
  /**
   * Stamped by `POST /exams/marks/submit`, and the single most consequential field on this screen:
   * a submitted paper's marks can no longer be entered or corrected, and the result calculation
   * reads only submitted papers.
   */
  marks_submitted_at: string | null;
  subject?: { id: number; name: string; code: string | null } | null;
  teacher?: { id: number; first_name: string; last_name: string; employee_id: string | null } | null;
}

/** One `marks` row as `GET /exams/marks` returns it. */
export interface MarkRow {
  id: number;
  exam_subject_id: number;
  student_id: number;
  marks_obtained: number | string | null;
  practical_marks_obtained: number | string | null;
  is_absent: boolean;
  /* Both derived by the calculation from the paper's passing marks — never sent by this screen. */
  grade_name: string | null;
  outcome: string | null;
  status: string;
  remarks: string | null;
  student?: {
    id: number;
    student_id: string | null;
    roll_number: string | null;
    first_name: string;
    last_name: string;
  } | null;
}

export interface ExamScope {
  exam: ExamDetail | null;
  subjects: ExamSubjectRow[];
  loading: boolean;
  error: string | null;
  refusal: Refusal | null;
  reload: () => void;
  /** Adopt the exam a write returned, without a second round trip. */
  adoptExam: (exam: ExamDetail) => void;
}

export function useExamDetail(id: string | null): ExamScope {
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [subjects, setSubjects] = useState<ExamSubjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!id) {
      setExam(null);
      return undefined;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        const [record, papers] = await Promise.all([
          api.get<{ exam: ExamDetail }>(`/exams/${id}`, { signal: controller.signal }),
          api.get<{ subjects: ExamSubjectRow[] }>(`/exams/${id}/subjects`, {
            signal: controller.signal,
          }),
        ]);
        if (controller.signal.aborted) return;
        setExam(record.exam);
        setSubjects(papers.subjects);
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
  }, [id, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const adoptExam = useCallback((next: ExamDetail) => setExam(next), []);

  return { exam, subjects, loading, error, refusal, reload, adoptExam };
}

/* ───────────────────────────── shared formatting ───────────────────────────── */

export function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * A mark for display: the number as stored, or the word for the two cases a number would misreport.
 *
 * `null` is *not entered* and `is_absent` is *did not sit the paper*. §19's own absence rule — which
 * `subjectRows()` in the PDF renderer states and this mirrors — is that neither may be shown as `0`,
 * because 0 is a mark a student can earn by answering everything wrongly.
 */
export function markLabel(value: number | string | null, absent: boolean): string {
  if (absent) return 'absent';
  if (value === null || value === '') return '—';
  return String(value);
}

/** A student's name, or a stand-in that still identifies the row. */
export function studentName(row: MarkRow): string {
  if (!row.student) return `Student #${row.student_id}`;
  return `${row.student.first_name} ${row.student.last_name}`.trim();
}

/** A paper's name, falling back to its id rather than rendering an empty cell. */
export function paperName(row: ExamSubjectRow): string {
  if (!row.subject) return `Paper #${row.id}`;
  return row.subject.code ? `${row.subject.name} (${row.subject.code})` : row.subject.name;
}
