// Display + aggregation helpers used across the LITe dashboard pages.

import type { Participant, WaveYear, WaveStatus, STSStatus, CompletionCode, DashboardStats } from "@/types";

export const WAVE_YEARS: WaveYear[] = [1, 2, 3];
export const WAVE_LABELS: Record<WaveYear, string> = { 1: "Year 1", 2: "Year 2", 3: "Year 3" };

// REDCap completion codes
export const COMPLETION_LABELS: Record<CompletionCode, string> = {
  0: "Incomplete",
  1: "Unverified",
  2: "Complete",
};

export function formatDate(s: string | null | undefined): string {
  if (!s) return "—";
  // Accept "YYYY-MM-DD" or ISO
  const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// Short "MM/YY" — for STS schedule cells where we want to match the
// month/year shorthand the team uses in the Follow up.{N} Google Sheet.
export function formatMonthShort(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(typeof s === "string" && s.length === 10 ? s + "T12:00:00" : (s as string));
  if (isNaN(d.getTime())) return String(s);
  const mm = d.getMonth() + 1;
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${yy}`;
}

export function formatTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function formatDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function pidSort(a: Participant, b: Participant): number {
  // Numeric PID sort when possible
  const na = Number(a.pid), nb = Number(b.pid);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return a.pid.localeCompare(b.pid);
}

export function stsAllComplete(s: STSStatus | null | undefined): boolean {
  if (!s || !s.active) return false;
  return s.cycles.length > 0 && s.cycles.every(c => c.complete === 2);
}

export function stsCompleteCount(s: STSStatus | null | undefined): number {
  if (!s) return 0;
  return s.cycles.filter(c => c.complete === 2).length;
}

export function emaPromptsComplete(wave: WaveStatus | null | undefined): number {
  if (!wave?.ema) return 0;
  return wave.ema.prompts.filter(p => p.complete).length;
}

export function emaPromptsScheduled(wave: WaveStatus | null | undefined): number {
  if (!wave?.ema) return 0;
  return wave.ema.prompts.filter(p => p.scheduledAt).length;
}

export function computeStats(participants: Participant[]): DashboardStats {
  const byWave: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  const v1Complete: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  const atHomeComplete: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  const sts1Complete: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  const sts2Complete: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  const emaActive: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  const v2Complete: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };

  for (const p of participants) {
    for (const w of WAVE_YEARS) {
      const wave = p.waves[w];
      if (!wave) continue;
      byWave[w]++;
      if (wave.v1?.allComplete) v1Complete[w]++;
      if (wave.atHome?.athomeMeasuresComplete === 2) atHomeComplete[w]++;
      if (stsAllComplete(wave.sts1)) sts1Complete[w]++;
      if (stsAllComplete(wave.sts2)) sts2Complete[w]++;
      if (wave.ema?.active) emaActive[w]++;
      if (wave.v2?.allComplete) v2Complete[w]++;
    }
  }

  return {
    totalParticipants: participants.length,
    byWave, v1Complete, atHomeComplete, sts1Complete, sts2Complete, emaActive, v2Complete,
    remindersToday: { sms: 0, email: 0 },  // overridden by callers using due-reminders.json
  };
}

// Pretty status pill colors keyed by completion code.
export function pillColor(c: CompletionCode | undefined): string {
  switch (c) {
    case 2: return "bg-emerald-100 text-emerald-700";
    case 1: return "bg-amber-100 text-amber-700";
    case 0: return "bg-gray-100 text-gray-600";
    default: return "bg-gray-100 text-gray-400";
  }
}

// Today / yesterday / tomorrow / Mar 4
export function relativeDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const diffDays = Math.round((x.getTime() - today.getTime()) / (24 * 3600 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays > 0 && diffDays < 7) return `In ${diffDays} days`;
  if (diffDays < 0 && diffDays > -7) return `${-diffDays} days ago`;
  return formatDate(s);
}
