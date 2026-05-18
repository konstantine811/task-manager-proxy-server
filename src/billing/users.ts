import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { FREE_TRIAL_DAYS, PLANS, isAdminEmail } from "../config.js";
import { db, admin } from "../firebase.js";
import { httpError } from "../errors.js";
import type { AdminBillingUser, EffectiveUserPlan, PlanId } from "../types.js";

export function getUserDoc(userId: string) {
  return db.collection("billingUsers").doc(userId);
}

export function getMonthlyUsageDoc(userId: string) {
  return getUserDoc(userId).collection("usage").doc(currentMonthKey());
}

export function currentMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getCurrentPlan(
  userId: string,
  email?: string | null,
): Promise<EffectiveUserPlan> {
  const snapshot = await ensureBillingUser(userId, email ?? undefined);
  return buildEffectivePlan(snapshot.data() ?? {});
}

export function buildEffectivePlan(data: FirebaseFirestore.DocumentData): EffectiveUserPlan {
  const adminAccess = data.adminAccess === true || isAdminEmail(data.email);
  const planId = normalizePlan(data.planId) ?? "free";
  const basePlan = adminAccess ? PLANS.pro : PLANS[planId] ?? PLANS.free;
  const trialStartedAt = timestampToDate(data.trialStartedAt);
  const trialEndsAt = timestampToDate(data.trialEndsAt);
  const accessEndsAt = timestampToDate(data.accessEndsAt) ?? timestampToDate(data.currentPeriodEnd);
  const isPaidPlan = planId === "starter" || planId === "pro";
  const paidActive = Boolean(isPaidPlan && (!accessEndsAt || accessEndsAt.getTime() > Date.now()));
  const trialActive = Boolean(trialEndsAt && trialEndsAt.getTime() > Date.now());
  const activePlan = adminAccess || paidActive ? basePlan : PLANS.free;

  return {
    ...activePlan,
    trialDays: FREE_TRIAL_DAYS,
    trialStartedAt: trialStartedAt ? trialStartedAt.toISOString() : null,
    trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
    trialActive: adminAccess || paidActive || trialActive,
    accessEndsAt: accessEndsAt ? accessEndsAt.toISOString() : null,
    paymentRequired: false,
    adminAccess,
  };
}

export function toAdminBillingUser(
  userId: string,
  data: FirebaseFirestore.DocumentData,
): AdminBillingUser {
  const plan = buildEffectivePlan(data);
  const status: AdminBillingUser["status"] = plan.adminAccess
    ? "admin"
    : plan.id !== "free" && !plan.paymentRequired
      ? "paid-active"
      : plan.trialActive
        ? "trial-active"
        : "expired";

  return {
    userId,
    email: typeof data.email === "string" ? data.email : null,
    plan,
    status,
    billingProvider: typeof data.billingProvider === "string" ? data.billingProvider : null,
    subscriptionStatus:
      typeof data.subscriptionStatus === "string" ? data.subscriptionStatus : null,
    portmoneOrderReference:
      typeof data.portmoneOrderReference === "string"
        ? data.portmoneOrderReference
        : null,
    updatedAt: timestampToDate(data.updatedAt)?.toISOString() ?? null,
    createdAt: timestampToDate(data.createdAt)?.toISOString() ?? null,
  };
}

export async function getMonthlyUsage(userId: string) {
  const [usageSnapshot, userSnapshot] = await Promise.all([
    getMonthlyUsageDoc(userId).get(),
    getUserDoc(userId).get(),
  ]);
  const usage = usageSnapshot.data() ?? {};
  const user = userSnapshot.data() ?? {};

  return {
    month: currentMonthKey(),
    aiRequests: Number(usage.aiRequests ?? 0),
    inputTokens: Number(usage.inputTokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? 0),
    totalTokens: Number(usage.totalTokens ?? 0),
    storageBytes: Number(user.storageBytes ?? 0),
  };
}

export async function ensureBillingUser(userId: string, email?: string) {
  const ref = getUserDoc(userId);
  const snapshot = await ref.get();
  const now = new Date();
  const data = snapshot.data();
  const nextEmail = email ?? data?.email ?? null;
  const adminAccess = isAdminEmail(nextEmail);
  const trialStartedAt = timestampToDate(data?.trialStartedAt) ?? now;
  const trialEndsAt =
    timestampToDate(data?.trialEndsAt) ??
    new Date(trialStartedAt.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);

  if (!snapshot.exists || !data?.trialEndsAt) {
    await ref.set(
      {
        planId: normalizePlan(data?.planId) ?? "free",
        email: nextEmail,
        adminAccess,
        trialStartedAt: Timestamp.fromDate(trialStartedAt),
        trialEndsAt: Timestamp.fromDate(trialEndsAt),
        createdAt: data?.createdAt ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return ref.get();
  }

  if ((email && data.email !== email) || data.adminAccess !== adminAccess) {
    await ref.set(
      {
        email: nextEmail,
        adminAccess,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  return snapshot;
}

export async function setUserSubscription(
  userId: string,
  data: {
    planId: PlanId;
    subscriptionStatus: string;
    currentPeriodEnd?: Timestamp | null;
    accessEndsAt?: Timestamp | null;
    billingProvider?: string;
    portmoneOrderReference?: string;
  },
) {
  await getUserDoc(userId).set(
    {
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export async function setManualUserAccess(
  userId: string,
  data: {
    planId: Exclude<PlanId, "free">;
    accessEndsAt: Timestamp;
    email?: string | null;
  },
) {
  await getUserDoc(userId).set(
    {
      planId: data.planId,
      accessEndsAt: data.accessEndsAt,
      currentPeriodEnd: data.accessEndsAt,
      billingProvider: "manual",
      subscriptionStatus: "manual_active",
      updatedAt: FieldValue.serverTimestamp(),
      ...(data.email ? { email: data.email.trim().toLowerCase() } : {}),
    },
    { merge: true },
  );
}

export function normalizePlan(value: unknown): PlanId | null {
  return value === "free" || value === "starter" || value === "pro" ? value : null;
}

export async function findBillingUserByEmail(email: string) {
  const snapshot = await db
    .collection("billingUsers")
    .where("email", "==", email)
    .limit(1)
    .get();
  return snapshot.docs[0] ?? null;
}

export async function getUserIdByEmail(email: string) {
  try {
    const user = await admin.auth().getUserByEmail(email.trim().toLowerCase());
    return user.uid;
  } catch {
    throw httpError(404, `Firebase user was not found for email: ${email}`);
  }
}

export function timestampToDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
