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
 * `generated` → `preview` is its own step, and the easiest one to lose. The only transition that
 * writes `preview` is `POST /banks/:id/difficulty` (SRS:1160, "Teacher selects difficulty"), and the
 * review requires `preview`. This screen used to offer "Review the questions" on a `generated` bank
 * and tuck the difficulty call behind the generate step, where a generated bank could never reach it
 * — so every bank stopped at `generated`, and the review it offered was refused with
 * `AI_STAGE_INVALID`. The difficulty is now the step a `generated` bank offers.
 *
 * The preview-and-approve half is the reason the machine exists at all: `workflow_stage` is
 * `forbidden()` in every schema precisely so that nothing can jump to `approved` and put unreviewed
 * questions into the Question Bank. This screen sends no stage anywhere.
 *
 * ## Generation is the metered step, and it is the only one
 *
 * `enforceLimit(LIMITS.AI_LIMIT)` guards `POST /banks/:id/generate` alone, and it is the only route
 * that spends the allowance: `generate()` reserves one unit before calling the provider
 * (`usageService.reserveUsage`) and gives it back with `releaseUsage` if nothing usable came back.
 * Extraction and analysis are free — §21's own example is "Plan: 1000 AI Requests", and metering all
 * three would buy a school 333 question sets. The usage figure is read from `GET /ai/usage` and shown
 * above the list, so what a generation costs is visible before it is spent — and so is the point at
 * which the next one is refused or billed as overage.
 *
 * ## Approval is per question, and every question has to be decided
 *
 * `POST /banks/:id/approve` takes `approve` and `reject` as two arrays of question ids. An approved
 * question enters the Question Bank; a rejected one stays on the bank with its status changed, which
 * is what makes the decision reviewable afterwards.
 *
 * The API lets a question be named in neither array, and leaves it `pending_review` — but the review
 * also moves the bank on, to `approved` (or to `rejected` when nothing was approved), and the review
 * route requires `preview`. So a question left undecided can never be decided afterwards: nothing
 * can review that bank again. This screen used to call it "a real third state" that "can be decided
 * later". It is not, so the review cannot be saved until every question has a verdict.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { splitApiErrors } from '@/lib/formErrors';
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
  /** `[{ key: 'A', text: '…' }, …]` by the model's comment — read through `optionsOf()`, never trusted. */
  options: unknown;
  correct_option: string | null;
  answer_explanation: string | null;
  difficulty: string | null;
  status: string;
  marks: number | string | null;
}

/** One MCQ choice, as `optionsOf()` recovers it. */
interface QuestionOption {
  key: string;
  text: string;
}

/**
 * `GET /ai/usage` — `ai.service.js`'s `usage()`.
 *
 * `at_limit` is computed there "rather than left for a client to derive from two numbers and get
 * wrong", and `overage_allowed` is what decides whether the next generation is refused or billed.
 */
interface Usage {
  used: number;
  allowed: number | null;
  remaining: number | null;
  unlimited: boolean;
  overage_allowed: boolean;
  at_limit: boolean;
}

