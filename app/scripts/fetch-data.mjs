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

// Years between dob and today, or null if dob unparseable.
function computeAgeFromDob(dobStr) {
  if (!dobStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dobStr));
  if (!m) return null;
  const dob = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

// Canonical STS schedule from a single anchor.
//
//   STS1 fires at 17:00 (5 PM) on day 20 of the month following the
//   anchor + (i × 1 month). Anchor for Yn STS1 = prior wave's V2 (or for
//   Y1, the participant's V1 since there's no prior wave).
//
//   STS2 fires at 17:00 (5 PM) on day 20 of the month following the
//   anchor + (i × 1 month). Anchor = ema_start_day for ≥13, or
//   "hypothetical EMA" date for <13 (= 1 month after STS1 cycle 6).
//
// Returns ["YYYY-MM-DD 17:00:00", ...] of `count` entries — same shape as
// the REDCap-native date strings so toEpoch() can attach Eastern offset
// later. Returns array of nulls if the anchor is unparseable.
function computeStsCycleDates(anchorDate, count, hour = 17) {
  if (!anchorDate) return Array(count).fill(null);
  const raw = String(anchorDate).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return Array(count).fill(null);
  let year = parseInt(m[1], 10);
  let month = parseInt(m[2], 10);  // 1-12 (anchor month)
  const out = [];
  for (let i = 0; i < count; i++) {
    month++;
    if (month > 12) { month = 1; year++; }
    const mm = String(month).padStart(2, "0");
    const hh = String(hour).padStart(2, "0");
    out.push(`${year}-${mm}-20 ${hh}:00:00`);
  }
  return out;
}

// EMA cycle is a fixed 10-day schedule keyed off the participant's
// ema_start_day (which is ALWAYS a Monday — REDCap snaps to the Monday
// after the participant clicks Enable). Each prompt has a deterministic
// day-of-week offset and time-of-day pulled from the Timeline of
// Automated Messages spreadsheet.
const EMA_DAY_OFFSET = {
  "Monday 1":    0,
  "Tuesday 1":   1,
  "Wednesday 1": 2,
  "Thursday":    3,
  "Friday":      4,
  "Saturday":    5,
  "Sunday":      6,
  "Monday 2":    7,
  "Tuesday 2":   8,
  "Wednesday 2": 9,
};

function parseEmaTimeLabel(label) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(label).trim());
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && hours !== 12) hours += 12;
  if (ampm === "AM" && hours === 12) hours = 0;
  return { hours, minutes };
}

// Returns the Monday on or after the given YYYY-MM-DD date. The EMA
// cycle's start_day is always a Monday — REDCap advances to the next
// Monday automatically when the participant enables on a Tue–Sun.
function nextMondayOnOrAfter(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d.getTime())) return null;
  const dow = d.getUTCDay();              // 0=Sun, 1=Mon, ... 6=Sat
  const addDays = (1 - dow + 7) % 7;      // shift forward to Monday
  d.setUTCDate(d.getUTCDate() + addDays);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Build the 25 canonical EMA prompt timestamps off a start_day (Monday).
// Returns "YYYY-MM-DD HH:MM:00" strings keyed by EMA_PROMPTS field name.
// Falls back to nulls (matching null scheduledAt slots) if start_day is
// unparseable.
function computeEmaPromptDates(startDay) {
  const out = {};
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startDay || ""));
  if (!m) {
    for (const [k] of EMA_PROMPTS) out[k] = null;
    return out;
  }
  const baseY = +m[1], baseM = +m[2] - 1, baseD = +m[3];
  for (const [key, dayLabel, timeLabel] of EMA_PROMPTS) {
    const offset = EMA_DAY_OFFSET[dayLabel];
    const t = parseEmaTimeLabel(timeLabel);
    if (offset == null || !t) { out[key] = null; continue; }
    const dt = new Date(Date.UTC(baseY, baseM, baseD + offset));
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    const hh = String(t.hours).padStart(2, "0");
    const mi = String(t.minutes).padStart(2, "0");
    out[key] = `${yyyy}-${mm}-${dd} ${hh}:${mi}:00`;
  }
  return out;
}

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
    // DOB from REDCap preenrollment (already in the bulk fetch — no extra
    // API call). Age computed from DOB.
    // Age gates: <13 doesn't get the EMA survey; STS2 still scheduled
    // using a hypothetical EMA anchor. Also drives payment variant
    // (#287 = 13+, #288 = <13).
    dob: pick("dob") || null,
    age: computeAgeFromDob(pick("dob")) ?? (Number(pick("age") || pick("participant_age") || 0) || null),
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
      // V1/V2 visits have break_1 / break_2 / break_3 _complete fields
      // (the in-lab break checkpoints). Use the LAST break that exists
      // as the gate — if break_3_complete=2, the visit is fully done.
      // If only break_2 exists, use that. If only break_1, that.
      // Falls back to "any form is 2" so a row with non-break_*_complete
      // fields still counts as touched.
      const breaks = [row.break_1_complete, row.break_2_complete, row.break_3_complete]
        .map(v => v === "" || v === undefined ? null : num(v));
      const definedBreaks = breaks.filter(v => v !== null);
      let allComplete = false;
      if (definedBreaks.length > 0) {
        // Done = the LAST defined break is complete (2)
        allComplete = definedBreaks[definedBreaks.length - 1] === 2;
      } else {
        // No break fields — fall back to "any form complete = at least started"
        allComplete = Object.values(forms).some(v => v === 2);
      }
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
  // NOTE: canonical STS schedule is applied as a post-pass in main() once
  // the cohort-sheet V1/V2 dates have merged onto p.waves[N].vK.date —
  // not here, because at this point the cohort sheet hasn't been read yet.

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

