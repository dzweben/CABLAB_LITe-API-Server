#!/usr/bin/env node
/**
 * Project LITe outgoing-message poller.
 *
 * Runs every 5 minutes from GitHub Actions. Each invocation:
 *   1. Loads participants.json + due-reminders.json (from the latest
 *      fetch-data run) and sent-log.json (rolling log).
 *   2. Finds reminders whose scheduledAt falls inside [now - 2.5m, now + 2.5m]
 *      AND that aren't already marked sent in sent-log.json.
 *   3. Renders each message via the Timeline templates (with the
 *      participant's firstName, survey-link, etc. substituted in).
 *   4. Sends:
 *        - SMS via OpenPhone API → phone_primary + phone_secondary
 *          (or ema_phone for EMA prompts)
 *        - Email via Gmail SMTP
 *   5. Appends an entry per channel to sent-log.json.
 *
 * Env vars:
 *   GMAIL_USER, GMAIL_APP_PASSWORD
 *   QUO_API_KEY, QUO_FROM_NUMBER     (OpenPhone — same as SDN)
 *   REDCAP_LITE_TOKEN                (for last-minute survey-link resolution)
 *   REDCAP_API_URL                   (defaults to Temple's)
 *   DRY_RUN=true                     (preview only — no actual sends)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "private", "data");
const PARTICIPANTS_PATH = path.join(DATA_DIR, "participants.json");
const DUE_PATH = path.join(DATA_DIR, "due-reminders.json");
const SENT_LOG_PATH = path.join(DATA_DIR, "sent-log.json");
const POSTPONED_PATH = path.join(DATA_DIR, "postponed.json");

const DRY_RUN = (process.env.DRY_RUN || "").toLowerCase() === "true";
const WINDOW_MS = 5 * 60 * 1000;  // ±2.5 min on each side of "now"

const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const QUO_API_KEY = process.env.QUO_API_KEY || "";
const QUO_FROM_NUMBER = process.env.QUO_FROM_NUMBER || "";
const REDCAP_API_URL = process.env.REDCAP_API_URL || "https://cphapps.temple.edu/redcap/api/";
const LITE_TOKEN = process.env.REDCAP_LITE_TOKEN || "";

// --- IO helpers ---
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// --- Idempotency key ---
function dueKey(d) {
  return `${d.pid}|${d.alertId}|${d.scheduledAt}`;
}

// --- Template rendering ---
// Replace [event][field] placeholders + [event][survey-link:instr].
function renderMessage(template, participant, wave, surveyLinks) {
  if (!template) return "";
  let out = template;
  const subs = {
    "[preenrollment_arm_1][first_name]": participant.contact.firstName || "",
    "[preenrollment_arm_1][last_name]":  participant.contact.lastName || "",
    "[preenrollment_arm_1][parent_name]":participant.contact.parentName || "",
    "[preenrollment_arm_1][email]":      participant.contact.email || "",
    "[preenrollment_arm_1][phone_primary]":   participant.contact.phonePrimary || "",
    "[preenrollment_arm_1][phone_secondary]": participant.contact.phoneSecondary || "",
  };
  for (const [k, v] of Object.entries(subs)) {
    out = out.split(k).join(v);
  }
  // Survey link slots: [{event_name}][survey-link:{instrument}]
  out = out.replace(/\[([a-z0-9_]+)\]\[survey-link:([a-z0-9_]+)\]/gi, (_m, evt, instr) => {
    return surveyLinks[`${evt}|${instr}`] || "[SURVEY LINK PENDING]";
  });
  return out;
}

// --- Survey-link resolver (lazy, only what we need NOW) ---
const linkCache = {};
async function resolveSurveyLink(recordId, eventName, instrument) {
  const key = `${recordId}|${eventName}|${instrument}`;
  if (linkCache[key]) return linkCache[key];
  if (!LITE_TOKEN) return null;
  try {
    const body = new URLSearchParams({
      token: LITE_TOKEN, content: "surveyLink", format: "json",
      record: recordId, event: eventName, instrument,
    });
    const res = await fetch(REDCAP_API_URL, {
      method: "POST", body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const txt = (await res.text()).trim();
    const link = txt.startsWith("http") ? txt : null;
    linkCache[key] = link;
    return link;
  } catch { return null; }
}

// --- Senders ---
let mailTransporter = null;
function getMailer() {
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false,
      pool: true, maxConnections: 1, maxMessages: Infinity,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return mailTransporter;
}

async function sendEmail(to, subject, body) {
  if (DRY_RUN) { console.log(`  [DRY] email → ${to}: ${subject}`); return; }
  if (!GMAIL_USER) throw new Error("GMAIL_USER not set");
  await getMailer().sendMail({
    from: `"Project LITe - CABLAB" <${GMAIL_USER}>`,
    to, subject, text: body,
  });
}

function normalizePhone(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (!d) return null;
  if (!d.startsWith("1")) d = "1" + d;
  return "+" + d;
}

async function sendSMS(to, body) {
  if (DRY_RUN) { console.log(`  [DRY] sms → ${to}: ${body.slice(0, 60)}…`); return; }
  if (!QUO_API_KEY || !QUO_FROM_NUMBER) throw new Error("QUO_API_KEY / QUO_FROM_NUMBER not set");
  const e164 = normalizePhone(to);
  if (!e164) throw new Error(`Bad phone ${to}`);
  const res = await fetch("https://api.openphone.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: QUO_API_KEY },
    body: JSON.stringify({ content: body, from: QUO_FROM_NUMBER, to: [e164] }),
  });
  if (!res.ok) throw new Error(`OpenPhone ${res.status}: ${await res.text()}`);
}

// --- Timeline template lookup (mirrors src/lib/timeline.ts) ---
function loadTimeline() {
  // The runtime can't import a .ts file. Instead we read the AUTO-GENERATED
  // section of timeline.ts and pull message text by (alertId, wave).
  const tsPath = path.join(__dirname, "..", "src", "lib", "timeline.ts");
  const ts = fs.readFileSync(tsPath, "utf-8");
  const entries = [];
  const blockRegex = /\{\s*alertId:\s*(\d+),\s*wave:\s*(\d)\s*as WaveYear,\s*kind:\s*"([^"]+)",\s*instrument:\s*("(?:[^"\\]|\\.)*"),[\s\S]*?message:\s*("(?:[^"\\]|\\.)*"),\s*\},/g;
  let m;
  while ((m = blockRegex.exec(ts)) !== null) {
    entries.push({
      alertId: Number(m[1]),
      wave: Number(m[2]),
      kind: m[3],
      instrument: JSON.parse(m[4]),
      message: JSON.parse(m[5]),
    });
  }
  return entries;
}

const TIMELINE = loadTimeline();

function findTemplate(alertId, wave, kind) {
  return TIMELINE.find(t => t.alertId === alertId && t.wave === wave)
      || TIMELINE.find(t => t.alertId === alertId)  // fallback ignore wave
      || TIMELINE.find(t => t.kind === kind && t.wave === wave); // last-resort
}

// --- Main ---
async function main() {
  const data = readJson(PARTICIPANTS_PATH, { participants: [] });
  const due = readJson(DUE_PATH, []);
  const sentLog = readJson(SENT_LOG_PATH, []);
  const postponed = new Set((readJson(POSTPONED_PATH, [])).map(s => String(s).toLowerCase()));

  console.log(`Loaded ${data.participants.length} participants, ${due.length} due, ${sentLog.length} sent-log entries`);

  const now = Date.now();
  const lo = now - WINDOW_MS / 2;
  const hi = now + WINDOW_MS / 2;
  const alreadySent = new Set(sentLog.filter(e => e.status === "sent").map(e => `${e.pid}|${e.alertId}|${e.scheduledAt}`));

  const participantByPid = Object.fromEntries(data.participants.map(p => [p.pid, p]));

  const fires = due.filter(d => {
    if (postponed.has(String(d.pid).toLowerCase())) return false;
    if (d.complete) return false;                            // survey already done — don't bug them
    if (d.mode === "manual") return false;                   // visibility only — coordinator handles
    const t = new Date(d.scheduledAt).getTime();
    if (isNaN(t) || t < lo || t > hi) return false;
    if (alreadySent.has(dueKey(d))) return false;
    return true;
  });

  console.log(`Window: ${new Date(lo).toISOString()} → ${new Date(hi).toISOString()}`);
  console.log(`Firing ${fires.length} reminders this cycle`);
  if (fires.length === 0) { console.log("Nothing to do."); return; }

  let sent = 0, failed = 0;

  for (const d of fires) {
    const p = participantByPid[d.pid];
    if (!p) { console.warn(`  ! pid ${d.pid} not found in participants.json — skipping`); continue; }
    const tmpl = findTemplate(d.alertId, d.wave, d.kind);
    if (!tmpl) { console.warn(`  ! no template for alert ${d.alertId}/wave ${d.wave} — skipping`); continue; }

    // Resolve any survey-link placeholders just-in-time.
    const linkSlots = [...(tmpl.message?.matchAll(/\[([a-z0-9_]+)\]\[survey-link:([a-z0-9_]+)\]/gi) || [])];
    const surveyLinks = {};
    for (const [, evt, instr] of linkSlots) {
      const link = await resolveSurveyLink(p.recordId, evt, instr);
      if (link) surveyLinks[`${evt}|${instr}`] = link;
    }

    const body = renderMessage(tmpl.message, p, d.wave, surveyLinks);
    const subject = tmpl.kind?.includes("email")
      ? `Project LITe – ${tmpl.instrument}`
      : null;

    // Channels per template
    const wantSMS   = tmpl.kind === "ema_prompt" || tmpl.kind === "ema_enable" || tmpl.kind === "athome_sms" || tmpl.kind === "sts1_invite" || tmpl.kind === "sts1_followup" || tmpl.kind === "sts2_invite" || tmpl.kind === "sts2_followup";
    const wantEmail = tmpl.kind === "athome_email" || tmpl.kind === "sts1_invite" || tmpl.kind === "sts1_followup" || tmpl.kind === "sts2_invite" || tmpl.kind === "sts2_followup";

    const phones = [p.contact.phonePrimary, p.contact.phoneSecondary].filter(Boolean);
    const email  = p.contact.email;

    // EMA prompts only go to the dedicated EMA line, never email
    const useEmaPhone = tmpl.kind === "ema_prompt" && p.waves?.[d.wave]?.ema?.phone;
    const smsTargets = useEmaPhone ? [p.waves[d.wave].ema.phone] : phones;

    const tryRecord = async (channel, recipient, fn) => {
      try {
        await fn();
        sent++;
        sentLog.push({
          id: dueKey(d), timestamp: new Date().toISOString(),
          pid: d.pid, alertId: d.alertId, instrument: tmpl.instrument,
          channel, recipient, status: "sent",
        });
        console.log(`  ✓ ${channel} → ${d.pid} (${recipient})`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        sentLog.push({
          id: dueKey(d), timestamp: new Date().toISOString(),
          pid: d.pid, alertId: d.alertId, instrument: tmpl.instrument,
          channel, recipient, status: "failed", error: msg,
        });
        console.error(`  ✗ ${channel} → ${d.pid} (${recipient}): ${msg}`);
      }
    };

    if (wantSMS) {
      for (const ph of smsTargets) {
        await tryRecord("sms", ph, () => sendSMS(ph, body));
      }
    }
    if (wantEmail && email) {
      await tryRecord("email", email, () => sendEmail(email, subject || `Project LITe – ${tmpl.instrument}`, body));
    }

    // Snapshot log frequently so a mid-run crash doesn't lose state
    writeJson(SENT_LOG_PATH, sentLog);
  }

  writeJson(SENT_LOG_PATH, sentLog);
  console.log(`\nDone. Sent ${sent}, failed ${failed}.`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
