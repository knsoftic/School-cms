'use client';

/**
 * Documents — SRS §20.5, §33's "Documents", checklist row 4.4.
 *
 * ## The one screen with no module gate, and the reason is worth knowing
 *
 * Every other module router mounts `requireModule(...)`. This one mounts
 * `requireActiveSubscription()` instead, because §20.5's seven document types span **four**
 * subscribable modules — `DOCUMENT_TYPE_MODULE` maps them onto `id_cards`, `certificates`, `fees`
 * and `exams`. There is no single key to gate on, so the module check happens per document type
 * inside the service.
 *
 * That has a visible consequence: this screen can load and list documents while a *particular* type
 * is still unavailable. A refusal on generating one is not a refusal of the screen.
 *
 * ## `file_path` never arrives, and that is the design
 *
 * `documents.service.js:128-132` deletes it and returns `has_file` instead. The bytes come from
 * `GET /documents/{id}?format=pdf`, which re-checks the tenant on the way out. A column showing the
 * path would be showing a value the API deliberately withholds — and one that was null anyway.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api, saveFile } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { splitApiErrors } from '@/lib/formErrors';
import { formatAmountWithCode } from '@/lib/money';
import {
  Field,
  Notice,
  SearchField,
  SelectField,
  SubmitButton,
  TextAreaField,
  FilterBar,
  FilterSelect,
  focusFirstInvalidField,
} from '@/components/form';
import { Icon, Spinner } from '@/components/icon';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
  RefusalNotice,
} from '@/components/table';

interface DocumentRow {
  id: number;
  document_type: string;
  owner_type: string;
  owner_id: number;
  title: string;
  file_name: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  is_generated: boolean;
  generated_at: string | null;
  description: string | null;
  created_at: string;
  /* `present()` adds this in place of the path it removes. */
  has_file: boolean;
}

/** §20.5's seven types, for the filter. There is no endpoint that lists them. */
const TYPES = [
  'student_id_card',
  'teacher_id_card',
  'admission_form',
  'fee_receipt',
  'result_card',
  'character_certificate',
  'leaving_certificate',
];

/**
 * `leaving_certificate` -> `Leaving certificate`.
 *
 * One helper rather than the four inline `.replace(/_/g, ' ')` calls this file had, which
 * differed in whether they capitalised. Sentence case, because these are labels.
 */