const SOURCE_TYPES = ['pdf', 'image', 'syllabus'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

/**
 * The `ai_source` upload profile's allowlist, from `UPLOAD_RULES` — PDF plus the three raster
 * formats, the same whichever source type is chosen. A hint to the file picker only: the server
 * checks the declared type *and* that the extension matches it.
 */
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';

/** The fields a workflow step can refuse by name — the generate step's two inputs, and the difficulty. */
const STEP_FIELDS = new Set(['count', 'difficulty']);

/**
 * What can be done at each stage, what it does, and who may do it.
 *
 * Keyed by the stage the **server** reports. A stage with no entry offers nothing, which is correct
 * for `approved` and `rejected` — both are ends.
 *
 * `needs` is the route's own permission: the first three steps are `ai.generate`, and the difficulty
 * and the review are `ai.approve` (`ai.routes.js`). `waiting` is what a caller without it is shown.
 */
const NEXT_STEP: Record<
  string,
  {
    action: 'extract' | 'analyze' | 'generate' | 'difficulty' | 'review';
    label: string;
    description: string;
    needs: 'generate' | 'approve';
    waiting: string;
  }
> = {
  uploaded: {
    action: 'extract',
    label: 'Extract the text',
    description:
      'Reads the uploaded source and pulls its text out. Free — only generation counts against the AI allowance.',
    needs: 'generate',
    waiting: 'Extract the text',
  },
  extracted: {
    action: 'analyze',
    label: 'Analyse the topics',
    description:
      'Works out what the extracted text is about, which is what the questions are then generated from. Also free.',
    needs: 'generate',
    waiting: 'Analyse the topics',
  },
  analyzed: {
    action: 'generate',
    label: 'Generate questions',
    description:
      'The metered step: this is what counts against the plan’s AI allowance. Nothing is added to the Question Bank yet — the questions come back for review first.',
    needs: 'generate',
    waiting: 'Generate questions',
  },
  generated: {
    action: 'difficulty',
    label: 'Set the difficulty',
    description:
      'SRS §21’s “Teacher selects difficulty”: the level every question awaiting review is filed under. Setting it is what opens the questions for review. Nothing is generated again and no allowance is used.',
    needs: 'approve',
    waiting: 'awaiting a difficulty',
  },
  preview: {
    action: 'review',
    label: 'Review the questions',
    description: 'Approve the ones worth keeping and reject the rest.',
    needs: 'approve',
    waiting: 'awaiting review',
  },
};

const spell = (value: string) => value.replace(/_/g, ' ');

/**
 * The badge for a stage. Only the two ends are finished states; everything before them is work in
 * progress. `rejected` used to fall into "pending" with the rest, so a bank whose every question had
 * been turned down read as one still waiting to be looked at.
 */
function stageBadge(stage: string): string {
  return stage === 'approved' || stage === 'rejected' ? stage : 'pending';
}

/**
 * The choices of an MCQ, defensively.
 *
 * `options` is a JSON column; the model's validator requires an array of at least two `{ key }`
 * objects on every MCQ, but the column type promises nothing, and a preview that threw on one odd row
 * would hide every question in the bank.
 */
function optionsOf(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({ key: String(item.key ?? ''), text: String(item.text ?? '') }));
}

/**
 * The sentence for a refused step or review.
 *
 * `banner` is what `splitApiErrors` could not place on a field: for a stage the provider failed on,
 * the provider's own reason (`runStage` reports it under `source`); for Joi, the per-field sentences.
 * `caught.message` is the headline. Joi's headline is only "Validation failed", which says nothing,
 * so it is dropped; a stage failure's ("The AI provider could not extract this content") is kept in
 * front of its reason. These used to show the headline alone — "Validation failed" for a refused
 * count, and the provider failure without the provider's reason.
 */
