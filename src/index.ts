import "dotenv/config";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import Stripe from "stripe";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type PlanId = "free" | "starter" | "pro";

type UserPlan = {
  id: PlanId;
  aiRequestsPerMonth: number;
  storageBytes: number;
};

type EffectiveUserPlan = UserPlan & {
  trialDays: number;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialActive: boolean;
  accessEndsAt: string | null;
  paymentRequired: boolean;
};

type AuthenticatedRequest = Request & {
  user: admin.auth.DecodedIdToken;
};

const FREE_TRIAL_DAYS = Number(process.env.FREE_TRIAL_DAYS ?? 7);
const BILLING_PROVIDER = process.env.BILLING_PROVIDER ?? "wayforpay";
const PAID_ACCESS_DAYS = Number(process.env.PAID_ACCESS_DAYS ?? 30);
const LIQPAY_CHECKOUT_URL = "https://www.liqpay.ua/api/3/checkout";

const PLANS: Record<PlanId, UserPlan> = {
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

const PLAN_BY_PRICE_ID = new Map<string, PlanId>(
  [
    [process.env.STRIPE_PRICE_STARTER_MONTHLY, "starter"],
    [process.env.STRIPE_PRICE_PRO_MONTHLY, "pro"],
  ].filter((entry): entry is [string, PlanId] => Boolean(entry[0])),
);

const app = express();
const port = Number(process.env.PORT ?? 8787);
const appUrl = process.env.APP_URL ?? "http://localhost:5173";
const publicProxyUrl = process.env.PUBLIC_PROXY_URL ?? "";
const geminiModel = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const liqpayPublicKey = process.env.LIQPAY_PUBLIC_KEY;
const liqpayPrivateKey = process.env.LIQPAY_PRIVATE_KEY;
const liqpayCurrency = process.env.LIQPAY_CURRENCY ?? "USD";
const liqpaySignatureAlgorithm = process.env.LIQPAY_SIGNATURE_ALGORITHM ?? "sha3-256";
const wayforpayMerchantAccount = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
const wayforpaySecretKey = process.env.WAYFORPAY_SECRET_KEY;
const wayforpayCurrency = process.env.WAYFORPAY_CURRENCY ?? "UAH";

initializeFirebase();

const db = admin.firestore();
const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-02-25.clover",
      typescript: true,
    })
  : null;
const genai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

app.disable("x-powered-by");
app.use(helmet());

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res, next) => {
    try {
      await handleStripeWebhook(req, res);
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/liqpay/callback",
  express.urlencoded({ extended: false }),
  async (req, res, next) => {
    try {
      await handleLiqPayCallback(req, res);
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/wayforpay/callback",
  express.json({ limit: "1mb" }),
  async (req, res, next) => {
    try {
      await handleWayForPayCallback(req, res);
    } catch (error) {
      next(error);
    }
  },
);

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
      portal: "/api/billing/portal",
      liqpayCallback: "/api/liqpay/callback",
      wayforpayCallback: "/api/wayforpay/callback",
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
  const userId = user.uid;
  const [plan, usage] = await Promise.all([getCurrentPlan(userId), getMonthlyUsage(userId)]);

  res.json({
    userId,
    email: user.email ?? null,
    plan,
    usage,
  });
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
    allowed: !plan.paymentRequired && projectedBytes <= plan.storageBytes,
    plan,
    storageBytes: usage.storageBytes,
    projectedBytes,
  });
});

app.post("/api/storage/sync", requireAuth, async (req, res) => {
  const user = authUser(req);
  if (!bucketName) {
    throw httpError(500, "FIREBASE_STORAGE_BUCKET is not configured.");
  }

  const prefix = `task-manager-life-focus/${user.uid}/`;
  const [files] = await admin.storage().bucket(bucketName).getFiles({ prefix });
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
  res.json({ storageBytes, plan, allowed: !plan.paymentRequired && storageBytes <= plan.storageBytes });
});