function humanise(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

function fileSize(bytes: number | null) {
  if (bytes === null) return <span className="text-muted-soft">—</span>;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const { can } = useAuth();
  const { success, error: errorToast } = useToast();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [documentType, setDocumentType] = useState('');

  /*
   * 300 ms, as every other search screen does. `useCollection` refetches on every change to the
   * query and holds no timer of its own, so feeding `search` straight in sent one request per
   * keystroke — ten for a ten-character title.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      /*
       * Resetting to page one is part of the search, not a separate concern — searching from page
       * three and staying there shows an empty table for a query that has two pages of results.
       */
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo(
    () => ({ page, limit: 20, q: debounced || undefined, document_type: documentType || undefined }),
    [page, debounced, documentType]
  );
  const { rows, meta, loading, error, refusal, reload } = useCollection<DocumentRow>('/documents', query);

  const canGenerate = can('documents.generate');

  const [generating, setGenerating] = useState(false);
  /** The row whose PDF is being fetched, so only that button spins. */
  const [downloading, setDownloading] = useState<number | null>(null);

  /*
   * `useCallback`, because the columns memo captures it. See the note on the taxes screen:
   * without it the memo holds whichever copy existed when its own dependencies last changed,
   * and is correct only by accident of what the handler happens to read.
   */
  const downloadPdf = useCallback(async (row: DocumentRow) => {
    setDownloading(row.id);
    try {
      const file = await api.download(
        `/documents/${row.id}`,
        { query: { format: 'pdf' } },
        `${row.document_type}-${row.id}.pdf`
      );
      saveFile(file);
    } catch (caught) {
      errorToast(
        'Could not produce that PDF',
        caught instanceof ApiError ? caught.message : undefined
      );
    } finally {
      setDownloading(null);
    }

  }, [errorToast]);

  const columns = useMemo<Column<DocumentRow>[]>(
    () => [
      { key: 'title', header: 'Title', cell: (row) => <span className="font-medium">{row.title}</span> },
      { key: 'type', header: 'Type', cell: (row) => humanise(row.document_type) },
      {
        key: 'owner',
        header: 'Belongs to',
        /*
         * A polymorphic owner: `owner_type` plus `owner_id`, with no association to include because
         * the target table varies by row. The id is shown because it is all there is — and unlike a
         * plain foreign key, the type beside it makes the pair meaningful.
         */
        cell: (row) => (
          <>
            {humanise(row.owner_type)}
            <span className="ml-1 text-muted-soft">#{row.owner_id}</span>
          </>
        ),
      },
      {
        key: 'origin',
        header: 'Origin',
        /*
         * Generated and uploaded documents behave differently — a generated one can be regenerated
         * from `generation_payload`, an uploaded one cannot — so the distinction earns a column.
         */
        cell: (row) =>
          row.is_generated ? (
            <>
              generated
              {row.generated_at ? (
                <span className="block text-xs text-muted-soft">{row.generated_at.slice(0, 10)}</span>
              ) : null}
            </>
          ) : (
            'uploaded'
          ),
      },
      {
        key: 'file',
        header: 'File',
        cell: (row) =>
          row.has_file ? (
            <>
              {row.file_name ?? 'file'}
              <span className="block text-xs text-muted-soft">{fileSize(row.file_size_bytes)}</span>
            </>
          ) : (
            /*
             * A row with no file is normal rather than broken: §22 established that generated
             * artefacts are streamed on request instead of being written to disk, so a generated
             * document usually has a payload and no stored file.
             */
            <span className="text-muted-soft">streamed on request</span>
          ),
      },
      {
        /*
         * The control this cell used to promise and not offer.
         *
         * "streamed on request" was true and there was **no way to make the request**: nothing in
         * the frontend fetched `GET /documents/:id?format=pdf`, which `documents.controller.js`
         * has answered with a PDF Buffer and an attachment header since Phase 5.4. So an accountant
         * who needed a fee receipt could see that one had been generated and could not obtain it.
         *
         * A plain `<a href>` will not do: `readBearerToken` reads the `Authorization` header only,
         * so an unadorned navigation is a 401. The bytes come through `api.download` and go to the
         * browser's save flow via `saveFile`.
         */
        key: 'download',
        header: 'PDF',
        cell: (row) => (
          <button
            type="button"
            onClick={() => void downloadPdf(row)}
            disabled={downloading === row.id}
            aria-busy={downloading === row.id}
            className="btn btn-ghost btn-sm"
          >
            {downloading === row.id ? <Spinner size={13} /> : <Icon name="download" size={14} />}
            {downloading === row.id ? 'Preparing…' : 'PDF'}
          </button>
        ),
      },
    ],
    [downloading, downloadPdf]
  );

  return (
    <div>
      <PageHeader
        title="Documents"
        description="Generated and uploaded records — §20.5's seven types."
        action={
          /* `documents.generate` is the key `POST /documents` is mounted behind. */
          canGenerate ? (
            <button type="button" onClick={() => setGenerating(true)} className="btn btn-primary">
              <Icon name="plus" size={15} />
              Generate a document
            </button>
          ) : undefined
        }
      />

      <FilterBar
        activeCount={[documentType, search].filter(Boolean).length}
        onClear={() => {
          setDocumentType('');
          setSearch('');
          setPage(1);
        }}
      >
        <div>
          {/*
            * "Title", not "Title or description". `documents.service.js` builds this filter as
            * `where.title = { [Op.like]: … }` and touches nothing else, so the old placeholder
            * promised a description search that never happened — a box that looks like it worked and
            * returns too few rows, which is the failure mode this codebase keeps naming and keeps
            * re-introducing in the label rather than the query.
            */}
          <SearchField
            id="document-search"
            label="Search documents by title"
            placeholder="Search by title…"
            value={search}
            onChange={setSearch}
          />
        </div>
        <div>
          <FilterSelect
            id="document-type"
            label="Document type"
            value={documentType}
            onChange={(value) => { setDocumentType(value); setPage(1); }}
          >
            <option value="">Any type</option>
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {humanise(type)}
              </option>
            ))}
          </FilterSelect>
        </div>
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {debounced || documentType ? 'No document matches these filters.' : 'No documents yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Documents"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <GenerateDialog
        open={generating}
        onClose={() => setGenerating(false)}
        onDone={(name) => {
          setGenerating(false);
          success(`${name} generated`, 'Download it as a PDF from the list.');
          reload();
        }}
      />
    </div>
  );
}

