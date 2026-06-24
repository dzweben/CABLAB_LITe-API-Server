"use client";

import React, { useEffect, useState, useMemo } from "react";
import type { Participant } from "@/types";
import { WAVE_LABELS, formatDateTime, formatTime, relativeDate } from "@/lib/lite-utils";
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
  overdue?: boolean;
}

// Kind → display config
const KIND_META: Record<string, { label: string; color: string; channels: string[] }> = {
  sts1_invite:      { label: "STS1 invite",    color: "bg-indigo-100 text-indigo-800",   channels: ["sms", "email"] },
  sts1_followup:    { label: "STS1 follow-up", color: "bg-indigo-50 text-indigo-700",    channels: ["sms", "email"] },
  sts2_invite:      { label: "STS2 invite",    color: "bg-purple-100 text-purple-800",   channels: ["sms", "email"] },
  sts2_followup:    { label: "STS2 follow-up", color: "bg-purple-50 text-purple-700",    channels: ["sms", "email"] },
  ema_prompt:       { label: "EMA prompt",     color: "bg-emerald-100 text-emerald-800", channels: ["sms"] },
  ema_enable:       { label: "EMA enable",     color: "bg-emerald-50 text-emerald-700",  channels: ["sms"] },
  athome_sms:       { label: "At-home (SMS)",  color: "bg-amber-100 text-amber-800",     channels: ["sms"] },
  athome_email:     { label: "At-home (email)",color: "bg-amber-50 text-amber-700",      channels: ["email"] },
  payment_email:    { label: "Payment email",  color: "bg-rose-100 text-rose-800",       channels: ["sms", "email"] },
  other:            { label: "Other",          color: "bg-gray-100 text-gray-700",       channels: [] },
};

