'use client';

/**
 * Sections — SRS §14.3 "Classes" (which lists Sections), §33's "Sections", checklist row 4.4.
 *
 * ## §33 lists this as a screen; the API has no collection behind it
 *
 * There is no `GET /sections`. A section belongs to a class and is reached at
 * `GET /classes/{id}/sections` — the same shape as the plan sub-screens on the platform surface,
 * where §33 names a screen the API models as part of something else.
 *
 * The resolution here is a class picker rather than a recorded mismatch, because unlike Features
 * this one **has a vocabulary to pick from**: `/classes` is a real list, and "sections of a class"
 * is a question an administrator actually asks. Choosing the class is not a workaround; it is the
 * question the endpoint answers.
 *
 * The chosen class lives in the URL (`?class=7`), so the screen is linkable and survives a reload —
 * the same reasoning as the tabs in `components/tabs.tsx`.
 *
 * ## Two requests, and the second waits for the first
 *
 * The class list loads unconditionally. The sections load only once a class is chosen, and
 * `useCollection` needs a path, so the panel that fetches them is a separate component that is not
 * rendered until there is a class to fetch for. Passing a placeholder path would fire a request for
 * `/classes/undefined/sections` on every first render.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES, useCollection } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  Field,
  Notice,
  focusFirstInvalidField,
  SubmitButton,
  FilterBar,
  FilterSelect,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

interface ClassRow {
  id: number;
  name: string;
  code: string | null;
}

interface SectionRow {
  id: number;
  name: string;
  class_id: number;
  class_teacher_id: number | null;
  capacity: number | null;
  room: string | null;
  is_active: boolean;
}

/**
 * A teacher as `GET /teachers` returns them — the same five fields `classes/new` reads for its picker.
 *
 * ## Why this screen fetches them at all
 *
 * `SectionRow` used to declare `classTeacher?: { first_name, last_name }` and render it.
 * `classes.service.listSections()` is `db.Section.findAll({ where, order })` with **no `include`**,
 * so that association never arrives: the branch was dead and every assigned section fell through to
 * `teacher #12`, which is a number that names nothing an administrator can look up.
 *
 * The sibling `classes/page.tsx` met the same gap and answered it by showing presence — Assigned /
 * Unassigned — with the reasoning written out. That is right for a catalogue of classes, where the
 * question is which ones still need somebody. It is too thin here: a sections table exists to say who
 * takes which section, and \Assigned\ does not answer that.
 *
 * So the names are resolved the way `lib/useSchoolNames` resolves schools — one request, mapped by
 * id, falling back to the id it replaced. `classes/new` already loads exactly this list for its
 * picker, so it is a request the surface already makes.
 */
interface TeacherOption {
  id: number;
  first_name: string;
  last_name: string | null;
}

