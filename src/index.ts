import "dotenv/config";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { FIREBASE_STORAGE_BUCKET, FREE_TRIAL_DAYS, PLANS, PORT, parseCsv } from "./config.js";
import { admin, db } from "./firebase.js";
import { authUser, requireAdmin, requireAuth } from "./auth.js";
import { httpError } from "./errors.js";
import {
  ADVISOR_ADVICE_ONLY_SYSTEM,
  ADVISOR_TASKS_ONLY_SYSTEM,
  PARSE_TASKS_SYSTEM,
  generateJson,
} from "./ai.js";
import {
  getCurrentPlan,
  getMonthlyUsage,
  getUserDoc,
  getUserIdByEmail,
  toAdminBillingUser,
} from "./billing/users.js";
import {
  createPortmoneCheckout,
  handlePortmoneCallback,
  renderPortmoneCheckout,
  refundPortmoneOrder,
  syncPortmoneOrder,
} from "./billing/portmone.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      const allowed = parseCsv(process.env.CORS_ORIGINS);
      if (!origin || allowed.length === 0 || allowed.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin is not allowed by CORS: ${origin}`));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "task-manager-ai-proxy",
    health: "/health",
    authenticated: {
      me: "/api/me",
      parseTasks: "/api/ai/parse-tasks",
      advisorAdvice: "/api/ai/advisor/advice",
      advisorTasks: "/api/ai/advisor/tasks",
      checkout: "/api/billing/checkout",
      adminUsers: "/api/admin/users",
      adminTrial: "/api/admin/users/trial",
      adminPortmoneRefund: "/api/admin/portmone/refund",
      portmoneCallback: "/api/portmone/callback",
    },
  });
});

app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => {
  res.status(204).end();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, freeTrialDays: FREE_TRIAL_DAYS, plans: PLANS });
});

app.get("/api/me", requireAuth, async (req, res) => {
  const user = authUser(req);
  const [plan, usage] = await Promise.all([
    getCurrentPlan(user.uid, user.email),
    getMonthlyUsage(user.uid),
  ]);

  res.json({
    userId: user.uid,
    email: user.email ?? null,
    plan,
    usage,
  });
});

app.get("/api/admin/users", requireAuth, requireAdmin, async (_req, res) => {
  const snapshot = await db.collection("billingUsers").limit(500).get();
  const users = snapshot.docs
    .map((docSnap) => toAdminBillingUser(docSnap.id, docSnap.data()))
    .sort((left, right) => {
      const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
      const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
      return rightTime - leftTime;
    });

  res.json({
    users,
    total: users.length,
    activePaid: users.filter((user) => user.status === "paid-active").length,
  });
});

app.post("/api/admin/users/trial", requireAuth, requireAdmin, async (req, res) => {
  const body = z
    .object({
      email: z.string().email().optional(),
      userId: z.string().min(1).optional(),
      trialEndsAt: z.string().datetime().optional(),
      trialDaysFromNow: z.number().finite().optional(),
      expired: z.boolean().optional(),
    })
    .refine((value) => value.email || value.userId, {
      message: "Provide either email or userId.",
      path: ["email"],
    })
    .refine(
      (value) =>
        [value.trialEndsAt, value.trialDaysFromNow, value.expired ? true : undefined].filter(
          (item) => item !== undefined,
        ).length === 1,
      {
        message: "Provide exactly one of trialEndsAt, trialDaysFromNow, or expired.",
        path: ["trialEndsAt"],
      },
    )
    .parse(req.body);

  const userId = body.userId ?? (await getUserIdByEmail(body.email!));
  const now = new Date();
  const trialEndsAt = body.expired
    ? new Date(now.getTime() - 60 * 1000)
    : body.trialEndsAt
      ? new Date(body.trialEndsAt)
      : new Date(now.getTime() + Number(body.trialDaysFromNow) * 24 * 60 * 60 * 1000);

  await getUserDoc(userId).set(
    {
      planId: "free",
      trialStartedAt: Timestamp.fromDate(now),
      trialEndsAt: Timestamp.fromDate(trialEndsAt),
      accessEndsAt: FieldValue.delete(),
      currentPeriodEnd: FieldValue.delete(),
      subscriptionStatus: "admin_test_override",
      updatedAt: FieldValue.serverTimestamp(),
      ...(body.email ? { email: body.email.trim().toLowerCase() } : {}),
    },
    { merge: true },
  );

  const [plan, usage] = await Promise.all([getCurrentPlan(userId), getMonthlyUsage(userId)]);
  res.json({ userId, email: body.email ?? null, plan, usage });
});

app.post("/api/ai/parse-tasks", requireAuth, async (req, res) => {
  const user = authUser(req);
  const body = z.object({ text: z.string().min(1).max(8000) }).parse(req.body);
  const result = await generateJson(user.uid, {
    contents: `${PARSE_TASKS_SYSTEM}\n\nUser input:\n${body.text}`,
    temperature: 0.2,
    maxOutputTokens: 2048,
  });

  res.json(result.json);
});

app.post("/api/ai/advisor/advice", requireAuth, async (req, res) => {
  const user = authUser(req);
  const body = z
    .object({
      prompt: z.string().min(1).max(12000),
      tasksContext: z.string().max(30000).optional(),
    })
    .parse(req.body);
  const context = body.tasksContext ? `\n\nКонтекст - задачі:\n${body.tasksContext}\n` : "";

  const result = await generateJson(user.uid, {
    contents: `${ADVISOR_ADVICE_ONLY_SYSTEM}\n\n${context}\n\nЗапит:\n${body.prompt.trim()}`,
    temperature: 0.7,
    maxOutputTokens: 8192,
  });

  res.json(result.json);
});

app.post("/api/ai/advisor/tasks", requireAuth, async (req, res) => {
  const user = authUser(req);
  const body = z
    .object({
      previousAdvice: z.string().min(1).max(30000),
      templateTasksContext: z.string().max(30000).optional(),
    })
    .parse(req.body);
  const context = body.templateTasksContext
    ? `\n\nПоточні задачі в шаблоні:\n${body.templateTasksContext}\n`
    : "";

  const result = await generateJson(user.uid, {
    contents: `${ADVISOR_TASKS_ONLY_SYSTEM}\n\n${context}\n\nПорада:\n${body.previousAdvice.trim()}`,
    temperature: 0.5,
    maxOutputTokens: 8192,
  });

  res.json(result.json);
});

app.post("/api/storage/check-capacity", requireAuth, async (req, res) => {
  const user = authUser(req);
  const body = z.object({ additionalBytes: z.number().int().min(0) }).parse(req.body);
  const plan = await getCurrentPlan(user.uid);
  const usage = await getMonthlyUsage(user.uid);
  const projectedBytes = usage.storageBytes + body.additionalBytes;

  res.json({
    allowed: plan.adminAccess || (!plan.paymentRequired && projectedBytes <= plan.storageBytes),
    plan,
    storageBytes: usage.storageBytes,
    projectedBytes,
  });
});

app.post("/api/storage/sync", requireAuth, async (req, res) => {
  const user = authUser(req);
  if (!FIREBASE_STORAGE_BUCKET) {
    throw httpError(500, "FIREBASE_STORAGE_BUCKET is not configured.");
  }

  const prefix = `task-manager-life-focus/${user.uid}/`;
  const [files] = await admin.storage().bucket(FIREBASE_STORAGE_BUCKET).getFiles({ prefix });
  const storageBytes = files.reduce((sum, file) => sum + Number(file.metadata.size ?? 0), 0);

  await getUserDoc(user.uid).set(
    {
      storageBytes,
      storageSyncedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const plan = await getCurrentPlan(user.uid);
  res.json({
    storageBytes,
    plan,
    allowed: plan.adminAccess || (!plan.paymentRequired && storageBytes <= plan.storageBytes),
  });
});

app.post("/api/billing/checkout", requireAuth, async (req, res) => {
  const user = authUser(req);
  const body = z.object({ plan: z.enum(["starter", "pro"]) }).parse(req.body);
  res.json(await createPortmoneCheckout(user, body.plan));
});

app.get("/api/portmone/checkout/:orderReference", async (req, res) => {
  await renderPortmoneCheckout(req, res);
});

app.post("/api/portmone/callback", async (req, res) => {
  await handlePortmoneCallback(req, res);
});

app.get("/api/portmone/callback", async (req, res) => {
  await handlePortmoneCallback(req, res);
});

app.post("/api/portmone/sync", requireAuth, requireAdmin, async (req, res) => {
  const body = z.object({ orderReference: z.string().min(1) }).parse(req.body);
  res.json({ order: await syncPortmoneOrder(body.orderReference) });
});

app.post("/api/admin/portmone/refund", requireAuth, requireAdmin, async (req, res) => {
  const body = z
    .object({
      orderReference: z.string().min(1),
      amount: z.number().finite().positive().optional(),
      message: z.string().max(500).optional(),
    })
    .parse(req.body);
  res.json(await refundPortmoneOrder(body.orderReference, body));
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request body.", details: error.issues });
    return;
  }

  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
  const message = error instanceof Error ? error.message : "Internal server error.";
  res.status(status || 500).json({ error: message });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Task Manager AI proxy listening on http://localhost:${PORT}`);
  });
}

export default app;