app.post("/api/billing/checkout", requireAuth, async (req, res) => {
  const user = authUser(req);
  const body = z.object({ plan: z.enum(["starter", "pro"]) }).parse(req.body);

  if (BILLING_PROVIDER === "wayforpay") {
    await ensureBillingUser(user.uid, user.email);
    res.json({
      provider: "wayforpay",
      checkoutUrl: process.env.WAYFORPAY_SUBSCRIPTION_URL ?? "",
    });
    return;
  }

  if (BILLING_PROVIDER === "liqpay") {
    const checkout = await createLiqPayCheckout(user, body.plan);
    res.json(checkout);
    return;
  }

  ensureStripe();
  const priceId =
    body.plan === "starter"
      ? process.env.STRIPE_PRICE_STARTER_MONTHLY
      : process.env.STRIPE_PRICE_PRO_MONTHLY;

  if (!priceId) {
    throw httpError(500, `Stripe price id for ${body.plan} is not configured.`);
  }

  const customerId = await getOrCreateStripeCustomer(user);
  const session = await stripe!.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/app/billing?checkout=success`,
    cancel_url: `${appUrl}/app/billing?checkout=cancelled`,
    metadata: {
      userId: user.uid,
      plan: body.plan,
    },
    subscription_data: {
      metadata: {
        userId: user.uid,
        plan: body.plan,
      },
    },
  });

  res.json({ url: session.url });
});

app.post("/api/billing/portal", requireAuth, async (req, res) => {
  const user = authUser(req);
  if (BILLING_PROVIDER === "wayforpay") {
    res.status(501).json({
      error: "WayForPay hosted subscriptions are managed on the WayForPay subscription page.",
    });
    return;
  }

  if (BILLING_PROVIDER === "liqpay") {
    res.status(501).json({
      error: "LiqPay billing portal is not available. Show plan renewal controls in the app.",
    });
    return;
  }

  ensureStripe();
  const customerId = await getOrCreateStripeCustomer(user);
  const session = await stripe!.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/app/billing`,
  });

  res.json({ url: session.url });
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
  app.listen(port, () => {
    console.log(`Task Manager AI proxy listening on http://localhost:${port}`);
  });
}

export default app;

function initializeFirebase() {
  if (admin.apps.length > 0) return;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    return;
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) throw httpError(401, "Missing Firebase ID token.");

    (req as AuthenticatedRequest).user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    next(error);
  }
}

function authUser(req: Request) {
  const user = (req as AuthenticatedRequest).user;
  if (!user) throw httpError(401, "Missing authenticated user.");
  return user;
}

