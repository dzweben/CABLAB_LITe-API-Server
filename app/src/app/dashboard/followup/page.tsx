"use client";

import React, { useEffect, useState, useMemo } from "react";
import type { Participant, WaveYear, SentLogEntry } from "@/types";
import { WAVE_YEARS, WAVE_LABELS, pidSort, formatDate, formatDateTime } from "@/lib/lite-utils";

// Follow-up tracker: focuses on the V1→at-home→V2 timeline that the
// session-notes Excel tracks across waves. Surfaces what reminders went
// out and what's still outstanding.

export default function FollowupPage() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [sent, setSent] = useState<SentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [wave, setWave] = useState<WaveYear>(1);
  const [statusFilter, setStatusFilter] = useState<"all" | "outstanding" | "complete">("all");
  const [search, setSearch] = useState("");
  const [expandedPid, setExpandedPid] = useState<string | null>(null);

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
    let xs = participants.filter(p => p.waves[wave]);
    if (statusFilter !== "all") {
      xs = xs.filter(p => {
        const w = p.waves[wave]!;
        const allDone = w.v1?.allComplete && w.atHome?.athomeMeasuresComplete === 2 && w.v2?.allComplete;
        if (statusFilter === "complete") return allDone;
        return !allDone;
      });
    }
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(p => p.pid.toLowerCase().includes(s));
    }
    return xs;
  }, [participants, wave, statusFilter, search]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Follow-up Tracker</h2>
        <p className="text-sm text-gray-500 mt-1">
          V1 → at-home survey → V2 lifecycle, with the message-history count for each step.
        </p>
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
          onChange={e => setStatusFilter(e.target.value as "all" | "outstanding" | "complete")}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">All statuses</option>
          <option value="outstanding">Outstanding only</option>
          <option value="complete">Fully done</option>
        </select>
        <input
          type="text"
          placeholder="PID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <span className="text-sm text-gray-500 ml-auto">{rows.length} shown</span>
      </div>

      {loading ? <p className="text-gray-500 text-sm">Loading…</p> : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                <th className="text-left px-4 py-3 font-semibold">PID</th>
                <th className="text-left px-4 py-3 font-semibold">V1</th>
                <th className="text-left px-4 py-3 font-semibold">At-home start</th>
                <th className="text-center px-4 py-3 font-semibold">At-home complete</th>
                <th className="text-center px-4 py-3 font-semibold">At-home sends</th>
                <th className="text-left px-4 py-3 font-semibold">V2</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} className="py-10 text-center text-gray-400">No participants match.</td></tr>
              )}
              {rows.map(p => {
                const w = p.waves[wave]!;
                const expanded = expandedPid === p.pid;
                const athomeSends = (sentByPidAlert[`${p.pid}|60`] || 0) + (sentByPidAlert[`${p.pid}|61`] || 0);
                return (
                  <React.Fragment key={p.pid}>
                    <tr
                      className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${expanded ? "bg-indigo-50/40" : ""}`}
                      onClick={() => setExpandedPid(expanded ? null : p.pid)}
                    >
                      <td className="px-4 py-3 font-mono font-medium">{p.pid}</td>
                      <td className="px-4 py-3 text-gray-700">{w.v1?.date ? formatDate(w.v1.date) : "—"}</td>
                      <td className="px-4 py-3 text-gray-700">{w.atHome?.timestamp ? formatDateTime(w.atHome.timestamp) : "—"}</td>
                      <td className="px-4 py-3 text-center">
                        {w.atHome?.athomeMeasuresComplete === 2
                          ? <span className="text-emerald-600">✓</span>
                          : <span className="text-gray-400">·</span>}
                      </td>
                      <td className="px-4 py-3 text-center font-mono">{athomeSends}</td>
                      <td className="px-4 py-3 text-gray-700">{w.v2?.date ? formatDate(w.v2.date) : "—"}</td>
                      <td className="px-4 py-3 text-right text-gray-400 text-xs">{expanded ? "▲" : "▼"}</td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={7} className="bg-gray-50 px-6 py-4 border-b border-gray-200">
                          <SendHistory pid={p.pid} sent={sent} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SendHistory({ pid, sent }: { pid: string; sent: SentLogEntry[] }) {
  const mine = sent.filter(e => e.pid === pid).slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (mine.length === 0) return <p className="text-sm text-gray-500">No messages sent to this participant yet.</p>;
  return (
    <div>
      <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Send history ({mine.length})</h4>
      <ul className="space-y-1">
        {mine.slice(0, 20).map((e, i) => (
          <li key={i} className="flex items-center gap-3 text-xs">
            <span className="font-mono text-gray-500 w-32">{formatDateTime(e.timestamp)}</span>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
              e.status === "sent" ? "bg-emerald-100 text-emerald-700" :
              e.status === "failed" ? "bg-red-100 text-red-700" :
              "bg-gray-100 text-gray-600"
            }`}>{e.status}</span>
            <span className="text-gray-700">[{e.channel}] {e.instrument}</span>
            <span className="text-gray-400 ml-auto truncate">{e.recipient}</span>
          </li>
        ))}
        {mine.length > 20 && <li className="text-xs text-gray-400">…{mine.length - 20} more</li>}
      </ul>
    </div>
  );
}
