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
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';

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

  const query = useMemo(
    () => ({ page, limit: 50, scale_name: scale || undefined }),
    [page, scale]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<GradeRow>(
    '/exams/grade-scales',
    query
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
   * Taken from the rows on screen rather than from a catalogue, because there is no catalogue — see
   * the header. That makes the list only as complete as the page, which is why the form's control is
   * a free-text input with suggestions rather than a select: a select built from one page would
   * silently prevent adding a band to a scale that exists on the next.
   */
  const scaleNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of rows) if (row.scale_name) names.add(row.scale_name);
    return [...names].sort();
  }, [rows]);

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
     * One rule the schema does not carry: a band whose floor is above its ceiling matches nothing.
     * Both are `percentField` independently, so the API stores the pair happily and every result
     * graded against it would silently fall through to no band at all.
     */
    const min = Number(values.min_percentage);
    const max = Number(values.max_percentage);
    if (values.min_percentage !== '' && values.max_percentage !== '' && min > max) {
      setFormError('The lowest percentage must be at or below the highest — a band the wrong way round matches no result.');
      return;
    }

    setBusy(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = {
        name: values.name.trim(),
        min_percentage: values.min_percentage.trim(),
        max_percentage: values.max_percentage.trim(),
        is_failing: values.is_failing,
        is_active: values.is_active,
      };
      body.scale_name = values.scale_name.trim() === '' ? undefined : values.scale_name.trim();
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
      close();
      reload();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setFormError(
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
              cell: (row: GradeRow) => (
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
            rows={rows}
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

          {editing?.is_system ? (
            <Notice tone="info">
              This band was provided with the platform. It can be edited and withdrawn like any other,
              and the marker stays so it is clear where it came from.
            </Notice>
          ) : null}

          <FormGrid>
            <Field
              id="scale_name"
              label="Scale"
              list="grade-scale-names"
              value={values.scale_name}
              error={fieldErrors.scale_name}
              onChange={(event) => set('scale_name', event.target.value)}
              hint="Bands sharing a name are one scale. Leave blank for the school's default scale."
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
