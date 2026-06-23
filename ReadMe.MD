# Project LITe — Survey Automation Server

NIH-funded 4-year longitudinal study (~430 participants, 3 cohorts × 3
waves) for the **Control + Adaptive Behavior Lab** at Temple University.

This repo now contains **two implementations** side-by-side:

## ✨ New: `app/` — Next.js dashboard server

The web-based replacement for the legacy local-cron Python scripts. Same
architectural philosophy as the SDN / Project SPARK dashboard:

- REDCap → JSON snapshots committed by GitHub Actions
- Live dashboard at a Vercel URL with password-gated coordinator UI
- All ~92 message templates baked in from the
  `Timeline of Automated Messages.xlsx` workbook
- 5-minute outgoing-message poller (Gmail SMTP + OpenPhone SMS)
- No more Google Sheet or local cron required

**Start here:** [`app/README.md`](app/README.md). It includes:

- the generated dashboard password
- the full GitHub secrets list
- Vercel-project setup steps
- which legacy field names need verification

## 📂 Legacy directories

The folders below are the pre-2026 implementation that ran on a local Mac
mini. They remain in the repo for historical reference and as
field-name documentation for the new server. They are **not** running
anymore (paths were hardcoded to `/Users/tur50045/`).

- `FollowupCheck/` — REDCap report 8040 → Google Sheet sync
- `ConditionalFormatting/` — color-code completion in Google Sheet
- `FollowupText/` — monthly outreach (SMS + email)
- `stsemaimport/` — survey-cycle scheduling (Y1/Y2 STS/EMA)
- `Wave-2/` — Y2 versions of the same
- `API_INFO/`, `Contacts/`, `Google_API/` — credentials + contact lists

Once the new dashboard is verified in production, these can be archived.

## 👨‍💻 Developer

Built and maintained by **Danny Zweben** —
[`danny.zweben99@gmail.com`](mailto:danny.zweben99@gmail.com)
