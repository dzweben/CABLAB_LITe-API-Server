// Cohort filter used by every dashboard page.
//
// Cohorts are derived from PID prefix:
//   1000-1999 = Cohort 1
//   2000-2999 = Cohort 2
//   3000-3999 = Cohort 3
//
// This is an OPTIONAL filter — by default a page shows all cohorts. The
// user can layer a single cohort on top by clicking the pill, and the
// selection persists in localStorage so it survives page navigation.

"use client";

import { useEffect, useState, useCallback } from "react";

export type Cohort = "all" | "1" | "2" | "3";

const STORAGE_KEY = "lite-cohort-filter";

export function cohortOfPid(pid: string): "1" | "2" | "3" | null {
  const n = Number(String(pid).replace(/\.0$/, ""));
  if (!isFinite(n)) return null;
  if (n >= 1000 && n <= 1999) return "1";
  if (n >= 2000 && n <= 2999) return "2";
  if (n >= 3000 && n <= 3999) return "3";
  return null;
}

export function cohortMatches(pid: string, c: Cohort): boolean {
  if (c === "all") return true;
  return cohortOfPid(pid) === c;
}

export function useCohort(): [Cohort, (c: Cohort) => void] {
  const [c, setC] = useState<Cohort>("all");
  // Restore from localStorage after mount (SSR-safe)
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "all" || stored === "1" || stored === "2" || stored === "3") {
        setC(stored);
      }
    } catch { /* localStorage blocked — ignore */ }
  }, []);
  const update = useCallback((next: Cohort) => {
    setC(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  }, []);
  return [c, update];
}
