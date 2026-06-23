#!/usr/bin/env node
/**
 * Fetch Project LITe data from REDCap → static JSON for the dashboard.
 *
 * Runs in GitHub Actions (Temple REDCap blocks Vercel IPs). On success
 * writes:
 *
 *   private/data/participants.json     — pivoted per-participant view
 *   private/data/due-reminders.json    — next 7 days of scheduled sends
 *   private/data/last-fetch.json       — { ok, timestamp, counts }
 *
 * Env vars required:
 *   REDCAP_API_URL          (defaults to Temple's URL)
 *   REDCAP_LITE_TOKEN       (project API token)
 *
 * Re-uses the SDN refresh-data pattern: retries on transient network
 * errors, batches surveyLink calls with concurrency cap.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "private", "data");

const REDCAP_API_URL = process.env.REDCAP_API_URL || "https://cphapps.temple.edu/redcap/api/";
const LITE_TOKEN = process.env.REDCAP_LITE_TOKEN;
const GOOGLE_SHEET_ID = process.env.LITE_GOOGLE_SHEET_ID || "18LScSoBcT8XmwA_WjfeN4Lt2PZESDm7FycAqocZ1cH4";
const GOOGLE_SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;  // full JSON string

if (!LITE_TOKEN) {
  console.error("Missing REDCAP_LITE_TOKEN env var.");
  process.exit(1);
}

const WAVES = [1, 2, 3];

// Canonical event names per the Timeline workbook + REDCap metadata.
function eventName(kind, wave) {
  switch (kind) {
    case "pre":     return "preenrollment_arm_1";
    case "enroll":  return "enrollment_arm_1";
    case "v1":      return `visit_1_y${wave}_arm_1`;
    case "athome":  return `athome_measures_y${wave}_arm_1`;
    case "sts1":    return `screen_time_y${wave}_arm_1`;
    case "sts2":    return `screen_time_2_y${wave}_arm_1`;
    case "ema":     return `ema_y${wave}_arm_1`;
    case "v2":      return `visit_2_y${wave}_arm_1`;
    default: throw new Error(`Unknown event kind ${kind}`);
  }
}

// EMA prompt field names + their canonical day/time labels straight from
// the Timeline_of_Automated_Messages workbook. The REDCap field names
// don't encode AM/PM (5:01 PM is stored as just "501"), so we can't
// guess from the digits alone — pull the truth from the Excel labels.
const EMA_PROMPTS = [
  ["ema_m1_734", "Monday 1",    "7:34 AM"],
  ["ema_m1_517", "Monday 1",    "5:17 PM"],
  ["ema_m1_846", "Monday 1",    "8:46 PM"],
  ["ema_t1_832", "Tuesday 1",   "8:32 AM"],
  ["ema_t1_634", "Tuesday 1",   "6:34 PM"],
  ["ema_t1_858", "Tuesday 1",   "8:58 PM"],
  ["ema_w1_812", "Wednesday 1", "8:12 AM"],
  ["ema_w1_900", "Wednesday 1", "9:00 PM"],
  ["ema_th_711", "Thursday",    "7:11 AM"],
  ["ema_th_532", "Thursday",    "5:32 PM"],
  ["ema_f_900",  "Friday",      "9:00 AM"],
  ["ema_f_704",  "Friday",      "7:04 PM"],
  ["ema_f_841",  "Friday",      "8:41 PM"],
  ["ema_sa_856", "Saturday",    "8:56 AM"],
  ["ema_sa_501", "Saturday",    "5:01 PM"],
  ["ema_su_755", "Sunday",      "7:55 AM"],
  ["ema_su_601", "Sunday",      "6:01 PM"],
  ["ema_su_736", "Sunday",      "7:36 PM"],
  ["ema_m2_849", "Monday 2",    "8:49 AM"],
  ["ema_m2_809", "Monday 2",    "8:09 PM"],
  ["ema_t2_733", "Tuesday 2",   "7:33 AM"],
  ["ema_t2_512", "Tuesday 2",   "5:12 PM"],
  ["ema_w2_840", "Wednesday 2", "8:40 AM"],
  ["ema_w2_601", "Wednesday 2", "6:01 PM"],
  ["ema_w2_736", "Wednesday 2", "7:36 PM"],
];
const EMA_PROMPT_FIELDS = EMA_PROMPTS.map(([k]) => k);
const EMA_LABELS = Object.fromEntries(EMA_PROMPTS.map(([k, day, time]) => [k, { day, time }]));

function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const parseRow = (line) => {
    const result = [];
    let cur = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) { result.push(cur); cur = ""; }
      else cur += ch;
    }
    result.push(cur);
    return result;
  };
  const headers = parseRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseRow(lines[i]);
    const r = {};
    for (let j = 0; j < headers.length; j++) r[headers[j]] = vals[j] ?? "";
    rows.push(r);
  }
  return rows;
}

async function redcapPost(params, attempt = 1) {
  const body = new URLSearchParams({ token: LITE_TOKEN, ...params });
  try {
    const res = await fetch(REDCAP_API_URL, {
      method: "POST", body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`REDCap error ${res.status}: ${await res.text()}`);
    return await res.text();
  } catch (err) {
    const transient = /timeout|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(String(err));
    if (transient && attempt < 3) {
      const delay = 2000 * attempt;
      console.warn(`  REDCap transient error (attempt ${attempt}): ${err.message || err}. Retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
      return redcapPost(params, attempt + 1);
    }
    throw err;
  }
}

// Chunked record fetch — LITe is large enough that a single bulk export
// blows out REDCap's server memory. We loop per-event and stream each
// chunk straight into the per-record bucket so we never hold more than
// one event's worth of raw rows in memory at once.
async function fetchAllRecordsStreaming(byRecord) {
  const events = [eventName("pre"), eventName("enroll")];
  for (const w of WAVES) {
    for (const k of ["v1", "athome", "sts1", "sts2", "ema", "v2"]) {
      events.push(eventName(k, w));
    }
  }
  console.log(`  Will fetch ${events.length} events in series…`);
  let total = 0;
  for (const evt of events) {
    try {
      const csv = await redcapPost({
        content: "record", format: "csv", type: "flat",
        rawOrLabel: "raw", rawOrLabelHeaders: "raw",
        exportSurveyFields: "true",
        "events[0]": evt,
      });
      const rows = parseCSV(csv);
      console.log(`    ${evt}: ${rows.length} rows`);
      total += rows.length;
      for (const r of rows) {
        const id = r.record_id;
        if (!id) continue;
        if (!byRecord[id]) byRecord[id] = [];
        byRecord[id].push(r);
      }
    } catch (err) {
      console.warn(`    ${evt}: SKIPPED (${err.message})`);
    }
  }
  return total;
}

async function fetchReport(reportId) {
  const csv = await redcapPost({
    content: "report", format: "csv", report_id: String(reportId),
    rawOrLabel: "raw", rawOrLabelHeaders: "raw",
  });
  return parseCSV(csv);
}

async function fetchSurveyLink(recordId, evtName, instrument) {
  try {
    const txt = await redcapPost({
      content: "surveyLink", format: "json",
      record: recordId, event: evtName, instrument,
    });
    const t = txt.trim();
    return t.startsWith("http") ? t : null;
  } catch { return null; }
}

async function batchAsync(tasks, concurrency = 3, delayMs = 200) {
  const out = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const res = await Promise.all(batch.map(f => f()));
    out.push(...res);
    if (i + concurrency < tasks.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return out;
}

function num(s) {
  const n = parseInt(s ?? "", 10);
  return isNaN(n) ? 0 : n;
}

function dayLabelForKey(k)  { return EMA_LABELS[k]?.day  ?? k; }
function timeLabelForKey(k) { return EMA_LABELS[k]?.time ?? ""; }

function pivotParticipant(recordRows) {
  if (recordRows.length === 0) return null;
  const recordId = recordRows[0].record_id;

  const byEvent = {};
  for (const r of recordRows) byEvent[r.redcap_event_name || ""] = r;

  // ONLY count someone as a participant once they have an enrollment row —
  // preenrollment alone is just a signup form, ~3x more rows than real
  // enrollees, and is what was polluting the dashboard's contact display.
  const enroll = byEvent[eventName("enroll")];
  if (!enroll) return null;

  // Pull contact info from enrollment, falling back to preenrollment.
  const pre = byEvent[eventName("pre")] || {};
  const pick = (field) => enroll[field] || pre[field] || "";
  const contact = {
    firstName: pick("first_name"),
    lastName: pick("last_name"),
    parentName: pick("parent_name"),
    email: pick("email"),
    phonePrimary: pick("phone_primary"),
    phoneSecondary: pick("phone_secondary"),
    childPhone: pick("child_phone"),
    // Cohort group is derivable from the record_id range: 1-999 -> "Y1 cohort",
    // 1000-1999 -> "Y2 cohort", 2000+ -> "Y3 cohort" per the session-notes
    // workbook convention. Keep the raw record_id range as the label.
    cohortGroup: pick("cohort_group") || pick("tppid") || "",
    // Age — controls which payment-email variant fires (#287 13+ vs #288 <13).
    age: Number(pick("age") || pick("participant_age") || 0) || null,
  };
  // The friendly PID for coordinators is the REDCap record_id (1-3160 range).
  const pid = String(recordId);

  const waves = {};
  let activeWave = null;
  for (const w of WAVES) {
    const v1 = byEvent[eventName("v1", w)];
    const athome = byEvent[eventName("athome", w)];
    const sts1 = byEvent[eventName("sts1", w)];
    const sts2 = byEvent[eventName("sts2", w)];
    const ema = byEvent[eventName("ema", w)];
    const v2 = byEvent[eventName("v2", w)];

    if (!v1 && !athome && !sts1 && !sts2 && !ema && !v2) continue;

    const buildVisit = (row) => {
      if (!row) return null;
      const forms = {};
      for (const k of Object.keys(row)) {
        if (k.endsWith("_complete")) forms[k.replace(/_complete$/, "")] = num(row[k]);
      }
      const allComplete = Object.values(forms).length > 0 && Object.values(forms).every(v => v === 2);
      return { date: row.visit_date || row.scheduled_date || null, forms, allComplete };
    };

    const buildSTS = (row, count) => {
      if (!row) return null;
      const cycles = [];
      // STS1 dates: screen_time_1_1_date … screen_time_1_6_date
      // STS1 complete: screen_time_1_complete … screen_time_6_complete
      // STS2 dates: screen_time_2_1_date … screen_time_2_3_date
      // STS2 complete: screen_time_1_2_complete, screen_time_2_2_complete,
      //   screen_time_3_2_complete  (the "_2_" suffix marks the STS2 instrument).
      // This matches REDCap reports 8040 (Y1) / 8430 (Y2) used by the legacy
      // followup_download scripts.
      const which = count === 6 ? "1" : "2";
      for (let i = 1; i <= count; i++) {
        const datefield = `screen_time_${which}_${i}_date`;
        const compField = which === "1"
          ? `screen_time_${i}_complete`
          : `screen_time_${i}_2_complete`;
        cycles.push({
          index: i,
          date: row[datefield] || null,
          complete: num(row[compField]),
          surveyLink: null,
        });
      }
      return {
        active: row[`screen_time_cycle_${which}`] === "1",
        cycles,
      };
    };

    const buildEMA = (row) => {
      if (!row) return null;
      const prompts = EMA_PROMPT_FIELDS.map(k => ({
        key: k,
        dayLabel: dayLabelForKey(k),
        timeLabel: timeLabelForKey(k),
        scheduledAt: row[k] || null,
        complete: num(row[`${k}_complete`] || row.ema_response_complete) === 2,
      }));
      // ema_start_day_calc sums (1..4) count down weekly while waiting for
      // the participant to enable. When the sum hits 0, the cycle is ready
      // to fire and ema_start_day is locked. After 4 weeks of waiting the
      // calcs auto-resolve and the prompts go regardless.
      const startDayCalcSum =
        num(row.ema_start_day_calc) +
        num(row.ema_start_day_calc_2) +
        num(row.ema_start_day_calc_3) +
        num(row.ema_start_day_calc_4);
      return {
        active: row.ema_cycle === "1",
        startDay: row.ema_start_day || null,
        startDayCalc: row.ema_start_day_calc ? Number(row.ema_start_day_calc) : null,
        startDayCalcSum,
        enableConfirmed: row.ema_enable === "1",
        settingsComplete: num(row.ema_settings_complete),
        paymentEmailButton: row.ema_payment_email_button === "1",
        paymentComplete: num(row.ema_payment_complete),
        enableSent: false,
        phone: row.ema_phone || contact.phonePrimary,
        prompts,
      };
    };

    waves[w] = {
      year: w,
      v1: buildVisit(v1),
      atHome: athome ? {
        timestamp: athome.timestamp_athome || null,
        break1Complete: num(athome.break_1_complete),
        athomeMeasuresComplete: num(athome.athome_measures_complete),
      } : null,
      sts1: buildSTS(sts1, 6),
      sts2: buildSTS(sts2, 3),
      ema: buildEMA(ema),
      v2: buildVisit(v2),
    };

    if (waves[w].v1 && !waves[w].v2?.allComplete) activeWave = w;
  }

  return {
    pid,
    recordId,
    contact,
    waves,
    activeWave,
  };
}

// Eastern-time offset for a given UTC instant. CABLAB lives in
// Philadelphia, EST/EDT. DST: 2nd Sun of March → 1st Sun of November.
// Returns "-04:00" during EDT, "-05:00" during EST. Approximated by month
// boundaries — accurate enough for display fidelity on a 60-day horizon.
function easternOffset(yyyyMmDd) {
  // Parse year + month from the bare date string to avoid a recursive new Date.
  const m = /^(\d{4})-(\d{2})/.exec(String(yyyyMmDd));
  if (!m) return "-04:00";
  const month = Number(m[2]);
  // DST roughly mid-March through early November
  return (month >= 4 && month <= 10) ? "-04:00" : "-05:00";
}

// REDCap returns dates in several flavours: "YYYY-MM-DD",
// "YYYY-MM-DD HH:MM", "YYYY-MM-DD HH:MM:SS". Coerce to ISO and ignore
// anything we can't parse so a single bad row doesn't tank the whole run.
//
// CRITICAL: REDCap stores local Eastern times without a timezone marker
// ("2026-07-21 18:45:00"). Constructing `new Date("...T18:45:00")` on the
// GitHub Actions UTC runner interprets it as UTC, then the browser shifts
// it back to Eastern → 18:45 UTC → 2:45 PM Eastern (off by hours). And
// when we attach our own default-hour (T09:00:00) without a tz, 09:00 UTC
// renders as 5:00 AM Eastern — the "5 AM" bug. Attach the right Eastern
// offset to every constructed timestamp.
function toEpoch(s, defaultHour = 9) {
  if (!s) return null;
  const raw = String(s).trim();

  // Already has time component → keep it, just attach Eastern.
  const dt = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)$/.exec(raw);
  if (dt) {
    const off = easternOffset(dt[1]);
    const t = new Date(`${dt[1]}T${dt[2]}${off}`).getTime();
    if (isFinite(t)) return t;
  }

  // Date-only → attach defaultHour Eastern.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const off = easternOffset(raw);
    const hh = String(defaultHour).padStart(2, "0");
    const t = new Date(`${raw}T${hh}:00:00${off}`).getTime();
    if (isFinite(t)) return t;
  }

  // Last resort
  const direct = new Date(raw).getTime();
  return isFinite(direct) ? direct : null;
}

function safeIso(epoch) {
  if (!isFinite(epoch)) return null;
  try { return new Date(epoch).toISOString(); } catch { return null; }
}

function computeDueReminders(participants) {
  const out = [];
  const now = Date.now();
  const horizon = now + 60 * 24 * 3600 * 1000;  // 60 days — STS cycles are monthly
  for (const p of participants) {
    for (const w of WAVES) {
      const wave = p.waves[w];
      if (!wave) continue;

      // STS1: initial invite on the cycle date (alerts 48-53), then a
      // daily follow-up for up to 6 days after if the survey isn't done
      // (alerts 54-59 per the Timeline xlsx).
      wave.sts1?.cycles.forEach((c, idx) => {
        const baseT = toEpoch(c.date);
        if (baseT == null) return;
        const done = c.complete === 2;
        // Initial invite
        if (baseT >= now && baseT <= horizon) {
          const iso = safeIso(baseT);
          if (iso) out.push({
            pid: p.pid, recordId: p.recordId, wave: w,
            alertId: 48 + idx, kind: "sts1_invite",
            instrument: `Screen Time Auto Invite 1.${idx + 1}`,
            scheduledAt: iso, complete: done,
          });
        }
        // Daily follow-ups while incomplete
        if (!done) {
          for (let d = 1; d <= 6; d++) {
            const t = baseT + d * 24 * 3600 * 1000;
            if (t < now || t > horizon) continue;
            const iso = safeIso(t); if (!iso) continue;
            out.push({
              pid: p.pid, recordId: p.recordId, wave: w,
              alertId: 54 + idx, kind: "sts1_followup",
              instrument: `Screen Time Follow Up 1.${idx + 1} (day ${d})`,
              scheduledAt: iso, complete: false,
            });
          }
        }
      });
      // STS2: initial invite (alerts 89-91) + daily follow-up x6 (93-95).
      wave.sts2?.cycles.forEach((c, idx) => {
        const baseT = toEpoch(c.date);
        if (baseT == null) return;
        const done = c.complete === 2;
        if (baseT >= now && baseT <= horizon) {
          const iso = safeIso(baseT);
          if (iso) out.push({
            pid: p.pid, recordId: p.recordId, wave: w,
            alertId: 89 + idx, kind: "sts2_invite",
            instrument: `Screen Time Auto Invite 2.${idx + 1}`,
            scheduledAt: iso, complete: done,
          });
        }
        if (!done) {
          for (let d = 1; d <= 6; d++) {
            const t = baseT + d * 24 * 3600 * 1000;
            if (t < now || t > horizon) continue;
            const iso = safeIso(t); if (!iso) continue;
            out.push({
              pid: p.pid, recordId: p.recordId, wave: w,
              alertId: 93 + idx, kind: "sts2_followup",
              instrument: `Screen Time Follow Up 2.${idx + 1} (day ${d})`,
              scheduledAt: iso, complete: false,
            });
          }
        }
      });
      // EMA prompts (alerts 64-88) — each fires at its own REDCap-computed
      // datetime. Conditions: cycle active, settings not yet locked.
      wave.ema?.prompts.forEach(prompt => {
        if (!wave.ema?.active) return;
        if (wave.ema.settingsComplete === 2 || wave.ema.settingsComplete === 1) return;
        if (!prompt.scheduledAt) return;
        const t = toEpoch(prompt.scheduledAt);
        if (t == null || t < now || t > horizon) return;
        const iso = safeIso(t); if (!iso) return;
        out.push({
          pid: p.pid, recordId: p.recordId, wave: w,
          alertId: 64, kind: "ema_prompt",
          emaKey: prompt.key,
          instrument: `EMA ${prompt.dayLabel} ${prompt.timeLabel}`,
          scheduledAt: iso,
          complete: prompt.complete,
        });
      });

      // EMA Enable (alert 63) — fires 3d8h before ema_start_day when:
      //   - participant enabled (ema_enable=1)
      //   - start_day_calc sum has resolved to 0 (rolling 4-week window
      //     done) OR REDCap auto-resolved after week 5
      //   - cycle hasn't already activated
      if (wave.ema?.enableConfirmed && wave.ema.startDay && !wave.ema.active && wave.ema.startDayCalcSum === 0) {
        const startT = toEpoch(wave.ema.startDay);
        if (startT != null) {
          const sendT = startT - (3 * 24 + 8) * 3600 * 1000;
          if (sendT >= now && sendT <= horizon) {
            const iso = safeIso(sendT);
            if (iso) out.push({
              pid: p.pid, recordId: p.recordId, wave: w,
              alertId: 63, kind: "ema_enable",
              instrument: `EMA Y${w} Enable`,
              scheduledAt: iso,
              complete: false,
            });
          }
        }
      }

      // Payment email (alerts 287 / 288) — fires 5 days after the last
      // STS1 invite date, when ema_payment_email_button is set and the
      // payment instrument hasn't been completed yet. 287 = 13+, 288 = <13.
      if (wave.ema?.paymentEmailButton && wave.ema.paymentComplete !== 2) {
        const lastCycle = wave.sts1?.cycles[wave.sts1.cycles.length - 1];
        const baseT = lastCycle?.date ? toEpoch(lastCycle.date) : null;
        if (baseT != null) {
          const sendT = baseT + 5 * 24 * 3600 * 1000;
          if (sendT >= now && sendT <= horizon) {
            const iso = safeIso(sendT);
            const age = p.contact?.age;
            const alertId = (age != null && age < 13) ? 288 : 287;
            const variant = (age != null && age < 13) ? "<13" : "13+";
            if (iso) out.push({
              pid: p.pid, recordId: p.recordId, wave: w,
              alertId, kind: "payment_email",
              instrument: `W${w} ${variant} STS-EMA Payment email`,
              scheduledAt: iso,
              complete: false,
            });
          }
        }
      }
      if (wave.atHome?.timestamp && wave.atHome.break1Complete === 2) {
        const base = new Date(wave.atHome.timestamp).getTime();
        if (!isFinite(base)) continue;
        const t = base + (3 * 60 + 45) * 60 * 1000;
        if (t >= now && t <= horizon) {
          const iso = safeIso(t); if (!iso) continue;
          out.push({
            pid: p.pid, recordId: p.recordId, wave: w,
            alertId: 60, kind: "athome_sms",
            instrument: "At-Home Survey Send (Text)",
            scheduledAt: iso,
            complete: wave.atHome.athomeMeasuresComplete === 2,
          });
          out.push({
            pid: p.pid, recordId: p.recordId, wave: w,
            alertId: 61, kind: "athome_email",
            instrument: "At-Home Survey Send (Email)",
            scheduledAt: iso,
            complete: wave.atHome.athomeMeasuresComplete === 2,
          });
        }
      }
    }
  }
  out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return out;
}

// --- Google Sheets read (PID Session Notes) ---
//
// The Excel mirror is /Users/dannyzweben/Downloads/0.LITe.1_PID_sessionnotes.xlsx.
// Tabs we care about:
//   Follow up.1 — Y1 follow-up: header row 3, V2 date col N, STS1 P-U, STS2 AB-AD, EMA W/X
//   Follow up.2 — Y2 follow-up: header row 8, V2 date col M, STS1 O-T, STS2 AB-AD, EMA W/X
//
// We index by PID and merge into participants[].waves[N].followupSheet so the
// dashboard can show V1/V2 completion the team manually tracks here.

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function googleAccessToken() {
  if (!GOOGLE_SA_JSON) return null;
  let sa;
  try { sa = JSON.parse(GOOGLE_SA_JSON); }
  catch { console.warn("  ! GOOGLE_SERVICE_ACCOUNT_JSON not valid JSON"); return null; }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = base64url(signer.sign(sa.private_key));
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    console.warn(`  ! Google auth ${res.status}: ${await res.text()}`);
    return null;
  }
  const { access_token } = await res.json();
  return access_token;
}

async function readSheetTab(accessToken, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    console.warn(`  ! Sheet read ${range} ${res.status}: ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return data.values || [];
}

// Excel-style column letter → 0-based index. "A"=0, "Z"=25, "AA"=26, "AF"=31
function col(letter) {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cell(row, letter) {
  const v = row[col(letter)];
  if (v === undefined || v === null || v === "") return null;
  return v;
}

// Excel/Sheets stores real dates as serial day-counts since 1899-12-30.
// "v2Date: 45065" → "2023-04-09". Text-like strings (" 6/24" etc.) pass through.
function excelDateToIso(v) {
  if (typeof v !== "number" || !isFinite(v) || v < 1 || v > 80000) return v;
  const ms = Math.round((v - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (!isFinite(d.getTime())) return v;
  return d.toISOString().slice(0, 10);
}

function normalizeSheetCell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    const iso = excelDateToIso(v);
    return iso === v ? v : iso;
  }
  return v;
}

// Returns true-ish if the cell holds a date or a non-empty value indicating
// the column has been actioned. Excel dates come back as ISO strings when we
// use UNFORMATTED_VALUE+sheet API, or numeric serial dates, or already-text.
function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return v !== 0;
  return true;
}

async function fetchFollowupSheet() {
  if (!GOOGLE_SA_JSON) {
    console.log("  Skipping Google Sheets pull (GOOGLE_SERVICE_ACCOUNT_JSON not set)");
    return {};
  }
  const tok = await googleAccessToken();
  if (!tok) return {};

  // Follow up.1 (Y1) — header row 3, data from row 6 onward (rows 4-5 are notes/cohort marker).
  // Follow up.2 (Y2) — header row 8, data from row 11 onward.
  const followupByPid = {};

  const f1 = await readSheetTab(tok, "Follow up.1!A1:AZ700");
  for (let i = 5; i < f1.length; i++) {  // 0-indexed row 5 == sheet row 6
    const row = f1[i];
    if (!row?.length) continue;
    const pid = String(cell(row, "D") || "").trim().replace(/\.0$/, "");
    if (!pid || pid === "PID") continue;
    if (!followupByPid[pid]) followupByPid[pid] = {};
    followupByPid[pid].y1 = {
      record: cell(row, "A"),
      v2Date: normalizeSheetCell(cell(row, "N")),       // "Visit 2" date → V2Y1 complete if set
      sts1Months: [cell(row, "P"), cell(row, "Q"), cell(row, "R"), cell(row, "S"), cell(row, "T"), cell(row, "U")].map(normalizeSheetCell),
      emaDate: normalizeSheetCell(cell(row, "W")),
      emaStatus: cell(row, "X"),
      w1Comp: cell(row, "AA"),
      sts2Months: [cell(row, "AB"), cell(row, "AC"), cell(row, "AD")].map(normalizeSheetCell),
      wave2StartDate: normalizeSheetCell(cell(row, "AF")),
      raTag: cell(row, "L"),
      notes: cell(row, "I"),
    };
  }

  const f2 = await readSheetTab(tok, "Follow up.2!A1:AZ700");
  for (let i = 10; i < f2.length; i++) {  // header row 8, data row 11+
    const row = f2[i];
    if (!row?.length) continue;
    const pid = String(cell(row, "A") || "").trim().replace(/\.0$/, "");
    if (!pid || pid === "PID") continue;
    if (!followupByPid[pid]) followupByPid[pid] = {};
    followupByPid[pid].y2 = {
      record: cell(row, "B"),
      v2Date: normalizeSheetCell(cell(row, "M")),       // "WAVE 2, V2 Date" → V2Y2 complete if set
      sts1Months: [cell(row, "O"), cell(row, "P"), cell(row, "Q"), cell(row, "R"), cell(row, "S"), cell(row, "T")].map(normalizeSheetCell),
      emaDate: normalizeSheetCell(cell(row, "W")),
      emaStatus: cell(row, "X"),
      w2Comp: cell(row, "Z"),
      sts2Months: [cell(row, "AB"), cell(row, "AC"), cell(row, "AD")].map(normalizeSheetCell),
      wave3StartDate: normalizeSheetCell(cell(row, "AF")),
      notes: cell(row, "J"),
    };
  }

  console.log(`  Followup sheet: ${Object.keys(followupByPid).length} PIDs (` +
    `${Object.values(followupByPid).filter(x => x.y1).length} Y1, ` +
    `${Object.values(followupByPid).filter(x => x.y2).length} Y2)`);
  return followupByPid;
}

async function main() {
  console.log("=== LITe REDCap fetch ===");
  const byRecord = {};
  const total = await fetchAllRecordsStreaming(byRecord);
  console.log(`  Got ${total} REDCap rows, grouped into ${Object.keys(byRecord).length} records`);

  const participants = [];
  let droppedOutOfRange = 0;
  for (const recordRows of Object.values(byRecord)) {
    const p = pivotParticipant(recordRows);
    if (!p) continue;
    // Cohort scope: only PIDs in [1000, 3999]. Everything else is a test
    // record, screener residue, or pre-cohort entry that shouldn't appear
    // on the dashboard.
    const pidNum = Number(String(p.pid).replace(/\.0$/, ""));
    if (!isFinite(pidNum) || pidNum < 1000 || pidNum > 3999) { droppedOutOfRange++; continue; }
    participants.push(p);
  }
  participants.sort((a, b) => a.pid.localeCompare(b.pid));
  console.log(`  Pivoted to ${participants.length} participants (dropped ${droppedOutOfRange} out-of-range)`);

  // EMA + at-home completion reports per wave (saved REDCap reports the
  // legacy team already maintains). Each row is indexed by record_id.
  const COMPLETION_REPORTS = {
    1: { ema: "10821", atHome: "10824" },
    2: { ema: "7111",  atHome: "6787"  },
    3: { ema: "10820", atHome: "10823" },
  };
  const reportData = {};  // recordId → { emaY1: {...}, atHomeY1: {...}, ... }
  for (const w of WAVES) {
    const ids = COMPLETION_REPORTS[w];
    for (const kind of ["ema", "atHome"]) {
      try {
        const rows = await fetchReport(ids[kind]);
        console.log(`  Report ${ids[kind]} (${kind} y${w}): ${rows.length} rows`);
        for (const r of rows) {
          const rid = r.record_id;
          if (!rid) continue;
          if (!reportData[rid]) reportData[rid] = {};
          reportData[rid][`${kind}Y${w}`] = r;
        }
      } catch (err) {
        console.warn(`  ! Report ${ids[kind]} failed: ${err.message}`);
      }
    }
  }
  // Stitch the report rows into the participant's wave structure.
  // The reports vary in field names, but a row indicates the participant
  // has at least started that event. We harvest every key ending in
  // _complete and store it as forms[k] = code so the dashboard can render
  // generic completion counts even when we don't know the exact form name.
  for (const p of participants) {
    const rd = reportData[p.recordId];
    if (!rd) continue;
    for (const w of WAVES) {
      const wave = p.waves[w];
      if (!wave) continue;
      const ema = rd[`emaY${w}`];
      if (ema && wave.ema) {
        // Overlay EMA prompt completion using the report's _complete fields
        for (const prompt of wave.ema.prompts) {
          const compField = `${prompt.key}_complete`;
          if (ema[compField] !== undefined) {
            prompt.complete = num(ema[compField]) === 2;
          }
        }
        // Surface any other _complete codes onto a forms map
        const forms = {};
        for (const k of Object.keys(ema)) {
          if (k.endsWith("_complete") && !k.match(/^ema_[a-z]+\d?_\d+_complete$/)) {
            forms[k.replace(/_complete$/, "")] = num(ema[k]);
          }
        }
        wave.ema.formsFromReport = forms;
      }
      const ah = rd[`atHomeY${w}`];
      if (ah) {
        // Build/overlay the at-home status with whatever the report knows
        if (!wave.atHome) wave.atHome = { timestamp: null, break1Complete: 0, athomeMeasuresComplete: 0 };
        if (ah.timestamp_athome) wave.atHome.timestamp = ah.timestamp_athome;
        if (ah.break_1_complete !== undefined) wave.atHome.break1Complete = num(ah.break_1_complete);
        if (ah.athome_measures_complete !== undefined) wave.atHome.athomeMeasuresComplete = num(ah.athome_measures_complete);
        // Detail completion codes for every _complete field in the report
        const forms = {};
        for (const k of Object.keys(ah)) {
          if (k.endsWith("_complete")) forms[k.replace(/_complete$/, "")] = num(ah[k]);
        }
        wave.atHome.formsFromReport = forms;
      }
    }
  }

  // Merge in Google Sheets data (Follow up.1 + .2)
  const followupByPid = await fetchFollowupSheet();
  let merged = 0;
  for (const p of participants) {
    const key = String(p.pid || "").replace(/\.0$/, "");
    const sheet = followupByPid[key];
    if (!sheet) continue;
    merged++;
    if (sheet.y1) {
      if (!p.waves[1]) p.waves[1] = { year: 1, v1: null, atHome: null, sts1: null, sts2: null, ema: null, v2: null };
      p.waves[1].followupSheet = sheet.y1;
      // Mark V2 complete if the V2 date is filled in.
      if (hasValue(sheet.y1.v2Date)) {
        if (!p.waves[1].v2) p.waves[1].v2 = { date: null, forms: {}, allComplete: false };
        p.waves[1].v2.date = String(sheet.y1.v2Date);
        p.waves[1].v2.allComplete = true;
      }
      // V1 done = exists in Follow up.1
      if (!p.waves[1].v1) p.waves[1].v1 = { date: null, forms: {}, allComplete: true };
      else p.waves[1].v1.allComplete = true;
    }
    if (sheet.y2) {
      if (!p.waves[2]) p.waves[2] = { year: 2, v1: null, atHome: null, sts1: null, sts2: null, ema: null, v2: null };
      p.waves[2].followupSheet = sheet.y2;
      if (hasValue(sheet.y2.v2Date)) {
        if (!p.waves[2].v2) p.waves[2].v2 = { date: null, forms: {}, allComplete: false };
        p.waves[2].v2.date = String(sheet.y2.v2Date);
        p.waves[2].v2.allComplete = true;
      }
      if (!p.waves[2].v1) p.waves[2].v1 = { date: null, forms: {}, allComplete: true };
      else p.waves[2].v1.allComplete = true;
    }
  }
  console.log(`  Merged followup-sheet data into ${merged} participants`);

  // Recompute activeWave now that the sheet has updated V1/V2 completion.
  // Definition: the highest-numbered wave where V1 has happened but V2
  // hasn't yet. If all of Y1-Y3 V2 are done, activeWave is null.
  for (const p of participants) {
    let active = null;
    for (const w of WAVES) {
      const wave = p.waves[w];
      if (!wave) continue;
      const v1Done = !!wave.v1?.allComplete;
      const v2Done = !!wave.v2?.allComplete;
      if (v1Done && !v2Done) active = w;            // mid-wave wins
      else if (!v1Done && !v2Done && wave.v1) active = active ?? w;  // pre-V1
    }
    p.activeWave = active;
  }

  const linkTasks = [];
  for (const p of participants) {
    for (const w of WAVES) {
      const wave = p.waves[w];
      if (!wave) continue;
      if (wave.sts1?.active) {
        wave.sts1.cycles.forEach((c, idx) => {
          if (c.complete !== 2 && c.date) {
            linkTasks.push(async () => {
              c.surveyLink = await fetchSurveyLink(p.recordId, eventName("sts1", w), `screen_time_${idx + 1}`);
            });
          }
        });
      }
      if (wave.sts2?.active) {
        wave.sts2.cycles.forEach((c, idx) => {
          if (c.complete !== 2 && c.date) {
            linkTasks.push(async () => {
              c.surveyLink = await fetchSurveyLink(p.recordId, eventName("sts2", w), `screen_time_${idx + 1}_2`);
            });
          }
        });
      }
    }
  }
  console.log(`  Resolving ${linkTasks.length} survey links…`);
  await batchAsync(linkTasks, 3, 200);

  const due = computeDueReminders(participants);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "participants.json"), JSON.stringify({ participants, fetchedAt: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, "due-reminders.json"), JSON.stringify(due, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, "last-fetch.json"), JSON.stringify({
    ok: true,
    timestamp: new Date().toISOString(),
    counts: {
      participants: participants.length,
      dueNext7Days: due.length,
    },
  }, null, 2));

  console.log(`✓ Wrote participants.json (${participants.length})`);
  console.log(`✓ Wrote due-reminders.json (${due.length} upcoming)`);
}

main().catch(err => {
  console.error("FATAL:", err.message);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "last-fetch.json"), JSON.stringify({
      ok: false,
      timestamp: new Date().toISOString(),
      error: err.message,
    }, null, 2));
  } catch {}
  process.exit(1);
});
