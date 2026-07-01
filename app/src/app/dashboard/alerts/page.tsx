"use client";

import { useMemo, useState } from "react";
import { TIMELINE_ALERTS, type TimelineAlert, type AlertKind } from "@/lib/timeline";
import type { WaveYear } from "@/types";

// Reference view of every automated alert and its internal logic — what
// fires it, the condition, the send-date rule, and the message copy.
// Sourced straight from timeline.ts (the app's alert definitions).

const KIND_LABEL: Record<AlertKind, string> = {
  athome_sms: "At-home (SMS)",
  athome_email: "At-home (email)",
  sts1_invite: "STS1 invite",
  sts1_followup: "STS1 follow-up",
  sts2_invite: "STS2 invite",
  sts2_followup: "STS2 follow-up",
  ema_enable: "EMA enable",
  ema_prompt: "EMA prompt",
  payment_email: "Payment",
  payment_followup: "Payment follow-up",
  payment_expire: "Payment expired",
  other: "Other",
};

const KIND_COLOR: Record<AlertKind, string> = {
  athome_sms: "bg-amber-100 text-amber-800",
  athome_email: "bg-amber-50 text-amber-700",
  sts1_invite: "bg-indigo-100 text-indigo-800",
  sts1_followup: "bg-indigo-50 text-indigo-700",
  sts2_invite: "bg-purple-100 text-purple-800",
  sts2_followup: "bg-purple-50 text-purple-700",
  ema_enable: "bg-emerald-50 text-emerald-700",
  ema_prompt: "bg-emerald-100 text-emerald-800",
  payment_email: "bg-rose-100 text-rose-800",
  payment_followup: "bg-rose-50 text-rose-700",
  payment_expire: "bg-gray-200 text-gray-700",
  other: "bg-gray-100 text-gray-700",
};

export default function AlertsPage() {
  const [wave, setWave] = useState<WaveYear>(2);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const rows = useMemo(() => {
    let xs = TIMELINE_ALERTS.filter(a => a.wave === wave);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      xs = xs.filter(a =>
        String(a.alertId).includes(s) ||
        a.instrument.toLowerCase().includes(s) ||
        a.kind.toLowerCase().includes(s) ||
        (a.message || "").toLowerCase().includes(s) ||
        (a.condition || "").toLowerCase().includes(s)
      );
    }
    return xs.slice().sort((a, b) => a.alertId - b.alertId);
  }, [wave, search]);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Alerts &amp; Logic</h2>
          <p className="text-sm text-gray-500 mt-1">
            Every automated message the study sends, with its trigger, conditional logic, send-date
            rule, and message copy. Click a row to expand. Placeholders like{" "}
            <code className="px-1 py-0.5 bg-gray-100 rounded text-xs">[preenrollment_arm_1][first_name]</code>{" "}
            and <code className="px-1 py-0.5 bg-gray-100 rounded text-xs">[expire_date]</code> fill in at send time.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {([2, 3] as WaveYear[]).map(w => (
            <button
              key={w}
              onClick={() => setWave(w)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md ${
                wave === w ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              Wave {w}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search alert #, instrument, condition, message…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-80 max-w-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <span className="text-sm text-gray-500 ml-auto">{rows.length} alerts</span>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <ul className="divide-y divide-gray-100">
          {rows.map(a => (
            <AlertRow
              key={`${a.wave}-${a.alertId}`}
              alert={a}
              open={expanded === a.alertId}
              onToggle={() => setExpanded(expanded === a.alertId ? null : a.alertId)}
            />
          ))}
          {rows.length === 0 && (
            <li className="py-10 text-center text-gray-400">No alerts match.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

function AlertRow({ alert, open, onToggle }: { alert: TimelineAlert; open: boolean; onToggle: () => void }) {
  return (
    <li>
      <button
        onClick={onToggle}
        className="w-full text-left px-5 py-3 hover:bg-gray-50 flex items-center gap-3 flex-wrap"
      >
        <span className="font-mono text-xs text-gray-400 w-10 shrink-0">#{alert.alertId}</span>
        <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold shrink-0 ${KIND_COLOR[alert.kind]}`}>
          {KIND_LABEL[alert.kind]}
        </span>
        <span className="text-sm font-medium text-gray-900 flex-1 min-w-0 truncate">{alert.instrument}</span>
        <span className="inline-flex gap-1 shrink-0">
          {alert.channels.map(ch => (
            <span key={ch} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-100 text-sky-800 uppercase">
              {ch}
            </span>
          ))}
        </span>
        <span className="text-xs text-gray-400 shrink-0 w-3">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="px-5 pb-4 bg-gray-50/60 grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm">
          <Field label="Trigger" value={alert.trigger} />
          <Field label="Send date" value={alert.sendDateSpec} />
          <Field label="Conditional logic" value={alert.condition} mono wide />
          <Field label="Destination" value={alert.destinationSpec} mono />
          <div className="lg:col-span-2">
            <p className="font-semibold text-gray-500 text-xs uppercase tracking-wider mb-1">Message</p>
            {alert.message ? (
              <pre className="whitespace-pre-wrap font-sans text-sm bg-white border border-gray-200 rounded p-3 text-gray-800">{alert.message}</pre>
            ) : (
              <p className="text-gray-400 italic">No message body.</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function Field({ label, value, mono, wide }: { label: string; value: string | null; mono?: boolean; wide?: boolean }) {
  return (
    <div className={wide ? "lg:col-span-2" : ""}>
      <p className="font-semibold text-gray-500 text-xs uppercase tracking-wider mb-1">{label}</p>
      {value ? (
        <pre className={`whitespace-pre-wrap ${mono ? "font-mono text-xs" : "font-sans text-sm"} text-gray-700 bg-white border border-gray-200 rounded p-2`}>{value}</pre>
      ) : (
        <p className="text-gray-400 italic text-sm">—</p>
      )}
    </div>
  );
}
