import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// EMA SENDER — the one and only delivery path for EMA prompts.
//
// Vercel's minute-cron invokes this route every 60 seconds. Each tick:
//   1. Reads the prompt schedule and the ledger LIVE from the GitHub
//      contents API (GITHUB_DATA_TOKEN) — never from the deployed
//      bundle, so data staleness and deploy timing are irrelevant.
//   2. Sends every prompt whose slot is due and within the 30-minute
//      protocol grace, skipping anything already terminal in the ledger.
//   3. Checks OpenPhone's own message history before each send (fail
//      closed) — the carrier is the arbiter, so no other sender, past
//      or present, can ever be double-sent against.
//   4. Writes the ledger rows back through the contents API (sha-retry),
//      so the audit and dashboard see exactly what happened.
//
// GitHub Actions no longer sends EMA prompts at all — the EMA Prompt
// Sender workflow's cron schedule was removed 2026-09-18 (it survives
// as manual-dispatch dry-run only). Actions' only remaining EMA job is
// regenerating the schedule file — batch work where lateness is
// harmless. If the GitHub API read fails, the route falls back to the
// bundled schedule copy rather than going dark. The saer Mac remains
// the independent late backstop; carrier-history dedup keeps every
// sender at-most-once.
//
// Auth: x-sweep-secret header, ?secret=, or Vercel Cron's
// `Authorization: Bearer ${CRON_SECRET}`.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GRACE_MS = 30 * 60 * 1000;
const QUO_BASE = "https://api.openphone.com/v1";
const REPO = "dzweben/CABLAB_LITe-API-Server";
const TERMINAL = new Set(["sent", "skipped_late", "skipped", "already_delivered"]);

interface ScheduleRow {
  pid: string; wave: number | string; key: string;
  sendAt: string; phone: string; surveyLink: string | null;
  firstName?: string; dayLabel?: string; timeLabel?: string;
}
interface LedgerRow {
  key: string; pid: string; wave: number | string; promptKey: string;
  status: string; channel?: string; recipient?: string; sendAt: string;
  at?: string; latencySec?: number; note?: string; error?: string; dryRun?: boolean;
}

function normalizePhone(s: unknown): string | null {
  let d = String(s || "").replace(/\D/g, "");
  if (d.length === 10) d = "1" + d;
  return d.length === 11 && d.startsWith("1") ? "+" + d : null;
}

// --- GitHub contents API (live data plane) ---
async function ghGetRaw(repoPath: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${repoPath}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw" },
      signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}
async function ghGetJsonWithSha(repoPath: string, token: string): Promise<{ data: unknown; sha: string } | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${repoPath}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(20_000), cache: "no-store",
    });
    if (!res.ok) return null;
    const body = await res.json() as { content: string; sha: string };
    return { data: JSON.parse(Buffer.from(body.content, "base64").toString()), sha: body.sha };
  } catch { return null; }
}
async function ghPutJson(repoPath: string, token: string, data: unknown, sha: string, message: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${repoPath}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ message, sha, content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64") }),
      signal: AbortSignal.timeout(25_000),
    });
    return res.ok;
  } catch { return false; }
}

async function readBundled<T>(rel: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "private", "data", rel), "utf-8");
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}

async function promptTemplate(): Promise<string | null> {
  try {
    const ts = await fs.readFile(path.join(process.cwd(), "src", "lib", "timeline.ts"), "utf-8");
    const m = /alertId: 64,[\s\S]*?message: ("(?:[^"\\]|\\.)*"),/.exec(ts);
    return m ? (JSON.parse(m[1]) as string) : null;
  } catch { return null; }
}

function renderPrompt(tmpl: string, firstName: string, link: string): string {
  let out = tmpl.split("[preenrollment_arm_1][first_name]").join(firstName || "");
  out = out.replace(/\[[a-z0-9_]+\]\[survey-link:[a-z0-9_]+\]/gi, link);
  return out;
}

