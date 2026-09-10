'use client';

/**
 * Classes — SRS §14.3 "Classes", §33's School "Classes", checklist row 4.4.
 *
 * The shape is the exemplar's (`(platform)/super-admin/schools/page.tsx`): one `useCollection`, one
 * `Column[]`, the four-state render in refusal → error → loading → empty → table order, and
 * `Pagination`. What follows are only the places where `GET /classes` differs from `GET /schools`,
 * each of which was read out of `backend/src/modules/classes/` rather than assumed.
 *
 * ## There is no search box, and that is deliberate
 *
 * `classes.validation.js` builds its list schema with `listQuery(...)`, and `listQuery` concatenates
 * `commonSchemas.search` — so `?q=` passes validation on this endpoint. It is then **thrown away**:
 * `classes.service.js` `list()` builds its `where` from `school_id`, `academic_session_id` and
 * `is_active` only, and never reads `query.q`. A search box here would accept typing, fire a request,
 * and return the unfiltered first page — the worst kind of broken control, because it looks like it
 * worked. The filter below is `is_active`, which the service does honour.
 *
 * ## The academic session is a real gap, not an oversight
 *
 * A class is unique per `(school_id, academic_session_id, name)`, so "Grade 5" legitimately exists
 * once per session, and this list returns every session's classes interleaved by `numeric_order`.
 * The endpoint accepts `?academic_session_id=`, but filling a picker for it needs `GET /sessions`,
 * which `sessions.routes.js` gates behind `sessions.view` — a permission a class teacher holding
 * only `classes.view` does not have, so the picker would be a refusal banner on a working screen for
 * exactly the people this screen is for. The duplicate-name ambiguity is recorded rather than
 * papered over with a raw `academic_session_id` column, which would name a row nobody can look up.
 *
 * ## No module gate
 *
 * `classes.routes.js` mounts `requirePermission` and nothing else — classes are core school setup,
 * not a subscribed module. The refusal branch still stands, but for one reason rather than two:
 * `INSUFFICIENT_PERMISSION` reaches a bookmarked URL held by a role without `classes.view`.
 *
 * It cannot raise `SCHOOL_CONTEXT_REQUIRED`. That code comes from `resolveGatedSchoolId()` in
 * `entitlement.js`, which only runs from the entitlement guards — and this router mounts none of
 * them. Naming it here would describe a refusal this screen can never receive.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { EditDialog } from '@/components/editDialog';
import { FilterBar, FilterSelect, Notice } from '@/components/form';
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
  StatusBadge,
} from '@/components/table';

/**
 * A section as the list's `include` returns it.
 *
 * `classes.service.js` `list()` includes `{ model: db.Section, as: 'sections' }` with no `where`, so
 * retired sections arrive alongside live ones and the cell below has to separate them itself.
 */
interface ClassSection {
  id: number;
  name: string;
  is_active: boolean;
}

/**
 * A class row.
 *
 * `classes.controller.js` has no `present()` — it hands `ApiResponse.paginated` the Sequelize rows
 * whole — so the row carries every column of the `classes` model. Only the fields this screen renders
 * are declared; nothing here is secret, but narrowing the type keeps a column from quietly appearing
 * because a field happened to exist.
 *
 * `sections` is optional because the response has no schema to hold the include in place: if a
 * `present()` is ever added and drops it, this file should fail to compile at the cell rather than
 * render `undefined.length` at runtime.
 */
interface SchoolClass {
  id: number;
  name: string;
  code: string | null;
  numeric_order: number;
  /**
   * The `teachers.id` of the class teacher, or null. Rendered as presence only — see the column.
   */
  class_teacher_id: number | null;
  capacity: number | null;
  is_active: boolean;
  sections?: ClassSection[];
}

/** The three states of the one filter the service actually applies. */
type ActiveFilter = '' | 'true' | 'false';

