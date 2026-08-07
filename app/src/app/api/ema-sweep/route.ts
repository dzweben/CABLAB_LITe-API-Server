import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// EMA sweeper — the off-GitHub redundancy leg for prompt delivery.
//
// Runs on Vercel (independent infrastructure from GitHub Actions). Any
// trigger may hit it — Vercel cron, the lab Mac's launchd timer, the
// refresh workflow's ping — as often as it likes; the route is
// idempotent by construction:
//
//   1. Only prompts 10–30 minutes past their slot are considered. The
//      precision sender owns 0–10 min (it normally delivers within
//      seconds); >30 min is a protocol skip ("if 30 minutes has passed,
//      skip") and the sweeper respects it the same as the primary.
//   2. Before sending, it checks OpenPhone's OWN message history for an
//      outbound message to that participant carrying this prompt's
//      survey link since the slot opened. The carrier is the shared
//      source of truth across ALL senders, so a prompt delivered by the
//      primary — or by a previous sweep — is never sent twice.
//   3. If the history check fails for any reason, it does NOT send
//      (fail closed). A missed backstop beats a duplicate text.
//
// The sweeper cannot write the git ledger (no repo credentials on
// Vercel, deliberately). Its sends surface through the primary sender's
// own carrier check (ledgered as already_delivered) and through the
// daily audit's carrier reconciliation.
//
// Auth: x-sweep-secret header (or ?secret=) must match EMA_SWEEP_SECRET.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LATE_MS = 10 * 60 * 1000;
const GRACE_MS = 30 * 60 * 1000;
const QUO_BASE = "https://api.openphone.com/v1";

interface ScheduleRow {
  pid: string; wave: number | string; key: string;
  sendAt: string; phone: string; surveyLink: string | null;
  dayLabel?: string; timeLabel?: string;
}

function normalizePhone(s: unknown): string | null {
  let d = String(s || "").replace(/\D/g, "");
  if (d.length === 10) d = "1" + d;
  return d.length === 11 && d.startsWith("1") ? "+" + d : null;
}

async function readData<T>(rel: string, fallback: T): Promise<T> {
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

// Resolve our sending number's OpenPhone ID once per instance (the
// list-messages endpoint filters by phoneNumberId, not raw number).
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
  // Single-number workspaces: fall back to the only entry.
  if ((body?.data || []).length === 1) { cachedPhoneNumberId = String(body!.data![0].id); return cachedPhoneNumberId; }
  return null;
}

// Carrier-history check: has ANY outbound message carrying this survey
// link gone to this participant since just before the slot?
// Returns: true = delivered, false = definitely not delivered,
// null = couldn't verify (FAIL CLOSED — do not send).
async function alreadyDelivered(
  apiKey: string, pnId: string, phone: string, link: string, sendAtMs: number,
): Promise<boolean | null> {
  const createdAfter = new Date(sendAtMs - 2 * 60 * 1000).toISOString();
  const params = new URLSearchParams({ phoneNumberId: pnId, maxResults: "20", createdAfter });
  params.append("participants[]", phone);
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

export async function GET(req: NextRequest) { return sweep(req); }
export async function POST(req: NextRequest) { return sweep(req); }

async function sweep(req: NextRequest) {
  const secret = process.env.EMA_SWEEP_SECRET || "";
  const apiKey = process.env.QUO_API_KEY || "";
  const fromNumber = process.env.QUO_FROM_NUMBER || "";
  if (!secret || !apiKey || !fromNumber) {
    return NextResponse.json({ armed: false, reason: "sweeper env not provisioned" }, { status: 503 });
  }
  const given = req.headers.get("x-sweep-secret") || req.nextUrl.searchParams.get("secret") || "";
  if (given !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const trigger = req.nextUrl.searchParams.get("trigger") || "unknown";
  const now = Date.now();
  const schedule = await readData<ScheduleRow[]>("ema-prompt-schedule.json", []);
  const late = schedule.filter(r => {
    const t = new Date(r.sendAt).getTime();
    return !isNaN(t) && now - t >= LATE_MS && now - t <= GRACE_MS;
  });

  const report = {
    armed: true, trigger, at: new Date(now).toISOString(),
    scheduleRows: schedule.length, inSweepWindow: late.length,
    alreadyDelivered: 0, sent: [] as string[], unverifiable: 0, skippedBadRow: 0,
    errors: [] as string[],
  };
  if (late.length === 0) return NextResponse.json(report);

  const tmpl = await promptTemplate();
  const parts = await readData<{ participants: Array<{ pid: string; contact?: { firstName?: string } }> }>(
    "participants.json", { participants: [] });
  const nameByPid = Object.fromEntries(parts.participants.map(p => [p.pid, p.contact?.firstName || ""]));

  const pnId = await phoneNumberId(apiKey, fromNumber);
  if (!pnId) {
    report.errors.push("could not resolve phoneNumberId — fail closed, nothing sent");
    return NextResponse.json(report, { status: 502 });
  }

  for (const row of late) {
    const phone = normalizePhone(row.phone);
    const link = row.surveyLink;
    if (!phone || !link || !tmpl) { report.skippedBadRow++; continue; }
    try {
      const delivered = await alreadyDelivered(apiKey, pnId, phone, link, new Date(row.sendAt).getTime());
      if (delivered === null) { report.unverifiable++; continue; }  // fail closed
      if (delivered) { report.alreadyDelivered++; continue; }
      const res = await quo("/messages", apiKey, {
        method: "POST",
        body: JSON.stringify({ content: renderPrompt(tmpl, nameByPid[row.pid], link), from: fromNumber, to: [phone] }),
      });
      if (!res.ok) throw new Error(`OpenPhone ${res.status}`);
      report.sent.push(`${row.pid}|${row.wave}|${row.key}`);
      console.log(`ema-sweep [${trigger}]: RESCUED ${row.pid} ${row.key} (${Math.round((now - new Date(row.sendAt).getTime()) / 60000)} min late)`);
    } catch (e) {
      report.errors.push(`${row.pid}|${row.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`ema-sweep [${trigger}]: window=${report.inSweepWindow} delivered=${report.alreadyDelivered} rescued=${report.sent.length} unverifiable=${report.unverifiable}`);
  return NextResponse.json(report);
}
