'use client';

/**
 * Grade scales — SRS §19.1's "the Grade System".
 *
 * `POST /exams/grade-scales` and `PATCH /exams/grade-scales/:id`, neither of which had a caller.
 * Without them a school could not define what an A is, and every result was read against whatever
 * bands happened to be seeded.
 *
 * ## A school-wide screen, reached from Exams rather than listed in §33
 *
 * §33's School list of seventeen does not name a Grade Scales screen, and §19.1 does name the grade
 * system. The bands are **school-wide** rather than per exam — `exams.grade_scale` is a *name* that
 * points at a set of bands, so several exams share one scale — which is why this is not a tab on the
 * exam detail screen. It is linked from Exams, where the operator who needs it already is.
 *
 * ## Bands are per scale, and the scale is just a name
 *
 * `grades.scale_name` is a plain string column; there is no `grade_scales` table, and §29 forbids
 * inventing one. A "scale" is therefore the set of rows sharing a name, which has two consequences
 * this screen has to be honest about: a scale cannot be renamed in one operation (each band carries
 * its own copy of the name), and a scale with no bands does not exist at all. The filter offers the
 * names actually in use rather than a catalogue there is nowhere to keep.
 *
 * The column is NOT NULL with a default of `'default'`, and `createGrade()` writes `'default'` for a
 * blank — so "no scale" is not a state a band can be in. It is the scale called `default`, which is
 * also what an exam is graded against when it names none (`exams.grade_scale` defaults the same).
 *
 * ## There is no delete, and that is the API's decision
 *
 * `exams.routes.js` mounts no `DELETE` for a grade band. `is_active` is what withdraws one, and it
 * is on the form. A band that has been used to grade a result cannot be removed without changing
 * what that result said, which is the same reasoning `plans` uses for retiring a price instead of
 * deleting it.
 *
 * ## `is_system` is shown and never sent
 *
 * The schema forbids it by name: *"marks a platform-provided scale and is not settable"*. A seeded
 * band is marked so the school can see why it is there; the form does not offer it, and the API
 * would refuse it.
 *
 * Nor can a school edit such a band at all. `updateGrade()` refuses any row that `is_system` or has
 * no `school_id` with a 403 `GRADE_IS_SYSTEM` — a platform scale is shared by every school, and one
 * school may not change it for the rest. So those rows get no Edit button. The edit dialog used to
 * open for them and promise they could be "edited and withdrawn like any other", and Save was then
 * refused every time.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import {
  CheckboxField,
  FilterBar,
  FilterSelect,
  Field,
  FormGrid,
  Notice,
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

/** One `grades` row — a band, in the language this screen uses. */
interface GradeRow {
  id: number;
  /** Null on a platform-provided band, which `gradeScope()` shows every school beside its own. */
  school_id: number | null;
  scale_name: string | null;
  name: string;
  min_percentage: number | string;
  max_percentage: number | string;
  grade_point: number | string | null;
  is_failing: boolean;
  remarks: string | null;
  is_system: boolean;
  is_active: boolean;
}

interface FormValues {
  scale_name: string;
  name: string;
  min_percentage: string;
  max_percentage: string;
  grade_point: string;
  is_failing: boolean;
  is_active: boolean;
  remarks: string;
  reason: string;
}

const EMPTY: FormValues = {
  scale_name: '',
  name: '',
  min_percentage: '',
  max_percentage: '',
  grade_point: '',
  is_failing: false,
  is_active: true,
  remarks: '',
  reason: '',
};

/** The name `createGrade()` gives a band sent with no scale, and the column's own default. */
const DEFAULT_SCALE = 'default';

/** A band this school cannot edit — see the header on `is_system`. */
const isPlatformBand = (row: GradeRow) => row.is_system || row.school_id === null;

/**
 * `GRADE_BAND_OVERLAP`'s `details.conflicts_with`, as `ApiError.context` keeps it — the band this
 * one would have overlapped. `null` for any other refusal, or a shape this screen does not expect.
 */
