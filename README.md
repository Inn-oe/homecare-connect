# HomeCare Connect (Phase 1 MVP)

A home services platform for Zimbabwe. Homeowners book services through the company. The company vets **partner** service providers and dispatches each job to one of them. Partners are paid per job, and the company keeps a commission.

**Services:** grass cutting, yard cleaning, tree cutting, fumigation & pest control, home/carpet/sofa/mattress deep cleaning, CCTV installation & repair, house maids (day maids, part-time, live-in and nanny placements).

## Run it

Requires Node.js 22.13 or newer.

```
npm install
npm start
```

Open http://localhost:3000. The first run creates `data.db` and seeds the catalog plus these logins:

| Role | Login | Password |
|---|---|---|
| Operations admin | admin@homecare.local | admin123 |
| Demo homeowner | home@demo.local | demo123 |
| Demo partner (lawn, yard, cleaning; Harare North & East) | partner@demo.local | demo123 |

`npm run reset-db` wipes the data and starts fresh.

## How it works

The app works on phones (bottom navigation bar) and desktops. Visitors can browse services and prices before signing up.

**Homeowner:** signs up with their mobile number, searches or browses services, and books in a short step-by-step flow:
1. Choose an option and quantity.
2. Tap a date and arrival time.
3. Pick or add an address.
4. Add notes and choose how to pay: EcoCash, OneMoney, InnBucks, bank/ZIPIT or cash.
5. Review and confirm.

The price is shown throughout. Quote-priced work (tree cutting, CCTV installs, termites) books a free site visit instead. After booking, the homeowner tracks the job live, with progress steps from booked to done. Once a partner accepts, they see the partner's name, rating and Call/WhatsApp buttons. They then pay, confirm and rate, or report a problem.

**Partner:** applies with:
- national ID
- the services they offer, with certificates where required (fumigation, tree cutting, CCTV, maids)
- the areas they cover
- an EcoCash payout number

Operations approves the application. The partner can switch "available for jobs" on or off. They get job offers that show their earnings and the area, and accept or decline them. They then tap *I'm on my way → start job → job finished*, recording cash collected if applicable. Call, WhatsApp and Google Maps directions buttons appear once they accept, and the full address and customer phone are only revealed then. They can also see their earnings and payouts.

**Everyone:** can change their password and contact support by call or WhatsApp from the Account page. Job pages refresh automatically every 20 seconds.

**Operations (admin):**
- prepare quotes for tree cutting, termite, commercial fumigation and CCTV installs
- auto-assign or hand-pick a partner (the system ranks partners by rating, workload that day and experience, filtered by skill and area)
- verify mobile-money payment references
- resolve disputes (close or refund)
- approve or suspend partners
- settle partner balances weekly
- edit prices and commission

### Job lifecycle

```
quote_requested → quoted ─┐                      (quote services only)
                          ▼
                     confirmed → offered → accepted → en_route → in_progress → completed → closed
                                    │ decline → back to confirmed           └→ disputed → closed | refunded
cancel allowed up to "accepted"
```

### Money

- Each service has a commission rate (default 20%; CCTV installs 15%; day maids 25%). Maid placement fees are 100% company revenue. The maid's salary is agreed and paid separately between the homeowner and the maid.
- **Mobile money / bank:** the customer pays the company and submits the transaction reference. Ops verifies it, and once the job is closed the partner's share is added to their balance.
- **Cash:** the partner collects the full amount, so the company's commission is subtracted from the partner's balance.
- **Settlements:** the *Settlements* tab shows each partner's net balance. Pay it (or collect it) via EcoCash and record the reference.

## Before going live

- [ ] Change the admin password (or delete the seeded admin after creating a real one) and set `SEED_DEMO=false`
- [ ] Set `COMPANY_NAME`, `SUPPORT_PHONE`, `PAYMENT_INSTRUCTIONS` (real merchant codes and bank details) and `APP_SECRET`
- [ ] Review the seeded **prices**. They are placeholders in USD; edit them in *Services & prices*
- [ ] Get legal advice on partner agreements and house-maid placements (domestic worker regulations and minimum wages)
- [ ] Confirm fumigation partners hold the required pesticide/EMA licences
- [ ] Serve over HTTPS and back up `data.db`

## Production (Render)

The app uses **PostgreSQL** when `DATABASE_URL` is set, and a local SQLite file otherwise. With `NODE_ENV=production` it refuses to start unless these are set:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (use the Render *internal* URL) |
| `APP_SECRET` | Long random string used to sign logins. Changing it logs everyone out |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | First operations account, created when the database is empty. Change the password after first login |
| `ADMIN_PHONE` | Optional, the admin's mobile number |
| `COMPANY_NAME`, `SUPPORT_PHONE`, `PAYMENT_INSTRUCTIONS` | Business details shown in the app |

Demo accounts are never created in production. Build command: `npm install`. Start command: `npm start`. Health check path: `/healthz`.

## Code map

| File | What's in it |
|---|---|
| `server.js` | API: accounts, properties, bookings, the action table that drives the job lifecycle, dispatch ranking, earnings, admin |
| `db.js` | SQLite schema and seed catalog (categories, services, prices) |
| `auth.js` | Password hashing (scrypt) and signed login tokens |
| `config.js` | Company name, zones, payment methods, payment instructions |
| `public/app.js` | The web app: public site, booking wizard, homeowner/partner/operations screens (hash routes, so the back button works) |
| `public/styles.css` | Design system: colours, buttons, cards, choice tiles, progress tracker, mobile layout |

## Next phases

1. **Paynow integration:** automatic EcoCash/OneMoney/card confirmation instead of manual reference checks
2. **SMS / WhatsApp notifications:** job offers to partners, status updates to homeowners
3. **Photo uploads:** before/after photos and partner documents (ID, police clearance, licences)
4. **Recurring bookings:** fortnightly grass cutting, weekly maid days, quarterly fumigation
5. **Partner mobile app:** offline-friendly Android app; GPS check-in
6. **Move to PostgreSQL** when traffic grows. The SQL is standard, so mostly the `db.js` driver changes
