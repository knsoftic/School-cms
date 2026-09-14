'use client';

/**
 * Create a subject — SRS §14.4 "Subject Creation" (FR-SCHOOL-004), Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, which is where the shared decisions are argued —
 * the omit-blanks rule, `fieldErrors()` onto the inputs, `EXPLAINED_CODES` to `RefusalNotice`,
 * `router.replace` on success. Only what is specific to subjects is written down here.
 *
 * ## The field set is the create schema's
 *
 * `subjects.validation.js` `create` names `school_id`, `name`, `code`, `type`, `is_elective`,
 * `is_active`, `description` and `reason`, and marks exactly two `.required()` — **`name`** and
 * **`code`**. Everything else has a default in `subjects.service.create()`: `type` falls back to
 * `'theory'`, `is_elective` to `false`, `is_active` to `true`, `description` to `null`.
 *
 * `id` and `organization_id` are `forbiddenField(...)` — refused by name rather than stripped — so
 * they have no control here. The organization is taken from the school row, and a control for it
 * would only ever produce a 422 saying so.
 *
 * ## No school picker, and no foreign-key selects at all
 *
 * `school_id` is the one optional field the schema accepts that this form does not offer, for the
 * reason the subjects **list** screen already argues: `resolveSchool()` takes the school from
 * `req.tenant` for a caller who has one, and refuses a different id with `CROSS_SCHOOL_ACCESS`. A
 * principal or school admin therefore has exactly one answer, and sending it would restate what the
 * tenant scope already decided. A picker belongs on a platform surface, where the caller genuinely
 * has more than one school — this route group is not that surface.
 *
 * That leaves no foreign keys on this create at all, which is worth saying because most school
 * resources have several. A subject is not attached to a class or a teacher when it is created:
 * `class_subjects` and `teacher_subjects` are filled by `POST /subjects/:id/classes` and
 * `POST /subjects/:id/teachers`, both of which need the subject to exist first. Offering either
 * here would be a second create wearing the same button.
 *
 * ## Two checkboxes, sent only when they disagree with the column default
 *
 * `is_elective` and `is_active` are `Joi.boolean()` with no empty state to omit — unticked *is* an
 * answer. Each box opens on its column's default (`false` and `true`), and the value is put in the
 * body only when the operator has moved it, so an untouched form posts the same two fields the
 * service would have defaulted anyway.
 *
 * ## The most likely failure arrives with no field at all
 *
 * `code` is unique per school (`subjects_school_code_unique`), and `rethrow()` answers a collision
 * with a 409 `SUBJECT_CODE_TAKEN` whose `details` is the **object** `{ code }`, not the array of
 * `{ field, message }` a 422 carries. `ApiError`'s constructor drops a non-array `details`, so
 * `fieldErrors()` comes back empty and the refusal lands in the top-level `Notice` — where its
 * message, *"A subject with this code already exists at this school"*, is already a whole sentence.
 * No guard is needed at this call site; the normalisation is in `apiClient.ts`.
 *
 * A 422 can also name a field this form has no input for. A platform caller with no school in scope
 * reaches `resolveSchool()`'s *"school_id is required when the caller has no school in scope"*,
 * whose only detail is keyed `school_id` — and with no such control, storing it in `fieldErrors`
 * would render it nowhere and leave the operator staring at a form that did nothing. So a message
 * for an unknown field promotes the response's own top-level message into the notice instead.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import {
  CheckboxField,
  Field,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
  FormActions,
  FormSection,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/**
 * `SUBJECT_TYPES` from `subjects.validation.js`, which mirrors the model's own
 * `enumOf(['theory', 'practical', 'both'])`. There is no `SUBJECT_*` entry in `config/constants.js`
 * for this one — the enum lives in the model and the schema, and those are what is copied.
 *
 * The labels are the subjects list screen's, so a subject reads the same on the form that made it
 * as in the table it lands in. "Both" alone answers a question nobody asked.
 */
const TYPES: { value: string; label: string }[] = [
  { value: 'theory', label: 'Theory' },
  { value: 'practical', label: 'Practical' },
  { value: 'both', label: 'Theory & practical' },
];

/**
 * The fields this form actually renders an input for.
 *
 * Used to decide whether a 422's detail has somewhere to go — see the header on `school_id`, the
 * one field the schema accepts and this screen deliberately does not show.
 */
const CONTROLLED = new Set(['name', 'code', 'type', 'is_elective', 'is_active', 'description', 'reason']);

