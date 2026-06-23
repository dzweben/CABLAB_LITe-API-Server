"use client";

import React, { useEffect, useState, useMemo } from "react";
import type { Participant, WaveYear } from "@/types";
import { WAVE_YEARS, WAVE_LABELS, pidSort, formatDateTime } from "@/lib/lite-utils";

export default function EMAPage() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [wave, setWave] = useState<WaveYear>(1);
  const [showOnlyActive, setShowOnlyActive] = useState(true);
  const [expandedPid, setExpandedPid] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/data/participants").then(r => r.json()).then(d => {
      setParticipants((d.participants || []).slice().sort(pidSort));
    }).finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    let xs = participants.filter(p => p.waves[wave]?.ema);
    if (showOnlyActive) xs = xs.filter(p => p.waves[wave]?.ema?.active);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(p => p.pid.toLowerCase().includes(s));
    }
    return xs;
  }, [participants, wave, showOnlyActive, search]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">EMA Tracker</h2>
        <p className="text-sm text-gray-500 mt-1">
          Ecological Momentary Assessment — 25 timed micro-surveys over 2 weeks per active cycle.
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
        <span className="text-sm text-gray-500 ml-auto">{rows.length} active EMA cycles</span>
      </div>

      {loading ? <p className="text-gray-500 text-sm">Loading…</p> : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-gray-600">
                <th className="text-left px-4 py-3 font-semibold">PID</th>
                <th className="text-left px-4 py-3 font-semibold">EMA Phone</th>
                <th className="text-left px-4 py-3 font-semibold">Start Day</th>
                <th className="text-center px-4 py-3 font-semibold">Prompts done</th>
                <th className="text-center px-4 py-3 font-semibold">Prompts scheduled</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} className="py-10 text-center text-gray-400">No active EMA cycles.</td></tr>
              )}
              {rows.map(p => {
                const ema = p.waves[wave]!.ema!;
                const done = ema.prompts.filter(x => x.complete).length;
                const scheduled = ema.prompts.filter(x => x.scheduledAt).length;
                const expanded = expandedPid === p.pid;
                return (
                  <Row key={p.pid} pid={p.pid} ema={ema} expanded={expanded}
                    onToggle={() => setExpandedPid(expanded ? null : p.pid)}
                    done={done} scheduled={scheduled} />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ pid, ema, expanded, onToggle, done, scheduled }: {
  pid: string;
  ema: NonNullable<NonNullable<Participant["waves"][1]>["ema"]>;
  expanded: boolean;
  onToggle: () => void;
  done: number;
  scheduled: number;
}) {
  return (
    <React.Fragment>
      <tr
        className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${expanded ? "bg-indigo-50/40" : ""}`}
        onClick={onToggle}
      >
        <td className="px-4 py-3 font-mono font-medium">{pid}</td>
        <td className="px-4 py-3 text-gray-700 font-mono text-xs">{ema.phone || "—"}</td>
        <td className="px-4 py-3 text-gray-700">{ema.startDay || "—"}</td>
        <td className="px-4 py-3 text-center font-mono">{done}</td>
        <td className="px-4 py-3 text-center font-mono">{scheduled}</td>
        <td className="px-4 py-3 text-right text-gray-400 text-xs">{expanded ? "▲" : "▼"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="bg-gray-50 px-6 py-4 border-b border-gray-200">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {ema.prompts.map(p => (
                <div
                  key={p.key}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded ${
                    p.complete ? "bg-emerald-50 text-emerald-800" :
                    p.scheduledAt ? "bg-white border border-gray-200" :
                    "bg-gray-100 text-gray-400"
                  }`}
                >
                  <span className="text-xs font-medium">{p.dayLabel} · {p.timeLabel}</span>
                  <span className="text-xs font-mono">
                    {p.complete ? "✓" : p.scheduledAt ? formatDateTime(p.scheduledAt).slice(0, -3) : "—"}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}
