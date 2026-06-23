"use client";

import { useEffect, useState, useMemo } from "react";
import { WAVE_LABELS, formatDateTime, relativeDate } from "@/lib/lite-utils";
import { useCohort, cohortMatches } from "@/lib/cohort";
import CohortFilter from "@/components/CohortFilter";

interface DueRow {
  pid: string;
  recordId: string;
  wave: 1 | 2 | 3;
  alertId: number;
  kind: string;
  emaKey?: string;
  instrument: string;
  scheduledAt: string;
  complete: boolean;
}

export default function RemindersPage() {
  const [due, setDue] = useState<DueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "today" | "next24" | "next7">("today");
  const [kindFilter, setKindFilter] = useState<"all" | "sts1" | "sts2" | "ema" | "athome">("all");
  const [cohort] = useCohort();

  useEffect(() => {
    fetch("/api/data/due-reminders").then(r => r.json()).then(d => {
      setDue(Array.isArray(d) ? d : []);
    }).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let xs = due.filter(d => cohortMatches(d.pid, cohort));
    const now = Date.now();
    if (scope === "today") {
      const end = new Date(); end.setHours(23, 59, 59, 999);
      xs = xs.filter(d => {
        const t = new Date(d.scheduledAt).getTime();
        return t >= now - 12 * 3600 * 1000 && t <= end.getTime();
      });
    } else if (scope === "next24") {
      xs = xs.filter(d => {
        const t = new Date(d.scheduledAt).getTime();
        return t >= now && t <= now + 24 * 3600 * 1000;
      });
    } else if (scope === "next7") {
      xs = xs.filter(d => {
        const t = new Date(d.scheduledAt).getTime();
        return t >= now && t <= now + 7 * 24 * 3600 * 1000;
      });
    }
    if (kindFilter !== "all") {
      xs = xs.filter(d => d.kind.startsWith(kindFilter));
    }
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(d => d.pid.toLowerCase().includes(s) || d.instrument.toLowerCase().includes(s));
    }
    return xs;
  }, [due, search, scope, kindFilter, cohort]);

  const byKind = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of filtered) m[d.kind] = (m[d.kind] || 0) + 1;
    return m;
  }, [filtered]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Outgoing Queue</h2>
          <p className="text-sm text-gray-500 mt-1">
            Reminders the next refresh cycle will send. Drawn from <code className="text-xs">private/data/due-reminders.json</code>.
          </p>
        </div>
        <CohortFilter />
      </div>

      {/* Kind summary chips */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(byKind).map(([k, n]) => (
          <span key={k} className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
            {k} · {n}
          </span>
        ))}
        {filtered.length === 0 && !loading && <span className="text-sm text-gray-400">Nothing in this window.</span>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {(["today", "next24", "next7", "all"] as const).map(s => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md ${
                scope === s ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {s === "today" ? "Today" : s === "next24" ? "Next 24h" : s === "next7" ? "Next 7 days" : "All upcoming"}
            </button>
          ))}
        </div>
        <select
          value={kindFilter}
          onChange={e => setKindFilter(e.target.value as "all" | "sts1" | "sts2" | "ema" | "athome")}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">All kinds</option>
          <option value="sts1">STS1</option>
          <option value="sts2">STS2</option>
          <option value="ema">EMA</option>
          <option value="athome">At-home</option>
        </select>
        <input
          type="text"
          placeholder="Search PID or instrument…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <span className="text-sm text-gray-500 ml-auto">{filtered.length} queued</span>
      </div>

      {loading ? <p className="text-gray-500 text-sm">Loading…</p> : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                  <th className="text-left px-4 py-3 font-semibold">When</th>
                  <th className="text-left px-4 py-3 font-semibold">PID</th>
                  <th className="text-left px-4 py-3 font-semibold">Wave</th>
                  <th className="text-left px-4 py-3 font-semibold">Instrument</th>
                  <th className="text-left px-4 py-3 font-semibold">Kind</th>
                  <th className="text-center px-4 py-3 font-semibold">Alert #</th>
                  <th className="text-center px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="py-10 text-center text-gray-400">Nothing queued.</td></tr>
                )}
                {filtered.map((d, i) => (
                  <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium">{relativeDate(d.scheduledAt)}</div>
                      <div className="text-xs text-gray-400">{formatDateTime(d.scheduledAt)}</div>
                    </td>
                    <td className="px-4 py-3 font-mono font-medium">{d.pid}</td>
                    <td className="px-4 py-3">{WAVE_LABELS[d.wave]}</td>
                    <td className="px-4 py-3 text-gray-700">{d.instrument}</td>
                    <td className="px-4 py-3 text-xs">
                      <span className="inline-flex px-2 py-0.5 rounded bg-indigo-50 text-indigo-700">{d.kind}</span>
                    </td>
                    <td className="px-4 py-3 text-center font-mono">{d.alertId}</td>
                    <td className="px-4 py-3 text-center">
                      {d.complete
                        ? <span className="text-emerald-600 text-xs">✓ already done</span>
                        : <span className="text-amber-600 text-xs">queued</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
