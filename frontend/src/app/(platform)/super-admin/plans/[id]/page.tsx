'use client';

/**
 * One plan — FR-SUB-002 (Edit Plan) and FR-SUB-006 (pricing). `PATCH /plans/:id`,
 * `PUT /plans/:id/prices`.
 *
 * ## Why the plan's own screen carries pricing and not the three sub-screens
 *
 * §33's Super Admin list names Plans, Modules, Features and Limits — and no Pricing. Modules,
 * Features and Limits are screens of their own because the source says so; prices are not, so they
 * live on the plan, which is also where FR-SUB-006 puts them ("Configure Plan Pricing" is an
 * operation on a plan). Inventing a fifth screen the source does not name would be the same mistake
 * the quotations module made, and it is recorded in `docs/SRS-FINAL-PASS-FINDINGS.md` as one.
 *
 * ## Two permissions, two answers
 *
 * `PATCH /plans/:id` is behind `plans.manage` and `PUT /plans/:id/prices` behind
 * `plans.pricing.manage`. They are separate keys in `config/permissions.js`, so an operator may hold
 * either without the other and the two tabs are gated independently rather than on one flag. Both
 * routes also carry `requirePlatformScope()`, which `can()` cannot see — a school-scoped account
 * holding the permission is refused by the API with `PLATFORM_SCOPE_REQUIRED`, which lands in
 * `RefusalNotice` with an explanation.
 *
 * ## Status is not on this form
 *
 * Deliberately, and for the same reason the create form has no status control: `plans.validation.js`
 * `update` does not accept `status`, because FR-SUB-004 and FR-SUB-005 own it and each has its own
 * endpoint with its own audit reason. Those are on the list screen, as row actions. A status select
 * here would be a field the API **refuses** — `update` declares `status: refusedStatus`, a
 * `forbidden()` with its own message, so the save would come back 422 naming the two endpoints to
 * use. (This used to say the key was silently stripped, which is what `stripUnknown` does to an
 * undeclared key; `status` is declared precisely so that it is not.)
 *
 * ## Both tabs stay mounted
 *
 * The panels are hidden, not unmounted. Switching from Details to Pricing used to unmount the details
 * form, so its unsaved edits were gone by the time the operator came back — and the same the other
 * way round for a half-built price set. Each form also re-seeds from a reload only when the part of
 * the plan it edits actually changed on the server, so saving one tab does not wipe the other's work.
 *
 * A hidden panel's controls are still in the document, so a stale field error on the Details form
 * could have caught `focusFirstInvalidField()` when a Pricing save was refused, and focus would have
 * gone nowhere. It now takes the first invalid control that is rendered — a `hidden` subtree has no
 * client rects — so focus lands on the Pricing field that failed.
 */

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  CheckboxField,
  Field,
  FormActions,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { usePlanDetail } from '@/components/planScope';
