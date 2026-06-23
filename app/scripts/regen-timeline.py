#!/usr/bin/env python3
"""Regenerate src/lib/timeline.ts from the wave 2 + wave 3 CSVs.

Sources of truth (canonical, edited by the team):
    private/docs/timeline_wave2.csv
    private/docs/timeline_wave3.csv

Each CSV exports one tab of the Timeline of Automated Messages workbook.
They share alert numbers; the only delta is the REDCap event slug
(screen_time_y2_arm_1 vs screen_time_y3_arm_1) and the per-wave message
copies. Wave 1 is not separately defined — the team treats the wave 2
schedule as the canonical Y1 template and rebinds event names at fetch
time.

Run after the team edits the CSVs:
    python3 scripts/regen-timeline.py
"""

import csv
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_W2 = ROOT / "private" / "docs" / "timeline_wave2.csv"
SRC_W3 = ROOT / "private" / "docs" / "timeline_wave3.csv"
OUT    = ROOT / "src" / "lib" / "timeline.ts"


def js_str(s):
    if s is None or s == "":
        return "null"
    return json.dumps(s, ensure_ascii=False)


def classify(instr):
    n = (instr or "").lower()
    if "at-home" in n and "text" in n: return "athome_sms"
    if "at-home" in n and "email" in n: return "athome_email"
    if "auto invite 1." in n or "auto invite 1 " in n: return "sts1_invite"
    if "follow up 1." in n: return "sts1_followup"
    if "auto invite 2." in n: return "sts2_invite"
    if "follow up 2." in n: return "sts2_followup"
    if "ema y1 enable" in n or "ema y2 enable" in n or "ema y3 enable" in n: return "ema_enable"
    if n.startswith("ema."): return "ema_prompt"
    if "payment email" in n or "payment" in n: return "payment_email"
    return "other"


def ema_key(instr):
    if not instr or not instr.lower().startswith("ema."): return None
    m = re.search(r"(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*(\d+)?\s+(\d+):(\d+)\s*(AM|PM)",
                  instr, re.IGNORECASE)
    if not m: return None
    full_day = m.group(1).lower()
    week_num = m.group(2) or "1"
    hh = m.group(3); mm = m.group(4)
    if full_day == "monday": day_part = f"m{week_num}"
    elif full_day == "tuesday": day_part = f"t{week_num}"
    elif full_day == "wednesday": day_part = f"w{week_num}"
    elif full_day == "thursday": day_part = "th"
    elif full_day == "friday": day_part = "f"
    elif full_day == "saturday": day_part = "sa"
    elif full_day == "sunday": day_part = "su"
    else: day_part = full_day[:2]
    return f"ema_{day_part}_{hh}{mm}"


def normalize(s):
    if not s: return None
    return re.sub(r"\s+", " ", str(s).replace("\xa0", " ").strip()) or None


def read_csv(path, wave):
    rows = []
    with open(path, encoding="latin-1") as f:
        reader = csv.reader(f)
        for row in reader:
            if not row: continue
            while len(row) < 8: row.append("")
            alert_id, instr, notes, trigger, condition, send_date, destination, message = row[:8]
            try:
                aid = int(alert_id.strip())
            except (ValueError, AttributeError):
                continue
            rows.append({
                "wave": wave,
                "alertId": aid,
                "kind": classify(instr),
                "instrument": normalize(instr),
                "trigger": normalize(trigger) if trigger and trigger.strip().lower() != "na" else None,
                "condition": (condition or "").replace("\xa0", " ").strip() or None,
                "sendDateSpec": (send_date or "").replace("\xa0", " ").strip() or None,
                "destinationSpec": (destination or "").replace("\xa0", " ").strip() or None,
                "emaKey": ema_key(instr),
                "message": (message or "").replace("\xa0", " ").strip() or None,
            })
    return rows