function stepMessage(caught: ApiError, banner: string | null): string | null {
  if (banner === null) return null;
  if (caught.message === 'Validation failed' || banner === caught.message) return banner;
  return `${caught.message}: ${banner}`;
}

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

  /* generate, and the difficulty step */
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
    setError(null);

    /*
     * The file is checked here as well as by the server, because the server's answer had nowhere to
     * land: `createBank()` refuses a missing file under `source`, which is one of this form's fields,
     * so the banner stood down — and `FileField` was not given the error, so nothing said anything.
     * It is given it now; this check only saves the round trip.
     */
    if (!source) {
      setFieldErrors({ source: 'Choose the file the questions are to be generated from.' });
      return;
    }

    setBusy(true);
    setFieldErrors({});
    try {
      /* Multipart: §21 step 1 is a file, and `uploadSingle` parses the body before `validate()`. */
      const form = new FormData();
      form.append('name', name.trim());
      form.append('source_type', sourceType);
      if (topic.trim()) form.append('topic', topic.trim());
      form.append('source', source);

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

  /** Open the dialog for a bank's next step, starting the difficulty from what the bank last asked for. */
  function openStep(bank: Bank) {
    setWorking(bank);
    setError(null);
    setFieldErrors({});
    setDifficulty(bank.requested_difficulty ?? 'medium');
  }

  async function advance(bank: Bank, action: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
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
        success(`Difficulty set to ${difficulty}`, 'The questions are ready for review.');
      } else {
        await api.post(`/ai/banks/${bank.id}/generate`, {
          count: count.trim(),
          difficulty,
        });
        success('Questions generated', 'Set their difficulty, then review them.');
        void loadUsage();
      }
      setWorking(null);
      banks.reload();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const { perField, banner } = splitApiErrors(caught, STEP_FIELDS);
        setFieldErrors(perField);
        setError(stepMessage(caught, banner));
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      /*
       * The row may have moved even though the step failed: a provider failure is written to the
       * bank's `error_message`, and a 409 `AI_STAGE_INVALID` means somebody else has already taken
       * the step. Reloading is what shows either.
       */
      banks.reload();
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
    setFieldErrors({});
    setBusy(true);
    try {
      /* `generate` is bounded at fifty questions, so one page of a hundred is the whole bank. */
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
    setFieldErrors({});
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
      if (caught instanceof ApiError) {
        const { perField, banner } = splitApiErrors(caught, new Set(['review_note']));
        setFieldErrors(perField);
        setError(stepMessage(caught, banner));
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      /* A 409 here means the bank was reviewed from somewhere else meanwhile; the list should say so. */
      banks.reload();
    } finally {
      setBusy(false);
    }
  }

  /** Move a question between approve, reject and undecided. Undecided is a draft state only — see the header. */
  function decide(id: number, verdict: 'approve' | 'reject' | 'undecided') {
    setApprove((current) =>
      verdict === 'approve' ? [...new Set([...current, id])] : current.filter((x) => x !== id)
    );
    setReject((current) =>
      verdict === 'reject' ? [...new Set([...current, id])] : current.filter((x) => x !== id)
    );
  }

  /** The same verdict for every question — the common case of a good bank, or a hopeless one. */
  function decideAll(verdict: 'approve' | 'reject') {
    const ids = questions.map((question) => question.id);
    setApprove(verdict === 'approve' ? ids : []);
    setReject(verdict === 'reject' ? ids : []);
  }

  const undecided = questions.length - approve.length - reject.length;

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
            <StatusBadge status={stageBadge(row.workflow_stage)} />
            <span className="block text-xs text-muted-soft">{spell(row.workflow_stage)}</span>
            {row.error_message ? (
              <span className="block max-w-xs truncate text-xs text-danger" title={row.error_message}>
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
          const allowed = step.needs === 'approve' ? canApprove : canGenerate;
          if (!allowed) return <span className="text-muted-soft">{step.waiting}</span>;
          if (step.action === 'review') {
            return (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void openReview(row)}
              >
                {step.label}
              </button>
            );
          }
          return (
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => openStep(row)}>
              {step.label}
            </button>
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
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setCreating(true);
                  setError(null);
                  setFieldErrors({});
                }}
              >
                Upload a source
              </button>
            ) : null}
          </div>
        }
      />

      {usage ? (
        <div className="mb-6">
          {/*
            * `allowed` is null for an unlimited allowance, which is a different thing from zero —
            * showing "0 of 0" for a school with no ceiling would read as exhausted.
            *
            * At the limit the notice turns to a warning, and says which of the two things happens
            * next: with overage allowed the generation still runs and is billed; without it
            * `enforceLimit` refuses it. This used to stay an info notice reading "0 left" either way,
            * which is the one moment §21's "block/warning" (SRS:1147) exists for.
            */}
          {usage.allowed === null || usage.unlimited ? (
            <Notice tone="info">
              {`${usage.used} generation${usage.used === 1 ? '' : 's'} used this period — the plan sets no ceiling.`}
            </Notice>
          ) : usage.at_limit ? (
            <Notice tone="warn">
              {usage.overage_allowed
                ? `All ${usage.allowed} generations in this period’s allowance are used (${usage.used} so far). Generating still works, and each one from here is billed as overage.`
                : `All ${usage.allowed} generations in this period’s allowance are used, so generating is blocked until the next period or until the plan’s AI limit is raised. Extracting, analysing and reviewing still work.`}
            </Notice>
          ) : (
            <Notice tone="info">
              {`${usage.used} of ${usage.allowed} generations used this period, ${usage.remaining ?? 0} left. Only generating counts; extracting and analysing are free.`}
            </Notice>
          )}
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
              /* It used to say "The file is checked against it", and it is not: the `ai_source`
                 profile accepts the same four formats whichever of these is chosen. */
              hint="What the file is — §21’s three kinds. A label only: any PDF, JPEG, PNG or WebP is accepted whichever is chosen."
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
            required
            accept={ACCEPT}
            file={source}
            onChange={(file) => {
              setSource(file);
              /* A file chosen answers "choose a file"; the rest of the form's errors stand. */
              if (file) {
                setFieldErrors((current) => {
                  const next = { ...current };
                  delete next.source;
                  return next;
                });
              }
            }}
            busy={busy}
            error={fieldErrors.source}
            hint="The document the questions are generated from. The size ceiling is your plan’s file upload limit."
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

          {step?.action === 'generate' ? (
            <FormGrid>
              <Field
                id="count"
                label="How many"
                type="number"
                min={1}
                max={50}
                value={count}
                error={fieldErrors.count}
                onChange={(event) => setCount(event.target.value)}
                hint="Up to fifty in one request."
              />
              <SelectField
                id="difficulty"
                label="Difficulty"
                value={difficulty}
                error={fieldErrors.difficulty}
                onChange={(event) => setDifficulty(event.target.value)}
                hint="A hint to the generation. The next step sets the difficulty the questions are filed under, so it can be changed then."
              >
                {DIFFICULTIES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </SelectField>
            </FormGrid>
          ) : step?.action === 'difficulty' ? (
            /*
             * `POST /banks/:id/difficulty` — SRS:1160's own step, and the only transition that writes
             * `preview`. Started from what the bank asked the generator for, because a teacher happy
             * with what came back re-states the same value (the schema's own reading).
             */
            <SelectField
              id="difficulty"
              label="Difficulty"
              required
              value={difficulty}
              error={fieldErrors.difficulty}
              onChange={(event) => setDifficulty(event.target.value)}
              hint={
                working?.requested_difficulty
                  ? `The questions were generated as ${working.requested_difficulty}. Keep it, or file them under another level.`
                  : undefined
              }
            >
              {DIFFICULTIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={reviewing !== null}
        onClose={() => {
          if (!busy) setReviewing(null);
        }}
        title={reviewing ? `Review ${reviewing.name}` : ''}
        description="Approved questions go into the Question Bank. Rejected ones stay here with the decision recorded. Every question needs a verdict: once this is saved the bank is closed, and one left undecided could never be decided afterwards."
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
              disabled={busy || questions.length === 0 || undecided > 0}
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

          {questions.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* Said in words, because it is the reason the save button is disabled. */}
              <p className="text-sm text-muted" aria-live="polite">
                {undecided > 0
                  ? `${undecided} of ${questions.length} not yet decided.`
                  : `All ${questions.length} decided.`}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => decideAll('approve')}
                >
                  Approve all
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => decideAll('reject')}
                >
                  Reject all
                </button>
              </div>
            </div>
          ) : null}

          <ul className="space-y-3">
            {questions.map((question) => {
              const options = optionsOf(question.options);
              const answer = question.correct_option === null ? null : String(question.correct_option);
              return (
                <li key={question.id} className="rounded-lg border border-border p-3">
                  <p className="text-sm">{question.question_text}</p>

                  {/*
                    * The choices and the answer are what a teacher is approving, and they used to be
                    * missing: the preview showed the question alone, so a question with the wrong
                    * answer marked could be approved into the Question Bank unseen. The correct one
                    * is said in words, not by colour alone.
                    */}
                  {options.length > 0 ? (
                    <ol className="mt-2 space-y-1 text-sm">
                      {options.map((option) => {
                        const correct = answer !== null && option.key === answer;
                        return (
                          <li
                            key={option.key}
                            className={correct ? 'font-medium text-success' : 'text-ink-soft'}
                          >
                            <span className="tabular-nums">{option.key}.</span> {option.text}
                            {correct ? <span className="ml-1.5 text-xs">(correct answer)</span> : null}
                          </li>
                        );
                      })}
                    </ol>
                  ) : null}
                  {answer !== null && !options.some((option) => option.key === answer) ? (
                    <p className="mt-2 text-sm">
                      <span className="font-medium">Correct answer:</span> {answer}
                    </p>
                  ) : null}
                  {question.answer_explanation ? (
                    <p className="mt-2 text-xs leading-relaxed text-muted">
                      <span className="font-medium text-ink-soft">Why: </span>
                      {question.answer_explanation}
                    </p>
                  ) : null}

                  <p className="mt-2 text-xs text-muted-soft">
                    {spell(question.type)}
                    {question.difficulty ? ` · ${question.difficulty}` : ''}
                    {question.marks === null
                      ? ''
                      : ` · ${question.marks} mark${Number(question.marks) === 1 ? '' : 's'}`}
                    {` · ${spell(question.status)}`}
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
                      <option value="undecided">Not decided yet</option>
                      <option value="approve">Approve</option>
                      <option value="reject">Reject</option>
                    </select>
                  </div>
                </li>
              );
            })}
          </ul>

          <TextAreaField
            id="review_note"
            label="Review note"
            rows={2}
            maxLength={500}
            value={reviewNote}
            error={fieldErrors.review_note}
            onChange={(event) => setReviewNote(event.target.value)}
            hint="Recorded against the decision."
          />
        </div>
      </Modal>
    </div>
  );
}
