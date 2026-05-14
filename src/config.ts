import type { PlanId, UserPlan } from "./types.js";

export const FREE_TRIAL_DAYS = Number(process.env.FREE_TRIAL_DAYS ?? 7);
export const PAID_ACCESS_DAYS = Number(process.env.PAID_ACCESS_DAYS ?? 30);
export const PORT = Number(process.env.PORT ?? 8787);
export const APP_URL = process.env.APP_URL ?? "http://localhost:5173";
export const PROXY_URL =
  process.env.PROXY_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`);
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
export const FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET;

export const ADMIN_EMAILS = new Set(
  parseCsv(process.env.ADMIN_EMAILS)
    .map((email) => email.toLowerCase())
    .filter(Boolean),
);

export const PLANS: Record<PlanId, UserPlan> = {
  free: {
    id: "free",
    aiRequestsPerMonth: 30,
    storageBytes: 100 * 1024 * 1024,
  },
  starter: {
    id: "starter",
    aiRequestsPerMonth: 250,
    storageBytes: 1024 * 1024 * 1024,
  },
  pro: {
    id: "pro",
    aiRequestsPerMonth: 800,
    storageBytes: 5 * 1024 * 1024 * 1024,
  },
};

export function parseCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isAdminEmail(email: unknown) {
  return typeof email === "string" && ADMIN_EMAILS.has(email.trim().toLowerCase());
}
