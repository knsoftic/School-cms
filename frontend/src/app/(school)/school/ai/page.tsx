'use client';

/**
 * The AI question generator — SRS §21, FR-AI-001, and six write routes with no caller and no screen.
 *
 * `POST /ai/banks` (upload), `/banks/:id/extract`, `/analyze`, `/generate`, `/difficulty` and
 * `/approve`. §21's nine-step workflow is built, module-gated, metered against `ai_limit` and
 * verified by 188 backend assertions — and there was no way to start it.
 *
 * ## §33 lists no AI screen, and §21 describes a workflow rather than a screen
 *
 * The same reading as school settings and assignments: the requirement is stated and the screen list
 * is not the requirement. Reached from the school dashboard, because the School nav is fixed at
 * §33's seventeen and `verify-frontend.js` asserts the count.
 *
 * ## The workflow is a state machine and this screen never guesses at it
 *
 * `workflow_stage` moves uploaded → extracted → analyzed → generated → preview → approved, and every
 * transition is refused out of order by the service. So the action offered on a bank is derived from
 * the stage the **server** reports, one step at a time, rather than from a wizard tracking where it
 * thinks the user is. A screen that kept its own position would eventually disagree with the row,
 * and the row is what the API enforces against.
 *
 * The preview-and-approve half is the reason the machine exists at all: `workflow_stage` is
 * `forbidden()` in every schema precisely so that nothing can jump to `approved` and put unreviewed
 * questions into the Question Bank. This screen sends no stage anywhere.
 *
 * ## Generation is the metered step, and it is the only one
 *
 * `enforceLimit(LIMITS.AI_LIMIT)` guards `POST /banks/:id/generate` alone, and it is the only caller
 * of `recordUsage`. Extraction and analysis are free — §21's own example is "Plan: 1000 AI Requests",
 * and metering all three would buy a school 333 question sets. The usage figure is read from
 * `GET /ai/usage` and shown beside the button, so what a generation costs is visible before it is
 * spent.
 *
 * ## Approval is per question, and rejecting is not deleting
 *
 * `POST /banks/:id/approve` takes `approve` and `reject` as two arrays of question ids. An approved
 * question enters the Question Bank; a rejected one stays on the bank with its status changed, which
 * is what makes the decision reviewable afterwards. Neither list is inferred from the other — a
 * question in neither array is simply not yet decided, and that is a real third state.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import {
  Field,
  FileField,
  FormGrid,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form';
import { Modal } from '@/components/overlay';
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

/** One `question_banks` row, as `presentBank()` returns it. */
interface Bank {
  id: number;
  name: string;
  topic: string | null;
  source_type: string;
  source_filename: string | null;
  workflow_stage: string;
  requested_difficulty: string | null;
  requested_count: number | null;
  generated_count: number;
  approved_count: number;
  ai_model: string | null;
  error_message: string | null;
}

/** One generated question, as `GET /banks/:id/questions` returns it. */
interface Question {
  id: number;
  question_text: string;
  type: string;
  options: unknown;
  correct_option: string | null;
  difficulty: string | null;
  status: string;
  marks: number | string | null;
}

/** `GET /ai/usage`. */
interface Usage {
  used: number;
  allowed: number | null;
  remaining: number | null;
}