function SectionsPanel({ classId }: { classId: number }) {
  const { can } = useAuth();

  /*
   * No pagination: `/classes/{id}/sections` takes only `school_id`, because a class has a handful of
   * sections rather than a page of them. Rendering a pager for a list that cannot page would promise
   * a control that does nothing.
   *
   * And therefore NOT `useCollection`, which this used to call. That hook reads the **paginated**
   * envelope — `setRows(result.data ?? [])` — but `classes.controller.js:51` answers
   * `ApiResponse.ok(res, { sections: rows })`, so `rows` became the wrapper object. `rows.length
   * === 0` then evaluated `undefined === 0`, skipping the empty branch, and `DataTable` called
   * `.map` on an object: **`rows.map is not a function`, on every class**, replacing the whole page
   * with Next's default error screen. `timetable/new/page.tsx` already reads this same endpoint
   * correctly as `{ sections }`.
   *
   * The four states are kept by hand rather than inherited, because the hook that owns them is the
   * wrong shape for this endpoint. `EXPLAINED_CODES` is imported from the hook rather than copied.
   */
  const [rows, setRows] = useState<SectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false);

  /*
   * Teacher names, by id. Loaded once for the panel and never blocking the sections themselves — a
   * failure here leaves the column showing ids, which is exactly what it showed before, so the table
   * is never held up or broken by a decoration.
   */
  const [teacherNames, setTeacherNames] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const page = await api.page<TeacherOption[]>('/teachers', {
          query: { limit: 100 },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setTeacherNames(
          new Map(
            page.data.map((teacher) => [
              teacher.id,
              [teacher.first_name, teacher.last_name].filter(Boolean).join(' '),
            ])
          )
        );
      } catch {
        /* Swallowed on purpose: see above. */
      }
    })();
    return () => controller.abort();
  }, []);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        const result = await api.get<{ sections: SectionRow[] }>(
          `/classes/${classId}/sections`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        setRows(result.sections ?? []);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setRows([]);
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
  }, [classId, attempt]);

  const columns = useMemo<Column<SectionRow>[]>(
    () => [
      { key: 'name', header: 'Section', cell: (row) => <span className="font-medium">{row.name}</span> },
      {
        key: 'teacher',
        header: 'Class teacher',
        cell: (row) => {
          if (row.class_teacher_id === null) {
            return <span className="text-muted-soft">unassigned</span>;
          }
          const named = teacherNames.get(row.class_teacher_id);
          /* The id is the fallback, not the answer — it is what this column used to always show. */
          return named ?? <span className="text-muted-soft">teacher #{row.class_teacher_id}</span>;
        },
      },
      {
        key: 'capacity',
        header: 'Capacity',
        numeric: true,
        cell: (row) => row.capacity ?? <span className="text-muted-soft">—</span>,
      },
      { key: 'room', header: 'Room', cell: (row) => row.room ?? <span className="text-muted-soft">—</span> },
      { key: 'active', header: 'Status', cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} /> },
    ],
    /* The names arrive after the first render; without this the column freezes on the fallback. */
    [teacherNames]
  );

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (error) return <ErrorNotice message={error} onRetry={reload} />;
  /* Skeleton on the first load only; a refetch after adding a section dims the table in place. */
  if (loading && rows.length === 0) return <LoadingBlock label="Loading sections…" />;

  const mayManage = can('classes.manage');
  const addButton = mayManage ? (
    <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
      <Icon name="plus" size={15} />
      Add section
    </button>
  ) : null;

  const dialog = (
    <AddSectionDialog
      classId={classId}
      open={adding}
      onClose={() => setAdding(false)}
      onCreated={() => {
        setAdding(false);
        reload();
      }}
    />
  );

  /*
   * The empty state carries the action.
   *
   * This used to `return <EmptyNotice>` before reaching the button, so a class with **no sections at
   * all** — the one case where adding one is the only thing you would want to do — offered nothing.
   * The button was rendered only once at least one section already existed.
   */
  if (rows.length === 0) {
    return (
      <>
        <EmptyNotice icon="layers" title="No sections yet" action={addButton}>
          {mayManage
            ? 'A section divides a class into groups, each with its own teacher and room.'
            : 'This class has no sections yet. An administrator adds them.'}
        </EmptyNotice>
        {dialog}
      </>
    );
  }

  return (
    <>
      {addButton ? <div className="mb-3">{addButton}</div> : null}
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Sections of the selected class" busy={loading} />
      {dialog}
    </>
  );
}

/**
 * Add one section to a class — `POST /classes/:id/sections`.
 *
 * Only `name` is required by `createSection`; `capacity` and `room` are the two optional fields worth
 * asking for at creation, because they are what makes a section distinguishable from its siblings.
 * `class_teacher_id` is **not** collected: it takes a teacher id, this screen has no teacher list
 * loaded, and fetching one to populate a picker would make the dialog depend on a second endpoint to
 * offer a field the endpoint does not require. It is set from the section's own edit path.
 *
 * `class_id` is deliberately not sent — the schema declares it `forbiddenField('"class_id" is the
 * path parameter')`, so sending it is a 422.
 */
