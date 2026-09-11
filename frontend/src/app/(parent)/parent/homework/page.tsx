'use client';

/**
 * A parent's view of their children's homework — SRS §20.2 (FR-HW-001, "Homework is available to the
 * relevant class/students") and FR-PARENT-001's "records for all linked children". Read-only.
 *
 * ## The narrowing is the server's, not this screen's
 *
 * `homework.view` is one permission shared by staff, students and parents; there is no
 * `homework.self.view`. So `homework.service.js` narrows by who the caller is: an account with a
 * parent profile sees the homework set for its linked children's classes, and published rows only.
 * This screen sends no class filter of its own. It could only restate that rule, and a restatement
 * is a second copy that can disagree with the first.
 *
 * ## "For" is worked out here, from two answers the parent already has
 *
 * A homework row names its class and, when it is set for one section, that section's id — never a
 * child. With two children at the school, *whose is this?* is the first question. `GET
 * /parents/dashboard` carries each child's `class_id` and `section_id`, so a row is matched to the
 * children it reaches: the same class, and either no section or the child's own. When the dashboard
 * cannot be read, the column shows only the class name rather than guessing.
 *
 * ## Newest due date first
 *
 * The school's Homework screen keeps the API's default, `due_date` ascending, which puts the start of
 * term on page one by the end of it. A parent opens this to see what is due now, so the list asks for
 * `due_date` descending: the latest work first, and what came before on the pages after.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api, saveFile } from '@/lib/apiClient';
import { useCollection } from '@/lib/useCollection';
import { FilterBar, FilterDate, SearchField } from '@/components/form';
import { Icon } from '@/components/icon';
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
import { useToast } from '@/components/toast';

import { childName, useParentDashboard } from '../children';

/**
 * One row of `GET /homework`, as `present()` builds it: the `homework` columns without
 * `attachment_path`, plus `has_attachment`, plus the two joins `list()` asks for — `class` with
 * `['id','name']` and `subject` with `['id','name','code']`. The section arrives as a bare id; it is
 * read here only to match a row against a child's own section.
 */
