// Project LITe data model.
//
// REDCap structure (from the Timeline of Automated Messages workbook):
//
//   preenrollment_arm_1          → demographics + contact info (constant per participant)
//   visit_1_y{N}_arm_1           → V1 in-lab visit (per wave N=1..3)
//   athome_measures_y{N}_arm_1   → 8-section at-home survey (per wave)
//   screen_time_y{N}_arm_1       → STS1 cycle, 6 sub-surveys (per wave)
//   screen_time_2_y{N}_arm_1     → STS2 cycle, 3 sub-surveys (per wave)
//   ema_y{N}_arm_1               → EMA cycle with ~20 timed micro-surveys (per wave)
//   visit_2_y{N}_arm_1           → V2 in-lab visit (per wave)

export type WaveYear = 1 | 2 | 3;
export type Channel = "sms" | "email";

// REDCap completion code: 0=incomplete, 1=unverified, 2=complete
export type CompletionCode = 0 | 1 | 2;

// ---------- Participant ----------

export interface ContactInfo {
  firstName: string;
  lastName: string;
  parentName: string;
  email: string;
  phonePrimary: string;
  phoneSecondary: string;
  childPhone: string;
  // Comma-separated cohort label from the Session Notes sheet: "1000" | "2000" | "3000".
  cohortGroup: string;
}

export interface AtHomeStatus {
  timestamp: string | null;       // [visit_1_y{N}_arm_1][timestamp_athome] — set when in-lab break_1 hits 2
  break1Complete: CompletionCode; // gates the at-home send
  athomeMeasuresComplete: CompletionCode;
}

export interface STSCycle {
  index: number;                  // 1-based: 1.1, 1.2 … or 2.1, 2.2 …
  date: string | null;            // scheduled send date from REDCap (date-only YYYY-MM-DD)
  complete: CompletionCode;       // 0/1/2
  surveyLink: string | null;
}

export interface STSStatus {
  active: boolean;                // screen_time_cycle_{1|2} == "1"
  cycles: STSCycle[];             // STS1: 6 entries, STS2: 3 entries
}

export interface EMAPrompt {
  key: string;                    // e.g. "ema_m1_734" (Monday week-1 7:34 AM)
  dayLabel: string;               // "Monday 1", "Tuesday 1", …
  timeLabel: string;              // "7:34 AM", …
  scheduledAt: string | null;     // ISO datetime from REDCap (or null if not yet computed)
  complete: boolean;              // we infer from the survey completion field
}

export interface EMAStatus {
  active: boolean;                // ema_cycle == "1"
  startDay: string | null;        // ema_start_day
  startDayCalc: number | null;    // ema_start_day_calc
  enableSent: boolean;            // tracked client-side via sent-log
  phone: string;                  // ema_phone (which line to text for EMA)
  prompts: EMAPrompt[];           // ~20 timed prompts per cycle
}

export interface VisitStatus {
  date: string | null;
  // Per-form completion codes for the rich V1/V2 instruments.
  forms: Record<string, CompletionCode>;
  allComplete: boolean;
}

// Per-participant per-wave row pulled directly from the team-maintained
// Follow up.{N} Google Sheet. This is the source of truth for V1/V2
// completion (and the human-friendly month-labels for STS sends) until
// REDCap exposes the corresponding fields.
export interface FollowupSheetRow {
  record?: string | number | null;
  v2Date?: string | number | null;          // "Visit 2" date — V2 done if filled
  sts1Months?: (string | number | null)[];  // 6 entries — month/year labels for STS1.1..1.6
  sts2Months?: (string | number | null)[];  // 3 entries
  emaDate?: string | number | null;
  emaStatus?: string | null;                // e.g. "COMPLETE"
  w1Comp?: string | number | null;
  w2Comp?: string | number | null;
  wave2StartDate?: string | number | null;
  wave3StartDate?: string | number | null;
  raTag?: string | null;
  notes?: string | null;
}

export interface WaveStatus {
  year: WaveYear;
  // null if the participant hasn't started this wave yet.
  v1: VisitStatus | null;
  atHome: AtHomeStatus | null;
  sts1: STSStatus | null;
  sts2: STSStatus | null;
  ema: EMAStatus | null;
  v2: VisitStatus | null;
  // Source-of-truth tracker pulled from the Google Sheet (Follow up.{year}).
  followupSheet?: FollowupSheetRow;
}

export interface Participant {
  pid: string;                    // study-facing ID, e.g. "1001"
  recordId: string;               // REDCap record_id
  contact: ContactInfo;
  // Wave-by-wave participation. Keys: 1, 2, 3.
  waves: Partial<Record<WaveYear, WaveStatus>>;
  // Current active wave (the highest year with an open V1).
  activeWave: WaveYear | null;
}

// ---------- Reminders (the outgoing queue) ----------

// Each "due reminder" is a single (participant, alert) tuple that the
// 5-min poller resolves into outbound messages.
export interface DueReminder {
  id: string;                        // hash of (pid|alertId|scheduledAt) — idempotency key
  pid: string;
  recordId: string;
  alertId: number;                   // matches "Alert #" in the Timeline spreadsheet
  instrument: string;                // e.g. "Screen Time Auto Invite 1.1"
  wave: WaveYear;
  scheduledAt: string;               // ISO datetime — when this is supposed to fire
  channels: Channel[];               // ["sms"], ["email"], or both
  recipientPhones: string[];         // E.164 strings ready for OpenPhone
  recipientEmail: string | null;
  subject: string | null;            // null when channel is sms-only
  messageBody: string;               // already substituted, ready to send
  // What survey-link substitution the body needs (resolved at send-time):
  surveyLinkSlot: {
    eventName: string;
    instrument: string;
  } | null;
}

export interface SentLogEntry {
  id: string;                        // matches DueReminder.id
  timestamp: string;                 // ISO when we actually sent
  pid: string;
  alertId: number;
  instrument: string;
  channel: Channel;
  recipient: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
}

// ---------- Dashboard rollups ----------

export interface DashboardStats {
  totalParticipants: number;
  byWave: Record<WaveYear, number>;
  // Per-wave completion counts for the marquee numbers on Overview.
  v1Complete: Record<WaveYear, number>;
  atHomeComplete: Record<WaveYear, number>;
  sts1Complete: Record<WaveYear, number>;   // all 6 cycles done
  sts2Complete: Record<WaveYear, number>;   // all 3 cycles done
  emaActive: Record<WaveYear, number>;
  v2Complete: Record<WaveYear, number>;
  // Today's outgoing count by channel.
  remindersToday: { sms: number; email: number };
}

export interface STSGridRow {
  pid: string;
  wave: WaveYear;
  active: boolean;
  cycles: STSCycle[];
  allComplete: boolean;
  totalComplete: number;
  totalCycles: number;
}

export interface EMAGridRow {
  pid: string;
  wave: WaveYear;
  active: boolean;
  startDay: string | null;
  totalPrompts: number;
  promptsSent: number;
  promptsComplete: number;
}