function AddSectionDialog({
  classId,
  open,
  onClose,
  onCreated,
}: {
  classId: number;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { success } = useToast();
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [room, setRoom] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName('');
    setCapacity('');
    setRoom('');
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      await api.post(`/classes/${classId}/sections`, {
        name: name.trim(),
        /* Left off entirely rather than sent empty: both are `.allow(null)`, not `.allow('')`. */
        capacity: capacity === '' ? undefined : Number(capacity),
        room: room.trim() || undefined,
      });
      success(`Section ${name.trim()} added`);
      onCreated();
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      const perField = caught.fieldErrors();
      if (Object.keys(perField).length > 0) {
        setFieldErrors(perField);
        focusFirstInvalidField();
      } else {
        setFailure(caught.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="sm"
      title="Add a section"
      description="Sections divide a class into groups that are taught and marked separately."
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <SubmitButton form="add-section" busy={busy} busyLabel="Adding…">
            Add section
          </SubmitButton>
        </>
      }
    >
      <form id="add-section" onSubmit={submit} className="space-y-4">
        {failure ? <Notice tone="error">{failure}</Notice> : null}

        <Field
          id="section-name"
          label="Name"
          required
          maxLength={60}
          value={name}
          error={fieldErrors.name}
          onChange={(event) => setName(event.target.value)}
          placeholder="A"
          hint="Usually a letter or a short word. It has to be unique within the class."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="section-capacity"
            label="Capacity"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={capacity}
            error={fieldErrors.capacity}
            onChange={(event) => setCapacity(event.target.value)}
            hint="Optional."
          />
          <Field
            id="section-room"
            label="Room"
            maxLength={60}
            value={room}
            error={fieldErrors.room}
            onChange={(event) => setRoom(event.target.value)}
            hint="Optional."
          />
        </div>
      </form>
    </Modal>
  );
}

function SectionsScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('class');

  const classes = useCollection<ClassRow>('/classes', useMemo(() => ({ limit: 100 }), []));

  return (
    <div>
      <PageHeader
        title="Sections"
        description="A section belongs to a class, so choose the class first."
      />

      {/*
        * Not a filter — this picker is what the screen is *for*, since there is no `GET /sections`
        * and the whole table below depends on it. It uses the filter row's shape anyway, so it lines
        * up with every other list screen, and keeps its visible label because "Choose a class…"
        * names an action rather than the thing being chosen. No clear button: clearing it would
        * leave the screen with nothing to show.
        */}
      <FilterBar>
        <FilterSelect
          id="class-picker"
          label="Class"
          labelVisible
          value={selected ? String(selected) : ''}
          onChange={(value) => {
            const next = new URLSearchParams(params.toString());
            if (value) next.set('class', value);
            else next.delete('class');
            router.replace(`?${next.toString()}`, { scroll: false });
          }}
          disabled={classes.loading || classes.rows.length === 0}
          className="sm:min-w-64"
        >
          <option value="">Choose a class…</option>
          {classes.rows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
              {row.code ? ` (${row.code})` : ''}
            </option>
          ))}
        </FilterSelect>
      </FilterBar>

      {/*
        * The class list's own failures are surfaced here rather than swallowed. A refusal on
        * `/classes` means this screen cannot work at all, and saying "choose a class" over an empty
        * picker would describe the symptom instead of the cause.
        */}
      {classes.refusal ? (
        <RefusalNotice refusal={classes.refusal} />
      ) : classes.error ? (
        <ErrorNotice message={classes.error} onRetry={classes.reload} />
      ) : classes.loading && classes.rows.length === 0 ? (
        <LoadingBlock />
      ) : classes.rows.length === 0 ? (
        <EmptyNotice>No classes exist yet, so there are no sections to show.</EmptyNotice>
      ) : selected ? (
        <SectionsPanel classId={Number(selected)} />
      ) : (
        <EmptyNotice>Choose a class above to see its sections.</EmptyNotice>
      )}
    </div>
  );
}

export default function SectionsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <SectionsScreen />
    </Suspense>
  );
}
