#!/usr/bin/env python3
"""Regenerate src/lib/timeline.ts from private/docs/Timeline_of_Automated_Messages.xlsx.

The TS file is auto-generated and should not be hand-edited — if the
spreadsheet changes (new alerts, message-text edits, schedule updates),
rerun:

    python3 scripts/regen-timeline.py

Requires: pip install openpyxl
"""
import json, os, re, sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("openpyxl not installed. Run: pip install openpyxl", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
XLSX = ROOT / "private" / "docs" / "Timeline_of_Automated_Messages.xlsx"
OUT  = ROOT / "src" / "lib" / "timeline.ts"


def js_str(s):
    if s is None: return "null"
    return json.dumps(s, ensure_ascii=False)


def classify(instr):
    n = (instr or "").lower()
    if "at-home" in n and "text" in n: return "athome_sms"
    if "at-home" in n and "email" in n: return "athome_email"
    if "auto invite 1." in n: return "sts1_invite"
    if "follow up 1." in n: return "sts1_followup"
    if "auto invite 2." in n: return "sts2_invite"
    if "follow up 2." in n: return "sts2_followup"
    if "ema y1 enable" in n: return "ema_enable"
    if n.startswith("ema."): return "ema_prompt"
    return "other"


def ema_key(instr):
    if not instr or not instr.lower().startswith("ema."): return None
    m = re.search(r"(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*(\d+)?\s+(\d+):(\d+)\s*(AM|PM)", instr, re.IGNORECASE)
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
    if not s: return s
    return re.sub(r"\s+", " ", str(s).strip())


def main():
    wb = openpyxl.load_workbook(str(XLSX), data_only=True)
    entries = []
    for sheet_name in ["wave 2", "wave 3"]:
        wave = 2 if "2" in sheet_name else 3
        ws = wb[sheet_name]
        for row in ws.iter_rows(values_only=True):
            cells = list(row)
            while cells and cells[-1] is None: cells.pop()
            if not cells or len(cells) < 2: continue
            if isinstance(cells[0], str) and "Alert" in cells[0]: continue
            while len(cells) < 8: cells.append(None)
            alert_id, instrument, _notes, trigger, condition, send_date, destination, message = cells[:8]
            if not isinstance(alert_id, (int, float)): continue
            entries.append({
                "wave": wave,
                "alertId": int(alert_id),
                "kind": classify(instrument),
                "instrument": normalize(instrument),
                "trigger": normalize(trigger) if trigger else None,
                "condition": str(condition) if condition else None,
                "sendDateSpec": str(send_date) if send_date else None,
                "destinationSpec": str(destination) if destination else None,
                "emaKey": ema_key(instrument),
                "message": message,
            })

    lines = [
        "// AUTO-GENERATED from app/private/docs/Timeline_of_Automated_Messages.xlsx.",
        "// Don't hand-edit; regenerate with scripts/regen-timeline.py if needed.",
        "//",
        "// Each entry corresponds to a single 'Alert #' row in the source workbook.",
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
        for k in ("alertId","wave","kind","instrument","trigger","condition","sendDateSpec","destinationSpec","emaKey","message"):
            if k == "wave":
                lines.append(f'    {k}: {e[k]} as WaveYear,')
            elif k == "alertId":
                lines.append(f'    {k}: {e[k]},')
            else:
                lines.append(f'    {k}: {js_str(e[k])},')
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
    ]
    OUT.write_text("\n".join(lines))
    print(f"Wrote {OUT} — {len(entries)} alerts")


if __name__ == "__main__":
    main()