export default function ClassesPage() {
  const { can } = useAuth();
  const { success } = useToast();

  /*
   * Editing and removing a class — `PATCH /classes/:id` and `DELETE /classes/:id`, neither of which
   * had a caller. A class could be created and then never renamed, re-capped, given a class teacher
   * or retired, and one created by mistake stayed for good.
   *
   * `academic_session_id` and `class_teacher_id` are accepted by the schema and are **not offered**.
   * Both take a numeric id, and a control that asks a school administrator to type `17` is worse
   * than no control; the session picker in particular belongs with the sessions screen §33 does not
   * name. Recorded rather than guessed at — see the log's §7 brief.
   */
  const [editing, setEditing] = useState<SchoolClass | null>(null);
  const [removing, setRemoving] = useState<SchoolClass | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [active, setActive] = useState<ActiveFilter>('');

  /*
   * No debounce, because there is nothing to debounce: a select fires once per deliberate choice,
   * unlike the exemplar's search box where every keystroke would otherwise spend `apiLimiter` budget.
   * The page reset is kept for the same reason the exemplar resets on search — narrowing to "active
   * only" from page four shows an empty table for a filter that has two pages of results.
   */
  const onFilter = (next: ActiveFilter) => {
    setActive(next);
    setPage(1);
  };

  /*
   * Only parameters `schemas.list` declares are sent. `validate()` runs with `stripUnknown` on the
   * query container, so anything else would be silently removed — a filter that appears to work and
   * does not. `is_active` goes over the wire as the string 'true'/'false'; Joi's `convert: true`
   * (`validate.js` BASE_OPTIONS) turns it back into a boolean before the service sees it.
   *
   * `school_id` is deliberately not sent: `tenantWhere(req.tenant, …)` already pins the query to the
   * caller's school, and a school-surface user has exactly one to choose from.
   */
  const query = useMemo(
    () => ({ page, limit: 20, is_active: active || undefined }),
    [page, active]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<SchoolClass>(
    '/classes',
    query
  );

  const columns = useMemo<Column<SchoolClass>[]>(
    () => [
      {
        key: 'name',
        header: 'Class',
        cell: (row) => <span className="font-medium">{row.name}</span>,
      },
      {
        key: 'code',
        header: 'Code',
        cell: (row) =>
          row.code ? (
            <code className="text-xs text-muted">{row.code}</code>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      {
        /*
         * `numeric_order` earns a column despite looking like bookkeeping: the model comments say it
         * "drives default promotion target (FR-STUDENT-002)" — next class = same school,
         * numeric_order + 1. A gap or a duplicate in this column is what breaks end-of-year
         * promotion, and this list, ordered by it, is the only place that is visible.
         */
        key: 'numeric_order',
        header: 'Order',
        numeric: true,
        cell: (row) => row.numeric_order,
      },
      {
        /*
         * The single most useful column on this screen, and the only association the list query
         * actually includes. Names are short by design ("A", "B"), so they fit where a bare count
         * would send the reader to the detail screen to learn anything.
         *
         * Retired sections are counted, not listed: including them in the names would misreport which
         * sections a class currently teaches, and omitting them entirely would hide the reason a
         * class looks smaller than an administrator remembers.
         */
        key: 'sections',
        header: 'Sections',
        cell: (row) => {
          const sections = row.sections ?? [];
          const live = sections.filter((section) => section.is_active);
          const retired = sections.length - live.length;

          if (sections.length === 0) return <span className="text-muted-soft">none</span>;

          return (
            <span className="whitespace-nowrap">
              {live.length > 0 ? (
                live.map((section) => section.name).join(', ')
              ) : (
                <span className="text-muted-soft">none active</span>
              )}
              {retired > 0 ? (
                <span className="ml-1 text-xs text-muted-soft">
                  (+{retired} inactive)
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        key: 'capacity',
        header: 'Capacity',
        numeric: true,
        /* Nullable on the model, and "not set" is a different fact from a capacity of zero. */
        cell: (row) =>
          row.capacity === null ? <span className="text-muted-soft">not set</span> : row.capacity,
      },
      {
        /*
         * Presence, never the id. `Class.belongsTo(Teacher, { as: 'classTeacher' })` exists in
         * `models/index.js`, but `list()` includes only `sections` — so the teacher's name is simply
         * not in this response, and printing `class_teacher_id: 7` would put a number in front of an
         * administrator that names nothing they can look up.
         *
         * What is genuinely answerable from `class_teacher_id` alone is the question SRS §14.3's
         * "Class Teachers" makes worth asking at a glance: which classes have nobody assigned. That
         * is derived from the column, not a rendering of it.
         */
        key: 'class_teacher',
        header: 'Class teacher',
        cell: (row) =>
          row.class_teacher_id === null ? (
            <span className="text-warn">Unassigned</span>
          ) : (
            <span className="text-muted">Assigned</span>
          ),
      },
      {
        /*
         * `is_active` is a boolean, and `StatusBadge` takes the vocabulary from `constants.js` —
         * 'active' is toned green and 'inactive' is toned as ended, so mapping the boolean onto those
         * two words gets the right tone without a second badge component.
         */
        key: 'is_active',
        header: 'Status',
        cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} />,
      },
      ...(can('classes.manage')
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: SchoolClass) => (
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => setEditing(row)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger-ghost"
                    onClick={() => {
                      setRemoving(row);
                      setRemoveError(null);
                    }}
                  >
                    Delete
                  </button>
                </div>
              ),
            } as Column<SchoolClass>,
          ]
        : []),
    ],
    [can]
  );

  async function remove() {
    if (!removing || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api.delete(`/classes/${removing.id}`);
      success(`${removing.name} deleted`);
      setRemoving(null);
      reload();
    } catch (caught) {
      /*
       * The refusal worth reading here is the one about students: a class holding enrolments cannot
       * be deleted, and the API says so with the count. That is actionable — move or promote them
       * first — and it is the answer to "why can I not delete this?", so it stays in the dialog.
       */
      setRemoveError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Classes"
        description="Every class in this school, ordered by promotion sequence."
        action={
          /*
           * `classes.manage` is a real key (`config/permissions.js:81`, "Manage classes, sections &
           * class teachers"). Hiding the button without it is a courtesy: the permission is re-read
           * from the database on the request itself, so forcing the button into existence still ends
           * at `requirePermission('classes.manage')` in Express.
           *
           * `Link`, not a raw `<a>`: a plain anchor is a document navigation, which throws away the
           * in-memory access token and re-runs the whole session bootstrap before the form appears.
           */
          can('classes.manage') ? (
            <Link href="/school/classes/new" className="btn btn-primary">
              Add class
            </Link>
          ) : null
        }
      />

      <FilterBar
        activeCount={active ? 1 : 0}
        onClear={() => onFilter('')}
      >
        <FilterSelect
          id="class-active"
          label="Show classes"
          value={active}
          onChange={(value) => onFilter(value as ActiveFilter)}
        >
          <option value="">All classes</option>
          <option value="true">Active only</option>
          <option value="false">Inactive only</option>
        </FilterSelect>
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {/*
            * The filter is named in the empty message. "No classes yet" under an active
            * "Inactive only" filter would read as a missing setup step rather than as the filter
            * doing its job, and the fix — clearing the filter — would not be obvious.
            *
            * Each branch states only what its own request asked. An earlier version of the inactive
            * branch read "every class in this school is active", which the response cannot support:
            * the query sent `is_active=false`, so an empty result says nothing about the active
            * rows — and the sentence is simply false for a school with no classes at all.
            */}
          {active === 'true'
            ? 'No active classes. Clear the filter to include retired ones.'
            : active === 'false'
              ? 'No inactive classes. Clear the filter to see the active ones.'
              : 'No classes have been created for this school yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Classes"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <EditDialog
        row={editing}
        title={editing ? `Edit ${editing.name}` : ''}
        description="What the class is called, where it sits in the order, and how many students it holds."
        success="Class updated"
        onClose={() => setEditing(null)}
        onSaved={reload}
        save={(row, body) => api.patch(`/classes/${row.id}`, body)}
        initial={(row) => ({
          name: row.name,
          code: row.code ?? '',
          numeric_order: String(row.numeric_order),
          capacity: row.capacity === null ? '' : String(row.capacity),
          is_active: row.is_active,
        })}
        fields={[
          { name: 'name', label: 'Name', required: true },
          {
            name: 'code',
            label: 'Code',
            nullable: true,
            hint: 'Short form used on reports. Optional.',
          },
          {
            name: 'numeric_order',
            label: 'Order',
            kind: 'number',
            min: 0,
            hint: 'Where this class sits in the sequence — 1 before 2. Promotion reads it.',
          },
          {
            name: 'capacity',
            label: 'Capacity',
            kind: 'number',
            min: 0,
            nullable: true,
            hint: 'Blank for no ceiling. Admission does not enforce it; the plan’s student limit does.',
          },
          {
            name: 'is_active',
            kind: 'checkbox',
            label: 'Active',
            hint: 'A retired class keeps its students and its history and stops being offered.',
          },
        ]}
      />

      <Modal
        open={removing !== null}
        onClose={() => {
          if (!removeBusy) setRemoving(null);
        }}
        title={`Delete ${removing ? removing.name : 'this class'}?`}
        description="Its sections go with it. A class that still has students enrolled cannot be deleted — move or promote them first, and the API will say so if any remain."
        size="sm"
        busy={removeBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={removeBusy}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={removeBusy}
              aria-busy={removeBusy}
              onClick={() => void remove()}
            >
              {removeBusy ? 'Deleting…' : 'Delete class'}
            </button>
          </>
        }
      >
        {removeError ? <Notice tone="error">{removeError}</Notice> : null}
      </Modal>
    </div>
  );
}