import type { Catalogue, PlanDetail } from '@/components/planScope';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
import { useToast } from '@/components/toast';
import {
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

import { PricingEditor } from './pricing';

/** §10.2's Public/Private. */
const VISIBILITIES = ['public', 'private'];

/** §12.5's two renewal modes. */
const RENEWAL_MODES = ['manual', 'automatic'];

/**
 * The four integer columns, which are `NOT NULL DEFAULT 0`.
 *
 * "Blank" is not a state any of them has, which is why an empty box is reported as an error here
 * rather than sent. Omitting it instead would be worse: the field would spring back to its old value
 * after a save that appeared to accept the change.
 */
const NUMERIC_FIELDS = ['display_order', 'trial_days', 'grace_period_days', 'tier_rank'] as const;

interface FormValues {
  name: string;
  code: string;
  description: string;
  visibility: string;
  default_renewal_mode: string;
  display_order: string;
  trial_days: string;
  grace_period_days: string;
  tier_rank: string;
  is_recommended: boolean;
}

function toValues(plan: PlanDetail): FormValues {
  return {
    name: plan.name,
    code: plan.code,
    description: plan.description ?? '',
    visibility: plan.visibility,
    default_renewal_mode: plan.default_renewal_mode,
    display_order: String(plan.display_order),
    trial_days: String(plan.trial_days),
    grace_period_days: String(plan.grace_period_days),
    tier_rank: String(plan.tier_rank),
    is_recommended: plan.is_recommended,
  };
}

function DetailsForm({
  plan,
  canEdit,
  onSaved,
}: {
  plan: PlanDetail;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { success } = useToast();

  const [values, setValues] = useState<FormValues>(() => toValues(plan));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  /*
   * Re-sync on reload, so what the form shows is what was stored — but only when the plan's own
   * columns changed. A save on the Pricing tab reloads the plan too, and both tabs stay mounted (see
   * the header), so re-seeding on every new `plan` object would discard edits here that the operator
   * had not saved yet. Comparing the seeded values tells the two apart: a pricing save leaves them
   * identical, a save from this form (or anybody else's) does not.
   */
  const seeded = useRef(JSON.stringify(toValues(plan)));
  useEffect(() => {
    const next = toValues(plan);
    const key = JSON.stringify(next);
    if (key === seeded.current) return;
    seeded.current = key;
    setValues(next);
    setFieldErrors({});
  }, [plan]);

  const set = (key: keyof FormValues) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;

    /* See `NUMERIC_FIELDS` — an empty integer box is a mistake, not an instruction. */
    const blanks: Record<string, string> = {};
    for (const key of NUMERIC_FIELDS) {
      if (!values[key].trim()) blanks[key] = 'Enter a number. Use 0 for none.';
    }
    if (Object.keys(blanks).length) {
      setFieldErrors(blanks);
      setError(null);
      focusFirstInvalidField();
      return;
    }

    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /*
     * Everything is sent, not just what changed. `update` is `.min(1)` and the service snapshots the
     * row before and after, so the audit entry records the state the operator confirmed rather than
     * a diff this screen computed — and a diff computed from a stale load is the way two
     * administrators overwrite each other without either seeing it.
     *
     * `description` is the one field that must go as `null` when empty: it is `.empty('')`, so a
     * blank string is stripped before validation and the column would keep its old text.
     */
    const body = {
      name: values.name.trim(),
      code: values.code.trim(),
      description: values.description.trim() || null,
      visibility: values.visibility,
      default_renewal_mode: values.default_renewal_mode,
      display_order: Number(values.display_order),
      trial_days: Number(values.trial_days),
      grace_period_days: Number(values.grace_period_days),
      tier_rank: Number(values.tier_rank),
      is_recommended: values.is_recommended,
    };

    try {
      await api.patch(`/plans/${plan.id}`, body);
      success('Plan updated');
      /*
       * This form's own save always re-seeds from the reload, even if what was stored happens to
       * equal the previous seed — the server normalises (a trimmed name, say), and the form should
       * show what it kept rather than what was typed.
       */
      seeded.current = '';
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        const perField = caught.fieldErrors();
        setFieldErrors(perField);
        focusFirstInvalidField();
        const formLevel = caught.formErrors();
        setError(
          formLevel.length ? formLevel.join(' ') : Object.keys(perField).length ? null : caught.message
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl">
      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!canEdit ? (
        <Notice tone="info">
          You can see this plan but not change it. Editing needs the &ldquo;plans.manage&rdquo;
          permission.
        </Notice>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-8" noValidate>
        <FormSection title="The plan" description="Its name, code and description — what a school sees when choosing.">
          <Field
            id="name"
            label="Name"
            required
            disabled={!canEdit}
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="2 to 160 characters."
          />

          <Field
            id="code"
            label="Code"
            required
            disabled={!canEdit}
            value={values.code}
            onChange={set('code')}
            error={fieldErrors.code}
            hint="2 to 60 characters, starting with a letter or digit. Changing it does not affect subscriptions already taken on this plan — they hold a plan id, not a code."
          />

          <TextAreaField
            id="description"
            label="Description"
            rows={4}
            disabled={!canEdit}
            value={values.description}
            onChange={set('description')}
            error={fieldErrors.description}
            hint="Up to 5,000 characters. Clearing the box removes the description."
          />
        </FormSection>

        <FormSection
          title="Availability"
          description="Who can see the plan, and the trial and grace periods it comes with."
        >
          <SelectField
            id="visibility"
            label="Visibility"
            required
            disabled={!canEdit}
            value={values.visibility}
            onChange={set('visibility')}
            error={fieldErrors.visibility}
            hint="A private plan is withheld from every caller outside the platform, so it is the shape for a rate negotiated with one school."
          >
            {VISIBILITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>

          <Field
            id="trial_days"
            label="Trial days"
            type="number"
            min={0}
            max={3650}
            step={1}
            disabled={!canEdit}
            value={values.trial_days}
            onChange={set('trial_days')}
            error={fieldErrors.trial_days}
            hint="0 to 3,650. Zero means no trial. Changing it affects subscriptions taken from now on, not ones already running."
          />

          <Field
            id="grace_period_days"
            label="Grace period days"
            type="number"
            min={0}
            max={3650}
            step={1}
            disabled={!canEdit}
            value={values.grace_period_days}
            onChange={set('grace_period_days')}
            error={fieldErrors.grace_period_days}
            hint="0 to 3,650. How long an unpaid subscription keeps working (SRS §12.2)."
          />

          <SelectField
            id="default_renewal_mode"
            label="Default renewal mode"
            required
            disabled={!canEdit}
            value={values.default_renewal_mode}
            onChange={set('default_renewal_mode')}
            error={fieldErrors.default_renewal_mode}
            hint="What a subscription on this plan starts out renewing by (SRS §12.5)."
          >
            {RENEWAL_MODES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>
        </FormSection>

        <FormSection
          title="Placement"
          description="Where the plan sits in the list, and whether it is the one recommended."
        >
          <Field
            id="display_order"
            label="Display order"
            type="number"
            min={0}
            max={100000}
            step={1}
            disabled={!canEdit}
            value={values.display_order}
            onChange={set('display_order')}
            error={fieldErrors.display_order}
            hint="0 to 100,000. The catalogue is listed in ascending order, so a lower number comes first."
          />

          <Field
            id="tier_rank"
            label="Tier rank"
            type="number"
            min={0}
            max={10000}
            step={1}
            disabled={!canEdit}
            value={values.tier_rank}
            onChange={set('tier_rank')}
            error={fieldErrors.tier_rank}
            hint="0 to 10,000. Higher is a higher tier — this is what tells an upgrade from a downgrade (SRS §12.3, §12.4), so moving it changes how a plan change is classified and priced."
          />

          <CheckboxField
            id="is_recommended"
            label="Recommended"
            disabled={!canEdit}
            checked={values.is_recommended}
            onChange={(event) =>
              setValues((prev) => ({ ...prev, is_recommended: event.target.checked }))
            }
            error={fieldErrors.is_recommended}
            hint="Marks this as the plan the catalogue points schools at. Nothing at the database level stops a second plan carrying it, so check the list before ticking it."
          />
        </FormSection>

        {canEdit ? (
          <FormActions cancelHref="/super-admin/plans">
            <SubmitButton fullWidth={false} busy={saving} busyLabel="Saving…">
              Save changes
            </SubmitButton>
          </FormActions>
        ) : null}
      </form>
    </div>
  );
}

/** What the readiness block says is still missing, in one line under the title. */
function readinessLine(plan: PlanDetail, catalogue: Catalogue | null): string {
  const active = plan.prices.filter((price) => price.is_active).length;
  const modules = plan.modules.filter((row) => row.is_enabled).length;
  const limitTotal = catalogue?.limits.length ?? plan.limits.length;

  return [
    `${active} active price${active === 1 ? '' : 's'}`,
    `${modules} module${modules === 1 ? '' : 's'} enabled`,
    `${plan.limits.length} of ${limitTotal} limits configured`,
  ].join(' · ');
}

const TABS = [
  { key: 'details', label: 'Details' },
  { key: 'pricing', label: 'Pricing' },
];

function PlanDetailScreen() {
  const params = useParams<{ id: string }>();
  const { can } = useAuth();
  const [active, setActive] = useActiveTab(TABS);

  const { detail, catalogue, loading, error, refusal, reload } = usePlanDetail(params.id, true);

  const canManage = can('plans.manage');
  const canPrice = can('plans.pricing.manage');

  if (refusal) {
    return (
      <div>
        <PageHeader title="Plan" />
        <RefusalNotice refusal={refusal} />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Plan" />
        <ErrorNotice message={error} onRetry={reload} />
      </div>
    );
  }

  if (!detail || !catalogue) {
    return (
      <div>
        <PageHeader title="Plan" />
        <LoadingBlock />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={detail.name}
        description={readinessLine(detail, catalogue)}
        action={
          <Link href="/super-admin/plans" className="btn btn-secondary">
            Back to plans
          </Link>
        }
      />

      <p className="mb-5 flex flex-wrap items-center gap-2 text-sm text-muted">
        <code className="text-xs">{detail.code}</code>
        <StatusBadge status={detail.status} />
        <StatusBadge status={detail.visibility} />
        {/*
          * Straight to the three sub-screens, with this plan already chosen — they read `?plan=` and
          * would otherwise open on their own picker asking a question that has just been answered.
          */}
        <Link
          href={`/super-admin/plans/modules?plan=${detail.id}`}
          className="text-brand-text underline-offset-4 hover:underline"
        >
          Modules
        </Link>
        <Link
          href={`/super-admin/plans/features?plan=${detail.id}`}
          className="text-brand-text underline-offset-4 hover:underline"
        >
          Features
        </Link>
        <Link
          href={`/super-admin/plans/limits?plan=${detail.id}`}
          className="text-brand-text underline-offset-4 hover:underline"
        >
          Limits
        </Link>
      </p>

      <Tabs tabs={TABS} active={active} onChange={setActive} label="Plan configuration" />
      {/*
        * Both panels rendered, the inactive one `hidden` — see the header. `hidden` rather than a
        * conditional is the whole fix: a conditional unmounts the form and its state goes with it.
        * Each tab's `aria-controls` now always points at a panel that exists.
        */}
      <div hidden={active !== 'details'}>
        <TabPanel tabKey="details">
          <DetailsForm plan={detail} canEdit={canManage} onSaved={reload} />
        </TabPanel>
      </div>
      <div hidden={active !== 'pricing'}>
        <TabPanel tabKey="pricing">
          <PricingEditor plan={detail} catalogue={catalogue} canEdit={canPrice} onSaved={reload} />
        </TabPanel>
      </div>
    </div>
  );
}

export default function PlanDetailPage() {
  /* `useActiveTab` reads the query string, which cannot run during prerender. */
  return (
    <Suspense fallback={<LoadingBlock />}>
      <PlanDetailScreen />
    </Suspense>
  );
}