export default function NewSubjectPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState({
    name: '',
    code: '',
    type: '',
    description: '',
    reason: '',
  });
  /* Held apart from `values`: a checkbox has no blank to omit, so it carries its column's default. */
  const [isElective, setIsElective] = useState(false);
  const [isActive, setIsActive] = useState(true);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /*
     * Only what was filled in. `description` and `reason` are `.empty('')` server-side so a blank
     * would be coerced away either way, but a blank `name` sent as `""` fails as *"is not allowed to
     * be empty"* where an absent one fails as *"is required"* — and the second names the actual
     * problem.
     */
    const body: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(values)) {
      const value = raw.trim();
      if (value) body[key] = value;
    }

    /* Both columns default the other way, so an untouched box and an absent key are the same row. */
    if (isElective) body.is_elective = true;
    if (!isActive) body.is_active = false;

    try {
      const created = await api.post<{ subject: { id: number } }>('/subjects', body);
      /*
       * To the new subject, not the list. The toast says to assign it to classes and teachers next,
       * and that is done on the subject's own screen — landing on the list, which sorts by name and
       * pages at twenty, told the operator what to do and sent them somewhere they could not do it.
       *
       * `replace`, not `push`: Back would otherwise re-open an empty form for a subject that exists.
       */
      success('Subject created', 'Assign it to classes and teachers next.');
      router.replace(`/school/subjects/${created.subject.id}`);
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        const perField: Record<string, string> = {};
        let unplaceable = false;

        for (const [field, message] of Object.entries(caught.fieldErrors())) {
          if (CONTROLLED.has(field)) perField[field] = message;
          else unplaceable = true;
        }

        setFieldErrors(perField);
        focusFirstInvalidField();
        /*
         * The banner carries the response's own message rather than the orphaned detail: on the
         * `school_id` case above, the detail reads "Name the school" and the message says which
         * callers have to. It also covers `SUBJECT_CODE_TAKEN`, whose `details` is not a field list.
         */
        /* Whole-object rules have no field at all; `formErrors()` is where they arrive. */
        const formLevel = caught.formErrors();
        setError(
          formLevel.length
            ? formLevel.join(' ')
            : unplaceable || !Object.keys(perField).length
              ? caught.message
              : null
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setSaving(false);
    }
  }

  /*
   * Gated exactly as the list screen's "Add subject" button is.
   *
   * `subjects.routes.js` puts nothing else in front of `POST /subjects` — no `requireModule()`, no
   * `enforceLimit()`, no `requirePlatformScope()` — because subjects are core school setup rather
   * than a subscribed module. So `subjects.manage` is the whole of the gate, and a caller who forces
   * this URL without it is refused identically by `requirePermission`, which re-reads the grant from
   * the database on the request itself.
   */
  if (!can('subjects.manage')) {
    return (
      <div>
        <PageHeader title="New subject" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create a subject.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New subject"
        description="A name and a code are required. The code is what the timetable, exam and marks screens refer to."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The subject"
          description="What it is called, its code, and the kind of subject it is."
        >
          <Field
            id="name"
            width="md"
            label="Name"
            required
            maxLength={120}
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="Up to 120 characters, e.g. Mathematics."
          />

          <Field
            id="code"
            width="sm"
            label="Code"
            required
            maxLength={40}
            value={values.code}
            onChange={set('code')}
            error={fieldErrors.code}
            /*
             * `.uppercase()` on the schema with Joi's `convert: true`, so lower case is stored upper.
             * Said rather than rewritten as it is typed — a field that silently changes the entry is
             * harder to trust than one that says what it will do. No character rule is claimed: unlike
             * an organization code, this one is a plain trimmed string, so inventing a pattern here
             * would refuse codes the API accepts.
             */
            hint="Up to 40 characters, unique within this school. Stored in upper case."
          />

          {/*
            The blank option stays first and keeps an empty value, so an untouched select omits `type`
            from the body and the service applies its own `'theory'` rather than the form asserting it.
            Its label says what that means for the subject — it used to read "Server default", which
            describes the plumbing rather than the outcome.
          */}
          <SelectField
            id="type"
            width="sm"
            label="Type"
            value={values.type}
            onChange={set('type')}
            error={fieldErrors.type}
            hint="Whether the subject is taught as theory, as practical work, or as both."
          >
            <option value="">Not chosen — saved as theory</option>
            {TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>

          <TextAreaField
            id="description"
            label="Description"
            rows={3}
            maxLength={255}
            value={values.description}
            onChange={set('description')}
            error={fieldErrors.description}
            hint="Up to 255 characters. It is the only free text on the row, so it is what tells two similarly named subjects apart on the list."
          />
        </FormSection>

        <FormSection
          title="Options"
          description="Whether the subject is elective, and whether it is currently in use."
        >
          {/*
            `CheckboxField` carries the explanation as a `hint` wired up by `aria-describedby` instead
            of nesting it inside the label, where it was read out as part of the box's own name.
          */}
          <div className="space-y-2 pt-1">
            {/*
              `CheckboxField` takes an `error` now (form.tsx), wired with `aria-invalid` and
              `aria-describedby` like every other field — so these two no longer need the hand-rolled
              paragraphs that used to follow them. Both errors are near-unreachable — the boxes can
              only ever send `true`/`false`, which is what `Joi.boolean()` asks for — but a message
              that does arrive now sits on its box.
            */}
            <CheckboxField
              id="is_elective"
              label="Elective"
              checked={isElective}
              onChange={(event) => setIsElective(event.target.checked)}
              error={fieldErrors.is_elective}
              hint="An optional subject rather than one every student takes. Electives can be excluded from result aggregation, so this is worth getting right at creation rather than discovering it later from a marks discrepancy."
            />

            <CheckboxField
              id="is_active"
              label="Active"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              error={fieldErrors.is_active}
              hint="Subjects are not soft-deleted, so this flag is the whole of a subject's lifecycle. Leave it on unless the subject is being entered ahead of a session it is not yet taught in."
            />
          </div>
        </FormSection>

        <FormSection
          title="Internal notes"
          description="Kept on the audit entry for this subject."
        >
          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            /*
             * In the create schema and actually read: `create()` passes it to `recordAudit()` as the
             * `reason` on the subject's audit row. It is not a column on `subjects` and never appears
             * on the list — this is the one chance to record why the subject was added.
             */
            hint="Up to 255 characters, kept on the audit entry for this subject. Optional."
          />
        </FormSection>

        <FormActions cancelHref="/school/subjects">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create subject
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
