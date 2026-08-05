# Missed Sends: July 18 – August 4, 2026 — Inventory & Recovery Plan

## What happened

The automated sender launched July 15 but sent **zero messages** until this was
caught on August 4. Root cause: the outgoing queue is regenerated every 30
minutes and, by design, only keeps *future* items — but a message becomes
"due to send" the moment its time passes. Each refresh deleted the just-due
items seconds before the send step looked for them. Every send silently
starved. (Fixed Aug 4: the pipeline now writes a separate sender working-set
that keeps the last 24 hours; the dashboard's future-only view is unchanged.)

Impact is visible in the data: July STS completion is **2%** (2 of 96)
vs June's 27% under the old system.

## Everything that was missed

### 1. July 20 Screen-Time cycle — 96 invites, 94 still open
All STS1 + STS2 invites scheduled 7/20 5 PM ET, plus their daily follow-up
chains (~564 follow-up sends, 7/21–7/26), across 94 participants.
Two participants (completed on their own) are excluded from recovery.

**Recovery: STAGED, ready to fire.** 94 catch-up invites
(47 STS1, 47 STS2) are in `recovery-sends.json`. They fire only when the
"Send LITe Due Messages (manual)" workflow is dispatched with
`recovery=true`. Safeguards: fresh completion re-check at fire time,
sent-ledger dedup (cannot double-send), quiet hours, unresolved-link skip.
Follow-up chains for the recovered invites are NOT staged (a 2-week-late
invite followed by 6 days of nagging felt wrong) — say the word if you want
them.

### 2. EMA Enable nudges — 5 participants
Enable texts for the cycle starting Monday 8/3 never went out (scheduled
Thu 7/30 4 PM ET). Without the nudge, these participants never enabled, so
their 25-prompt EMA windows never started:

| PID | Wave | Enable was due | Cycle would have started |
|-----|------|----------------|--------------------------|
| 1023 | 2 | 7/30 | Mon 8/3 |
| 1024 | 2 | 7/30 | Mon 8/3 |
| 1050 | 2 | 7/30 | Mon 8/3 |
| 3027 | 2 | 7/30 | Mon 8/3 |
| 3130 | 2 | 7/30 | Mon 8/3 |

**Decision needed:** send their enable text late (their cycle starts the
Monday after they enable — the mechanics still work), or skip these five.
Can be added to the staged recovery in minutes.

### 3. Payment initial emails — 5 participants
Initial redemption texts scheduled 7/25 never sent. Their biweekly
follow-ups are automatically suppressed (system won't nag about an email
that never went out):

| PID | Wave | Initial was due |
|-----|------|-----------------|
| 1008 | 2 | 7/25 |
| 1018 | 2 | 7/25 |
| 2120 | 1 | 7/25 |
| 2128 | 1 | 7/25 |
| 3045 | 2 | 7/25 |

**Decision needed:** stage these like the July invites (expire clock would
start from the late send), or handle manually.

## How to fire the July recovery

GitHub → Actions → **Send LITe Due Messages (manual)** → Run workflow →
`dry_run=true, recovery=true` first (prints exactly what would send, sends
nothing) → then `dry_run=false, recovery=true` to send for real.
Or ask Danny/Claude to trigger it.

## August note

The August 20 STS cycle is queued normally. Per Danny: hold until closer to
the 30th — if the cycle should actually be *rescheduled* (rather than just
reviewed then), that needs a deliberate change; flag it before 8/20.

## Status of the system now

- Sender starvation bug: **fixed and deployed** (send-candidates split)
- Normal automated sends: resume with the next due item, no action needed
- July recovery: **staged, awaiting your go**
- EMA enables + payment initials: **awaiting your decision**
