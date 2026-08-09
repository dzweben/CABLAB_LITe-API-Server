#!/usr/bin/env node
// LITe local EMA sender — the Mac's FULL sender leg (holds real keys).
//
// Division of labor across the four legs, all deduped against the
// carrier's own message history so no two can double-send:
//   second 0        GitHub segment job (primary, sleeps to the second)
//   ≥3 min late     THIS script (Mac clock, fully independent of GitHub)
//   ≥10 min late    Vercel sweeper (pinged by refresh workflow + Mac timer)
//   >30 min late    protocol skip — nobody sends
//
// Every 60s (launchd): read the prompt schedule from GitHub (raw
// contents API via gh — survives GitHub *Actions* being down, which is
// the failure mode that matters), find prompts 3–30 min late with no
// terminal ledger row, verify against OpenPhone history (fail CLOSED),
// send from the same line the primary uses, and write the ledger row
// back through the contents API with sha-retry.
//
// Credentials: ~/Library/Application Support/cablab/sender.env (0600),
// relayed from GitHub secrets via one-shot RSA-OAEP workflow 2026-08-09.

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const BASE = path.join(os.homedir(), "Library", "Application Support", "cablab");
const GH = "/opt/homebrew/bin/gh";
const REPO = "dzweben/CABLAB_LITe-API-Server";
const QUO = "https://api.openphone.com/v1";
const MIN_LATE_MS = 3 * 60 * 1000;    // primary owns the first 3 minutes
const GRACE_MS = 30 * 60 * 1000;      // protocol: >30 min late = skip, never send
const TERMINAL = new Set(["sent", "skipped_late", "skipped", "already_delivered"]);

const log = (m) => console.log(`${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET  ${m}`);

const envFile = Object.fromEntries(
  fs.readFileSync(path.join(BASE, "sender.env"), "utf-8").split("\n")
    .filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const API_KEY = (envFile.QUO_API_KEY || "").trim();
const FROM = (envFile.QUO_FROM_NUMBER || "").trim();
if (!API_KEY || !FROM) { log("sender.env incomplete — exiting"); process.exit(0); }

const normalizePhone = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : d ? `+${d}` : "";
};

// --- GitHub contents API (works even when Actions is fully down) ---
function ghRaw(repoPath) {
  return execFileSync(GH, ["api", `repos/${REPO}/contents/${repoPath}`,
    "-H", "Accept: application/vnd.github.raw"], { maxBuffer: 64 * 1024 * 1024 }).toString();
}
function ghJson(repoPath, fallback) {
  try { return JSON.parse(ghRaw(repoPath)); } catch { return fallback; }
}