function overlapMessage(caught: ApiError): string | null {
  if (caught.code !== 'GRADE_BAND_OVERLAP') return null;
  const other = caught.context?.conflicts_with as
    | { name?: unknown; min_percentage?: unknown; max_percentage?: unknown }
    | undefined;
  if (!other || typeof other.name !== 'string') return null;
  const scaleName = caught.context?.scale_name;
  const scale = typeof scaleName === 'string' ? ` on the “${scaleName}” scale` : '';
  return `This band overlaps “${other.name}” (${String(other.min_percentage)}% – ${String(other.max_percentage)}%)${scale}. Bands on one scale cannot share a percentage, not even at an edge, so this range has to stop short of that one.`;
}

function toValues(row: GradeRow): FormValues {
  return {
    scale_name: row.scale_name ?? '',
    name: row.name,
    min_percentage: String(row.min_percentage),
    max_percentage: String(row.max_percentage),
    grade_point: row.grade_point === null ? '' : String(row.grade_point),
    is_failing: row.is_failing,
    is_active: row.is_active,
    remarks: row.remarks ?? '',
    reason: '',
  };
}

export default function GradeScalesPage() {
  const { can } = useAuth();
  const { success } = useToast();

  const [page, setPage] = useState(1);
  const [scale, setScale] = useState('');

  /*
   * The order. `listGrades()` falls back to `min_percentage DESC` across **every** scale, so with no
   * scale chosen the bands of two scales interleave — "A 90–100, Distinction 85–100, B 80–89…" —
   * and neither reads as a scale. Sorting by `scale_name` groups them; `getSort` takes one column,
   * so the order within each scale is then re-derived below, highest band first. With a scale
   * chosen, the server's own fallback is already exactly that and nothing is sent.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 50,
      scale_name: scale || undefined,
      sortBy: scale ? undefined : 'scale_name',
      sortOrder: scale ? undefined : ('asc' as const),
    }),
    [page, scale]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<GradeRow>(
    '/exams/grade-scales',
    query
  );

  /* Scale by scale, then highest band first — see `query`. Within one page; the server groups pages. */
  const ordered = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          (a.scale_name ?? '').localeCompare(b.scale_name ?? '') ||
          Number(b.min_percentage) - Number(a.min_percentage)
      ),
    [rows]
  );

  const [editing, setEditing] = useState<GradeRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const canManage = can('exams.manage');
  const open = adding || editing !== null;

  /*
   * The scale names actually in use, for the filter and for the datalist on the form.
   *
   * Gathered from the rows rather than from a catalogue, because there is no catalogue — see the
   * header. Accumulated across every page and filter this screen has loaded, not recomputed from
   * the rows on screen: recomputed, choosing a scale narrowed the rows to that scale, the filter's
   * own options narrowed with them, and the only way to reach a second scale was to clear the first.
   * Still only as complete as what has been loaded, which is why the form's control is a free-text
   * input with suggestions rather than a select: a select built from what is known would silently
   * prevent adding a band to a scale that exists on a page not yet seen.
   */
  const [scaleNames, setScaleNames] = useState<string[]>([]);

  const learnScales = useCallback(
    (names: (string | null)[]) =>
      setScaleNames((known) => {
        const next = new Set(known);
        for (const name of names) if (name) next.add(name);
        return next.size === known.length ? known : [...next].sort();
      }),
    []
  );

  useEffect(() => {
    learnScales(rows.map((row) => row.scale_name));
  }, [rows, learnScales]);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function openAdd() {
    /* A new band usually belongs to the scale being looked at, so that one is pre-filled. */
    setValues({ ...EMPTY, scale_name: scale });
    setAdding(true);
    setEditing(null);
    setFormError(null);
    setFieldErrors({});
  }

  function openEdit(row: GradeRow) {
    setValues(toValues(row));
    setEditing(row);
    setAdding(false);
    setFormError(null);
    setFieldErrors({});
  }

  function close() {
    if (busy) return;
    setAdding(false);
    setEditing(null);
  }

  async function save() {
    if (busy) return;

    /*
     * One rule the schema does not carry, checked here so it is said in words. Both ends are
     * `percentField` independently, so Joi passes any pair — but the model's own `bandOrdered`
     * validator (`models/exams.js`) refuses a ceiling **at or below** the floor, and reports it under
     * the validator's name rather than either field. This check used to allow the two to be equal,
     * which the model then refused; a band is a range, and 60–60 is not one.
     */
    const min = Number(values.min_percentage);
    const max = Number(values.max_percentage);
    if (values.min_percentage !== '' && values.max_percentage !== '' && min >= max) {
      setFormError('The highest percentage must be above the lowest — a band is a range, and one the wrong way round or of no width matches no result.');
      return;
    }

    setBusy(true);
    setFormError(null);
    setFieldErrors({});
    const scaleName = values.scale_name.trim() || DEFAULT_SCALE;
    try {
      const body: Record<string, unknown> = {
        name: values.name.trim(),
        min_percentage: values.min_percentage.trim(),
        max_percentage: values.max_percentage.trim(),
        is_failing: values.is_failing,
        is_active: values.is_active,
      };
      /*
       * Blank is the `default` scale, sent by name. It used to be sent as `undefined`, which on a
       * create meant the same thing — `createGrade()` falls back to `'default'` — but on an edit meant
       * "leave it", so clearing the box on a band of another scale saved it where it was.
       */
      body.scale_name = scaleName;
      body.grade_point = values.grade_point.trim() === '' ? null : values.grade_point.trim();
      body.remarks = values.remarks.trim() === '' ? null : values.remarks.trim();
      if (values.reason.trim()) body.reason = values.reason.trim();

      if (adding) {
        await api.post<{ grade: GradeRow }>('/exams/grade-scales', body);
        success('Grade band created');
      } else if (editing) {
        await api.patch<{ grade: GradeRow }>(`/exams/grade-scales/${editing.id}`, body);
        success('Grade band updated');
      }
      learnScales([scaleName]);
      close();
      reload();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setFormError(
          /*
           * An overlap names the band it collided with — `details.conflicts_with`, which `ApiError`
           * keeps as `context`. Without it the refusal said only that *a* band overlapped, and the
           * operator had to read every range on the scale to find which.
           */
          overlapMessage(caught) ??
            caught.bannerFor([
              'scale_name',
              'name',
              'min_percentage',
              'max_percentage',
              'grade_point',
              'remarks',
            ])
        );
      } else {
        setFormError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<Column<GradeRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Grade',
        cell: (row) => (
          <div>
            <span className="font-medium">{row.name}</span>
            <span className="block text-xs text-muted-soft">{row.scale_name ?? 'default scale'}</span>
          </div>
        ),
      },
      {
        key: 'range',
        header: 'Range',
        numeric: true,
        cell: (row) => (
          <span>
            {row.min_percentage}% – {row.max_percentage}%
          </span>
        ),
      },
      {
        key: 'point',
        header: 'Grade point',
        numeric: true,
        cell: (row) =>
          row.grade_point === null ? (
            <span className="text-muted-soft">—</span>
          ) : (
            <span>{row.grade_point}</span>
          ),
      },
      {
        key: 'outcome',
        header: 'Counts as',
        /* The whole point of a band, so it gets a word rather than a tick in a boolean column. */
        cell: (row) => <StatusBadge status={row.is_failing ? 'fail' : 'pass'} />,
      },
      {
        key: 'state',
        header: 'In use',
        cell: (row) => (
          <div>
            <StatusBadge status={row.is_active ? 'active' : 'inactive'} />
            {row.is_system ? (
              <span className="block text-xs text-muted-soft">platform-provided</span>
            ) : null}
          </div>
        ),
      },
      ...(canManage
        ? [
            {
              key: 'actions',
              header: 'Actions',
              /* No Edit on a platform band: `updateGrade()` refuses it outright — see the header. */
              cell: (row: GradeRow) =>
                isPlatformBand(row) ? (
                  <span className="text-xs text-muted-soft">read-only</span>
                ) : (
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => openEdit(row)}>
                    Edit
                  </button>
                ),
            } as Column<GradeRow>,
          ]
        : []),
    ],
    [canManage]
  );

  return (
    <div>
      <PageHeader
        title="Grade scales"
        description="The bands a percentage is read against to become a grade. Shared by every exam that names the scale."
        action={
          <div className="flex gap-2">
            <Link href="/school/exams" className="btn btn-secondary">
              Back to exams
            </Link>
            {canManage ? (
              <button type="button" className="btn btn-primary" onClick={openAdd}>
                Add a band
              </button>
            ) : null}
          </div>
        }
      />

      <FilterBar
        activeCount={scale ? 1 : 0}
        onClear={() => {
          setScale('');
          setPage(1);
        }}
      >
        <div>
          <FilterSelect
            id="grade-scale-name"
            label="Scale"
            labelVisible
            value={scale}
            onChange={(value) => {
              setScale(value);
              setPage(1);
            }}
          >
            <option value="">All scales</option>
            {scaleNames.map((name) => (
              <option key={name} value={name}>
                {name}
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
          {scale
            ? 'No band in this scale.'
            : 'No grade bands are defined, so no result can be given a grade. Add one band per grade — they should cover 0% to 100% between them without overlapping.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={ordered}
            rowKey={(row) => row.id}
            caption="Grade bands"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <Modal
        open={open}
        onClose={close}
        title={adding ? 'Add a grade band' : `Edit ${editing ? editing.name : 'band'}`}
        description="A band claims a percentage range. Results falling in it are given this grade, and whether that counts as a pass is part of the band rather than a separate rule."
        size="lg"
        busy={busy}
        footer={
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>
              Cancel
            </button>
            <SubmitButton
              form="grade-band"
              busy={busy}
              busyLabel={adding ? 'Creating…' : 'Saving…'}
              fullWidth={false}
            >
              {adding ? 'Create band' : 'Save changes'}
            </SubmitButton>
          </>
        }
      >
        <form
          id="grade-band"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {formError ? <Notice tone="error">{formError}</Notice> : null}

          {/*
            * There was an info notice here for a platform-provided band, saying it "can be edited and
            * withdrawn like any other". It cannot — `updateGrade()` refuses it — so such a band no
            * longer opens this dialog at all.
            */}

          <FormGrid>
            <Field
              id="scale_name"
              label="Scale"
              list="grade-scale-names"
              value={values.scale_name}
              error={fieldErrors.scale_name}
              onChange={(event) => set('scale_name', event.target.value)}
              hint="Bands sharing a name are one scale. Blank is the scale called “default” — the one an exam is graded against when it names none."
            />
            <Field
              id="name"
              label="Grade"
              required
              value={values.name}
              error={fieldErrors.name}
              onChange={(event) => set('name', event.target.value)}
              hint="What appears on the result — A+, B, Pass."
            />
          </FormGrid>
          {/* Suggestions, not a constraint: a name not on this page is still a valid scale. */}
          <datalist id="grade-scale-names">
            {scaleNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>

          <FormGrid>
            <Field
              id="min_percentage"
              label="From (%)"
              type="number"
              min={0}
              max={100}
              step="0.01"
              required
              value={values.min_percentage}
              error={fieldErrors.min_percentage}
              onChange={(event) => set('min_percentage', event.target.value)}
            />
            <Field
              id="max_percentage"
              label="To (%)"
              type="number"
              min={0}
              max={100}
              step="0.01"
              required
              value={values.max_percentage}
              error={fieldErrors.max_percentage}
              onChange={(event) => set('max_percentage', event.target.value)}
            />
          </FormGrid>

          <Field
            id="grade_point"
            label="Grade point"
            type="number"
            min={0}
            step="0.01"
            value={values.grade_point}
            error={fieldErrors.grade_point}
            onChange={(event) => set('grade_point', event.target.value)}
            hint="Optional. Used where a GPA is reported; leave blank if the school does not use one."
          />

          <CheckboxField
            id="is_failing"
            label="This grade is a fail"
            checked={values.is_failing}
            onChange={(event) => set('is_failing', event.target.checked)}
            hint="Decides the pass/fail outcome on every result graded into this band."
          />

          <CheckboxField
            id="is_active"
            label="In use"
            checked={values.is_active}
            onChange={(event) => set('is_active', event.target.checked)}
            hint="There is no delete. Withdrawing a band leaves results already graded against it untouched."
          />

          <TextAreaField
            id="remarks"
            label="Remarks"
            rows={2}
            value={values.remarks}
            error={fieldErrors.remarks}
            onChange={(event) => set('remarks', event.target.value)}
            hint="Printed beside the grade where a result card has room for it — “Excellent”, “Needs improvement”."
          />

          <TextAreaField
            id="grade-reason"
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