async function quo(pathname: string, apiKey: string, init?: RequestInit): Promise<Response> {
  return fetch(`${QUO_BASE}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: apiKey, ...(init?.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
}

// Warm-instance memory of keys sent by THIS process. Belt on top of the
// ledger + carrier checks: even if both are unreachable next minute, a
// reused instance will not re-send what it just sent.
const sentThisInstance = new Set<string>();

// 3 attempts with backoff, same as the retired GitHub sender.
async function sendSMS(apiKey: string, from: string, to: string, body: string): Promise<void> {
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await quo("/messages", apiKey, {
        method: "POST", body: JSON.stringify({ content: body, from, to: [to] }),
      });
      if (!res.ok) throw new Error(`OpenPhone ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return;
    } catch (e) {
      if (a === 3) throw e;
      await new Promise(r => setTimeout(r, 1500 * a));
    }
  }
}

let cachedPhoneNumberId: string | null = null;
async function phoneNumberId(apiKey: string, fromNumber: string): Promise<string | null> {
  if (cachedPhoneNumberId) return cachedPhoneNumberId;
  const res = await quo("/phone-numbers", apiKey);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as { data?: Array<Record<string, unknown>> } | null;
  const want = normalizePhone(fromNumber);
  for (const pn of body?.data || []) {
    const num = normalizePhone(pn.number ?? pn.phoneNumber ?? "");
    if (num && num === want) { cachedPhoneNumberId = String(pn.id); return cachedPhoneNumberId; }
  }
  if ((body?.data || []).length === 1) { cachedPhoneNumberId = String(body!.data![0].id); return cachedPhoneNumberId; }
  return null;
}

// Carrier-history check (fail closed on null).
async function alreadyDelivered(
  apiKey: string, pnId: string, phone: string, link: string, sendAtMs: number,
): Promise<boolean | null> {
  const createdAfter = new Date(sendAtMs - 2 * 60 * 1000).toISOString();
  const params = new URLSearchParams({ phoneNumberId: pnId, maxResults: "20", createdAfter });
  params.append("participants", phone);
  const res = await quo(`/messages?${params}`, apiKey);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as { data?: Array<Record<string, unknown>> } | null;
  if (!body?.data) return null;
  for (const m of body.data) {
    const dir = String(m.direction || "");
    const text = String(m.text ?? m.content ?? "");
    if (dir !== "incoming" && link && text.includes(link)) return true;
  }
  return false;
}

export async function GET(req: NextRequest) { return tick(req); }
export async function POST(req: NextRequest) { return tick(req); }

