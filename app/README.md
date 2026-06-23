# CABLAB · Project LITe — Server Dashboard

Next.js 16 dashboard + GitHub Actions automation that replaces the legacy
Python-on-cron + Google-Sheets workflow at the parent directory of this
folder. Same architecture as the SDN/Project SPARK dashboard:

- REDCap is the source of truth.
- A scheduled GitHub Actions workflow polls REDCap, builds JSON
  snapshots, commits them, and triggers a Vercel deploy.
- A separate workflow runs every 5 minutes, looks at
  `due-reminders.json`, fires anything whose `scheduledAt` is within
  ±2.5 min of "now", and logs to `sent-log.json`.
- The dashboard reads those JSON files via `/api/data/*` routes.

---

## Generated dashboard password

```
Mg6wz1wk2NO5nAGdsPf2
```

Set this as the `DASHBOARD_PASSWORD` env var in Vercel (production). The
auth cookie name is `lite_auth` (30-day TTL).

If you want to rotate it, regenerate with:

```bash
python3 -c "import secrets, string; print(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(20)))"
```

---

## Repository layout

```
app/
├── README.md                       this file
├── package.json                    Next 16 + Tailwind 4 + Prisma
├── private/
│   ├── data/                       (gitignored at runtime — GH Actions commits JSON here)
│   │   ├── participants.json       output of fetch-data.mjs
│   │   ├── due-reminders.json      next 7 days of scheduled sends
│   │   ├── sent-log.json           rolling log of what we've actually sent
│   │   ├── last-fetch.json         freshness banner data
│   │   └── postponed.json          (optional) [{ "pid": "1001" }] to skip
│   └── docs/                       reference materials, versioned
│       ├── Timeline_of_Automated_Messages.xlsx
│       └── Example_PID_sessionnotes.xlsx
├── scripts/
│   ├── fetch-data.mjs              REDCap → JSON snapshots
│   ├── send-due-messages.mjs       5-min poller (Gmail + OpenPhone)
│   └── regen-timeline.py           Excel → src/lib/timeline.ts
├── .github/workflows/
│   ├── refresh-data.yml            every 6h
│   └── send-due-messages.yml       every 5 min
└── src/
    ├── app/
    │   ├── login/                  password gate
    │   ├── dashboard/
    │   │   ├── overview/           wave-by-wave completion stats
    │   │   ├── participants/       PID directory + contact info
    │   │   ├── waves/              per-wave V1→V2 lifecycle grid
    │   │   ├── sts/                Screen Time Survey 1 + 2 tracker
    │   │   ├── ema/                EMA prompt status (per active cycle)
    │   │   ├── followup/           V1→at-home→V2 + send-history
    │   │   └── reminders/          outgoing queue (next 7 days)
    │   └── api/                    file-read passthroughs for data
    ├── components/DashboardShell   sidebar + nav
    ├── lib/
    │   ├── auth.ts                 HMAC cookie auth (Web Crypto API)
    │   ├── timeline.ts             AUTO-GENERATED from the xlsx
    │   ├── lite-utils.ts           shared helpers
    │   └── postponed.ts            unused — use private/data/postponed.json
    └── types/index.ts              LITe data model
```

---

## Required GitHub secrets

Set these in **Settings → Secrets and variables → Actions** on the
`CABLAB_LITe-API-Server` GitHub repo:

| Secret | Used by | How to get |
|---|---|---|
| `REDCAP_API_URL` | both | `https://cphapps.temple.edu/redcap/api/` |
| `REDCAP_LITE_TOKEN` | both | REDCap → LITe project → API → generate token. Needs full read + report + survey-link permissions. |
| `GMAIL_USER` | send | `cablablite@gmail.com` (already in use by the legacy scripts) |
| `GMAIL_APP_PASSWORD` | send | Google Account → Security → App passwords → "Mail / Other (LITe Server)". 16-char no spaces. |
| `QUO_API_KEY` | send | OpenPhone → Settings → API → key (already in `stsfollowup.py`) |
| `QUO_FROM_NUMBER` | send | OpenPhone Phone Number ID (the one starting with `PN...`, NOT the +1 number) |
| `VERCEL_TOKEN` | refresh | https://vercel.com/account/tokens → **No Expiration** (DO NOT pick CLI session) |
| `VERCEL_ORG_ID` | refresh | from `.vercel/project.json` after `vercel link` |
| `VERCEL_PROJECT_ID` | refresh | same place |

The two Vercel IDs are auto-populated by `vercel link` — see step 4 below.

---

## First-time setup (this is the part only you can do)

1. **Make a fresh Vercel project**
   - https://vercel.com/new
   - Import this GitHub repo (`CABLAB_LITe-API-Server`)
   - Root directory: `app`
   - Framework: Next.js (auto-detected)
   - Don't deploy yet — first add env vars

2. **Add the Vercel env vars** (Project Settings → Environment Variables, production):
   - `DASHBOARD_PASSWORD` = `Mg6wz1wk2NO5nAGdsPf2`
   - `COOKIE_SECRET` = anything random (or just reuse `DASHBOARD_PASSWORD`)
   - `REDCAP_API_URL`, `REDCAP_LITE_TOKEN` (so any SSR rendering still works if you ever add one)