// "YYYY-MM-DD" pulled off the Eastern-time wall calendar for an epoch.
// Used to derive the date portion of an EMA start_day Monday for
// downstream prompt-schedule materialization.
function isoDateOnly(epoch) {
  if (!isFinite(epoch)) return null;
  try {
    const off = easternOffset(new Date(epoch).toISOString().slice(0, 10));
    const offHours = parseInt(off.slice(0, 3), 10);
    const local = new Date(epoch + offHours * 3600 * 1000);
    const yyyy = local.getUTCFullYear();
    const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(local.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  } catch { return null; }
}

function computeDueReminders(participants) {
  const out = [];
  const now = Date.now();
  // 270-day horizon — covers a full STS1 cycle (6 monthly invites = ~5 months)
  // plus STS2 (3 more months) plus headroom. Without this, a participant
  // who just started Y2 STS1 wouldn't show cycles 3-6 in the queue.
  const horizon = now + 270 * 24 * 3600 * 1000;
  for (const p of participants) {
    for (const w of WAVES) {
      const wave = p.waves[w];
      if (!wave) continue;
      // No blanket wave-level gate. Each alert type checks v2.allComplete
      // for itself — within-wave alerts (STS/at-home/payment) suppress when
      // V2 is done; EMA Enable does NOT, because enabling EMA for the
      // *next* wave often happens after the previous wave's V2.
      const waveV2Done = !!wave.v2?.allComplete;

      // STS1 + STS2 — STRICT canonical only.
      //   Invite at the cycle date (if upcoming).
      //   Days 1–6 follow-up if the survey is still incomplete.
      // No past-date catch-ups, no "manual chase" entries. Anything the
      // team is behind on lives outside the queue (the STS page itself
      // surfaces incomplete cycles for manual coordinator follow-up).
      const queueSts = (cycles, kind, inviteAlertBase, followupAlertBase, instrumentNum) => {
        cycles?.forEach((c, idx) => {
          const baseT = toEpoch(c.date);
          if (baseT == null) return;
          if (c.complete === 2) return;  // already done — no invite or follow-ups

          // Invite fires only if its own date is still in the future.
          if (baseT >= now && baseT <= horizon) {
            const iso = safeIso(baseT);
            if (iso) out.push({
              pid: p.pid, recordId: p.recordId, wave: w,
              alertId: inviteAlertBase + idx,
              kind: `${kind}_invite`,
              instrument: `Screen Time Auto Invite ${instrumentNum}.${idx + 1}`,
              scheduledAt: iso, complete: false,
            });
          }
          // Follow-up days 1–6 are scheduled per-day. An invite that fired
          // last week can still have day-5 / day-6 follow-ups queued for the
          // future, as long as the survey is still incomplete.
          for (let d = 1; d <= 6; d++) {
            const t = baseT + d * 24 * 3600 * 1000;
            if (t < now || t > horizon) continue;
            const isoFu = safeIso(t); if (!isoFu) continue;
            out.push({
              pid: p.pid, recordId: p.recordId, wave: w,
              alertId: followupAlertBase + idx,
              kind: `${kind}_followup`,
              instrument: `Screen Time Follow Up ${instrumentNum}.${idx + 1} (day ${d})`,
              scheduledAt: isoFu, complete: false,
            });
          }
        });
      };
      // STS1/STS2 are POST-V2 follow-ups. Only queue them once the wave's
      // V2 (the second of two paired in-lab visits, ~1 week after V1) is
      // done. Participants pre-V2 haven't started the surveillance phase
      // of this wave yet, so they shouldn't appear in the schedule.
      if (waveV2Done) {
        queueSts(wave.sts1?.cycles, "sts1", 48, 54, "1");
        queueSts(wave.sts2?.cycles, "sts2", 89, 93, "2");
      }
      // The 25 EMA micro-survey prompts (alerts 64-88) are NOT in this
      // scheduled queue. They fire automatically via REDCap once the
      // participant has filled out the EMA Enable form and the cycle
      // activates — the dashboard never owns those sends.

      // EMA Enable (alert 63) — the canonical nudge the DASHBOARD sends
      // to the participant. Per the user's spec:
      //   - The first nudge fires 3d8h before ema_start_day (a Monday).
      //   - If the participant hasn't answered the Enable form by that
      //     Monday, the cycle shifts +1 week and a new nudge fires 3d8h
      //     before the next Monday. This repeats up to 4 weeks total.
      //     After week 4 the cycle auto-starts whether they enabled or
      //     not.
      //   - "Answered the Enable form" = ema_settings_complete === 2.
      //     Once that's true, we stop queuing further weekly retries.
      //   - Each nudge carries a `wouldTriggerPrompts` payload: the 25
      //     prompt timestamps that would fire if the participant enables
      //     before THAT Monday. The queue page renders this on click.
      //   - Suppressed entirely once the cycle has activated
      //     (ema_cycle=1, i.e. wave.ema.active).
      const enableAge = p.contact?.age;
      const enableIsUnder13 = typeof enableAge === "number" && enableAge < 13;
      const settingsAnswered = wave.ema?.settingsComplete === 2;
      if (!enableIsUnder13 && wave.ema?.startDay && !wave.ema.active) {
        const startT0 = toEpoch(wave.ema.startDay);
        if (startT0 != null) {
          const WEEK_MS = 7 * 24 * 3600 * 1000;
          const NUDGE_OFFSET_MS = (3 * 24 + 8) * 3600 * 1000;
          // If settings are already answered, REDCap will activate on
          // the next Monday — no further weekly retries needed.
          const maxWeeks = settingsAnswered ? 1 : 4;
          for (let wkIdx = 0; wkIdx < maxWeeks; wkIdx++) {
            const startT = startT0 + wkIdx * WEEK_MS;
            const sendT = startT - NUDGE_OFFSET_MS;
            if (sendT < now || sendT > horizon) continue;
            const iso = safeIso(sendT);
            if (!iso) continue;
            // Compute the would-be prompt schedule for this week's
            // hypothetical Monday — same EMA_PROMPTS layout, shifted to
            // start on startT.
            const startDateStr = isoDateOnly(startT);
            const promptDates = startDateStr ? computeEmaPromptDates(startDateStr) : {};
            const wouldTriggerPrompts = EMA_PROMPTS.map(([k, day, time]) => ({
              key: k, dayLabel: day, timeLabel: time,
              scheduledAt: promptDates[k] || null,
            }));
            out.push({
              pid: p.pid, recordId: p.recordId, wave: w,
              alertId: 63, kind: "ema_enable",
              instrument: `EMA Y${w} Enable${wkIdx > 0 ? ` (retry week ${wkIdx + 1})` : ""}`,
              scheduledAt: iso, complete: false,
              nudgeWeek: wkIdx + 1,
              hypotheticalStartDay: startDateStr,
              wouldTriggerPrompts,
            });
          }
        }
      }

      // Payment email (alerts 287 / 288) — purely scheduled.
      //   Send date: 5 days after canonical STS2.3 cycle date.
      //   Gate: V2 done (post-V2 work) + not already paid.
      //   Variant: 287 = 13+, 288 = <13 (per dob).
      // NOTE: the REDCap `ema_payment_email_button` field is a manual
      // override for the SEND side. The QUEUE is canonical-only and
      // pre-fills regardless of button state. For new W2 participants
      // whose ema_y2_arm_1 event hasn't been provisioned yet,
      // `wave.ema` is null — default paymentComplete to 0 so the
      // schedule still surfaces.
      const paymentComplete = wave.ema?.paymentComplete ?? 0;
      if (waveV2Done && paymentComplete !== 2) {
        const lastCycle = wave.sts2?.cycles[wave.sts2.cycles.length - 1];
        const baseT = lastCycle?.date ? toEpoch(lastCycle.date) : null;
        if (baseT != null) {
          const sendT = baseT + 5 * 24 * 3600 * 1000;
          const age = p.contact?.age;
          const alertId = (age != null && age < 13) ? 288 : 287;
          const variant = (age != null && age < 13) ? "<13" : "13+";
          if (sendT >= now && sendT <= horizon) {
            const iso = safeIso(sendT);
            if (iso) out.push({
              pid: p.pid, recordId: p.recordId, wave: w,
              alertId, kind: "payment_email",
              instrument: `W${w} ${variant} STS-EMA Payment email`,
              scheduledAt: iso, complete: false,
            });
          }
          // No past-due fallback — this is a scheduled queue, not an
          // outstanding-work list.
        }
      }

      // At-home survey send (alerts 60 SMS / 61 Email) — STRICT canonical:
      //   Condition: visit_1_y{N}_arm_1.break_1_complete = 2
      //              AND at-home survey not yet complete
      //              AND V2 for this wave not yet complete
      //              AND participant hasn't already started/completed
      //                  at-home (don't re-send after they've started it)
      //   Send time: timestamp_athome + 3h45m (single send each)
      // No daily follow-ups: the timeline has no at-home reminder alert,
      // only the single 3h45m-after-timestamp_athome send.
      const ah = wave.atHome;
      if (ah
          && ah.break1Complete === 2
          && ah.athomeMeasuresComplete !== 2
          && ah.timestamp
          && !wave.v2?.allComplete) {
        const baseT = toEpoch(ah.timestamp);
        if (baseT != null) {
          const sendT = baseT + (3 * 60 + 45) * 60 * 1000;
          if (sendT >= now && sendT <= horizon) {
            const iso = safeIso(sendT);
            if (iso) {
              out.push({
                pid: p.pid, recordId: p.recordId, wave: w,
                alertId: 60, kind: "athome_sms",
                instrument: "At-Home Survey Send (Text)",
                scheduledAt: iso, complete: false,
              });
              out.push({
                pid: p.pid, recordId: p.recordId, wave: w,
                alertId: 61, kind: "athome_email",
                instrument: "At-Home Survey Send (Email)",
                scheduledAt: iso, complete: false,
              });
            }
          }
        }
      }
    }
  }
  out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return out;
}

// --- Google Sheets read (PID Session Notes) ---
//
// SOURCE OF TRUTH for V1/V2 dates across all three waves and cohorts.
// We read from the cohort tabs (1000 / 2000 / 3000) which the team
// maintains by hand:
//   - 1000 tab: PIDs 1000-1999 (adults)
//   - 2000 tab: PIDs 2000-2999 (ages 12-17)
//   - 3000 tab: PIDs 3000-3999 (ages 18-20)
// All three tabs share the same column layout for Wave 1 / Wave 2; Wave 3
// uses AN/AV in tab 1000 vs AM/AU in 2000/3000 (subtle: tab 1000 has an
// extra Wave 2 V2 "L3 RA" column shifting Wave 3 over by one).
//
// LIMITATION: the cohort tabs do NOT carry STS1, STS2, EMA, or compensation
// columns — STS cycle months and EMA dates lived in the deprecated
// Follow up.{1,2} tabs only. After this migration STS schedule months
// fall back to the empty array, so participants whose REDCap STS event
// hasn't been provisioned yet (e.g. 3156/3157) will show as tracked but
// with no month-label placeholders. The coordinator needs to point us at
// a new source for STS/EMA schedule months before we can restore that.

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

// Per-cohort-tab schema. Same layout for Wave 1 / Wave 2 across all three;
// Wave 3 column letters differ between tab 1000 and the 2000/3000 tabs.
const COHORT_TABS = [
  { tab: "1000", w1V1: "G", w1V2: "M", w2V1: "U", w2V2: "AC", w3V1: "AN", w3V2: "AV" },
  { tab: "2000", w1V1: "G", w1V2: "M", w2V1: "U", w2V2: "AC", w3V1: "AM", w3V2: "AU" },
  { tab: "3000", w1V1: "G", w1V2: "M", w2V1: "U", w2V2: "AC", w3V1: "AM", w3V2: "AU" },
];
const COHORT_DATA_START_ROW = 8;   // sheet row 8 = 0-indexed row 7
const COHORT_PID_COL = "D";
const COHORT_RECORD_COL = "A";

// Builds an empty per-wave sheet entry with the legacy field shape so
// downstream consumers (STS page, EMA page, type defs) don't break.
// STS/EMA/comp/wave-start fields default to null/[] since cohort tabs
// don't carry them — flag to coordinator.
function emptyWaveSheetEntry(record, v1Date, v2Date) {
  return {
    record,
    v1Date: v1Date != null ? normalizeSheetCell(v1Date) : null,
    v2Date: v2Date != null ? normalizeSheetCell(v2Date) : null,
    sts1Months: [],
    sts2Months: [],
    emaDate: null,
    emaStatus: null,
    w1Comp: null,
    w2Comp: null,
    wave2StartDate: null,
    wave3StartDate: null,
    raTag: null,
    notes: null,
  };
}

async function fetchFollowupSheet() {
  if (!GOOGLE_SA_JSON) {
    console.log("  Skipping Google Sheets pull (GOOGLE_SERVICE_ACCOUNT_JSON not set)");
    return {};
  }
  const tok = await googleAccessToken();
  if (!tok) return {};

  // followupByPid[pid] = { y1, y2, y3 } where each yN is the empty-entry
  // shape iff there's evidence that wave's V1 happened for this PID.
  const followupByPid = {};
  let totalPids = 0;

  for (const tabCfg of COHORT_TABS) {
    const rows = await readSheetTab(tok, `${tabCfg.tab}!A1:CC1500`);
    let tabPids = 0;
    for (let i = COHORT_DATA_START_ROW - 1; i < rows.length; i++) {  // 0-indexed
      const row = rows[i];
      if (!row?.length) continue;
      const pidRaw = cell(row, COHORT_PID_COL);
      if (pidRaw === null) continue;
      const pid = String(pidRaw).trim().replace(/\.0$/, "");
      if (!pid || pid === "PID") continue;
      const recordId = cell(row, COHORT_RECORD_COL);
      const w1V1 = cell(row, tabCfg.w1V1);
      const w1V2 = cell(row, tabCfg.w1V2);
      const w2V1 = cell(row, tabCfg.w2V1);
      const w2V2 = cell(row, tabCfg.w2V2);
      const w3V1 = cell(row, tabCfg.w3V1);
      const w3V2 = cell(row, tabCfg.w3V2);

      if (!followupByPid[pid]) { followupByPid[pid] = {}; totalPids++; tabPids++; }

      // y1: presence in cohort tab = team is tracking them post-V1 (or
      // they have a Y1 V1 date). Always populate y1 so STS / EMA pages
      // can find sheet-tracked participants for Y1.
      followupByPid[pid].y1 = emptyWaveSheetEntry(recordId, w1V1, w1V2);
      // y2: present if Y2 V1 happened (U col date filled).
      if (hasValue(w2V1) || hasValue(w2V2)) {
        followupByPid[pid].y2 = emptyWaveSheetEntry(recordId, w2V1, w2V2);
      }
      // y3: present if Y3 V1 happened.
      if (hasValue(w3V1) || hasValue(w3V2)) {
        followupByPid[pid].y3 = emptyWaveSheetEntry(recordId, w3V1, w3V2);
      }
    }
    console.log(`  Cohort tab ${tabCfg.tab}: +${tabPids} PIDs`);
  }

  const y1Count = Object.values(followupByPid).filter(x => x.y1).length;
  const y2Count = Object.values(followupByPid).filter(x => x.y2).length;
  const y3Count = Object.values(followupByPid).filter(x => x.y3).length;
  console.log(`  Cohort sheets: ${totalPids} PIDs (${y1Count} y1, ${y2Count} y2, ${y3Count} y3)`);
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
  const reportFieldNames = {};
  for (const w of WAVES) {
    const ids = COMPLETION_REPORTS[w];
    for (const kind of ["ema", "atHome"]) {
      try {
        const rows = await fetchReport(ids[kind]);
        console.log(`  Report ${ids[kind]} (${kind} y${w}): ${rows.length} rows`);
        // Capture field names from the first row for diagnostics.
        if (rows.length > 0) {
          const completeFields = Object.keys(rows[0]).filter(k => k.endsWith("_complete"));
          reportFieldNames[`${kind}Y${w}`] = completeFields;
          console.log(`    _complete fields (${completeFields.length}): ${completeFields.slice(0, 8).join(", ")}${completeFields.length > 8 ? ` … +${completeFields.length - 8}` : ""}`);
        }
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
        // Overlay EMA prompt completion. The report uses index-based
        // ema_report_1_complete … ema_report_25_complete (NOT
        // ema_<dayhhmm>_complete as the field names might suggest), so we
        // map prompt order to report-index 1:1.
        for (let i = 0; i < wave.ema.prompts.length; i++) {
          const prompt = wave.ema.prompts[i];
          const reportField = `ema_report_${i + 1}_complete`;
          if (ema[reportField] !== undefined) {
            prompt.complete = num(ema[reportField]) === 2;
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
        // Aggregate prompt-level completion for headline stats
        wave.ema.promptsCompleteCount = wave.ema.prompts.filter(p => p.complete).length;
        wave.ema.promptsScheduledCount = wave.ema.prompts.filter(p => p.scheduledAt).length;
        wave.ema.promptsTotal = wave.ema.prompts.length;
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
        // Derive overall completion from per-section codes since
        // `athome_measures_complete` isn't necessarily one of them.
        // Complete = every section coded 2; in-progress = at least one
        // section touched (1 or 2); else 0.
        const formVals = Object.values(forms);
        if (formVals.length > 0) {
          const allDone = formVals.every(v => v === 2);
          const anyTouched = formVals.some(v => v === 1 || v === 2);
          wave.atHome.athomeMeasuresComplete = allDone ? 2 : (anyTouched ? 1 : 0);
          wave.atHome.sectionsComplete = formVals.filter(v => v === 2).length;
          wave.atHome.sectionsTotal = formVals.length;
        }
      }
    }
  }

  // Merge cohort-tab data (1000 / 2000 / 3000).
  //
  // For each wave's V1/V2:
  //   - Date populated in cohort tab → that visit happened.
  //   - The date is also set on p.waves[N].vK.date for display.
  //   - p.waves[N].followupSheet = sheet.yN so STS/EMA pages can list
  //     sheet-tracked participants even when REDCap event isn't yet
  //     provisioned (e.g. PIDs 3156/3157 are scheduled for Y2 STS1
  //     but their screen_time_y2_arm_1 event row hasn't been created).
  const ensureWave = (p, n) => {
    if (!p.waves[n]) p.waves[n] = { year: n, v1: null, atHome: null, sts1: null, sts2: null, ema: null, v2: null };
    return p.waves[n];
  };
  const ensureVisit = (wave, kind) => {
    if (!wave[kind]) wave[kind] = { date: null, forms: {}, allComplete: false };
    return wave[kind];
  };
  const followupByPid = await fetchFollowupSheet();
  let merged = 0;
  for (const p of participants) {
    const key = String(p.pid || "").replace(/\.0$/, "");
    const sheet = followupByPid[key];
    if (!sheet) continue;
    merged++;
    for (const n of [1, 2, 3]) {
      const yN = sheet[`y${n}`];
      if (!yN) continue;
      const wave = ensureWave(p, n);
      wave.followupSheet = yN;
      if (hasValue(yN.v1Date)) {
        const v1 = ensureVisit(wave, "v1");
        if (!v1.date) v1.date = String(yN.v1Date);
        v1.allComplete = true;
      }
      if (hasValue(yN.v2Date)) {
        const v2 = ensureVisit(wave, "v2");
        if (!v2.date) v2.date = String(yN.v2Date);
        v2.allComplete = true;
      }
    }
  }
  console.log(`  Merged cohort-sheet data into ${merged} participants`);

  // ─── Canonical STS schedule pass ─────────────────────────────────────
  // Run AFTER the cohort-sheet merge so wave.vK.date is populated with
  // the team's actual V1/V2 dates from the 1000/2000/3000 tabs.
  //
  // Rules per coordinator:
  //   STS1: 5 PM ET on day 20 of month following prior wave's V2 (Y1
  //         falls back to Y1 V1 since there is no prior wave). 6 cycles
  //         monthly thereafter, same day-of-month / hour.
  //   STS2: 5 PM ET on day 20 of month following canonical EMA. The
  //         canonical EMA = day 1 of (STS1.6 month + 4). Both ≥13 and
  //         <13 use the same anchor — <13 just doesn't get the EMA
  //         survey itself.
  //
  // We MATERIALIZE the cycles array even when REDCap hasn't yet created
  // the screen_time_y{N}_arm_1 event row, so future-scheduled invites
  // for in-progress participants (3056/3156/3157 etc) actually surface
  // in the queue. When REDCap eventually provisions the event, its
  // `complete` codes overlay via the completion-report fetch above.
  const makeCycle = (i, date) => ({ index: i + 1, date, complete: 0, surveyLink: null });
  let stsScheduled = 0;
  for (const p of participants) {
    for (const w of WAVES) {
      const wave = p.waves[w];
      if (!wave) continue;

      // STS1 anchor: the SAME wave's V2 — STS1.1 fires on day 20 of the
      // month AFTER V2. V1+V2 are paired in-lab visits at the wave start
      // (typically ~1 week apart); the 6 monthly STS1 cycles begin after V2.
      const sts1Anchor = wave.v2?.date || null;

      if (sts1Anchor) {
        const dates = computeStsCycleDates(sts1Anchor, 6, 17);
        if (!wave.sts1) wave.sts1 = { active: false, cycles: [] };
        if (!Array.isArray(wave.sts1.cycles)) wave.sts1.cycles = [];
        for (let i = 0; i < 6; i++) {
          if (!wave.sts1.cycles[i]) wave.sts1.cycles[i] = makeCycle(i, dates[i]);
          else if (dates[i]) wave.sts1.cycles[i].date = dates[i];
        }
        if (!wave.sts1.active && (wave.v1?.allComplete || wave.followupSheet)) {
          wave.sts1.active = true;
        }
        stsScheduled++;
      }

      // STS2 anchor: canonical EMA = day 1 of (STS1.6 month + 4).
      let sts2Anchor = null;
      if (wave.sts1?.cycles?.[5]?.date) {
        const s16 = String(wave.sts1.cycles[5].date).slice(0, 10);
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s16);
        if (m) {
          let year = parseInt(m[1], 10);
          let month = parseInt(m[2], 10) + 4;
          while (month > 12) { month -= 12; year++; }
          const mm = String(month).padStart(2, "0");
          sts2Anchor = `${year}-${mm}-01`;
        }
      }
      if (sts2Anchor) {
        const dates = computeStsCycleDates(sts2Anchor, 3, 17);
        if (!wave.sts2) wave.sts2 = { active: false, cycles: [] };
        if (!Array.isArray(wave.sts2.cycles)) wave.sts2.cycles = [];
        for (let i = 0; i < 3; i++) {
          if (!wave.sts2.cycles[i]) wave.sts2.cycles[i] = makeCycle(i, dates[i]);
          else if (dates[i]) wave.sts2.cycles[i].date = dates[i];
        }
        if (!wave.sts2.active && (wave.v1?.allComplete || wave.followupSheet)) {
          wave.sts2.active = true;
        }
      }

      // Canonical EMA start_day materialization — ≥13 only.
      //   The dashboard sends the EMA Enable nudge to every ≥13
      //   participant 3d8h before their start_day (a Monday). For
      //   participants whose ema_y{N}_arm_1 event hasn't been
      //   provisioned in REDCap yet, we synthesize a wave.ema with the
      //   canonical start_day so the Enable nudge surfaces in the
      //   queue. REDCap-provisioned cycles keep their real start_day;
      //   we only fill in a missing one.
      //   Anchor: Monday on/after day 1 of (STS1.6 month + 4).
      //   The 25 prompts are intentionally NOT pre-filled — they're
      //   participant-dependent and don't belong in the dashboard's
      //   automated-send queue.
      //   Under-13s are excluded by design (no EMA instrument).
      if (sts2Anchor) {
        const age = p.contact?.age;
        const isUnder13 = typeof age === "number" && age < 13;
        if (!isUnder13) {
          const canonicalStart = nextMondayOnOrAfter(sts2Anchor);
          if (!wave.ema) {
            wave.ema = {
              active: false,
              startDay: canonicalStart,
              startDayCalc: null,
              startDayCalcSum: 0,
              enableConfirmed: false,
              settingsComplete: 0,
              paymentEmailButton: false,
              paymentComplete: 0,
              enableSent: false,
              phone: p.contact?.phonePrimary || "",
              prompts: [],
            };
          } else if (!wave.ema.startDay) {
            wave.ema.startDay = canonicalStart;
          }
        }
      }
    }
  }
  console.log(`  Applied canonical STS schedule to ${stsScheduled} wave entries`);

  // ─── Gating ───────────────────────────────────────────────────────────
  // Per coordinator: nobody should appear who hasn't completed Y1 V1, and
  // no wave should display surveys/sends if that wave's V1 isn't done.
  // This makes Y1 V1 the gate-in criterion for the whole dashboard.
  let droppedNoY1V1 = 0;
  const gated = [];
  for (const p of participants) {
    if (!p.waves[1]?.v1?.allComplete) { droppedNoY1V1++; continue; }
    // Per-wave gate: keep the wave entry if the team is actively
    // tracking the participant for that wave OR they have any actual
    // event data for it. The only thing we drop is completely-empty
    // wave entries (no V1, no V2, no sheet, no REDCap event rows).
    for (const w of WAVES) {
      const wave = p.waves[w];
      if (!wave) continue;
      const hasAnyData = !!(
        wave.v1?.allComplete || wave.v2?.allComplete ||
        wave.followupSheet || wave.sts1 || wave.sts2 || wave.ema || wave.atHome
      );
      if (!hasAnyData) {
        delete p.waves[w];
      }
    }
    gated.push(p);
  }
  participants.length = 0;
  participants.push(...gated);
  console.log(`  Gated to ${participants.length} participants with Y1 V1 complete (dropped ${droppedNoY1V1})`);

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

  // Resolve survey links per queued item. Map each kind to its event +
  // instrument so the queue page can show the actual link a recipient
  // would click. Skip ones that are already-cached on the wave.sts cycle.
  const linkByKey = {};  // recordId|event|instrument → link
  // Pre-seed from the survey-link work we already did on STS cycles.
  for (const p of participants) {
    for (const w of WAVES) {
      const wave = p.waves[w];
      if (!wave) continue;
      wave.sts1?.cycles.forEach((c, idx) => {
        if (c.surveyLink) linkByKey[`${p.recordId}|${eventName("sts1", w)}|screen_time_${idx + 1}`] = c.surveyLink;
      });
      wave.sts2?.cycles.forEach((c, idx) => {
        if (c.surveyLink) linkByKey[`${p.recordId}|${eventName("sts2", w)}|screen_time_${idx + 1}_2`] = c.surveyLink;
      });
    }
  }

  // Helper that derives (eventName, instrumentName) for a queue row.
  function linkSpec(d) {
    const evWave = d.wave;
    if (d.kind === "sts1_invite" || d.kind === "sts1_followup") {
      const idx = ((d.alertId - 48) % 6 + 6) % 6 || (d.alertId - 54 + 1 - 1);
      const cycleIndex = d.kind === "sts1_invite" ? (d.alertId - 48) : (d.alertId - 54);
      return { event: eventName("sts1", evWave), instrument: `screen_time_${cycleIndex + 1}` };
    }
    if (d.kind === "sts2_invite" || d.kind === "sts2_followup") {
      const cycleIndex = d.kind === "sts2_invite" ? (d.alertId - 89) : (d.alertId - 93);
      return { event: eventName("sts2", evWave), instrument: `screen_time_${cycleIndex + 1}_2` };
    }
    if (d.kind === "ema_prompt") {
      // EMA prompt index — map emaKey to position in EMA_PROMPT_FIELDS
      const idx = EMA_PROMPT_FIELDS.indexOf(d.emaKey);
      return { event: eventName("ema", evWave), instrument: `ema_report_${idx >= 0 ? idx + 1 : 1}` };
    }
    if (d.kind === "ema_enable") {
      return { event: eventName("ema", evWave), instrument: "ema_participant_confirmation" };
    }
    if (d.kind === "athome_sms" || d.kind === "athome_email") {
      return { event: eventName("athome", evWave), instrument: "texi" };
    }
    if (d.kind === "payment_email") {
      return { event: eventName("ema", evWave), instrument: "ema_payment" };
    }
    return null;
  }

  // Resolve missing links via REDCap (capped to avoid blowing the token's
  // rate limit on 5000+ items)
  const missing = [];
  for (const d of due) {
    const spec = linkSpec(d);
    if (!spec) continue;
    d._linkKey = `${d.recordId}|${spec.event}|${spec.instrument}`;
    if (linkByKey[d._linkKey]) {
      d.surveyLink = linkByKey[d._linkKey];
    } else {
      missing.push({ d, spec });
    }
  }
  // Group missing keys to avoid duplicate work, cap to 1500 unique keys.
  const uniqueKeys = new Map();
  for (const { d, spec } of missing) {
    if (!uniqueKeys.has(d._linkKey)) uniqueKeys.set(d._linkKey, { d, spec });
  }
  console.log(`  Resolving ${uniqueKeys.size} queue-item survey links (${missing.length} queue rows reference them)…`);
  const queueLinkTasks = [];
  const linksToResolve = Array.from(uniqueKeys.values()).slice(0, 1500);
  for (const { d, spec } of linksToResolve) {
    queueLinkTasks.push(async () => {
      const link = await fetchSurveyLink(d.recordId, spec.event, spec.instrument);
      if (link) linkByKey[d._linkKey] = link;
    });
  }
  await batchAsync(queueLinkTasks, 3, 200);
  // Back-fill all queue rows with resolved links
  for (const d of due) {
    if (!d.surveyLink && d._linkKey && linkByKey[d._linkKey]) {
      d.surveyLink = linkByKey[d._linkKey];
    }
    delete d._linkKey;
  }

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
