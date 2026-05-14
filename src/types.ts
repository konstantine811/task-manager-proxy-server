import type { Request } from "express";
import type admin from "firebase-admin";

export type PlanId = "free" | "starter" | "pro";

export type UserPlan = {
  id: PlanId;
  aiRequestsPerMonth: number;
  storageBytes: number;
};

export type EffectiveUserPlan = UserPlan & {
  trialDays: number;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialActive: boolean;
  accessEndsAt: string | null;
  paymentRequired: boolean;
  adminAccess: boolean;
};

export type AdminBillingUser = {
  userId: string;
  email: string | null;
  plan: EffectiveUserPlan;
  status: "admin" | "paid-active" | "trial-active" | "expired";
  billingProvider: string | null;
  subscriptionStatus: string | null;
  portmoneOrderReference: string | null;
  updatedAt: string | null;
  createdAt: string | null;
};

export type AuthenticatedRequest = Request & {
  user: admin.auth.DecodedIdToken;
};