const SOURCE_TYPES = ['pdf', 'image', 'syllabus'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

/**
 * What can be done at each stage, and what it does.
 *
 * Keyed by the stage the **server** reports. A stage with no entry offers nothing, which is correct
 * for `approved` and `rejected` — both are ends.
 */
const NEXT_STEP: Record<
  string,
  { action: string; label: string; description: string; metered?: boolean }
> = {
  uploaded: {
    action: 'extract',
    label: 'Extract the text',
    description:
      'Reads the uploaded source and pulls its text out. Free — only generation counts against the AI allowance.',
  },
  extracted: {
    action: 'analyze',
    label: 'Analyse the topics',
    description:
      'Works out what the extracted text is about, which is what the questions are then generated from. Also free.',
  },
  analyzed: {
    action: 'generate',
    label: 'Generate questions',
    description:
      'The metered step: this is what counts against the plan’s AI allowance. Nothing is added to the Question Bank yet — the questions come back for review first.',
    metered: true,
  },
  generated: {
    action: 'review',
    label: 'Review the questions',
    description: 'Approve the ones worth keeping and reject the rest.',
  },
  preview: {
    action: 'review',
    label: 'Review the questions',
    description: 'Approve the ones worth keeping and reject the rest.',
  },
};

const spell = (value: string) => value.replace(/_/g, ' ');

export default function AiPage() {
  const { can } = useAuth();
  const { success } = useToast();

  const [page, setPage] = useState(1);
  const banks = useCollection<Bank>('/ai/banks', useMemo(() => ({ page, limit: 20 }), [page]));

  const canGenerate = can('ai.generate');
  const canApprove = can('ai.approve');

  const [usage, setUsage] = useState<Usage | null>(null);
  const [creating, setCreating] = useState(false);
  const [working, setWorking] = useState<Bank | null>(null);
  const [reviewing, setReviewing] = useState<Bank | null>(null);

  /* upload */
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState('pdf');
  const [topic, setTopic] = useState('');
  const [source, setSource] = useState<File | null>(null);

  /* generate */
  const [count, setCount] = useState('10');
  const [difficulty, setDifficulty] = useState('medium');

  /* review */
  const [questions, setQuestions] = useState<Question[]>([]);
  const [approve, setApprove] = useState<number[]>([]);
  const [reject, setReject] = useState<number[]>([]);
  const [reviewNote, setReviewNote] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const loadUsage = useCallback(async () => {
    try {
      const result = await api.get<{ usage: Usage }>('/ai/usage');
      setUsage(result.usage);
    } catch {
      /* The allowance is context, not the point of the screen; its absence is not an error here. */
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  async function upload() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      /* Multipart: §21 step 1 is a file, and `uploadSingle` parses the body before `validate()`. */
      const form = new FormData();
      form.append('name', name.trim());
      form.append('source_type', sourceType);
      if (topic.trim()) form.append('topic', topic.trim());
      if (source) form.append('source', source);

      await api.post('/ai/banks', undefined, { formData: form });
      success('Source uploaded', 'Extract its text to carry on.');
      setCreating(false);
      setName('');
      setTopic('');
      setSource(null);
      banks.reload();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(Array.isArray(caught.details) ? caught.fieldErrors() : {});
        setError(
          Array.isArray(caught.details)
            ? caught.bannerFor(['name', 'source_type', 'topic', 'source'])
            : caught.message
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function advance(bank: Bank, action: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      /*
       * Four calls written out. The path cannot be built from `action`: `verify-frontend.js` looks
       * for the literal at the call, and an interpolated stage name would leave every one of these
       * reporting as uncalled — which is the state this screen exists to end.
       */
      if (action === 'extract') {
        await api.post(`/ai/banks/${bank.id}/extract`, {});
        success('Text extracted');
      } else if (action === 'analyze') {
        await api.post(`/ai/banks/${bank.id}/analyze`, {});
        success('Topics analysed');
      } else if (action === 'difficulty') {
        await api.post(`/ai/banks/${bank.id}/difficulty`, { difficulty });
        success(`Difficulty set to ${difficulty}`);
      } else {
        await api.post(`/ai/banks/${bank.id}/generate`, {
          count: count.trim(),
          difficulty,
        });
        success('Questions generated', 'Review them before anything reaches the Question Bank.');
        void loadUsage();
      }
      setWorking(null);
      banks.reload();
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

  async function openReview(bank: Bank) {
    setReviewing(bank);
    setQuestions([]);
    setApprove([]);
    setReject([]);
    setReviewNote('');
    setError(null);
    setBusy(true);
    try {
      const result = await api.page<Question[]>(`/ai/banks/${bank.id}/questions`, {
        query: { limit: 100 },
      });
      setQuestions(result.data);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not load the generated questions.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitReview() {
    if (!reviewing || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/ai/banks/${reviewing.id}/approve`, {
        approve,
        reject,
        review_note: reviewNote.trim() || undefined,
      });
      success(
        `${approve.length} approved, ${reject.length} rejected`,
        approve.length > 0 ? 'The approved questions are in the Question Bank.' : undefined
      );
      setReviewing(null);
      banks.reload();
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

  /** Move a question between approve, reject and undecided — three states, not a checkbox. */
  function decide(id: number, verdict: 'approve' | 'reject' | 'undecided') {
    setApprove((current) =>
      verdict === 'approve' ? [...new Set([...current, id])] : current.filter((x) => x !== id)
    );
    setReject((current) =>
      verdict === 'reject' ? [...new Set([...current, id])] : current.filter((x) => x !== id)
    );
  }

  const columns = useMemo<Column<Bank>[]>(
    () => [
      {
        key: 'name',
        header: 'Question bank',
        cell: (row) => (
          <div>
            <span className="font-medium">{row.name}</span>
            <span className="block text-xs text-muted-soft">
              {spell(row.source_type)}
              {row.topic ? ` · ${row.topic}` : ''}
            </span>
          </div>
        ),
      },
      {
        key: 'stage',
        header: 'Stage',
        cell: (row) => (
          <div>
            <StatusBadge status={row.workflow_stage === 'approved' ? 'approved' : 'pending'} />
            <span className="block text-xs text-muted-soft">{spell(row.workflow_stage)}</span>
            {row.error_message ? (
              <span className="block max-w-xs truncate text-xs text-danger">
                {row.error_message}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'counts',
        header: 'Questions',
        numeric: true,
        cell: (row) => (
          <div>
            <span>{row.generated_count} generated</span>
            <span className="block text-xs text-muted-soft">{row.approved_count} approved</span>
          </div>
        ),
      },
      {
        key: 'actions',
        header: 'Next step',
        cell: (row) => {
          const step = NEXT_STEP[row.workflow_stage];
          if (!step) {
            return <span className="text-muted-soft">{spell(row.workflow_stage)}</span>;
          }
          if (step.action === 'review') {
            return canApprove ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void openReview(row)}
              >
                {step.label}
              </button>
            ) : (
              <span className="text-muted-soft">awaiting review</span>
            );
          }
          return canGenerate ? (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                setWorking(row);
                setError(null);
              }}
            >
              {step.label}
            </button>
          ) : (
            <span className="text-muted-soft">{step.label}</span>
          );
        },
      },
    ],
    [canApprove, canGenerate]
  );

  const step = working ? NEXT_STEP[working.workflow_stage] : null;

  return (
    <div>
      <PageHeader
        title="AI question generator"
        description="SRS §21 — upload a source, generate questions from it, and review them before any reach the Question Bank."
        action={
          <div className="flex gap-2">
            <Link href="/school" className="btn btn-secondary">
              Back to dashboard
            </Link>
            {canGenerate ? (
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Upload a source
              </button>
            ) : null}
          </div>
        }
      />

      {usage ? (
        <div className="mb-6">
          <Notice tone="info">
            {/*
              * `allowed` is null for an unlimited allowance, which is a different thing from zero —
              * showing "0 of 0" for a school with no ceiling would read as exhausted.
              */}
            {usage.allowed === null
              ? `${usage.used} generation${usage.used === 1 ? '' : 's'} used this period — the plan sets no ceiling.`
              : `${usage.used} of ${usage.allowed} generations used this period, ${usage.remaining ?? 0} left. Only generating counts; extracting and analysing are free.`}
          </Notice>
        </div>
      ) : null}

      {error && !working && !reviewing && !creating ? (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}

      {banks.refusal ? (
        <RefusalNotice refusal={banks.refusal} />
      ) : banks.error ? (
        <ErrorNotice message={banks.error} onRetry={banks.reload} />
      ) : banks.loading && banks.rows.length === 0 ? (
        <LoadingBlock />
      ) : banks.rows.length === 0 ? (
        <EmptyNotice>
          Nothing has been uploaded. §21’s workflow starts with a PDF, an image or a syllabus, and
          each step is taken deliberately — nothing reaches the Question Bank without being reviewed.
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={banks.rows}
            rowKey={(row) => row.id}
            caption="Question banks"
            busy={banks.loading}
          />
          {banks.meta ? <Pagination meta={banks.meta} onPage={setPage} /> : null}
        </>
      )}

      <Modal
        open={creating}
        onClose={() => {
          if (!busy) setCreating(false);
        }}
        title="Upload a source"
        description="Step one of §21's workflow. Nothing is generated yet — the text is extracted and analysed first, and both of those are free."
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
            <SubmitButton form="upload-source" busy={busy} busyLabel="Uploading…" fullWidth={false}>
              Upload
            </SubmitButton>
          </>
        }
      >
        <form
          id="upload-source"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void upload();
          }}
        >
          {error ? <Notice tone="error">{error}</Notice> : null}

          <Field
            id="name"
            label="Name"
            required
            value={name}
            error={fieldErrors.name}
            onChange={(event) => setName(event.target.value)}
            hint="What this set of questions is for — “Chapter 4 revision”, say."
          />

          <FormGrid>
            <SelectField
              id="source_type"
              label="Source"
              required
              value={sourceType}
              error={fieldErrors.source_type}
              onChange={(event) => setSourceType(event.target.value)}
              hint="The three §21 names. The file is checked against it."
            >
              {SOURCE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </SelectField>
            <Field
              id="topic"
              label="Topic"
              value={topic}
              error={fieldErrors.topic}
              onChange={(event) => setTopic(event.target.value)}
            />
          </FormGrid>

          <FileField
            id="source"
            label="File"
            file={source}
            onChange={(file) => setSource(file)}
            hint="The document the questions are generated from."
          />
        </form>
      </Modal>

      <Modal
        open={working !== null}
        onClose={() => {
          if (!busy) setWorking(null);
        }}
        title={step ? step.label : ''}
        description={step?.description}
        size="sm"
        busy={busy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setWorking(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              aria-busy={busy}
              onClick={() => working && step && void advance(working, step.action)}
            >
              {busy ? 'Working…' : step?.label ?? 'Continue'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {error ? <Notice tone="error">{error}</Notice> : null}

          {step?.metered ? (
            <>
              <FormGrid>
                <Field
                  id="count"
                  label="How many"
                  type="number"
                  min={1}
                  max={50}
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                  hint="Up to fifty in one request."
                />
                <SelectField
                  id="difficulty"
                  label="Difficulty"
                  value={difficulty}
                  onChange={(event) => setDifficulty(event.target.value)}
                  hint="A hint to the generation. It can also be set separately afterwards."
                >
                  {DIFFICULTIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </SelectField>
              </FormGrid>

              {/*
                * `POST /banks/:id/difficulty` is SRS:1160's own step — choosing a difficulty for a
                * bank after generation, rather than as an input to it. Offered here because this is
                * where a teacher already is, and written as a separate call because it is one.
                */}
              {working && working.generated_count > 0 ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => working && void advance(working, 'difficulty')}
                >
                  Set the difficulty without generating again
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={reviewing !== null}
        onClose={() => {
          if (!busy) setReviewing(null);
        }}
        title={reviewing ? `Review ${reviewing.name}` : ''}
        description="Approved questions go into the Question Bank. Rejected ones stay here with the decision recorded. A question you leave alone is neither, and can be decided later."
        size="lg"
        busy={busy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setReviewing(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || (approve.length === 0 && reject.length === 0)}
              aria-busy={busy}
              onClick={() => void submitReview()}
            >
              {busy ? 'Saving…' : `Approve ${approve.length}, reject ${reject.length}`}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {error ? <Notice tone="error">{error}</Notice> : null}

          {questions.length === 0 && !busy ? (
            <p className="text-sm text-muted">No question has been generated for this bank.</p>
          ) : null}

          <ul className="space-y-3">
            {questions.map((question) => (
              <li key={question.id} className="rounded-lg border border-border p-3">
                <p className="text-sm">{question.question_text}</p>
                <p className="mt-1 text-xs text-muted-soft">
                  {spell(question.type)}
                  {question.difficulty ? ` · ${question.difficulty}` : ''}
                  {question.marks === null ? '' : ` · ${question.marks} marks`}
                  {` · ${question.status}`}
                </p>
                <div className="mt-2">
                  <label className="sr-only" htmlFor={`verdict-${question.id}`}>
                    Verdict for this question
                  </label>
                  <select
                    id={`verdict-${question.id}`}
                    className="field-select w-48"
                    value={
                      approve.includes(question.id)
                        ? 'approve'
                        : reject.includes(question.id)
                          ? 'reject'
                          : 'undecided'
                    }
                    onChange={(event) =>
                      decide(question.id, event.target.value as 'approve' | 'reject' | 'undecided')
                    }
                  >
                    <option value="undecided">Not decided</option>
                    <option value="approve">Approve</option>
                    <option value="reject">Reject</option>
                  </select>
                </div>
              </li>
            ))}
          </ul>

          <TextAreaField
            id="review_note"
            label="Review note"
            rows={2}
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            hint="Recorded against the decision."
          />
        </div>
      </Modal>
    </div>
  );
}
