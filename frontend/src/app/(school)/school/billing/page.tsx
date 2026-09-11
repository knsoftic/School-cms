'use client';

/**
 * Billing — the school's own subscription, invoices and payments. The owner's decision D27.
 *
 * §33's School list has no billing screen, and FR-SUB-013/014/015 and FR-BILL-003/005 all name the
 * school as an actor: upgrading, downgrading, paying an invoice with a transaction id or a screenshot,
 * applying a coupon. School leadership held `subscriptions.self.manage` and `payments.submit` with no
 * screen to use them from, and lacked the reads they need; D27 built this screen and granted Principal
 * and School Admin `plans.view`, `addons.view` and `payments.view`.
 *
 * ## Each tab is shown to whoever holds its read
 *
 * Five sections, and the keys that open each are the keys the API checks — `can()` decides what to
 * render, never what is allowed:
 *
 * | Tab          | Read                        | Writes                                                        |
 * |--------------|-----------------------------|---------------------------------------------------------------|
 * | Subscription | `subscriptions.self.view`   | renew (`subscriptions.self.manage`)                           |
 * | Invoices     | `invoices.self.view`        | pay (`payments.submit`), coupon (`coupons.redeem`)             |
 * | Payments     | `payments.view`             | —                                                             |
 * | Change plan  | `subscriptions.self.view`   | `subscriptions.self.manage` + `plans.view`                     |
 * | Add-ons      | `subscriptions.self.view`   | buy (`subscriptions.self.manage` + `addons.view`), cancel (`subscriptions.self.manage`) |
 *
 * So a Principal or School Admin sees all five. An Accountant holds `invoices.self.view` and
 * `payments.submit` and nothing else here: they see the invoices and can pay them, and follow a
 * payment's review on the invoice's own screen, which carries its payments.
 *
 * ## One subscription read for three tabs
 *
 * The overview, the plan change and the add-ons all read the same record, and every write on the last
 * two answers with the whole subscription — so it is read once here (`useOwnSubscription()`) and a
 * write's response replaces it, rather than three tabs each fetching and drifting apart.
 */

import { Suspense } from 'react';

import { useAuth } from '@/lib/auth';
import { Notice } from '@/components/form';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
import { LoadingBlock, PageHeader } from '@/components/table';

import { AddonsPanel } from './addons';
import { useOwnSubscription } from './billing';
import { InvoicesPanel } from './invoiceList';
import { OverviewPanel } from './overview';
import { PaymentsPanel } from './paymentList';
import { PlanChangePanel } from './planChange';

function BillingScreen() {
  const { can } = useAuth();

  const canSeeSubscription = can('subscriptions.self.view');
  const canSeeInvoices = can('invoices.self.view');
  const canSeePayments = can('payments.view');

  const tabs = [
    ...(canSeeSubscription ? [{ key: 'overview', label: 'Subscription' }] : []),
    ...(canSeeInvoices ? [{ key: 'invoices', label: 'Invoices' }] : []),
    ...(canSeePayments ? [{ key: 'payments', label: 'Payments' }] : []),
    ...(canSeeSubscription ? [{ key: 'plan', label: 'Change plan' }, { key: 'addons', label: 'Add-ons' }] : []),
  ];

  /*
   * Called whatever the tabs are — a hook cannot be conditional — with a placeholder when there are
   * none, which the notice below replaces. An address naming a tab this account cannot see (a payment
   * notification opened by an Accountant, say) falls back to the first one it can.
   */
  const [active, setActive] = useActiveTab(tabs.length > 0 ? tabs : [{ key: 'none', label: '' }]);
  const scope = useOwnSubscription(canSeeSubscription);

  /* The wallet, for the pay dialog's hint — only when the subscription is readable at all. */
  const walletBalance = scope.subscription ? Number(scope.subscription.wallet_balance) || 0 : null;

  return (
    <div>
      <PageHeader
        title="Billing"
        description="Your school’s subscription, its invoices and the payments made against them."
      />

      {tabs.length === 0 ? (
        <Notice tone="info">
          Billing needs permission to view the school’s subscription, its invoices or its payments, and this
          account holds none of them.
        </Notice>
      ) : (
        <>
          <Tabs tabs={tabs} active={active} onChange={setActive} label="Billing sections" />
          <TabPanel tabKey={active}>
            {active === 'overview' ? (
              <OverviewPanel scope={scope} canRenew={can('subscriptions.self.manage')} />
            ) : active === 'invoices' ? (
              <InvoicesPanel canPay={can('payments.submit')} walletBalance={walletBalance} />
            ) : active === 'payments' ? (
              <PaymentsPanel />
            ) : active === 'plan' ? (
              <PlanChangePanel
                scope={scope}
                canChange={can('subscriptions.self.manage')}
                canReadPlans={can('plans.view')}
                canSeeInvoices={canSeeInvoices}
              />
            ) : (
              <AddonsPanel
                scope={scope}
                canBuy={can('subscriptions.self.manage')}
                canReadCatalogue={can('addons.view')}
                canSeeInvoices={canSeeInvoices}
              />
            )}
          </TabPanel>
        </>
      )}
    </div>
  );
}

/* `useActiveTab` reads the address, so the screen renders inside a Suspense boundary — the Fees shape. */
export default function BillingPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <BillingScreen />
    </Suspense>
  );
}
