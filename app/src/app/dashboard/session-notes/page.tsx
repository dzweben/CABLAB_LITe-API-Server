"use client";

import { useEffect, useState } from "react";

// The PID Session Notes workbook (cohort tabs 1000/2000/3000) — the team's
// V1/V2 source of truth. We embed the LIVE editable Google Sheet here so
// coordinators can read AND edit it without leaving the dashboard. The
// iframe loads Google's real editor, which uses the viewer's own Google
// login for edit access — nothing is exposed publicly.
//
// Sheet ID resolution: prefer whatever the data pipeline actually used
// (surfaced in last-fetch.json), falling back to the known workbook ID so
// the page works even before the next fetch writes the field.
const FALLBACK_SHEET_ID = "18LScSoBcT8XmwA_WjfeN4Lt2PZESDm7FycAqocZ1cH4";

export default function SessionNotesPage() {
  const [sheetId, setSheetId] = useState<string>(FALLBACK_SHEET_ID);

  useEffect(() => {
    fetch("/api/data/last-fetch")
      .then(r => r.json())
      .then(d => { if (d?.sheetId) setSheetId(d.sheetId); })
      .catch(() => { /* keep fallback */ });
  }, []);

  const editUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?usp=sharing&rm=minimal`;
  const openUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] gap-3">
      <div className="flex items-start justify-between gap-4 flex-wrap shrink-0">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Session Notes</h2>
          <p className="text-sm text-gray-500 mt-1">
            The live cohort workbook (tabs 1000 / 2000 / 3000) — the source of truth for V1/V2 dates.
            Edit it right here; changes save straight to Google. You must be signed into a Google
            account with access to the sheet.
          </p>
        </div>
        <a
          href={openUrl}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 shrink-0"
        >
          Open in Google Sheets
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>

      <div className="flex-1 min-h-0 rounded-xl border border-gray-200 overflow-hidden bg-white">
        <iframe
          src={editUrl}
          title="PID Session Notes"
          className="w-full h-full"
          // Let Google's editor run fully inside the frame.
          allow="clipboard-read; clipboard-write"
        />
      </div>

      <p className="text-xs text-gray-400 shrink-0">
        Not seeing the sheet? Make sure you&rsquo;re logged into the Google account that has access,
        then reload. If Google blocks the embed, use the “Open in Google Sheets” button above.
      </p>
    </div>
  );
}