def main():
    entries = read_csv(SRC_W2, 2) + read_csv(SRC_W3, 3)
    entries.sort(key=lambda e: (e["wave"], e["alertId"]))

    lines = [
        "// AUTO-GENERATED from private/docs/timeline_wave{2,3}.csv.",
        "// Don't hand-edit; regenerate with scripts/regen-timeline.py.",
        "//",
        "// Each entry corresponds to one 'Alert #' row in the source CSVs.",
        "// Together these define every automated message Project LITe sends.",
        "",
        'import type { Channel, WaveYear } from "@/types";',
        "",
        "export type AlertKind =",
        '  | "athome_sms"',
        '  | "athome_email"',
        '  | "sts1_invite"',
        '  | "sts1_followup"',
        '  | "sts2_invite"',
        '  | "sts2_followup"',
        '  | "ema_enable"',
        '  | "ema_prompt"',
        '  | "payment_email"',
        '  | "other";',
        "",
        "export interface TimelineAlert {",
        "  alertId: number;",
        "  wave: WaveYear;",
        "  kind: AlertKind;",
        "  instrument: string;",
        "  trigger: string | null;",
        "  condition: string | null;",
        "  sendDateSpec: string | null;",
        "  destinationSpec: string | null;",
        "  channels: Channel[];",
        "  emaKey: string | null;",
        "  message: string | null;",
        "}",
        "",
        "function parseChannels(spec: string | null): Channel[] {",
        "  if (!spec) return [];",
        "  const s = spec.toLowerCase();",
        "  const out: Channel[] = [];",
        '  if (s.includes("phone") || s.includes("ema_phone")) out.push("sms");',
        '  if (s.includes("email")) out.push("email");',
        "  return out;",
        "}",
        "",
        'const RAW: Omit<TimelineAlert, "channels">[] = [',
    ]
    for e in entries:
        lines.append("  {")
        lines.append(f'    alertId: {e["alertId"]},')
        lines.append(f'    wave: {e["wave"]} as WaveYear,')
        lines.append(f'    kind: {js_str(e["kind"])},')
        lines.append(f'    instrument: {js_str(e["instrument"])},')
        lines.append(f'    trigger: {js_str(e["trigger"])},')
        lines.append(f'    condition: {js_str(e["condition"])},')
        lines.append(f'    sendDateSpec: {js_str(e["sendDateSpec"])},')
        lines.append(f'    destinationSpec: {js_str(e["destinationSpec"])},')
        lines.append(f'    emaKey: {js_str(e["emaKey"])},')
        lines.append(f'    message: {js_str(e["message"])},')
        lines.append("  },")
    lines += [
        "];",
        "",
        "export const TIMELINE_ALERTS: TimelineAlert[] = RAW.map((a) => ({",
        "  ...a,",
        "  channels: parseChannels(a.destinationSpec),",
        "}));",
        "",
        "export function alertsForWave(wave: WaveYear): TimelineAlert[] {",
        "  return TIMELINE_ALERTS.filter((a) => a.wave === wave);",
        "}",
        "",
        "export function alertById(alertId: number, wave: WaveYear): TimelineAlert | undefined {",
        "  return TIMELINE_ALERTS.find((a) => a.alertId === alertId && a.wave === wave);",
        "}",
        "",
        "// Wave 1 uses the same schedule as Wave 2 (the team treats Y1 as the",
        "// canonical template). Fetch-time field bindings rewrite the event slug.",
        "export function alertsForRuntimeWave(wave: WaveYear): TimelineAlert[] {",
        "  return TIMELINE_ALERTS.filter((a) => a.wave === (wave === 3 ? 3 : 2));",
        "}",
        "",
    ]
    OUT.write_text("\n".join(lines))
    print(f"Wrote {OUT}  ({len(entries)} alerts total)")
    # Stats
    by_kind = {}
    for e in entries:
        by_kind[e["kind"]] = by_kind.get(e["kind"], 0) + 1
    for k, n in sorted(by_kind.items(), key=lambda x: -x[1]):
        print(f"  {k:>18}: {n}")


if __name__ == "__main__":
    main()
