import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Ensure private/data/*.json is bundled with the data API routes on Vercel.
  // Without this, the serverless function can't find the files at runtime.
  outputFileTracingIncludes: {
    "/api/data/participants": ["./private/data/**/*"],
    "/api/data/sent-log": ["./private/data/**/*"],
    "/api/data/todays-reminders": ["./private/data/**/*"],
    "/api/data/screener-migrations": ["./private/data/**/*"],
    "/api/data/audits": ["./private/data/**/*"],
    // The EMA sweeper reads the prompt schedule + participants, and
    // renders the exact prompt text from the timeline source.
    "/api/ema-sweep": ["./private/data/**/*", "./src/lib/timeline.ts"],
  },
};

export default nextConfig;