async function quo(pathname, init) {
  return fetch(`${QUO}${pathname}`, {
    ...init,
    headers: { Authorization: API_KEY, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
}

let pnIdCache = null;
async function phoneNumberId() {
  if (pnIdCache) return pnIdCache;
  const res = await quo("/phone-numbers");
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const want = normalizePhone(FROM);
  for (const pn of body?.data || []) {
    if (normalizePhone(pn.number ?? pn.phoneNumber ?? "") === want) { pnIdCache = String(pn.id); return pnIdCache; }
  }
  if ((body?.data || []).length === 1) { pnIdCache = String(body.data[0].id); return pnIdCache; }
  return null;
}

// true = delivered, false = definitely not, null = unverifiable (FAIL CLOSED)
async function alreadyDelivered(pnId, phone, link, sendAtMs) {
  const params = new URLSearchParams({
    phoneNumberId: pnId, maxResults: "20",
    createdAfter: new Date(sendAtMs - 2 * 60 * 1000).toISOString(),
  });
  params.append("participants", phone);
  const res = await quo(`/messages?${params}`);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  if (!body?.data) return null;
  for (const m of body.data) {
    if (String(m.direction || "") !== "incoming" && link && String(m.text ?? m.content ?? "").includes(link)) return true;
  }
  return false;
}

// Prompt template: same source as the sweeper (timeline.ts alertId 64).
function promptTemplate() {
  try {
    const ts = ghRaw("app/src/lib/timeline.ts");
    const m = /alertId: 64,[\s\S]*?message: ("(?:[^"\\]|\\.)*"),/.exec(ts);
    return m ? JSON.parse(m[1]) : null;
  } catch { return null; }
}
const renderPrompt = (tmpl, firstName, link) =>
  tmpl.split("[preenrollment_arm_1][first_name]").join(firstName || "")
      .replace(/\[[a-z0-9_]+\]\[survey-link:[a-z0-9_]+\]/gi, link);

// Ledger write-back through the contents API with sha-retry.
function pushLedgerRows(rows) {
  const LP = "app/private/data/ema-sent-log.json";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const meta = JSON.parse(execFileSync(GH, ["api", `repos/${REPO}/contents/${LP}`], { maxBuffer: 64 * 1024 * 1024 }).toString());
      const cur = JSON.parse(Buffer.from(meta.content, "base64").toString());
      const have = new Set(cur.map(e => `${e.key}|${e.status}`));
      const fresh = rows.filter(r => !have.has(`${r.key}|${r.status}`));
      if (fresh.length === 0) return true;
      const next = Buffer.from(JSON.stringify([...cur, ...fresh], null, 2)).toString("base64");
      const tmp = path.join(os.tmpdir(), `hb-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify({ message: `mac-sender ledger [${new Date().toISOString()}]`, content: next, sha: meta.sha }));
      execFileSync(GH, ["api", "-X", "PUT", `repos/${REPO}/contents/${LP}`, "--input", tmp], { maxBuffer: 16 * 1024 * 1024 });
      fs.unlinkSync(tmp);
      return true;
    } catch (e) {
      if (attempt === 3) { log(`ledger push FAILED after 3 attempts: ${e.message}`); return false; }
    }
  }
}

const main = async () => {
  const now = Date.now();
  const schedule = ghJson("app/private/data/ema-prompt-schedule.json", []);
  const candidates = schedule.filter(r => {
    const t = new Date(r.sendAt).getTime();
    return !isNaN(t) && now - t >= MIN_LATE_MS && now - t <= GRACE_MS;
  });
  if (candidates.length === 0) { if (new Date().getMinutes() === 0) log(`ok — ${schedule.length} scheduled, none in my window`); return; }

  log(`${candidates.length} prompt(s) in the 3–30 min late window — primary may be down`);
  const ledger = ghJson("app/private/data/ema-sent-log.json", []);
  const done = new Set(ledger.filter(e => TERMINAL.has(e.status) && !e.dryRun).map(e => e.key));
  const tmpl = promptTemplate();
  const parts = ghJson("app/private/data/participants.json", { participants: [] });
  const nameByPid = Object.fromEntries((parts.participants || []).map(p => [p.pid, p.contact?.firstName || ""]));
  const pnId = await phoneNumberId();
  if (!pnId || !tmpl) { log("cannot resolve phoneNumberId/template — fail closed"); return; }

  const rows = [];
  for (const row of candidates) {
    const k = `${row.pid}|${row.wave}|${row.key}`;
    if (done.has(k)) continue;
    const phone = normalizePhone(row.phone);
    const link = row.surveyLink;
    const sendAtMs = new Date(row.sendAt).getTime();
    if (!phone || !link) { log(`  ✗ ${k}: missing phone/link — skip`); continue; }
    const seen = await alreadyDelivered(pnId, phone, link, sendAtMs);
    if (seen === null) { log(`  ? ${k}: history unverifiable — fail closed, not sending`); continue; }
    if (seen === true) {
      log(`  ◦ ${k}: already delivered per carrier history`);
      rows.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "already_delivered", channel: "sms", recipient: phone, sendAt: row.sendAt, at: new Date(now).toISOString(), note: "confirmed by mac-sender via carrier history" });
      continue;
    }
    const res = await quo("/messages", { method: "POST", body: JSON.stringify({ content: renderPrompt(tmpl, nameByPid[row.pid], link), from: FROM, to: [phone] }) });
    if (!res.ok) { log(`  ✗ ${k}: OpenPhone ${res.status}`); rows.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "failed", channel: "sms", recipient: phone, sendAt: row.sendAt, at: new Date(Date.now()).toISOString(), note: `mac-sender OpenPhone ${res.status}` }); continue; }
    const latencySec = Math.round((Date.now() - sendAtMs) / 1000);
    log(`  ✓ SENT ${k} → ${phone.slice(0, 5)}*** (${latencySec}s after slot) [mac-sender]`);
    rows.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "sent", channel: "sms", recipient: phone, sendAt: row.sendAt, at: new Date(Date.now()).toISOString(), latencySec, note: "mac-sender leg (GitHub legs missed the slot)" });
  }
  if (rows.length) pushLedgerRows(rows);
};

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(0); });