export default function RemindersPage() {
  const [due, setDue] = useState<DueRow[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "today" | "next24" | "next7" | "next14">("next7");
  const [kindFilter, setKindFilter] = useState<"all" | "sts1" | "sts2" | "ema" | "athome" | "payment">("all");
  const [hideCompleted, setHideCompleted] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [cohort] = useCohort();

  useEffect(() => {
    Promise.all([
      fetch("/api/data/due-reminders").then(r => r.json()),
      fetch("/api/data/participants").then(r => r.json()),
    ]).then(([d, p]) => {
      setDue(Array.isArray(d) ? d : []);
      setParticipants(p.participants || []);
    }).finally(() => setLoading(false));
  }, []);

  // Contact-info lookup by pid for showing recipients
  const contactByPid = useMemo(() => {
    const m: Record<string, Participant["contact"]> = {};
    for (const p of participants) m[p.pid] = p.contact;
    return m;
  }, [participants]);

  const filtered = useMemo(() => {
    let xs = due.filter(d => cohortMatches(d.pid, cohort));
    if (hideCompleted) xs = xs.filter(d => !d.complete);
    const now = Date.now();
    if (scope === "today") {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(); end.setHours(23, 59, 59, 999);
      xs = xs.filter(d => {
        const t = new Date(d.scheduledAt).getTime();
        return t >= start.getTime() && t <= end.getTime();
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
    } else if (scope === "next14") {
      xs = xs.filter(d => {
        const t = new Date(d.scheduledAt).getTime();
        return t >= now && t <= now + 14 * 24 * 3600 * 1000;
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
  }, [due, search, scope, kindFilter, cohort, hideCompleted]);

  // Group by Eastern-time day so a 10 PM Eastern send doesn't slip into
  // tomorrow's bucket. (toLocaleDateString respects the browser's tz which
  // for our coordinators is Philly.)
  const grouped = useMemo(() => {
    const byDay: Record<string, DueRow[]> = {};
    const dayKey = (iso: string) => {
      const d = new Date(iso);
      return isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    };
    for (const d of filtered) {
      (byDay[dayKey(d.scheduledAt)] ||= []).push(d);
    }
    return Object.entries(byDay)
      .map(([day, items]) => ({
        day,
        items: items.slice().sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)),
      }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }, [filtered]);

  // Roll-up counts for the chip bar
  const byKind = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of filtered) m[d.kind] = (m[d.kind] || 0) + 1;
    return m;
  }, [filtered]);
  const totalMessages = useMemo(() => {
    // Each row may fan out to multiple channels
    let total = 0;
    for (const d of filtered) {
      const meta = KIND_META[d.kind] || KIND_META.other;
      total += meta.channels.length || 1;
    }
    return total;
  }, [filtered]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Outgoing Queue</h2>
          <p className="text-sm text-gray-500 mt-1">
            What the 5-minute poller will send. Grouped by day; each row fans out to
            one SMS per phone + optional email depending on the alert type.
          </p>
        </div>
        <CohortFilter />
      </div>

      {/* Headline counters */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="Reminders queued" value={filtered.length} accent="indigo" />
        <Stat label="Overdue" value={filtered.filter(d => d.overdue).length} accent="red" />
        <Stat label="Outgoing messages" value={totalMessages} accent="purple" suffix=" total" />
        <Stat label="Distinct participants" value={new Set(filtered.map(d => d.pid)).size} accent="emerald" />
        <Stat label="Days covered" value={grouped.length} accent="amber" />
      </div>

      {/* Kind chips */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
          const meta = KIND_META[k] || KIND_META.other;
          return (
            <span key={k} className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${meta.color}`}>
              {meta.label} <span className="font-bold">{n}</span>
            </span>
          );
        })}
        {filtered.length === 0 && !loading && <span className="text-sm text-gray-400">Nothing queued in this window.</span>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {([
            ["today", "Today"],
            ["next24", "Next 24h"],
            ["next7", "Next 7d"],
            ["next14", "Next 14d"],
            ["all", "All upcoming"],
          ] as const).map(([s, label]) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md ${
                scope === s ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          value={kindFilter}
          onChange={e => setKindFilter(e.target.value as typeof kindFilter)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">All kinds</option>
          <option value="sts1">STS1 (invite + follow-up)</option>
          <option value="sts2">STS2 (invite + follow-up)</option>
          <option value="ema">EMA</option>
          <option value="athome">At-home</option>
          <option value="payment">Payment emails</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={hideCompleted}
            onChange={e => setHideCompleted(e.target.checked)}
            className="rounded border-gray-300"
          />
          Hide already-completed
        </label>
        <input
          type="text"
          placeholder="Search PID or instrument…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {loading ? <p className="text-gray-500 text-sm">Loading…</p> : (
        <div className="space-y-4">
          {grouped.length === 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">
              Nothing queued in this window.
            </div>
          )}
          {grouped.map(({ day, items }) => (
            <DayBlock
              key={day}
              day={day}
              items={items}
              contactByPid={contactByPid}
              expandedKey={expandedKey}
              onToggle={k => setExpandedKey(expandedKey === k ? null : k)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, suffix, accent }: { label: string; value: number; suffix?: string; accent: "indigo" | "purple" | "emerald" | "amber" | "red" }) {
  const c = {
    indigo: "text-indigo-600",
    purple: "text-purple-600",
    emerald: "text-emerald-600",
    amber: "text-amber-600",
    red: "text-red-600",
  }[accent];
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold ${c} mt-1 tabular-nums`}>
        {value}<span className="text-sm text-gray-400 font-medium">{suffix || ""}</span>
      </p>
    </div>
  );
}

function DayBlock({
  day,
  items,
  contactByPid,
  expandedKey,
  onToggle,
}: {
  day: string;
  items: DueRow[];
  contactByPid: Record<string, Participant["contact"]>;
  expandedKey: string | null;
  onToggle: (k: string) => void;
}) {
  // Day header with summary chip counts
  const counts: Record<string, number> = {};
  for (const d of items) counts[d.kind] = (counts[d.kind] || 0) + 1;
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="bg-gradient-to-r from-indigo-50 to-white border-b border-gray-200 px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-bold text-gray-900">{relativeDate(day)}</h3>
          <span className="text-sm text-gray-500 font-mono">{day}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(counts).map(([k, n]) => {
            const meta = KIND_META[k] || KIND_META.other;
            return (
              <span key={k} className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${meta.color}`}>
                {meta.label.replace(" follow-up", " f/u")} · {n}
              </span>
            );
          })}
          <span className="text-xs text-gray-500 ml-1">{items.length} total</span>
        </div>
      </div>
      <ul className="divide-y divide-gray-100">
        {items.map((d, i) => {
          const key = `${day}-${i}`;
          const meta = KIND_META[d.kind] || KIND_META.other;
          const contact = contactByPid[d.pid];
          const expanded = expandedKey === key;
          return (
            <li key={key}>
              <button
                onClick={() => onToggle(key)}
                className="w-full text-left px-5 py-2.5 hover:bg-gray-50 transition-colors flex items-center gap-3 flex-wrap"
              >
                <span className="text-sm font-mono text-gray-500 w-20 shrink-0 tabular-nums">{formatTime(d.scheduledAt)}</span>
                <span className="font-mono font-semibold text-gray-900 w-14 shrink-0">{d.pid}</span>
                <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold ${meta.color} shrink-0`}>{meta.label}</span>
                {d.overdue && (
                  <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold bg-red-600 text-white shrink-0 animate-pulse">
                    OVERDUE
                  </span>
                )}
                <span className="text-sm text-gray-700 truncate flex-1 min-w-0">{d.instrument}</span>
                <span className="text-xs text-gray-400 shrink-0">W{d.wave}</span>
                <div className="inline-flex gap-1 shrink-0">
                  {meta.channels.map(ch => (
                    <ChannelPill key={ch} channel={ch} contact={contact} />
                  ))}
                </div>
                <span className="text-xs text-gray-400 shrink-0 w-3">{expanded ? "▲" : "▼"}</span>
              </button>
              {expanded && (
                <div className="px-5 pb-4 -mt-1 text-xs text-gray-600 bg-gray-50/50 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <p className="font-semibold text-gray-500 mb-1">Recipient</p>
                    <ul className="space-y-0.5 font-mono">
                      {contact?.phonePrimary && <li>📱 primary: {contact.phonePrimary}</li>}
                      {contact?.phoneSecondary && <li>📱 secondary: {contact.phoneSecondary}</li>}
                      {contact?.childPhone && <li>📱 child: {contact.childPhone}</li>}
                      {contact?.email && <li>✉ {contact.email}</li>}
                      {!contact && <li className="text-red-600">No contact info for this PID</li>}
                    </ul>
                  </div>
                  <div>
                    <p className="font-semibold text-gray-500 mb-1">Alert metadata</p>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                      <dt className="text-gray-400">Alert #</dt><dd className="font-mono">{d.alertId}</dd>
                      <dt className="text-gray-400">Kind</dt><dd className="font-mono">{d.kind}</dd>
                      <dt className="text-gray-400">When</dt><dd className="font-mono">{formatDateTime(d.scheduledAt)}</dd>
                      {d.emaKey && (<><dt className="text-gray-400">EMA field</dt><dd className="font-mono">{d.emaKey}</dd></>)}
                      {d.complete && (<><dt className="text-gray-400">Status</dt><dd className="text-emerald-700">Survey already completed — won't send</dd></>)}
                    </dl>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ChannelPill({ channel, contact }: { channel: string; contact: Participant["contact"] | undefined }) {
  if (channel === "sms") {
    const has = contact?.phonePrimary || contact?.phoneSecondary;
    return (
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${has ? "bg-sky-100 text-sky-800" : "bg-red-100 text-red-700"}`}>
        SMS{!has ? "?" : ""}
      </span>
    );
  }
  if (channel === "email") {
    const has = !!contact?.email;
    return (
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${has ? "bg-violet-100 text-violet-800" : "bg-red-100 text-red-700"}`}>
        EM{!has ? "?" : ""}
      </span>
    );
  }
  return null;
}