async function tick(req: NextRequest) {
  const secret = process.env.EMA_SWEEP_SECRET || "";
  const apiKey = process.env.QUO_API_KEY || "";
  const fromNumber = process.env.QUO_FROM_NUMBER || "";
  const ghToken = process.env.GITHUB_DATA_TOKEN || "";
  if (!secret || !apiKey || !fromNumber) {
    return NextResponse.json({ armed: false, reason: "sender env not provisioned" }, { status: 503 });
  }
  const given = req.headers.get("x-sweep-secret") || req.nextUrl.searchParams.get("secret") || "";
  const bearerOk = req.headers.get("authorization") === `Bearer ${secret}`;
  if (given !== secret && !bearerOk) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const trigger = req.nextUrl.searchParams.get("trigger") || (bearerOk ? "vercel-cron" : "unknown");
  const now = Date.now();

  // Schedule: LIVE from GitHub first; bundle only as a fallback so a
  // GitHub API blip degrades to yesterday's behavior, not to silence.
  let schedule: ScheduleRow[] = [];
  let source = "github-live";
  if (ghToken) {
    const raw = await ghGetRaw("app/private/data/ema-prompt-schedule.json", ghToken);
    if (raw) { try { schedule = JSON.parse(raw) as ScheduleRow[]; } catch { /* fall through */ } }
  }
  if (schedule.length === 0) {
    schedule = await readBundled<ScheduleRow[]>("ema-prompt-schedule.json", []);
    source = "bundle-fallback";
  }

  // Opt-out registry: a participant who texted STOP never gets a text,
  // even off a stale schedule. Live read first, bundled copy as fallback,
  // keys starting with "_" are documentation.
  let optOutRaw: Record<string, unknown> = {};
  const optLive = ghToken ? await ghGetRaw("app/private/data/opt-outs.json", ghToken) : null;
  if (optLive) { try { optOutRaw = JSON.parse(optLive); } catch { /* fall through */ } }
  if (Object.keys(optOutRaw).length === 0) {
    optOutRaw = await readBundled<Record<string, unknown>>("opt-outs.json", {});
  }
  const optedOut = new Set(Object.keys(optOutRaw).filter(k => !k.startsWith("_")));

  // HARD RULES carried from every sender before this one:
  //  - cohort 1000-1999 never gets EMA texts, no matter what the
  //    schedule file says;
  //  - opted-out pids never get any text.
  const eligible = schedule.filter(r => {
    const n = Number(String(r.pid).replace(/\D/g, ""));
    if (n >= 1000 && n <= 1999) return false;
    if (optedOut.has(String(r.pid))) return false;
    return true;
  });
  const due = eligible.filter(r => {
    const t = new Date(r.sendAt).getTime();
    return !isNaN(t) && now - t >= 0 && now - t <= GRACE_MS;
  });
  // Past grace (protocol skip) but within 24h: mark skipped_late so the
  // ledger stays truthful with no other process involved.
  const expired = eligible.filter(r => {
    const t = new Date(r.sendAt).getTime();
    return !isNaN(t) && now - t > GRACE_MS && now - t <= 24 * 60 * 60 * 1000;
  });

  const report = {
    armed: true, trigger, source, at: new Date(now).toISOString(),
    scheduleRows: schedule.length, due: due.length,
    alreadyDone: 0, alreadyDelivered: 0, sent: [] as string[],
    markedLate: [] as string[],
    unverifiable: 0, skippedBadRow: 0, ledgerWritten: false,
    errors: [] as string[],
  };
  if (due.length === 0 && expired.length === 0) return NextResponse.json(report);

  // Ledger: live read for terminal-state dedup.
  let ledger: LedgerRow[] = [];
  let ledgerSha = "";
  if (ghToken) {
    const led = await ghGetJsonWithSha("app/private/data/ema-sent-log.json", ghToken);
    if (led) { ledger = led.data as LedgerRow[]; ledgerSha = led.sha; }
  }
  if (!ledgerSha) ledger = await readBundled<LedgerRow[]>("ema-sent-log.json", []);
  const done = new Set(ledger.filter(e => TERMINAL.has(e.status) && !e.dryRun).map(e => e.key));

  const newRows: LedgerRow[] = [];
  for (const row of expired) {
    const k = `${row.pid}|${row.wave}|${row.key}`;
    if (done.has(k)) continue;
    report.markedLate.push(k);
    newRows.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "skipped_late",
      channel: "sms", recipient: String(row.phone || ""), sendAt: row.sendAt, at: new Date().toISOString(),
      note: "vercel-sender: past 30-min grace, protocol skip" });
    done.add(k);
  }

  const tmpl = await promptTemplate();
  const parts = await readBundled<{ participants: Array<{ pid: string; contact?: { firstName?: string } }> }>(
    "participants.json", { participants: [] });
  const nameByPid = Object.fromEntries(parts.participants.map(p => [p.pid, p.contact?.firstName || ""]));

  const pnId = due.length > 0 ? await phoneNumberId(apiKey, fromNumber) : null;
  if (due.length > 0 && !pnId) {
    report.errors.push("could not resolve phoneNumberId — fail closed, nothing sent");
  }

  if (due.length > 0 && !tmpl) {
    // Template extraction broke (timeline.ts moved?). Loud error, no
    // skip rows — the prompts stay retryable every minute until grace.
    report.errors.push("EMA prompt template (alert 64) not found in timeline.ts — nothing sent");
  }

  for (const row of due) {
    if (!pnId || !tmpl) break;
    const k = `${row.pid}|${row.wave}|${row.key}`;
    if (done.has(k)) { report.alreadyDone++; continue; }
    if (sentThisInstance.has(k)) { report.alreadyDone++; continue; }
    const phone = normalizePhone(row.phone);
    const link = row.surveyLink;
    if (!phone || !link) {
      // Bad data is terminal (same as every sender before): record it so
      // the audit sees it instead of a silent minute-by-minute retry.
      report.skippedBadRow++;
      newRows.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "skipped",
        error: !phone ? `bad phone "${row.phone}"` : "no survey link", sendAt: row.sendAt,
        at: new Date().toISOString(), note: "vercel-sender" });
      done.add(k);
      continue;
    }
    const sendAtMs = new Date(row.sendAt).getTime();
    try {
      // Carrier history is the shared source of truth across every
      // sender past and present. If the check itself errors: with a LIVE
      // ledger just read (seconds fresh) we are the protocol-authoritative
      // primary inside grace, so we fail OPEN and send — a lost prompt is
      // worse than the vanishing double-send case. Without a live ledger
      // (bundle fallback, could be stale) we fail CLOSED and retry next
      // minute.
      const delivered = await alreadyDelivered(apiKey, pnId, phone, link, sendAtMs);
      if (delivered === null && !ledgerSha) { report.unverifiable++; continue; }
      if (delivered) {
        report.alreadyDelivered++;
        newRows.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "already_delivered",
          channel: "sms", recipient: phone, sendAt: row.sendAt, at: new Date().toISOString(),
          note: "confirmed by vercel-sender via carrier history" });
        done.add(k);
        continue;
      }
      const firstName = row.firstName || nameByPid[row.pid] || "";
      await sendSMS(apiKey, fromNumber, phone, renderPrompt(tmpl, firstName, link));
      sentThisInstance.add(k);
      const latencySec = Math.round((Date.now() - sendAtMs) / 1000);
      report.sent.push(k);
      newRows.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "sent",
        channel: "sms", recipient: phone, sendAt: row.sendAt, at: new Date().toISOString(),
        latencySec, note: "vercel-sender" });
      done.add(k);
      console.log(`ema-sender [${trigger}]: SENT ${k} (${latencySec}s after slot)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.errors.push(`${k}: ${msg}`);
      // "failed" is NOT terminal — the next minute tick retries until
      // the 30-min grace runs out (same rule as before).
      newRows.push({ key: k, pid: row.pid, wave: row.wave, promptKey: row.key, status: "failed",
        error: msg.slice(0, 300), sendAt: row.sendAt, at: new Date().toISOString(), note: "vercel-sender" });
    }
  }

  // Ledger write-back with sha retry (3 attempts, union-safe).
  if (newRows.length > 0 && ghToken) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const led = await ghGetJsonWithSha("app/private/data/ema-sent-log.json", ghToken);
      if (!led) break;
      const cur = led.data as LedgerRow[];
      const have = new Set(cur.map(e => `${e.key}|${e.status}`));
      const fresh = newRows.filter(r => !have.has(`${r.key}|${r.status}`));
      if (fresh.length === 0) { report.ledgerWritten = true; break; }
      const ok = await ghPutJson("app/private/data/ema-sent-log.json", ghToken,
        [...cur, ...fresh], led.sha, `vercel-sender ledger [${new Date().toISOString()}]`);
      if (ok) { report.ledgerWritten = true; break; }
    }
    if (!report.ledgerWritten) report.errors.push("ledger write failed after 3 attempts (sends are still carrier-deduped)");
  }

  console.log(`ema-sender [${trigger}]: source=${source} due=${report.due} done=${report.alreadyDone} sent=${report.sent.length} carrierDup=${report.alreadyDelivered} late=${report.markedLate.length} unverifiable=${report.unverifiable} ledger=${report.ledgerWritten}`);
  return NextResponse.json(report);
}
