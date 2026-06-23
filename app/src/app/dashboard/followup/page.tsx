"use client";

import React, { useEffect, useState, useMemo } from "react";
import type { Participant, WaveYear, SentLogEntry } from "@/types";
import { WAVE_YEARS, WAVE_LABELS, pidSort, formatDate, formatDateTime } from "@/lib/lite-utils";
import { useCohort, cohortMatches } from "@/lib/cohort";
import CohortFilter from "@/components/CohortFilter";

// Mirrors the Follow up.{N} Google Sheet the team has been maintaining
// for years. Rows match the sheet 1:1 so coordinators see the same
// shape they're used to.

export default function FollowupPage() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [sent, setSent] = useState<SentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [wave, setWave] = useState<WaveYear>(1);
  const [statusFilter, setStatusFilter] = useState<"all" | "outstanding" | "v2_done" | "v1_only">("all");
  const [search, setSearch] = useState("");
  const [expandedPid, setExpandedPid] = useState<string | null>(null);
  const [cohort] = useCohort();

  useEffect(() => {
    Promise.all([
      fetch("/api/data/participants").then(r => r.json()),
      fetch("/api/data/sent-log").then(r => r.ok ? r.json() : []),
    ]).then(([p, s]) => {
      setParticipants((p.participants || []).slice().sort(pidSort));
      setSent(Array.isArray(s) ? s : []);
    }).finally(() => setLoading(false));
  }, []);

  const sentByPidAlert = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of sent) {
      if (e.status !== "sent") continue;
      const k = `${e.pid}|${e.alertId}`;
      m[k] = (m[k] || 0) + 1;
    }
    return m;
  }, [sent]);

  const rows = useMemo(() => {
    let xs = participants.filter(p => p.waves[wave] && cohortMatches(p.pid, cohort));
    if (statusFilter === "v2_done") {
      xs = xs.filter(p => p.waves[wave]?.v2?.allComplete);
    } else if (statusFilter === "v1_only") {
      xs = xs.filter(p => p.waves[wave]?.v1?.allComplete && !p.waves[wave]?.v2?.allComplete);
    } else if (statusFilter === "outstanding") {
      xs = xs.filter(p => !p.waves[wave]?.v2?.allComplete);
    }
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(p => p.pid.toLowerCase().includes(s));
    }
    return xs;
  }, [participants, wave, statusFilter, search, cohort]);

  const stats = useMemo(() => {
    const scoped = participants.filter(p => cohortMatches(p.pid, cohort));
    const inWave = scoped.filter(p => p.waves[wave]).length;
    const v1Done = scoped.filter(p => p.waves[wave]?.v1?.allComplete).length;
    const v2Done = scoped.filter(p => p.waves[wave]?.v2?.allComplete).length;
    const fromSheet = scoped.filter(p => p.waves[wave]?.followupSheet).length;
    return { inWave, v1Done, v2Done, fromSheet };
  }, [participants, wave, cohort]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Follow-up Tracker</h2>
          <p className="text-sm text-gray-500 mt-1">
            V1 → V2 lifecycle plus the team-maintained STS / EMA send log
            from the <code className="text-xs px-1 py-0.5 bg-gray-100 rounded">Follow&nbsp;up.{wave}</code> Google Sheet.
          </p>
        </div>
        <CohortFilter />
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="In this wave" value={stats.inWave} />
        <Stat label="V1 complete" value={stats.v1Done} suffix={`/${stats.inWave}`} color="emerald" />
        <Stat label="V2 complete" value={stats.v2Done} suffix={`/${stats.inWave}`} color="indigo" />
        <Stat label="In follow-up sheet" value={stats.fromSheet} suffix={`/${stats.inWave}`} color="amber" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {WAVE_YEARS.map(w => (
            <button
              key={w}
              onClick={() => setWave(w)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md ${
                wave === w ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {WAVE_LABELS[w]}
            </button>
          ))}
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as "all" | "outstanding" | "v2_done" | "v1_only")}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">All statuses</option>
          <option value="outstanding">V2 not done yet</option>
          <option value="v1_only">V1 done, V2 not</option>
          <option value="v2_done">V2 complete</option>
        </select>
        <input
          type="text"
          placeholder="Search PID or name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <span className="text-sm text-gray-500 ml-auto">{rows.length} shown</span>
      </div>

      {loading ? <p className="text-gray-500 text-sm">Loading…</p> : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                  <th className="text-left px-4 py-3 font-semibold sticky left-0 bg-gray-50">PID</th>
                  <th className="text-left px-4 py-3 font-semibold">Name</th>
                  <th className="text-center px-3 py-3 font-semibold">V1</th>
                  <th className="text-center px-3 py-3 font-semibold">V2</th>
                  <th colSpan={6} className="text-center px-2 py-3 font-semibold border-l border-gray-200">STS1 sends</th>
                  <th colSpan={3} className="text-center px-2 py-3 font-semibold border-l border-gray-200">STS2 sends</th>
                  <th className="text-center px-3 py-3 font-semibold border-l border-gray-200">EMA</th>
                  <th className="px-2 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={14} className="py-10 text-center text-gray-400">No participants match.</td></tr>
                )}
                {rows.map(p => {
                  const w = p.waves[wave]!;
                  const sheet = w.followupSheet;
                  const expanded = expandedPid === p.pid;
                  return (
                    <React.Fragment key={p.pid}>
                      <tr
                        className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${expanded ? "bg-indigo-50/40" : ""}`}
                        onClick={() => setExpandedPid(expanded ? null : p.pid)}
                      >
                        <td className="px-4 py-2.5 font-mono font-medium sticky left-0 bg-white">{p.pid}</td>
                        <td className="px-4 py-2.5 text-gray-700 truncate max-w-[180px]">{p.contact.firstName} {p.contact.lastName}</td>
                        <td className="px-3 py-2.5 text-center">
                          {w.v1?.allComplete ? <Check /> : <Dash />}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {w.v2?.allComplete
                            ? <CheckWith label={String(sheet?.v2Date || w.v2?.date || "")} />
                            : <Dash />}
                        </td>
                        {/* STS1 6 cells */}
                        {Array.from({ length: 6 }).map((_, i) => (
                          <td key={`s1${i}`} className={`px-2 py-2.5 text-center text-xs ${i === 0 ? "border-l border-gray-200" : ""}`}>
                            <STSMonthCell month={sheet?.sts1Months?.[i]} complete={w.sts1?.cycles[i]?.complete === 2} />
                          </td>
                        ))}
                        {/* STS2 3 cells */}
                        {Array.from({ length: 3 }).map((_, i) => (
                          <td key={`s2${i}`} className={`px-2 py-2.5 text-center text-xs ${i === 0 ? "border-l border-gray-200" : ""}`}>
                            <STSMonthCell month={sheet?.sts2Months?.[i]} complete={w.sts2?.cycles[i]?.complete === 2} />
                          </td>
                        ))}
                        <td className="px-3 py-2.5 text-center border-l border-gray-200">
                          <EMAStatusCell status={sheet?.emaStatus} date={sheet?.emaDate} />
                        </td>
                        <td className="px-2 py-2.5 text-right text-gray-400 text-xs">{expanded ? "▲" : "▼"}</td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={14} className="bg-gray-50 px-6 py-4 border-b border-gray-200">
                            <DetailPane p={p} wave={wave} sent={sent} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, suffix, color = "gray" }: { label: string; value: number; suffix?: string; color?: "emerald" | "indigo" | "amber" | "gray" }) {
  const cmap = {
    emerald: "text-emerald-600",
    indigo: "text-indigo-600",
    amber: "text-amber-600",
    gray: "text-gray-900",
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold ${cmap[color]} mt-1 tabular-nums`}>
        {value}<span className="text-base text-gray-400 font-medium">{suffix || ""}</span>
      </p>
    </div>
  );
}

function Check() {
  return <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs">✓</span>;
}
function Dash() {
  return <span className="text-gray-300">—</span>;
}
function CheckWith({ label }: { label: string }) {
  return (
    <div className="inline-flex flex-col items-center gap-0.5">
      <Check />
      {label && <span className="text-[10px] text-emerald-700 font-mono">{label.slice(0, 10)}</span>}
    </div>
  );
}

function STSMonthCell({ month, complete }: { month: string | number | null | undefined; complete: boolean }) {
  const hasMonth = month != null && String(month).trim() !== "";
  if (!hasMonth) return <span className="text-gray-300">·</span>;
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded ${
        complete ? "bg-emerald-500 text-white" : "bg-amber-100 text-amber-800"
      }`}
      title={complete ? "Complete in REDCap" : "Sent, awaiting completion"}
    >
      {String(month).trim()}
    </span>
  );
}

function EMAStatusCell({ status, date }: { status: string | null | undefined; date: string | number | null | undefined }) {
  if (!status && !date) return <span className="text-gray-300">—</span>;
  const s = String(status || "").toUpperCase();
  const ok = s.includes("COMPLETE");
  return (
    <div className="inline-flex flex-col items-center gap-0.5">
      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
        ok ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
      }`}>{s || "Pending"}</span>
      {date && <span className="text-[10px] font-mono text-gray-500">{String(date).slice(0, 10)}</span>}
    </div>
  );
}