interface Homework {
  id: number;
  title: string;
  /** `TEXT`, nullable — the instructions, and on this screen the reason for opening it. */
  description: string | null;
  class_id: number;
  section_id: number | null;
  /** Nullable although `class_id` is NOT NULL: a plain `include` is a LEFT JOIN. */
  class: { id: number; name: string } | null;
  /** Nullable twice over: `subject_id` is optional and its FK is `ON DELETE SET NULL`. */
  subject: { id: number; name: string; code: string | null } | null;
  /** Both `DATEONLY`, NOT NULL. */
  assigned_date: string;
  due_date: string;
  has_attachment: boolean;
  attachment_name: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A `DATEONLY` read as characters, never through `Date` — the school Homework screen's formatter.
 * `new Date('2026-02-01')` is UTC midnight, which west of Greenwich is the 31st of January: the day
 * the work is owed would move. Anything not shaped like a date is shown as the server sent it.
 */
function formatDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return value;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

export default function ParentHomework() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [dueFrom, setDueFrom] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      /* A search from page three would otherwise show an empty page for a query with results. */
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * Only keys `homework.validation.js` `list` declares, since `validate()` strips anything else in
   * silence. `is_published` is not sent: the service forces it to true for a parent, so a control
   * for it would be a control that did nothing. `due_to` is left off for the reason the school screen
   * gives — an end typed before its start is a 422 the reader cannot see the cause of.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 20,
      sortBy: 'due_date',
      sortOrder: 'desc' as const,
      q: debounced || undefined,
      due_from: dueFrom || undefined,
    }),
    [page, debounced, dueFrom]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<Homework>('/homework', query);

  const { data: dashboard } = useParentDashboard();
  const children = useMemo(
    () => (dashboard?.children ?? []).flatMap((link) => (link.student ? [link.student] : [])),
    [dashboard]
  );

  /* The children a row reaches: its class, and either no section (the whole class) or theirs. */
  const reached = useCallback(
    (row: Homework) =>
      children.filter(
        (student) =>
          student.class_id === row.class_id && (row.section_id === null || student.section_id === row.section_id)
      ),
    [children]
  );

  /*
   * The attachment, through the authenticated client. `GET /homework/:id/attachment` loads the row
   * through the same `findById()` narrowing as the list, so a parent can fetch the file of homework
   * they can see and no other. A plain link would carry no bearer token and 401.
   */
  const { error: toastError } = useToast();
  const [downloading, setDownloading] = useState<number | null>(null);

  const download = useCallback(
    async (row: Homework) => {
      setDownloading(row.id);
      try {
        const file = await api.download(
          `/homework/${row.id}/attachment`,
          {},
          row.attachment_name ?? `homework-${row.id}`
        );
        saveFile(file);
      } catch (caught) {
        toastError(
          'Could not download the attachment',
          caught instanceof ApiError
            ? caught.message
            : 'Could not reach the server. Check your connection and try again.'
        );
      } finally {
        setDownloading(null);
      }
    },
    [toastError]
  );

  const columns = useMemo<Column<Homework>[]>(
    () => [
      {
        key: 'title',
        header: 'Homework',
        cell: (row) => (
          <div>
            <span className="font-medium">{row.title}</span>
            {/*
              * In full, not clamped the way the inbox clamps a message. The description is the
              * homework — the instructions a child works from — and a clamp that reveals the rest
              * on hover reveals nothing on a phone. The width is capped so a long one wraps
              * inside its cell rather than widening the table.
              */}
            {row.description ? (
              <span className="mt-0.5 block max-w-md whitespace-pre-line text-xs text-muted">{row.description}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'for',
        header: 'For',
        cell: (row) => {
          const who = reached(row);
          if (who.length === 0 && !row.class) return <span className="text-muted-soft">—</span>;
          return (
            <span className="whitespace-nowrap">
              {who.length > 0 ? <span className="block">{who.map(childName).join(', ')}</span> : null}
              {row.class ? (
                <span className={who.length > 0 ? 'block text-xs text-muted-soft' : 'block'}>{row.class.name}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        key: 'subject',
        header: 'Subject',
        cell: (row) => {
          if (!row.subject) return <span className="text-muted-soft">—</span>;
          return (
            <span className="whitespace-nowrap">
              {row.subject.name}
              {row.subject.code ? <span className="ml-2 text-xs text-muted-soft">{row.subject.code}</span> : null}
            </span>
          );
        },
      },
      {
        key: 'assigned_date',
        header: 'Assigned',
        cell: (row) => <span className="whitespace-nowrap">{formatDay(row.assigned_date)}</span>,
      },
      {
        key: 'due_date',
        header: 'Due',
        /*
         * Not toned for lateness, for the school screen's reason: "overdue" needs a today, and a
         * client component rendered on the server first has no honest one.
         */
        cell: (row) => <span className="whitespace-nowrap font-medium">{formatDay(row.due_date)}</span>,
      },
      {
        key: 'attachment',
        header: 'Attachment',
        cell: (row) =>
          row.has_attachment ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm whitespace-nowrap"
              disabled={downloading === row.id}
              aria-busy={downloading === row.id}
              title={row.attachment_name ?? undefined}
              onClick={() => void download(row)}
            >
              <Icon name="download" size={14} />
              {downloading === row.id ? 'Downloading…' : 'Download'}
              <span className="sr-only"> {row.attachment_name ?? 'the attachment'}</span>
            </button>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
    ],
    [download, downloading, reached]
  );

  const filtered = Boolean(debounced || dueFrom);

  return (
    <div>
      <PageHeader
        title="Homework"
        description="Homework the school has published for your children’s classes, latest due date first."
      />

      <FilterBar
        activeCount={[search, dueFrom].filter(Boolean).length}
        onClear={() => {
          setSearch('');
          setDueFrom('');
          setPage(1);
        }}
      >
        <div>
          {/* `q` is matched against the title and the description, so the placeholder names both. */}
          <SearchField
            id="parent-homework-search"
            label="Search homework"
            placeholder="Search title or description…"
            value={search}
            onChange={setSearch}
          />
        </div>
        <div>
          <FilterDate
            id="parent-homework-due-from"
            label="Due on or after"
            value={dueFrom}
            onChange={(value) => {
              setDueFrom(value);
              setPage(1);
            }}
          />
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
          {filtered
            ? 'No homework matches these filters.'
            : dashboard && dashboard.children.length === 0
              ? 'No children are linked to your account yet. The school office links a parent to a student.'
              : 'No homework has been published for your children’s classes yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Your children’s homework"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
