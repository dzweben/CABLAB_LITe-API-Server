import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

// DATA REFRESH ON VERCEL — Phase 2 of the migration.
//
// Strategy: run the EXISTING app/scripts/fetch-data.mjs byte-for-byte
// unchanged (it is pure Node — builtins only, no git, no deps) inside a
// /tmp sandbox: mirror the live private/data files from the GitHub
// contents API into the sandbox, spawn the script exactly as GitHub
// Actions does, then compare what it wrote against what came in. All
// 48 mapped pipeline rules are preserved by construction, because the
// code that implements them is identical.
//
// MODES:
//   ?mode=shadow (default, and the only mode until the Phase 2 gate
//   passes): run + diff + report. Writes NOTHING back. This is the
//   side-by-side verification leg that runs against GitHub's refresh
//   for a full day before any cutover.
//
// Auth: same shared secret as the EMA sender. Deliberately NOT on a
// Vercel cron yet — shadow runs are triggered manually/scripted.

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const REPO = "dzweben/CABLAB_LITe-API-Server";
const DATA_DIR_REPO = "app/private/data";
const CHILD_TIMEOUT_MS = 700_000;

async function ghJson(pathname: string, token: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${pathname}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${pathname}`);
  return res.json();
}
async function ghRaw(pathname: string, token: string): Promise<Buffer> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${pathname}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw" },
    signal: AbortSignal.timeout(120_000), cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub raw ${res.status} for ${pathname}`);
  return Buffer.from(await res.arrayBuffer());
}
const sha1 = (b: Buffer) => crypto.createHash("sha1").update(b).digest("hex");

function topLevelCount(buf: Buffer): number | null {
  try {
    const d = JSON.parse(buf.toString());
    if (Array.isArray(d)) return d.length;
    if (d && typeof d === "object") {
      const o = d as Record<string, unknown>;
      if (Array.isArray(o.participants)) return (o.participants as unknown[]).length;
      if (Array.isArray(o.reminders)) return (o.reminders as unknown[]).length;
      return Object.keys(o).length;
    }
    return null;
  } catch { return null; }
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }

async function run(req: NextRequest) {
  const secret = process.env.EMA_SWEEP_SECRET || "";
  const ghToken = process.env.GITHUB_DATA_TOKEN || "";
  const given = req.headers.get("x-sweep-secret") || req.nextUrl.searchParams.get("secret") || "";
  const bearerOk = req.headers.get("authorization") === `Bearer ${secret}`;
  if (!secret || (given !== secret && !bearerOk)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const mode = req.nextUrl.searchParams.get("mode") || "shadow";
  if (mode !== "shadow") {
    return NextResponse.json({ error: "only mode=shadow exists until the Phase 2 gate passes" }, { status: 400 });
  }
  if (!ghToken) return NextResponse.json({ error: "GITHUB_DATA_TOKEN missing" }, { status: 503 });
  try {
    return await shadowRun(ghToken);
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`refresh-shadow FAILED: ${msg}`);
    return NextResponse.json({ error: msg.slice(0, 400) }, { status: 500 });
  }
}