3. **Generate the REDCap LITe API token** (Temple's REDCap → LITe project → API)
   - Add it to GitHub secrets as `REDCAP_LITE_TOKEN`

4. **Generate the Vercel deploy token + link the project locally**
   ```bash
   cd app
   npx vercel login          # follow the email link
   npx vercel link           # pick the project you made in step 1 — creates .vercel/project.json
   cat .vercel/project.json  # copy projectId / orgId → GitHub secrets
   ```
   Then visit https://vercel.com/account/tokens → "Create token" → **No Expiration**.
   Save it as the `VERCEL_TOKEN` GitHub secret.

5. **Trigger the first refresh** (Actions tab → "Refresh LITe REDCap Data" → "Run workflow").
   It will pull from REDCap, commit `private/data/*.json`, then deploy.

6. **(optional) Disable Vercel deployment protection** on the project so
   non-Vercel-team viewers don't get bounced through SSO — same as we did
   for SPARK. Project Settings → Deployment Protection → Disable.

---

## Compute model: why GitHub Actions, not Vercel Cron

The legacy Python server runs on a Mac mini via local cron. We considered
three replacements:

| Option | Pros | Cons |
|---|---|---|
| **GitHub Actions (chosen)** | Free, proven for SDN, no IP-block issues with Temple REDCap, audit log built-in | 5-min cron minimum, ~30 sec startup overhead |
| Vercel Cron | 1-min granularity, lower latency | Vercel IPs **blocked** by Temple REDCap — disqualifies it |
| Cloudflare Workers Cron | 1-min granularity, sub-second startup | Need to plumb env, separate dashboard from worker. Migration path if 5-min becomes too coarse. |

EMA prompts are scheduled to specific clock times (e.g. Monday 7:34 AM),
but REDCap pre-calculates each timestamp as a field value. The poller
runs every 5 min with a ±2.5-min match window — so the worst-case latency
is 2.5 min. If you ever need tighter, lift `send-due-messages.mjs` into a
Cloudflare Worker; the rest of the stack stays the same.

---

## Adapting REDCap field names

I built `scripts/fetch-data.mjs` against the field names that appear in
the `Timeline of Automated Messages` workbook:

- Events: `preenrollment_arm_1`, `visit_1_y{N}_arm_1`, `athome_measures_y{N}_arm_1`, `screen_time_y{N}_arm_1`, `screen_time_2_y{N}_arm_1`, `ema_y{N}_arm_1`, `visit_2_y{N}_arm_1`
- Fields: `first_name`, `last_name`, `parent_name`, `email`, `phone_primary`, `phone_secondary`, `child_phone`, `pid`, `cohort_group`, `timestamp_athome`, `break_1_complete`, `athome_measures_complete`, `screen_time_cycle_{1|2}`, `screen_time_{1|2}_{n}_date`, `screen_time_{1..6}_complete`, `screen_time_2_{1..3}_complete`, `ema_cycle`, `ema_start_day`, `ema_phone`, `ema_response_complete`, `ema_{day}{week}_{hhmm}` (e.g. `ema_m1_734`)

If REDCap's actual field IDs differ (case, plural, suffix, etc.), edit
`scripts/fetch-data.mjs` — the only file that touches REDCap field names
directly. The dashboard pages all consume the LITe types in
`src/types/index.ts`, which is data-shape stable.

---

## Updating message templates

`src/lib/timeline.ts` is **auto-generated** from
`private/docs/Timeline_of_Automated_Messages.xlsx`. To update:

```bash
# 1) Edit the .xlsx in Excel/Sheets, save back into private/docs/
# 2) Regenerate the TS file:
pip install openpyxl
python3 scripts/regen-timeline.py
# 3) Commit and push — next refresh will use the new templates
```

---

## Local dev

```bash
cd app
npm install
echo 'DASHBOARD_PASSWORD=Mg6wz1wk2NO5nAGdsPf2' > .env.local
echo 'COOKIE_SECRET=anything-random-here' >> .env.local
echo 'REDCAP_LITE_TOKEN=put-it-here-to-fetch-locally' >> .env.local
npm run dev
# http://localhost:3000 → /login → /dashboard/overview
```

To populate JSON locally without waiting for GH Actions:

```bash
REDCAP_LITE_TOKEN=... node scripts/fetch-data.mjs
```

To preview a send cycle without actually sending:

```bash
DRY_RUN=true node scripts/send-due-messages.mjs
```

---

## What's NOT yet done (your turn)

These are the things I literally cannot do from this session — they need
your hands or credentials:

- [ ] Create the Vercel project
- [ ] Generate `REDCAP_LITE_TOKEN` from Temple REDCap
- [ ] Generate a Gmail App Password and confirm the cablablite@ account
  is what you want to send from
- [ ] Add all GitHub secrets listed above
- [ ] Run the first **Refresh LITe REDCap Data** workflow and confirm
  participants.json populates
- [ ] (only after a healthy refresh) enable the
  **Send LITe Due Messages** workflow (`*/5 * * * *` is live by default —
  you may want to disable until you're sure the data looks right;
  `Actions tab → Send LITe Due Messages → ⋯ → Disable workflow`)

Everything else is built, committed, and runnable as soon as the
secrets land.
