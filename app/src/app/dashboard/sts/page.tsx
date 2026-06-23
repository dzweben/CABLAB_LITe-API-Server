"use client";

import { useEffect, useState, useMemo } from "react";
import type { Participant, WaveYear } from "@/types";
import { WAVE_YEARS, WAVE_LABELS, pidSort, formatMonthShort, COMPLETION_LABELS } from "@/lib/lite-utils";
import { useCohort, cohortMatches } from "@/lib/cohort";
import CohortFilter from "@/components/CohortFilter";

type STSWhich = "sts1" | "sts2";

export default function STSPage() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [wave, setWave] = useState<WaveYear>(1);
  const [which, setWhich] = useState<STSWhich>("sts1");
  const [showOnlyActive, setShowOnlyActive] = useState(true);
  const [search, setSearch] = useState("");
  const [cohort] = useCohort();

  useEffect(() => {
    fetch("/api/data/participants").then(r => r.json()).then(d => {
      setParticipants((d.participants || []).slice().sort(pidSort));
    }).finally(() => setLoading(false));
  }, []);

  const cycleCount = which === "sts1" ? 6 : 3;
  const cycleLabel = which === "sts1" ? "STS1 (6 cycles)" : "STS2 (3 cycles)";

  const rows = useMemo(() => {
    let xs = participants.filter(p => p.waves[wave]?.[which] && cohortMatches(p.pid, cohort));
    if (showOnlyActive) xs = xs.filter(p => p.waves[wave]?.[which]?.active);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(p => p.pid.toLowerCase().includes(s));
    }
    return xs;
  }, [participants, wave, which, showOnlyActive, search, cohort]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Screen Time Surveys</h2>
          <p className="text-sm text-gray-500 mt-1">
            STS1 (6 cycles, ~weekly) and STS2 (3 cycles) for each active wave.
          </p>
        </div>
        <CohortFilter />
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
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {(["sts1", "sts2"] as STSWhich[]).map(k => (
            <button
              key={k}
              onClick={() => setWhich(k)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md ${
                which === k ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {k.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={showOnlyActive}
            onChange={e => setShowOnlyActive(e.target.checked)}
            className="rounded border-gray-300"
          />
          Active cycles only
        </label>
        <input
          type="text"
          placeholder="PID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <span className="text-sm text-gray-500 ml-auto">{rows.length} shown · {cycleLabel}</span>
      </div>

      {loading ? <p className="text-gray-500 text-sm">Loading…</p> : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                  <th className="text-left px-4 py-3 font-semibold">PID</th>
                  {Array.from({ length: cycleCount }).map((_, i) => (
                    <th key={i} className="text-center px-3 py-3 font-semibold">{which === "sts1" ? `1.${i + 1}` : `2.${i + 1}`}</th>
                  ))}
                  <th className="text-center px-4 py-3 font-semibold">Done</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={cycleCount + 2} className="py-10 text-center text-gray-400">No participants match.</td></tr>
                )}
                {rows.map(p => {
                  const sts = p.waves[wave]![which]!;
                  const done = sts.cycles.filter(c => c.complete === 2).length;
                  return (
                    <tr key={p.pid} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono font-medium">{p.pid}</td>
                      {sts.cycles.map(c => (
                        <td key={c.index} className="px-3 py-3 text-center">
                          <CycleCell complete={c.complete} date={c.date} link={c.surveyLink} />
                        </td>
                      ))}
                      <td className="px-4 py-3 text-center">
                        <span className="font-mono">{done}/{sts.cycles.length}</span>
                      </td>
                    </tr>
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

function CycleCell({ complete, date, link }: { complete: 0 | 1 | 2; date: string | null; link: string | null }) {
  const colorMap = {
    2: "bg-emerald-500 text-white",
    1: "bg-amber-300 text-amber-900",
    0: "bg-gray-100 text-gray-500",
  } as const;
  const cell = (
    <div className={`inline-flex flex-col items-center px-2 py-1 rounded min-w-[64px] ${colorMap[complete]}`}>
      <span className="text-xs font-semibold">{COMPLETION_LABELS[complete][0]}</span>
      <span className="text-[10px] font-mono mt-0.5 opacity-75">{date ? formatMonthShort(date) : "—"}</span>
    </div>
  );
  if (link && complete !== 2) {
    return <a href={link} target="_blank" rel="noopener" className="hover:opacity-80 inline-block">{cell}</a>;
  }
  return cell;
}