async function shadowRun(ghToken: string) {
  const mode = "shadow";
  const started = Date.now();
  const ws = path.join("/tmp", `refresh-${started}`);
  const wsScripts = path.join(ws, "scripts");
  const wsData = path.join(ws, "private", "data");
  await fs.mkdir(wsScripts, { recursive: true });
  await fs.mkdir(wsData, { recursive: true });

  // The script itself ships in this function's bundle.
  const script = await fs.readFile(path.join(process.cwd(), "scripts", "fetch-data.mjs"));
  await fs.writeFile(path.join(wsScripts, "fetch-data.mjs"), script);

  const mem = (label: string) => {
    const m = process.memoryUsage();
    console.log(`refresh-shadow MEM [${label}]: rss=${Math.round(m.rss / 1e6)}MB heap=${Math.round(m.heapUsed / 1e6)}MB`);
  };
  mem("start");
  // Ground truth on what memory this container ACTUALLY has (config
  // claims are not trusted after two silent OOM kills).
  let limitMB = 0;
  for (const p of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const v = (await fs.readFile(p, "utf-8")).trim();
      if (v && v !== "max") { limitMB = Math.round(Number(v) / 1e6); break; }
    } catch { /* next path */ }
  }
  console.log(`refresh-shadow: container memory limit = ${limitMB || "unknown"}MB`);
  // Mirror the LIVE data directory (not the bundle — the bundle can be
  // hours old) so the run starts from exactly what GitHub's leg would.
  console.log("refresh-shadow: mirroring live data dir");
  const listing = (await ghJson(DATA_DIR_REPO, ghToken)) as Array<{ name: string; type: string }>;
  const before = new Map<string, { hash: string; bytes: number; count: number | null }>();
  await Promise.all(listing.filter(f => f.type === "file" && f.name.endsWith(".json")).map(async f => {
    const buf = await ghRaw(`${DATA_DIR_REPO}/${f.name}`, ghToken);
    await fs.writeFile(path.join(wsData, f.name), buf);
    // Counts only for small files at mirror time — parsing the 9MB
    // participants.json here (13 files in parallel) spikes the heap for
    // a purely cosmetic report field.
    before.set(f.name, { hash: sha1(buf), bytes: buf.length, count: buf.length < 2_000_000 ? topLevelCount(buf) : null });
  }));
  mem("post-mirror");
  console.log(`refresh-shadow: mirrored ${before.size} files, spawning pipeline (node=${process.execPath})`);

  // Run the pipeline exactly as refresh-data.yml does (same entrypoint,
  // same env names; heap capped under the function's memory).
  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH || "",
    REDCAP_API_URL: process.env.REDCAP_API_URL || "",
    REDCAP_LITE_TOKEN: process.env.REDCAP_LITE_TOKEN || "",
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
    LITE_GOOGLE_SHEET_ID: process.env.LITE_GOOGLE_SHEET_ID || "",
  };
  // Child heap sized from the MEASURED container limit, leaving ~700MB
  // for the parent, buffers, and non-heap child memory. (V8's own
  // auto-size picked ~1.1GB and starved; an over-promise invites the
  // cgroup OOM killer — this threads between the two.)
  const childHeapMB = limitMB ? Math.max(1200, limitMB - 700) : 1900;
  console.log(`refresh-shadow: child max-old-space-size=${childHeapMB}MB`);
  const child = spawn(process.execPath, [`--max-old-space-size=${childHeapMB}`, "scripts/fetch-data.mjs"], {
    cwd: ws, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  const memTimer = setInterval(() => mem("child-running"), 15_000);
  let out = "", err = "";
  child.stdout.on("data", (d: Buffer) => { out = (out + d.toString()).slice(-6000); });
  child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-6000); });
  const exitCode: number | null = await new Promise(resolve => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(-1); }, CHILD_TIMEOUT_MS);
    // Without this handler a spawn failure (ENOENT etc.) is an
    // unhandled 'error' event and kills the whole function.
    child.on("error", e => { clearTimeout(t); err += `spawn error: ${e.message}`; resolve(-2); });
    child.on("close", code => { clearTimeout(t); resolve(code); });
  });
  clearInterval(memTimer);
  mem("child-exited");
  console.log(`refresh-shadow: pipeline exited ${exitCode} after ${Math.round((Date.now() - started) / 1000)}s`);

  // Diff: what the identical code produced from the identical inputs.
  const changed: Array<Record<string, unknown>> = [];
  const unchanged: string[] = [];
  const produced = await fs.readdir(wsData);
  for (const name of produced.filter(n => n.endsWith(".json")).sort()) {
    const buf = await fs.readFile(path.join(wsData, name));
    const prev = before.get(name);
    if (prev && prev.hash === sha1(buf)) { unchanged.push(name); continue; }
    changed.push({
      file: name, new: !prev,
      beforeBytes: prev?.bytes ?? 0, afterBytes: buf.length,
      beforeCount: prev?.count ?? null, afterCount: topLevelCount(buf),
    });
  }
  await fs.rm(ws, { recursive: true, force: true }).catch(() => {});

  const report = {
    mode, exitCode, durationMs: Date.now() - started,
    containerMemMB: limitMB, childHeapMB,
    inputFiles: before.size, changed, unchanged,
    stdoutTail: out.slice(-2500), stderrTail: err.slice(-2500),
  };
  console.log(`refresh-shadow: exit=${exitCode} ${Math.round(report.durationMs / 1000)}s changed=${changed.map(c => c.file).join(",")}`);
  return NextResponse.json(report);
}
