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
 * worked. The filters below are `is_active` and `academic_session_id`, both of which it does honour.
 *
 * ## The academic session is offered to whoever can read its name
 *
 * A class is unique per `(school_id, academic_session_id, name)`, so "Grade 5" legitimately exists
 * once per session, and this list returns every session's classes interleaved by `numeric_order`.
 * FR-SCHOOL-003's outcome is a structure "established for the academic session", so which session a
 * row belongs to is the first thing to know about it — hence a Session column and a session filter.
 *
 * Both are fed by `GET /sessions`, which `sessions.routes.js` gates behind `sessions.view`. A teacher
 * or receptionist holding only `classes.view` does not have it, and for them the column and the
 * filter are simply **absent**: not a refusal banner on a screen that otherwise works for them, and
 * never a raw `academic_session_id`, which would name a row nobody can look up. The list is only
 * requested for a caller who holds the key, so nobody is sent a 403 to learn what `can()` knew.
 *
 * ## The class teacher is a name where the teacher list can be read
 *
 * `list()` includes `sections` and nothing else, so `class_teacher_id` arrives as a bare id. The name
 * comes from `GET /teachers` — `teachers.view` **plus** the Teachers module, which
 * `teachers.routes.js` mounts on itself — read once and mapped by id, the way `classes/sections`
 * already names its section teachers. Where it cannot be read, the column falls back to the
 * presence it always showed, and the edit dialog says why it has no teacher picker.
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
import { teacherName, useList, useWholeList } from '@/lib/useTimetablePickers';
import type { SessionOption, TeacherOption } from '@/lib/useTimetablePickers';
import { EditDialog } from '@/components/editDialog';
import type { EditField } from '@/components/editDialog';
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
  /** Nullable on the column even though `classes.create` requires it — `SET NULL` on session delete. */
  academic_session_id: number | null;
  numeric_order: number;
  /**
   * The `teachers.id` of the class teacher, or null. Named from `GET /teachers` — see the column.
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
   * `class_teacher_id` is offered as a picker over the teacher list below — FR-SCHOOL-003's "User
   * assigns Class Teachers", which until now could be done at creation and never again.
   *
   * `academic_session_id` is accepted by the schema and is still **not offered**. The session list
   * is loaded now, so the old reason — a box asking for a raw id — is gone; what remains is that
   * moving a class to another session is a restructure rather than a correction. `update()` sets the
   * one column on the class row and nothing else, so the students enrolled in it keep their own
   * `academic_session_id`, and the class would sit in next year's structure with this year's pupils.
   */
  const [editing, setEditing] = useState<SchoolClass | null>(null);
  const [removing, setRemoving] = useState<SchoolClass | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [active, setActive] = useState<ActiveFilter>('');
  const [session, setSession] = useState('');

  /*
   * The two lists that turn this row's ids into names, each requested only for a caller who holds
   * its key — see the header. `useWholeList` reads past the first page: a teacher sorting 101st by
   * first name would otherwise show as "Assigned", and could not be chosen in the dialog.
   */
  const mayReadTeachers = can('teachers.view');
  const mayReadSessions = can('sessions.view');
  const firstTeachers = useList<TeacherOption>('/teachers', mayReadTeachers);
  const teachers = useWholeList('/teachers', firstTeachers);
  const firstSessions = useList<SessionOption>('/sessions', mayReadSessions);
  const sessions = useWholeList('/sessions', firstSessions);

  const teachersById = useMemo(
    () => new Map(teachers.state === 'ready' ? teachers.rows.map((row) => [row.id, row]) : []),
    [teachers]
  );
  const sessionsById = useMemo(
    () => new Map(sessions.state === 'ready' ? sessions.rows.map((row) => [row.id, row]) : []),
    [sessions]
  );
  /* Whether the session column and filter exist at all. See the header: absent, never an id. */
  const showSessions = mayReadSessions && sessions.state === 'ready';

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

  const onSession = (next: string) => {
    setSession(next);
    setPage(1);
  };

  /*
   * Only parameters `schemas.list` declares are sent. `validate()` runs with `stripUnknown` on the
   * query container, so anything else would be silently removed — a filter that appears to work and
   * does not. `is_active` goes over the wire as the string 'true'/'false'; Joi's `convert: true`
   * (`validate.js` BASE_OPTIONS) turns it back into a boolean before the service sees it, and
   * `academic_session_id` as the id's digits, which it turns back into a number.
   *
   * `school_id` is deliberately not sent: `tenantWhere(req.tenant, …)` already pins the query to the
   * caller's school, and a school-surface user has exactly one to choose from.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 20,
      is_active: active || undefined,
      academic_session_id: session || undefined,
    }),
    [page, active, session]
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
      ...(showSessions
        ? [
            {
              /*
               * What tells this year's "Grade 5" from last year's. "current" is the session row's own
               * `is_current` flag, shown so the live structure can be read at a glance without
               * filtering to it.
               *
               * A null id is a class whose session was deleted (`SET NULL`); an id the list does not
               * hold is past `useWholeList`'s ceiling. Neither prints the number.
               */
              key: 'session',
              header: 'Session',
              cell: (row: SchoolClass) => {
                const owner =
                  row.academic_session_id === null
                    ? undefined
                    : sessionsById.get(row.academic_session_id);
                if (!owner) return <span className="text-muted-soft">—</span>;
                return (
                  <span className="whitespace-nowrap">
                    {owner.name}
                    {owner.is_current ? (
                      <span className="ml-1.5 text-xs text-muted-soft">current</span>
                    ) : null}
                  </span>
                );
              },
            } as Column<SchoolClass>,
          ]
        : []),
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
         * The name, never the id. `Class.belongsTo(Teacher, { as: 'classTeacher' })` exists in
         * `models/index.js`, but `list()` includes only `sections` — so the name is looked up in the
         * teacher list (see the header), and printing `class_teacher_id: 7` would put a number in
         * front of an administrator that names nothing they can look up.
         *
         * Where the list cannot be read the cell falls back to presence, which still answers the
         * question SRS §14.3's "Class Teachers" makes worth asking at a glance: which classes have
         * nobody assigned. A teacher who has since been retired is named and marked, because a class
         * whose class teacher has left is the next thing to fix after one with none.
         */
        key: 'class_teacher',
        header: 'Class teacher',
        cell: (row) => {
          if (row.class_teacher_id === null) return <span className="text-warn">Unassigned</span>;
          const teacher = teachersById.get(row.class_teacher_id);
          if (!teacher) return <span className="text-muted">Assigned</span>;
          return (
            <span className="whitespace-nowrap">
              {teacherName(teacher)}
              {teacher.is_active ? null : (
                <span className="ml-1.5 text-xs text-warn">inactive</span>
              )}
            </span>
          );
        },
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
    /* The names arrive after the first render; without these the columns freeze on the fallback. */
    [can, showSessions, sessionsById, teachersById]
  );

  /*
   * The class teacher picker, offered only once the teacher list is on screen.
   *
   * A select whose options do not hold the value it carries displays its first option — "—" here —
   * so a dialog opened without the list would show a class that has a teacher as one with none, and
   * the select would look like the way to clear it. So the field is left out until the list is ready
   * and a sentence says why; `EditDialog` diffs and sends only the fields it renders, so the stored
   * teacher is untouched meanwhile.
   *
   * Retired teachers are marked, not withheld — `loadTeacherInSchool()` checks the school and nothing
   * else, as `classes/new` notes — and a stored teacher the list does not hold (past `useWholeList`'s
   * ceiling) keeps an option of its own, for the reason `timetable/[id]` gives for `storedOption`.
   */
  const teacherField: EditField | null =
    teachers.state === 'ready'
      ? {
          name: 'class_teacher_id',
          label: 'Class teacher',
          kind: 'select',
          nullable: true,
          options: [
            ...teachers.rows.map((teacher) => ({
              value: String(teacher.id),
              label: `${teacherName(teacher)} (${teacher.employee_id})${teacher.is_active ? '' : ' · inactive'}`,
            })),
            ...(editing?.class_teacher_id && !teachersById.has(editing.class_teacher_id)
              ? [{ value: String(editing.class_teacher_id), label: 'The teacher it has now' }]
              : []),
          ],
          hint:
            teachers.rows.length === 0
              ? 'No teachers have been added to this school yet, so there is nobody to assign.'
              : 'SRS §14.3’s class teacher. “—” leaves the class with nobody; sections carry a class teacher of their own.',
        }
      : null;

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
        activeCount={[active, session].filter(Boolean).length}
        onClear={() => {
          setActive('');
          setSession('');
          setPage(1);
        }}
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

        {/*
          * Every session by default, as before — a default that quietly hid last year's classes would
          * be a filter nobody chose. Absent for a caller who cannot read the session list; see the
          * header.
          */}
        {showSessions ? (
          <FilterSelect
            id="class-session"
            label="Academic session"
            value={session}
            onChange={onSession}
          >
            <option value="">All sessions</option>
            {sessions.state === 'ready'
              ? sessions.rows.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                    {option.is_current ? ' · current' : ''}
                  </option>
                ))
              : null}
          </FilterSelect>
        ) : null}
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
          {/*
            * The session branch comes first because it is the likeliest reason for an empty list:
            * `sessions.service.js` creates no classes, so a session starts with none until they are
            * added to it — `classes.create` requires the session, which is what "per session" means.
            */}
          {session
            ? 'No class in the chosen session matches. Classes are created per session, so a new session has none until they are added.'
            : active === 'true'
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
        description="What the class is called, where it sits in the order, how many students it holds, and who its class teacher is."
        success="Class updated"
        onClose={() => setEditing(null)}
        onSaved={reload}
        save={(row, body) => api.patch(`/classes/${row.id}`, body)}
        initial={(row) => ({
          name: row.name,
          code: row.code ?? '',
          numeric_order: String(row.numeric_order),
          /* Seeded even when the picker is not offered: `EditDialog` sends only the fields it renders. */
          class_teacher_id: row.class_teacher_id === null ? '' : String(row.class_teacher_id),
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
          ...(teacherField ? [teacherField] : []),
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
      >
        {/* Why there is no teacher picker, when there is none. See `teacherField`. */}
        {teacherField ? null : (
          <Notice tone="info">
            {!mayReadTeachers
              ? 'The class teacher cannot be changed here: choosing one needs the “View teachers” permission, which this account does not hold.'
              : teachers.state === 'loading'
                ? 'Loading the teacher list — the class teacher can be changed once it arrives.'
                : 'The teacher list could not be loaded, so the class teacher cannot be changed here. Reading it needs the “View teachers” permission and a plan that carries the Teachers module.'}
          </Notice>
        )}
      </EditDialog>

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
