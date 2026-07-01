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
// month/year shorthand the team uses in the cohort tabs.
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

// Coordinator-defined completion thresholds.
export const AT_HOME_DONE_THRESHOLD = 7;        // ≥ 7 of 8 at-home sections
export const AT_HOME_TOTAL_SECTIONS = 8;
export const STS_DONE_THRESHOLD = 5;            // ≥ 5 of 9 STS surveys (6 STS1 + 3 STS2)
export const STS_TOTAL = 9;
export const EMA_DONE_THRESHOLD = 10;           // ≥ 10 of 25 EMA prompts
export const EMA_TOTAL = 25;

export function isAtHomeDone(wave: WaveStatus | null | undefined): boolean {
  const ah = wave?.atHome;
  if (!ah) return false;
  // Prefer the per-section count when available (real numerator/denominator).
  if (ah.sectionsTotal != null && ah.sectionsTotal > 0) {
    return (ah.sectionsComplete ?? 0) >= AT_HOME_DONE_THRESHOLD;
  }
  // Otherwise fall back to the derived completion code.
  return ah.athomeMeasuresComplete === 2;
}

export function stsTotalCompleteCount(wave: WaveStatus | null | undefined): number {
  if (!wave) return 0;
  return stsCompleteCount(wave.sts1) + stsCompleteCount(wave.sts2);
}

export function isStsDone(wave: WaveStatus | null | undefined): boolean {
  return stsTotalCompleteCount(wave) >= STS_DONE_THRESHOLD;
}

export function isEmaDone(wave: WaveStatus | null | undefined): boolean {
  return emaPromptsComplete(wave) >= EMA_DONE_THRESHOLD;
}

export function computeStats(participants: Participant[]): DashboardStats {
  // `byWave[w]` = count of participants who appear in wave w (per-wave
  // active count). It is NOT the denominator for cross-wave completion
  // ratios — use `totalParticipants` for those.
  const byWave: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  const v1Complete: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  const atHomeComplete: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  // Single consolidated STS count (≥5 of 9 surveys done — STS1 6 + STS2 3).
  const stsComplete: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  // EMA count (≥10 of 25 prompts complete).
  const emaComplete: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  const emaActive: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };
  const v2Complete: Record<WaveYear, number> = { 1: 0, 2: 0, 3: 0 };

  for (const p of participants) {
    const isUnder13 = typeof p.contact?.age === "number" && p.contact.age < 13;
    for (const w of WAVE_YEARS) {
      const wave = p.waves[w];
      if (!wave) continue;
      byWave[w]++;
      if (wave.v1?.allComplete) v1Complete[w]++;
      if (isAtHomeDone(wave)) atHomeComplete[w]++;
      if (isStsDone(wave)) stsComplete[w]++;
      // EMA is a 13+ instrument by design; under-13s aren't sent prompts.
      // Exclude them from the EMA columns so the ratio reflects the actual
      // eligible cohort, not the whole study.
      if (!isUnder13) {
        if (isEmaDone(wave)) emaComplete[w]++;
        if (wave.ema?.active) emaActive[w]++;
      }
      if (wave.v2?.allComplete) v2Complete[w]++;
    }
  }

  return {
    totalParticipants: participants.length,
    byWave, v1Complete, atHomeComplete,
    stsComplete, emaComplete,
    emaActive, v2Complete,
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

// Render an alert message template with substitutions. Mirrors the
// runtime renderer in scripts/send-due-messages.mjs so the queue page
// can preview exactly what the participant would receive.
export function renderMessageTemplate(
  template: string | null | undefined,
  participant: { contact: { firstName: string; lastName: string; parentName: string; email: string; phonePrimary: string; phoneSecondary: string; childPhone: string } } | null,
  surveyLink: string | null,
  expireDate?: string | null
): string {
  if (!template) return "";
  let out = template;
  if (participant) {
    const subs: Record<string, string> = {
      "[preenrollment_arm_1][first_name]": participant.contact.firstName || "",
      "[preenrollment_arm_1][last_name]": participant.contact.lastName || "",
      "[preenrollment_arm_1][parent_name]": participant.contact.parentName || "",
      "[preenrollment_arm_1][email]": participant.contact.email || "",
      "[preenrollment_arm_1][phone_primary]": participant.contact.phonePrimary || "",
      "[preenrollment_arm_1][phone_secondary]": participant.contact.phoneSecondary || "",
      // Friendly aliases used in the payment message copy.
      "[name]": participant.contact.firstName || "",
    };
    for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v);
  }
  // Payment link-expiry date (the "3 months from now" in the copy).
  const expireLabel = expireDate ? formatExpireDate(expireDate) : "[expire date pending]";
  out = out.split("[expire_date]").join(expireLabel);
  // Replace every [event][survey-link:instrument] with the resolved link,
  // plus the friendly "[survey link]" alias.
  out = out.replace(/\[([a-z0-9_]+)\]\[survey-link:([a-z0-9_]+)\]/gi, () =>
    surveyLink || "[SURVEY LINK PENDING]"
  );
  out = out.split("[survey link]").join(surveyLink || "[SURVEY LINK PENDING]");
  return out;
}

// "March 25, 2027" from an ISO datetime, parsed UTC so it never drifts.
function formatExpireDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

// Today / yesterday / tomorrow / Mar 4
export function relativeDate(s: string | null | undefined): string {
  if (!s) return "—";
  // A bare "YYYY-MM-DD" (the day-group key) must be parsed as LOCAL
  // midnight, not UTC — otherwise in Eastern it lands the evening prior
  // and mislabels tomorrow as "Today".
  const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = md ? new Date(+md[1], +md[2] - 1, +md[3]) : new Date(s);
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
