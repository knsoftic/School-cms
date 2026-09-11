# Product-owner decisions

**Decided:** 2026-09-10 (session 28), by the project owner, in answer to questions put in the session.
**Status of this document:** an addendum to `SRS_Multi-School-Management-System.docx`. Where the SRS
states something, the SRS governs. These decisions fill gaps the SRS declares it does not fill — §35
lists "additional workflows", "additional business rules" and "additional pricing rules" among them —
and they are here so that each behaviour built on one can point at who decided it, rather than reading
as something the implementation invented.

Each entry names the gap it answers, the choice made, and the options that were offered and not
taken. Every question was put with a recommended option; every recommendation was accepted.

| # | Gap | Decision | Not chosen |
|---|---|---|---|
| D1 | **No login for teachers, staff, students or School Admins.** Only a Principal (FR-SADMIN-009) and a Parent (FR-PARENT-001) have a creation path; FR-TEACHER-002's precondition "Teacher account exists" names no creator | **The school creates logins.** A Principal or School Admin can create a login when adding a teacher, staff member or student, and can create School Admin accounts — a temporary password, changed at first sign-in, the way Parent accounts already work | Super Admin only; leave accounts outside the app |
| D2 | **`admin_limit` and `api_limit` are not enforced** (FR-SUB-008) | **Enforce Admin Limit** on School Admin accounts, like the other headcount limits. **API Limit stays unenforced** — the SRS never defines its unit | Enforce both; leave both |
| D3 | **A Principal who belongs to another school** (triage finding 10) | **Refuse, with a correct message** telling the Super Admin to create a Principal for this school. The account's tenancy never moves | Move the account to the new school |
| D4 | **Is a class required at admission?** (finding 17 — SRS:818 says yes, §15.1 lists Class Assignment separately) | **Class required.** Every admitted student gets a roll number at once | Optional, numbered when a class is first set |
| D5 | **Wallet does nothing** (§13.2, Known Issues #19) | **Refunds credit, invoices spend.** A refund to the wallet adds to the subscription's balance; paying with Wallet takes from it and is refused if the balance is short. No new table | Also a manual Super Admin credit; remove Wallet |
| D6 | **"A billing event" is never defined** (FR-BILL-001) | **Invoices are issued at each billing period.** A scheduled job (hourly, at ten past) issues a subscription's invoice once its period has started — first activation and every renewal — due when the plan's grace period ends. Manual Generate stays | Keep manual only |
| D7 | **A `price` override is stored and does nothing** (finding 39) | **It replaces the plan price** on invoices and renewals while it is in effect (`effective_from` / `effective_until`). Setup fee and add-ons are unchanged | Refuse price overrides |
| D8 | **Is a transaction id required?** (finding 52) | **A transaction id or a screenshot.** A manual submission with neither is refused | Transaction id for bank transfer only; both optional |
| D9 | **Premium Reports unlocks nothing** (finding 64) | **It unlocks report exports** — PDF, Excel and Print. Without it a school still sees every report on screen | Stop selling it; leave inert |
| D10 | **Who buys add-ons?** (finding 53 — "Super Admin and/or school" vs Actor "Super Admin") | **The Super Admin and the school** — today's behaviour, FR-SUB-009's Description | Super Admin only |
| D11 | **May a plan be created Active?** (finding 11) | **No — a plan starts inactive** and is activated once it has a price, as today | Allow Active when a price is supplied |
| D12 | **Two period-less fees of one component** (finding 20) | **A different fee structure is a different fee** when no month is named. The same structure twice is still refused as a double charge | Always require a month; keep refusing |
| D13 | **Admission "Documents" has no code path** (finding 16) | **Schools may upload documents to a student**, with the existing student permissions — upload on `students.manage`, view on `students.view` — stored as uploaded rows of the existing `documents` table. No new table or permission | Not in this version |
| D14 | **Do teachers edit the timetable?** (finding 47 — §5 prose vs FR-TT-001's Actor line) | **View only**, as today: FR-TT-001's Actor line governs | Teachers can edit |
| D15 | **Teacher and Super Admin receive no notification** (finding 63) | **Both do.** Teachers: exam announcements and published results for the classes they teach. Super Admin: payment received, payment failed and subscription expiry, as platform notifications | Super Admin only; teachers only; no change |
| D16 | **Custom Domain unlocks nothing** — serving a school on its own domain is hosting work outside this application | **Ship it switched off.** A new install seeds it inactive; the Super Admin can switch it on once hosting supports it | Leave it purchasable |

## Second round — D17 to D37

**Decided:** 2026-09-10, by the project owner, after a section-by-section re-audit of the SRS against
the code (commit `7e26dce`) found 21 gaps the SRS does not settle. Each was put with a recommended
option and the owner approved all 21 recommendations at once.

| # | Gap | Decision | Not chosen |
|---|---|---|---|
| D17 | **A student "has access relevant to their own records"** (SRS:105) but can reach only results and homework; `students.self.view`, `attendance.self.view` and `fees.self.view` are granted and mounted nowhere | **Read-only self-service views.** A student sees their own attendance, fees, student profile and class timetable; a parent sees the same for each linked child — on the existing self-view keys | Results and homework only |
| D18 | **No Organization Admin can be created** (SRS:97 — the role is seeded, its workflows "Not Specified") | **The Super Admin creates them**, under `users.manage`; the role keeps its seeded read-only grants | Leave it uncreatable |
| D19 | **Deactivating a teacher, staff member or student leaves their login active** (only parents sync the two) | **Deactivating the profile suspends its login**, as parents already do | Keep the two separate |
| D20 | **A closed academic session changes nothing** (SRS:753) | **A closed session refuses new classes, admissions, exams and fee structures**, and forms default to the current session | No effect |
| D21 | **An add-on bought without a price bills 0.00** (Known Issues #18) | **Refuse the purchase** | Bill it at 0.00 |
| D22 | **A plan change into another currency** | **Keep refusing it** — today's behaviour confirmed | Allow it |
| D23 | **Billing events do not drive the subscription state** (SRS:577-578, FR-BILL-004) | **An overdue invoice makes the subscription Past Due; paying every overdue invoice returns it to Active; paying old debts never revives a Cancelled or Suspended subscription; trial days are not billed** — the first invoice starts when the trial ends | The period-end sweep stays the only driver |
| D24 | **An add-on bought mid-period is billed late or never** (SRS:526) | **A prorated charge is invoiced at purchase**, as an upgrade is | Bill from the next period |
| D25 | **SMS Credits sells an allowance nothing uses** — there is no SMS channel | **Ship it switched off**, as D16 did for Custom Domain | Build an SMS channel (a provider is needed) |
| D26 | **Three of the five pricing models are one formula over a typed number** (§10.4 names them, defines none) | **Per-Student and Student-Based bill the school's live active-student count, re-counted at each renewal; Seat-Based keeps the typed quantity; a price row's unused overage rate is hidden** | The typed quantity for all three |
| D27 | **A school has no billing screen** (FR-SUB-013/014/015, FR-BILL-003/005 name the school) and school leadership lacks the keys to pick a plan, an add-on or see a payment | **Build the school Billing screen** — subscription, invoices, paying with a transaction id or screenshot, applying a coupon, upgrading, buying add-ons — and **grant Principal and School Admin the existing `plans.view`, `addons.view` and `payments.view`** | A read-only screen with no grant change |
| D28 | **§23's Fee Reminder never reaches a subscription invoice** (`reminderCandidates()` has no caller) | **It also reminds the school's billing roles** of a subscription invoice falling due | Student fees only |
| D29 | **A fee structure's fine is stored and never applied** (SRS:909, 922) | **A daily job applies it** to a fee still unpaid after its due date plus the grace days: `fixed` a flat amount, `percentage` a share of the fee, `per_day` an amount per day late, growing until paid | Fines stay typed by hand |
| D30 | **"Class/subject assignment exists"** (SRS:1099, 1108) is not enforced | **The subject stays optional; when named it must be on the class's curriculum** (`class_subjects`). Teachers are not restricted to their own classes | Also restrict teachers |
| D31 | **A Result Card can snapshot an unpublished result** that the student can then read through documents | **Refused until the result is published** | Allowed, hidden from student and parent until published |
| D32 | **At the AI limit, extraction and analysis still run** (SRS:1153, 1172) | **They are checked against the limit and refused at the cap, but not counted** — only generation consumes the allowance | Only generation is limited |
| D33 | **A deleted school still counts** in the platform's student, teacher and subscription totals | **Its rows drop out of the totals** | Keep counting them |
| D34 | **An Accountant or Receptionist cannot pick a teacher or an exam** to generate a Teacher ID Card or Result Card (FR-DOC-001 names both) | **Small pick-lists under `documents.generate`** | Grant them `teachers.view` and `exams.view` |
| D35 | **FR-SCHOOL-001's settings are stored, not "applied"** | **The school's name, logo and currency appear on its screens and documents** | Also theme and timezone |
| D36 | **§26's heavy reports run inside the request**, not through the queue — a queued report would need somewhere to be stored and fetched | **Keep reports synchronous, recorded** | Queue them into document storage |
| D37 | **Online Exams, Laboratory, Transport and Hostel** can be sold and have no requirement behind them (no FR; §29 gives Online Exams a table and nowhere to store an attempt) | **Leave them unbuilt, recorded** | Build them, with table decisions |

## Where each is built

All sixteen were built in session 28 (commit `826e19f`) and each is asserted by the suite named, so
a regression against a decision fails the loop rather than going unnoticed.

| # | Code | Proven by |
|---|---|---|
| D1 | `POST /users` — `users.validation.js` `CREATABLE_ROLES`, `users.service.create()`; screens: Create login on teachers, staff and students, School Admins in Settings | `verify-users-roles.js` |
| D2 | `usageService.reserveHeadcount(…, ADMIN_LIMIT)` on a School Admin login; counts Principals and School Admins | `verify-users-roles.js` |
| D3 | `schools.service.js` Principal assignment refusal and its hint | `verify-platform-modules.js` |
| D4 | `students.validation.js` `class_id` required on admission; the admission form | `verify-students.js` |
| D5 | `payments.service.js` wallet debit on approval, balance check on submit, refund to wallet | `verify-billing.js` |
| D6 | `invoices.service.issueForStartedPeriods()`, `jobs/tasks/invoiceIssue.js` | `verify-jobs.js` |
| D7 | `invoices.service.generateForSubscription()` bills the plan line at an in-force price override | `verify-billing.js` |
| D8 | `payments.service.js` `PAYMENT_EVIDENCE_REQUIRED` | `verify-billing.js` |
| D9 | `reports.routes.js` export routes behind `requireFeature('premium_reports')` | `verify-reports.js` |
| D10, D11, D14 | no change — today's behaviour confirmed | the existing suites for each |
| D12 | `fees.service.alreadyAssigned()` keys a period-less fee by structure | `verify-fees.js` |
| D13 | `POST/GET /students/:id/documents`; `documents.service.js` keeps generated-only types generated | `verify-students.js`, `verify-documents.js` |
| D15 | `notifications.service.js` teacher recipients and platform copies | `verify-notifications.js` |
| D16 | `seeders/05-addons.js` `SEEDED_INACTIVE` | `verify-seed.js` (on the seed definitions — an existing install keeps its own `is_active`) |

The second round was built in session 29, each again asserted by the suite named:

| # | Code | Proven by |
|---|---|---|
| D17 | `GET /students/mine`, `/attendance/mine`, `/fees/mine` over `services/selfScope.js`, each projected to named columns; the student and parent portal screens (attendance, fees, record, timetable) and the teacher's own timetable | `verify-students.js`, `verify-attendance.js`, `verify-fees.js`, `verify-parents.js` |
| D18 | `users.service.createOrganizationAdmin()`, `ORGANIZATION_ADMIN` in `users.validation.js` `CREATABLE_ROLES`; the Add admin action on the platform Organizations screen | `verify-users-roles.js` |
| D19 | `users.service.followProfile()`, called by the teacher, staff and student deactivate and reactivate paths | `verify-users-roles.js` |
| D20 | `utils/schoolScope.js` `assertSessionOpen()` / `assertOpenForNew()` on the four creates and on every move into a closed session (class session, student class or session, promotion); `/auth/me` `school.current_session` for the form defaults | `verify-school-setup.js`, `verify-students.js`, `verify-exams.js`, `verify-fees.js` |
| D21 | `subscriptions.validation.js` `addon_price_id` required on a purchase | `verify-subscriptions.js` |
| D22 | no change — today's refusal confirmed | the existing subscription suite |
| D23 | `subscriptions.service.js` `pastDueForOverdueInvoices()`, `settleArrears()`, the trial re-base in the sweep, and `renew()`, which with an invoice overdue advances the period but keeps Past Due or Grace (grace end included), moves Active or Expiring into its configured grace period (Past Due when that is zero days), and refuses an Expired subscription (`SUBSCRIPTION_IN_ARREARS`); `jobs/tasks/invoiceOverdue.js` | `verify-subscriptions.js`, `verify-billing.js` |
| D24 | `subscriptions.service.purchaseAddon()` invoices a prorated line when the period is already invoiced | `verify-billing.js` |
| D25 | `seeders/05-addons.js` `SEEDED_INACTIVE` gains `sms_credits` | `verify-seed.js` |
| D26 | `subscriptions.service.js` `COUNTED_MODELS`, `billedQuantity()`; a typed quantity refused on a counted price | `verify-subscriptions.js` |
| D27 | `config/permissions.js` `D27_BILLING_KEYS` and the seeder's `PREVIOUS_DEFAULTS` upgrade rule; the school Billing screen | `verify-seed.js`, `verify-billing.js` |
| D28 | `notifications.service.js` `sweepInvoiceReminders()` | `verify-notifications.js` |
| D29 | `fees.service.applyFines()`, `jobs/tasks/feeFines.js` | `verify-fees.js`, `verify-jobs.js` |
| D30 | `homework.service.assertOnCurriculum()`, shared with assignments; `GET /subjects?class_id=&section_id=` for the pickers | `verify-homework.js`, `verify-assignments.js`, `verify-school-setup.js` |
| D31 | `documents.service.js` refuses a Result Card for an unpublished result | `verify-documents.js` |
| D32 | `ai.routes.js` `enforceLimit(AI_LIMIT)` on extract, analyze and generate; only generation reserves | `verify-ai.js` |
| D33 | `platform.service.js` `OF_LIVE_SCHOOL` joins | `verify-platform-modules.js` |
| D34 | `GET /documents/pickers/teachers` and `/pickers/exams` under `documents.generate` | `verify-documents.js` |
| D35 | `utils/schoolScope.js` `schoolBrand()`: `/auth/me` `school` for every school role, the currency default on fee structures and ledger entries, the display name on documents (snapshotted), result cards, the class-result PDF and report exports | `verify-fees.js`, `verify-finance.js`, `verify-reports.js`, `verify-documents.js`, `verify-exams.js` |
| D36, D37 | no change — recorded | — |

## What these decisions do not change

- **The catalogue.** No decision adds a table, a column, a permission, a role, a module key or a limit
  key. D1 uses `users.manage`, which the catalogue already grants to school leadership as "Create /
  edit users"; D13 uses `students.manage` and `students.view`; D9 uses the `premium_reports` feature
  key the add-on already unlocks. **D27 is the one change to the default role grants**: it gives
  Principal and School Admin three keys the catalogue already has (`plans.view`, `addons.view`,
  `payments.view`) — seed data the owner decided, not a new key.
- **Anything the SRS states.** D10, D11 and D14 confirm today's behaviour; they are recorded because
  the question was open, not because anything changed.