/* ─────────────── generating one ─────────────── */

/**
 * Which record each document type is *about*.
 *
 * `documents.service.js` `OWNER_OF` is the authority and this mirrors it: `owner_type` is **derived
 * from the type, never supplied**, so the caller sends only an id — and which list that id has to
 * come from is exactly what this table decides. Five of the seven are about a student, one about a
 * teacher, and the fee receipt about a **`fee_payments` row** (§17's school-side receipt, not
 * §13's subscription payment, which is the platform billing the school).
 *
 * Getting this wrong is not an error a user could diagnose: the service loads the record in the
 * caller's school and refuses when it is absent, so a teacher id sent for a student document reads
 * as "that student does not exist".
 */
const OWNER_OF: Record<string, 'student' | 'teacher' | 'payment'> = {
  student_id_card: 'student',
  teacher_id_card: 'teacher',
  admission_form: 'student',
  fee_receipt: 'payment',
  result_card: 'student',
  character_certificate: 'student',
  leaving_certificate: 'student',
};

/** What the owner picker is called, per owner kind. */
const OWNER_LABEL: Record<string, string> = {
  student: 'Student',
  teacher: 'Teacher',
  payment: 'Fee payment',
};

/** The fields this dialog renders. Anything else a 422 names goes to the banner. */
const FORM_FIELDS = new Set([
  'document_type',
  'owner_id',
  'exam_id',
  'title',
  'description',
  'reason',
]);

interface StudentOwner {
  id: number;
  student_id: string;
  first_name: string;
  last_name: string | null;
}

interface TeacherOwner {
  id: number;
  employee_id: string;
  first_name: string;
  last_name: string | null;
}

interface PaymentOwner {
  id: number;
  receipt_number: string | null;
  amount: number | string;
  currency: string | null;
}

interface ExamOption {
  id: number;
  name: string;
}

function GenerateDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const [documentType, setDocumentType] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [examId, setExamId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [students, setStudents] = useState<StudentOwner[]>([]);
  const [teachers, setTeachers] = useState<TeacherOwner[]>([]);
  const [payments, setPayments] = useState<PaymentOwner[]>([]);
  const [exams, setExams] = useState<ExamOption[]>([]);
  const [ownersFailed, setOwnersFailed] = useState(false);

  const ownerKind = documentType ? OWNER_OF[documentType] : null;
  const needsExam = documentType === 'result_card';

  useEffect(() => {
    if (!open) return;
    setDocumentType('');
    setOwnerId('');
    setExamId('');
    setTitle('');
    setDescription('');
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [open]);

  /*
   * The owner list is fetched **once a type is chosen**, not up front: three of the four would be
   * wasted on any given document, and the payments list in particular is the school's whole receipt
   * history. A failure says so rather than leaving an empty dropdown that reads as "none exist".
   */
  useEffect(() => {
    if (!open || !ownerKind) return;
    const controller = new AbortController();
    setOwnersFailed(false);

    (async () => {
      try {
        if (ownerKind === 'student') {
          const page = await api.page<StudentOwner[]>('/students', {
            query: { limit: 100 },
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setStudents(page.data);
        } else if (ownerKind === 'teacher') {
          const page = await api.page<TeacherOwner[]>('/teachers', {
            query: { limit: 100 },
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setTeachers(page.data);
        } else {
          const page = await api.page<PaymentOwner[]>('/fees/payments', {
            query: { limit: 100 },
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setPayments(page.data);
        }
      } catch {
        if (!controller.signal.aborted) setOwnersFailed(true);
      }
    })();

    return () => controller.abort();
  }, [open, ownerKind]);

  /* Exams only for a result card — `exam_id` is `forbidden()` on every other type. */
  useEffect(() => {
    if (!open || !needsExam) return;
    const controller = new AbortController();

    (async () => {
      try {
        const page = await api.page<ExamOption[]>('/exams', {
          query: { limit: 100 },
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setExams(page.data);
      } catch {
        /* The field stays empty and the server refuses; no separate story is needed. */
      }
    })();

    return () => controller.abort();
  }, [open, needsExam]);

  const owners = useMemo(() => {
    if (ownerKind === 'student') {
      return students.map((row) => ({
        id: row.id,
        label: `${[row.first_name, row.last_name].filter(Boolean).join(' ')} (${row.student_id})`,
      }));
    }
    if (ownerKind === 'teacher') {
      return teachers.map((row) => ({
        id: row.id,
        label: `${[row.first_name, row.last_name].filter(Boolean).join(' ')} (${row.employee_id})`,
      }));
    }
    if (ownerKind === 'payment') {
      return payments.map((row) => ({
        id: row.id,
        label: `${row.receipt_number ?? `payment #${row.id}`} — ${formatAmountWithCode(row.amount, row.currency)}`,
      }));
    }
    return [];
  }, [ownerKind, students, teachers, payments]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      /*
       * `exam_id` goes **only** with a result card. The schema does not merely ignore it elsewhere
       * — it is `Joi.forbidden()` with its own message — so a value left over from a type the
       * user changed away from would be a 422 naming a field no longer on screen.
       */
      const body: Record<string, unknown> = {
        document_type: documentType,
        owner_id: Number(ownerId),
        title: title.trim() || undefined,
        description: description.trim() || undefined,
      };
      if (needsExam) body.exam_id = Number(examId);

      const result = await api.post<{ document: { title: string } }>('/documents', body);
      onDone(result.document?.title ?? 'Document');
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      const { perField, banner } = splitApiErrors(caught, FORM_FIELDS);
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
      title="Generate a document"
      description="The record is built from what the underlying row holds right now and keeps that snapshot, so a certificate reissued later says what it said when it was issued."
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="generate-document" busy={busy} busyLabel="Generating…">
            Generate
          </SubmitButton>
        </>
      }
    >
      <form id="generate-document" onSubmit={submit} className="space-y-4" noValidate>
        {failure ? <Notice tone="error">{failure}</Notice> : null}

        <SelectField
          id="document_type"
          label="Document"
          required
          value={documentType}
          onChange={(event) => {
            setDocumentType(event.target.value);
            /* The owner list changes with the type, so a carried-over id would name the wrong row. */
            setOwnerId('');
            setExamId('');
          }}
          error={fieldErrors.document_type}
          hint="Each type is about one kind of record, which decides who you pick below."
        >
          <option value="">Choose a document</option>
          {TYPES.map((value) => (
            <option key={value} value={value}>
              {humanise(value)}
            </option>
          ))}
        </SelectField>

        {ownerKind ? (
          <>
            {ownersFailed ? (
              <Notice tone="warn">
                The {OWNER_LABEL[ownerKind].toLowerCase()} list could not be loaded, so there is
                nothing to choose from. That list needs its own view permission, separate from
                generating documents.
              </Notice>
            ) : null}

            <SelectField
              id="owner_id"
              label={OWNER_LABEL[ownerKind]}
              required
              value={ownerId}
              onChange={(event) => setOwnerId(event.target.value)}
              error={fieldErrors.owner_id}
              hint={
                owners.length === 100
                  ? 'Showing the first 100. Anything beyond that cannot be picked here.'
                  : undefined
              }
            >
              <option value="">Choose a {OWNER_LABEL[ownerKind].toLowerCase()}</option>
              {owners.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </SelectField>
          </>
        ) : null}

        {needsExam ? (
          <SelectField
            id="exam_id"
            label="Exam"
            required
            value={examId}
            onChange={(event) => setExamId(event.target.value)}
            error={fieldErrors.exam_id}
            hint="A result card is about one exam. No other document type accepts one."
          >
            <option value="">Choose an exam</option>
            {exams.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </SelectField>
        ) : null}

        <Field
          id="title"
          label="Title"
          maxLength={180}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          error={fieldErrors.title}
          hint="Optional — left blank, the server names it from the type and the owner."
        />

        <TextAreaField
          id="description"
          label="Description"
          rows={2}
          maxLength={255}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          error={fieldErrors.description}
          hint="Optional. Kept on the record."
        />
      </form>
    </Modal>
  );
}
