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
| D6 | **"A billing event" is never defined** (FR-BILL-001) | **Invoices are issued at each billing period.** The daily job issues a subscription's invoice when its period starts — first activation and every renewal — due when the plan's grace period ends. Manual Generate stays | Keep manual only |
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

## What these decisions do not change

- **The catalogue.** No decision adds a table, a column, a permission, a role, a module key or a limit
  key. D1 uses `users.manage`, which the catalogue already grants to school leadership as "Create /
  edit users"; D13 uses `students.manage` and `students.view`; D9 uses the `premium_reports` feature
  key the add-on already unlocks.
- **Anything the SRS states.** D10, D11 and D14 confirm today's behaviour; they are recorded because
  the question was open, not because anything changed.