async function generateJson(
  userId: string,
  input: { contents: string; temperature: number; maxOutputTokens: number },
) {
  ensureGemini();
  await reserveAiRequest(userId);

  const response = await genai!.models.generateContent({
    model: geminiModel,
    contents: input.contents,
    config: {
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      responseMimeType: "application/json",
    },
  });

  const text = response.text?.trim();
  if (!text) throw httpError(502, "Empty response from AI provider.");

  await getMonthlyUsageDoc(userId).set(
    {
      outputTokens: FieldValue.increment(Number(response.usageMetadata?.candidatesTokenCount ?? 0)),
      inputTokens: FieldValue.increment(Number(response.usageMetadata?.promptTokenCount ?? 0)),
      totalTokens: FieldValue.increment(Number(response.usageMetadata?.totalTokenCount ?? 0)),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  try {
    return { json: JSON.parse(text) };
  } catch {
    throw httpError(502, "AI provider returned invalid JSON.");
  }
}

async function reserveAiRequest(userId: string) {
  const usageRef = getMonthlyUsageDoc(userId);
  const plan = await getCurrentPlan(userId);

  if (plan.paymentRequired) {
    throw httpError(402, "Free trial ended. Choose the $3 or $5 plan to continue using AI.");
  }

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(usageRef);
    const aiRequests = Number(snapshot.data()?.aiRequests ?? 0);

    if (aiRequests >= plan.aiRequestsPerMonth) {
      throw httpError(402, "AI monthly limit reached. Upgrade the plan or wait for the next month.");
    }

    transaction.set(
      usageRef,
      {
        userId,
        month: currentMonthKey(),
        aiRequests: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function getCurrentPlan(userId: string): Promise<EffectiveUserPlan> {
  const snapshot = await ensureBillingUser(userId);
  const data = snapshot.data() ?? {};
  const planId = normalizePlan(data.planId) ?? "free";
  const basePlan = PLANS[planId] ?? PLANS.free;
  const trialStartedAt = timestampToDate(data.trialStartedAt);
  const trialEndsAt = timestampToDate(data.trialEndsAt);
  const accessEndsAt = timestampToDate(data.accessEndsAt) ?? timestampToDate(data.currentPeriodEnd);
  const isPaidPlan = planId === "starter" || planId === "pro";
  const paidActive = Boolean(isPaidPlan && (!accessEndsAt || accessEndsAt.getTime() > Date.now()));
  const trialActive = Boolean(trialEndsAt && trialEndsAt.getTime() > Date.now());

  return {
    ...basePlan,
    trialDays: FREE_TRIAL_DAYS,
    trialStartedAt: trialStartedAt ? trialStartedAt.toISOString() : null,
    trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
    trialActive: paidActive || trialActive,
    accessEndsAt: accessEndsAt ? accessEndsAt.toISOString() : null,
    paymentRequired: !paidActive && !trialActive,
  };
}

async function getMonthlyUsage(userId: string) {
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

async function getOrCreateStripeCustomer(user: admin.auth.DecodedIdToken) {
  ensureStripe();
  const ref = getUserDoc(user.uid);
  const snapshot = await ensureBillingUser(user.uid, user.email);
  const existing = snapshot.data()?.stripeCustomerId;
  if (existing) return String(existing);

  const customer = await stripe!.customers.create({
    email: user.email,
    metadata: { userId: user.uid },
  });

  await ref.set(
    {
      stripeCustomerId: customer.id,
      email: user.email ?? null,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: snapshot.exists ? snapshot.data()?.createdAt ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return customer.id;
}

async function ensureBillingUser(userId: string, email?: string) {
  const ref = getUserDoc(userId);
  const snapshot = await ref.get();
  const now = new Date();
  const data = snapshot.data();
  const trialStartedAt = timestampToDate(data?.trialStartedAt) ?? now;
  const trialEndsAt =
    timestampToDate(data?.trialEndsAt) ??
    new Date(trialStartedAt.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);

  if (!snapshot.exists || !data?.trialEndsAt) {
    await ref.set(
      {
        planId: normalizePlan(data?.planId) ?? "free",
        email: email ?? data?.email ?? null,
        trialStartedAt: Timestamp.fromDate(trialStartedAt),
        trialEndsAt: Timestamp.fromDate(trialEndsAt),
        createdAt: data?.createdAt ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return ref.get();
  }

  if (email && data.email !== email) {
    await ref.set(
      {
        email,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  return snapshot;
}

async function createLiqPayCheckout(user: admin.auth.DecodedIdToken, plan: "starter" | "pro") {
  ensureLiqPay();
  if (!publicProxyUrl) {
    throw httpError(500, "PUBLIC_PROXY_URL is required for LiqPay callbacks.");
  }
  await ensureBillingUser(user.uid, user.email);

  const amount = plan === "starter" ? liqpayAmount("STARTER", 3) : liqpayAmount("PRO", 5);
  const orderId = `${user.uid}_${plan}_${Date.now()}`;
  const description = `Task Manager ${plan} plan - ${PAID_ACCESS_DAYS} days`;
  const payload = {
    public_key: liqpayPublicKey,
    version: 7,
    action: "pay",
    amount,
    currency: liqpayCurrency,
    description,
    order_id: orderId,
    result_url: `${appUrl}/app/billing?checkout=success`,
    server_url: `${publicProxyUrl}/api/liqpay/callback`,
    info: JSON.stringify({ userId: user.uid, plan }),
  };
  const data = encodeLiqPayData(payload);
  const signature = signLiqPayData(data);

  await db.collection("billingOrders").doc(orderId).set({
    userId: user.uid,
    plan,
    provider: "liqpay",
    amount,
    currency: liqpayCurrency,
    status: "created",
    data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    provider: "liqpay",
    checkoutUrl: LIQPAY_CHECKOUT_URL,
    method: "POST",
    data,
    signature,
    orderId,
  };
}

async function handleLiqPayCallback(req: Request, res: Response) {
  ensureLiqPay();
  const body = z.object({ data: z.string(), signature: z.string() }).parse(req.body);
  const expectedSignature = signLiqPayData(body.data);

  if (!safeEqual(body.signature, expectedSignature)) {
    throw httpError(400, "Invalid LiqPay callback signature.");
  }

  const payload = decodeLiqPayData(body.data);
  const orderId = String(payload.order_id ?? "");
  const status = String(payload.status ?? "");
  const orderRef = db.collection("billingOrders").doc(orderId);
  const orderSnapshot = await orderRef.get();
  const order = orderSnapshot.data();
  const plan = normalizePlan(order?.plan) ?? normalizePlanFromLiqPayInfo(payload.info);
  const userId = String(order?.userId ?? payload.userId ?? "");

  await orderRef.set(
    {
      liqpayPayload: payload,
      status,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  if (userId && (status === "success" || status === "subscribed") && (plan === "starter" || plan === "pro")) {
    const now = Date.now();
    const currentPlan = await getCurrentPlan(userId);
    const baseAccessEndsAt =
      currentPlan.accessEndsAt && new Date(currentPlan.accessEndsAt).getTime() > now
        ? new Date(currentPlan.accessEndsAt).getTime()
        : now;
    const accessEndsAt = new Date(baseAccessEndsAt + PAID_ACCESS_DAYS * 24 * 60 * 60 * 1000);

    await setUserSubscription(userId, {
      planId: plan,
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      subscriptionStatus: "active",
      currentPeriodEnd: Timestamp.fromDate(accessEndsAt),
      accessEndsAt: Timestamp.fromDate(accessEndsAt),
      billingProvider: "liqpay",
      liqpayOrderId: orderId,
      liqpayPaymentId: payload.payment_id ? String(payload.payment_id) : null,
    });
  }

  res.json({ ok: true });
}

async function handleWayForPayCallback(req: Request, res: Response) {
  ensureWayForPay();
  const payload = z
    .object({
      merchantAccount: z.string(),
      orderReference: z.string(),
      merchantSignature: z.string(),
      amount: z.union([z.string(), z.number()]),
      currency: z.string(),
      authCode: z.string().optional().default(""),
      cardPan: z.string().optional().default(""),
      transactionStatus: z.string(),
      reasonCode: z.union([z.string(), z.number()]),
      email: z.string().email().optional(),
      clientEmail: z.string().email().optional(),
      productName: z.union([z.string(), z.array(z.string())]).optional(),
      createdDate: z.union([z.string(), z.number()]).optional(),
      processingDate: z.union([z.string(), z.number()]).optional(),
    })
    .passthrough()
    .parse(req.body);

  if (wayforpayMerchantAccount && payload.merchantAccount !== wayforpayMerchantAccount) {
    throw httpError(400, "Invalid WayForPay merchant account.");
  }

  const expectedSignature = signWayForPayServicePayload({
    merchantAccount: payload.merchantAccount,
    orderReference: payload.orderReference,
    amount: payload.amount,
    currency: payload.currency,
    authCode: payload.authCode,
    cardPan: payload.cardPan,
    transactionStatus: payload.transactionStatus,
    reasonCode: payload.reasonCode,
  });

  if (!safeEqual(payload.merchantSignature, expectedSignature)) {
    throw httpError(400, "Invalid WayForPay callback signature.");
  }

  const paymentEmail = (payload.email ?? payload.clientEmail ?? "").trim().toLowerCase();
  const plan = resolveWayForPayPlan(payload.amount, payload.productName);
  const successful = payload.transactionStatus === "Approved" && String(payload.reasonCode) === "1100";
  const time = Math.floor(Date.now() / 1000);

  await db.collection("billingOrders").doc(payload.orderReference).set(
    {
      provider: "wayforpay",
      status: payload.transactionStatus,
      reasonCode: String(payload.reasonCode),
      amount: Number(payload.amount),
      currency: payload.currency,
      email: paymentEmail || null,
      plan,
      payload,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  if (successful && paymentEmail && (plan === "starter" || plan === "pro")) {
    const userSnapshot = await findBillingUserByEmail(paymentEmail);

    if (userSnapshot) {
      const userId = userSnapshot.id;
      const now = Date.now();
      const currentPlan = await getCurrentPlan(userId);
      const baseAccessEndsAt =
        currentPlan.accessEndsAt && new Date(currentPlan.accessEndsAt).getTime() > now
          ? new Date(currentPlan.accessEndsAt).getTime()
          : now;
      const accessEndsAt = new Date(baseAccessEndsAt + PAID_ACCESS_DAYS * 24 * 60 * 60 * 1000);

      await setUserSubscription(userId, {
        planId: plan,
        stripeCustomerId: "",
        stripeSubscriptionId: "",
        subscriptionStatus: "active",
        currentPeriodEnd: Timestamp.fromDate(accessEndsAt),
        accessEndsAt: Timestamp.fromDate(accessEndsAt),
        billingProvider: "wayforpay",
        wayforpayOrderReference: payload.orderReference,
      });
    } else {
      await db.collection("unmatchedBillingPayments").doc(payload.orderReference).set(
        {
          provider: "wayforpay",
          email: paymentEmail,
          plan,
          amount: Number(payload.amount),
          currency: payload.currency,
          payload,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  }

  res.json({
    orderReference: payload.orderReference,
    status: "accept",
    time,
    signature: signWayForPayAccept(payload.orderReference, time),
  });
}

async function handleStripeWebhook(req: Request, res: Response) {
  ensureStripe();
  const signature = req.header("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    throw httpError(400, "Stripe webhook signature or secret is missing.");
  }

  const event = stripe!.webhooks.constructEvent(req.body, signature, webhookSecret);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = normalizePlan(session.metadata?.plan);
      if (userId && plan) {
        await setUserSubscription(userId, {
          planId: plan,
          stripeCustomerId: String(session.customer ?? ""),
          stripeSubscriptionId: String(session.subscription ?? ""),
          subscriptionStatus: "active",
        });
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      const firstItem = subscription.items.data[0];
      const plan = normalizePlan(subscription.metadata?.plan) ?? normalizePlanByPrice(firstItem?.price.id);
      const active = event.type !== "customer.subscription.deleted" && ["active", "trialing"].includes(subscription.status);

      if (userId) {
        await setUserSubscription(userId, {
          planId: active && plan ? plan : "free",
          stripeCustomerId: String(subscription.customer),
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          currentPeriodEnd: firstItem?.current_period_end
            ? Timestamp.fromMillis(firstItem.current_period_end * 1000)
            : null,
        });
      }
      break;
    }
  }

  res.json({ received: true });
}

async function setUserSubscription(
  userId: string,
  data: {
    planId: PlanId;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    subscriptionStatus: string;
    currentPeriodEnd?: Timestamp | null;
    accessEndsAt?: Timestamp | null;
    billingProvider?: string;
    liqpayOrderId?: string;
    liqpayPaymentId?: string | null;
    wayforpayOrderReference?: string;
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

function getUserDoc(userId: string) {
  return db.collection("billingUsers").doc(userId);
}

function getMonthlyUsageDoc(userId: string) {
  return getUserDoc(userId).collection("usage").doc(currentMonthKey());
}

function currentMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizePlan(value: unknown): PlanId | null {
  return value === "free" || value === "starter" || value === "pro" ? value : null;
}

function normalizePlanByPrice(priceId: string | undefined): PlanId | null {
  return priceId ? PLAN_BY_PRICE_ID.get(priceId) ?? null : null;
}

function normalizePlanFromLiqPayInfo(info: unknown): PlanId | null {
  if (typeof info !== "string") return null;
  try {
    const parsed = JSON.parse(info) as { plan?: unknown };
    return normalizePlan(parsed.plan);
  } catch {
    return null;
  }
}

function resolveWayForPayPlan(
  amountValue: string | number,
  productName: string | string[] | undefined,
): PlanId {
  const names = Array.isArray(productName) ? productName : productName ? [productName] : [];
  const normalizedName = names.join(" ").toLowerCase();
  if (normalizedName.includes("pro")) return "pro";
  if (normalizedName.includes("starter")) return "starter";

  const amount = Number(amountValue);
  const proAmount = Number(process.env.WAYFORPAY_PRO_AMOUNT ?? 200);
  const starterAmount = Number(process.env.WAYFORPAY_STARTER_AMOUNT ?? 120);
  if (amount >= proAmount) return "pro";
  if (amount >= starterAmount) return "starter";
  return "free";
}

async function findBillingUserByEmail(email: string) {
  const snapshot = await db
    .collection("billingUsers")
    .where("email", "==", email)
    .limit(1)
    .get();
  return snapshot.docs[0] ?? null;
}

function timestampToDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function ensureStripe() {
  if (!stripe) throw httpError(500, "STRIPE_SECRET_KEY is not configured.");
}

function ensureLiqPay() {
  if (!liqpayPublicKey || !liqpayPrivateKey) {
    throw httpError(500, "LIQPAY_PUBLIC_KEY and LIQPAY_PRIVATE_KEY are not configured.");
  }
}

function ensureWayForPay() {
  if (!wayforpaySecretKey) {
    throw httpError(500, "WAYFORPAY_SECRET_KEY is not configured.");
  }
}

function ensureGemini() {
  if (!genai) throw httpError(500, "GEMINI_API_KEY is not configured.");
}

function liqpayAmount(planKey: "STARTER" | "PRO", fallback: number) {
  return Number(process.env[`LIQPAY_${planKey}_AMOUNT`] ?? fallback);
}

function encodeLiqPayData(payload: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function decodeLiqPayData(data: string) {
  return JSON.parse(Buffer.from(data, "base64").toString("utf8")) as Record<string, unknown>;
}

function signLiqPayData(data: string) {
  const signString = `${liqpayPrivateKey}${data}${liqpayPrivateKey}`;
  return createHash(liqpaySignatureAlgorithm).update(signString).digest("base64");
}

function signWayForPayServicePayload(payload: {
  merchantAccount: string;
  orderReference: string;
  amount: string | number;
  currency: string;
  authCode: string;
  cardPan: string;
  transactionStatus: string;
  reasonCode: string | number;
}) {
  return signWayForPay(
    [
      payload.merchantAccount,
      payload.orderReference,
      payload.amount,
      payload.currency,
      payload.authCode,
      payload.cardPan,
      payload.transactionStatus,
      payload.reasonCode,
    ].join(";"),
  );
}

function signWayForPayAccept(orderReference: string, time: number) {
  return signWayForPay([orderReference, "accept", time].join(";"));
}

function signWayForPay(baseString: string) {
  return createHmac("md5", wayforpaySecretKey!).update(baseString, "utf8").digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

const CATEGORY_LIST =
  "health, career, learning, finance, relationships, home, leisure, other";
const PRIORITY_LIST = "low, medium, high";

const PARSE_TASKS_SYSTEM = `You are a task extraction assistant. Extract tasks from the user's natural language input.
Return a JSON object with a "tasks" array. Each task has:
- title: string
- priority: one of ${PRIORITY_LIST}
- time: number duration in minutes, 0 if not specified
- category: one of ${CATEGORY_LIST} or null
Handle Ukrainian and English. Return ONLY valid JSON, no markdown.`;

const ADVISOR_ADVICE_ONLY_SYSTEM = `Ти - помічник з планування часу та продуктивності. Відповідай українською, коротко та зрозуміло. Поверни JSON лише з полем "advice" - текст поради без markdown.`;

const ADVISOR_TASKS_ONLY_SYSTEM = `Ти формуєш список задач на основі поради. Поверни JSON лише з полем "tasks" - масив задач. Кожна задача: title, priority ("low"|"medium"|"high"), time (тривалість у хвилинах), category з [${CATEGORY_LIST}] або null, whenDo - масив 1-7 опційно.`;
