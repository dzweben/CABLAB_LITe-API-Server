import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// Auth is enforced by middleware.ts — if we reach this handler, the caller has a valid cookie.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dataPath = path.join(process.cwd(), "private", "data", "participants.json");
    const raw = await fs.readFile(dataPath, "utf-8");
    return NextResponse.json(JSON.parse(raw));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to load participants", details: msg }, { status: 500 });
  }
}