function DetailPane({ p, wave, sent }: { p: Participant; wave: WaveYear; sent: SentLogEntry[] }) {
  const w = p.waves[wave]!;
  const sheet = w.followupSheet;
  const mine = sent.filter(e => e.pid === p.pid).slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 text-sm">
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Contact</h4>
        <dl className="space-y-1">
          <KV label="Parent" value={p.contact.parentName} />
          <KV label="Email" value={p.contact.email} />
          <KV label="Parent phone" value={p.contact.phonePrimary} />
          <KV label="Child phone" value={p.contact.childPhone} />
          {sheet?.raTag && <KV label="RA tag" value={sheet.raTag} />}
          {sheet?.notes && <KV label="Notes" value={String(sheet.notes)} />}
        </dl>
      </div>
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">{WAVE_LABELS[wave]} timeline</h4>
        <dl className="space-y-1">
          <KV label="V1 in-lab" value={w.v1?.date || (w.v1?.allComplete ? "Done (per sheet)" : "—")} />
          <KV label="At-home start" value={w.atHome?.timestamp ? formatDateTime(w.atHome.timestamp) : "—"} />
          <KV label="At-home complete" value={w.atHome?.athomeMeasuresComplete === 2 ? "✓" : "—"} />
          <KV label="V2 in-lab" value={sheet?.v2Date ? String(sheet.v2Date) : (w.v2?.date ? formatDate(w.v2.date) : "—")} />
          {sheet?.w1Comp && <KV label="W1 compensation" value={String(sheet.w1Comp)} />}
          {sheet?.w2Comp && <KV label="W2 compensation" value={String(sheet.w2Comp)} />}
        </dl>
      </div>
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Send history ({mine.length})</h4>
        {mine.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing sent yet.</p>
        ) : (
          <ul className="space-y-1 max-h-48 overflow-y-auto">
            {mine.slice(0, 30).map((e, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-gray-500 w-24 truncate">{formatDateTime(e.timestamp)}</span>
                <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                  e.status === "sent" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                }`}>{e.status}</span>
                <span className="text-gray-700 truncate">[{e.channel}] {e.instrument}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-3 text-gray-700">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-mono text-xs text-right break-all">{value || "—"}</dd>
    </div>
  );
}
