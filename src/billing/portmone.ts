import type { Request, Response } from "express";
import { createHmac, randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { APP_URL, PAID_ACCESS_DAYS, PROXY_URL } from "../config.js";
import { db } from "../firebase.js";
import { httpError } from "../errors.js";
import type { PlanId } from "../types.js";
import {
  ensureBillingUser,
  getCurrentPlan,
  setUserSubscription,
} from "./users.js";

type PortmoneOrder = {
  userId: string;
  email: string | null;
  plan: PlanId;
  amount: number;
  currency: string;
};

type PortmoneReportRow = {
  status?: string;
  shopBillId?: string;
  shopOrderNumber?: string;
  billAmount?: string | number;
  errorCode?: string | number;
  errorMessage?: string;
};

const PORTMONE_GATEWAY_URL =
  process.env.PORTMONE_GATEWAY_URL ?? "https://www.portmone.com.ua/gateway/";
const PORTMONE_PAYEE_ID = process.env.PORTMONE_PAYEE_ID;
const PORTMONE_LOGIN = process.env.PORTMONE_LOGIN;
const PORTMONE_PASSWORD = process.env.PORTMONE_PASSWORD;
const PORTMONE_SIGNATURE_KEY = process.env.PORTMONE_SIGNATURE_KEY;
const PORTMONE_CURRENCY = process.env.PORTMONE_CURRENCY ?? "UAH";
const PORTMONE_LANGUAGE = process.env.PORTMONE_LANGUAGE ?? "uk";

export async function createPortmoneCheckout(
  user: { uid: string; email?: string },
  plan: Extract<PlanId, "starter" | "pro">,
) {
  ensurePortmoneCheckoutConfig();
  await ensureBillingUser(user.uid, user.email);

  const amount = getPortmonePlanAmount(plan);
  const orderReference = `lf-${plan}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const order: PortmoneOrder = {
    userId: user.uid,
    email: user.email?.trim().toLowerCase() ?? null,
    plan,
    amount,
    currency: PORTMONE_CURRENCY,
  };

  // The local checkout page submits a signed form to Portmone because the
  // gateway expects a browser POST, not a plain redirect URL.
  await db.collection("billingOrders").doc(orderReference).set({
    provider: "portmone",
    status: "created",
    orderReference,
    ...order,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    provider: "portmone",
    orderReference,
    checkoutUrl: `${PROXY_URL}/api/portmone/checkout/${encodeURIComponent(orderReference)}`,
  };
}

export async function renderPortmoneCheckout(req: Request, res: Response) {
  const orderReference = firstRouteParam(req.params.orderReference);
  if (!orderReference) throw httpError(400, "Portmone order reference is missing.");

  const snapshot = await db.collection("billingOrders").doc(orderReference).get();
  if (!snapshot.exists) throw httpError(404, "Portmone order was not found.");

  const order = snapshot.data() as PortmoneOrder;
  const paymentRequest = buildPortmonePaymentRequest(orderReference, order);
  const bodyRequest = JSON.stringify(paymentRequest);

  res
    .status(200)
    .type("html")
    .send(renderAutoSubmitForm(PORTMONE_GATEWAY_URL, bodyRequest));
}

export async function handlePortmoneCallback(req: Request, res: Response) {
  ensurePortmoneStatusConfig();
  const payloadSource = req.method === "GET" ? req.query : req.body;
  const payload = z.record(z.string(), z.unknown()).parse(payloadSource ?? {});
  const orderReference = readString(payload, "shopOrderNumber", "SHOPORDERNUMBER", "BILL_NUMBER");

  if (!orderReference) {
    throw httpError(400, "Portmone callback does not include an order reference.");
  }

  const orderSnapshot = await db.collection("billingOrders").doc(orderReference).get();
  if (!orderSnapshot.exists) throw httpError(404, "Portmone order was not found.");

  const order = orderSnapshot.data() as PortmoneOrder;
  const reportRow = await fetchPortmoneOrderStatus(orderReference);
  const paid = normalizePortmoneStatus(reportRow.status) === "PAYED";
  const reportedAmount = Number(reportRow.billAmount ?? order.amount);

  if (paid && Math.abs(reportedAmount - order.amount) > 0.01) {
    throw httpError(400, "Portmone payment amount does not match the order.");
  }

  await db.collection("billingOrders").doc(orderReference).set(
    {
      status: reportRow.status ?? "unknown",
      portmoneShopBillId: reportRow.shopBillId ?? null,
      callbackPayload: payload,
      reportPayload: reportRow,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  if (paid) {
    await activatePaidAccessOnce(orderReference, order);
  }

  sendPortmoneCallbackResponse(req, res, orderReference);
}

export async function syncPortmoneOrder(orderReference: string) {
  ensurePortmoneStatusConfig();
  const orderSnapshot = await db.collection("billingOrders").doc(orderReference).get();
  if (!orderSnapshot.exists) throw httpError(404, "Portmone order was not found.");

  const order = orderSnapshot.data() as PortmoneOrder;
  const reportRow = await fetchPortmoneOrderStatus(orderReference);

  await db.collection("billingOrders").doc(orderReference).set(
    {
      status: reportRow.status ?? "unknown",
      portmoneShopBillId: reportRow.shopBillId ?? null,
      reportPayload: reportRow,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  if (normalizePortmoneStatus(reportRow.status) === "PAYED") {
    await activatePaidAccessOnce(orderReference, order);
  }

  return reportRow;
}

function buildPortmonePaymentRequest(orderReference: string, order: PortmoneOrder) {
  const billAmount = formatAmount(order.amount);
  const dt = formatPortmoneDate(new Date());

  return {
    paymentTypes: {
      card: "Y",
      portmone: "Y",
    },
    payee: {
      payeeId: PORTMONE_PAYEE_ID,
      login: PORTMONE_LOGIN,
      dt,
      signature: signPortmoneCheckout(orderReference, billAmount, dt),
    },
    order: {
      description: `Life Focus ${order.plan} plan`,
      shopOrderNumber: orderReference,
      billAmount,
      billCurrency: order.currency,
      successUrl: `${PROXY_URL}/api/portmone/callback`,
      failureUrl: `${APP_URL}/payment-result?status=failed&orderReference=${encodeURIComponent(orderReference)}`,
      preauthFlag: "N",
    },
    payer: {
      lang: PORTMONE_LANGUAGE,
      emailAddress: order.email ?? "",
      showEmail: "Y",
    },
  };
}

async function activatePaidAccess(orderReference: string, order: PortmoneOrder) {
  const now = Date.now();
  const currentPlan = await getCurrentPlan(order.userId, order.email);
  const baseAccessEndsAt =
    currentPlan.accessEndsAt && new Date(currentPlan.accessEndsAt).getTime() > now
      ? new Date(currentPlan.accessEndsAt).getTime()
      : now;
  const accessEndsAt = new Date(baseAccessEndsAt + PAID_ACCESS_DAYS * 24 * 60 * 60 * 1000);

  await setUserSubscription(order.userId, {
    planId: order.plan,
    subscriptionStatus: "active",
    currentPeriodEnd: Timestamp.fromDate(accessEndsAt),
    accessEndsAt: Timestamp.fromDate(accessEndsAt),
    billingProvider: "portmone",
    portmoneOrderReference: orderReference,
  });
}

async function activatePaidAccessOnce(orderReference: string, order: PortmoneOrder) {
  const orderRef = db.collection("billingOrders").doc(orderReference);
  const orderSnapshot = await orderRef.get();
  if (orderSnapshot.data()?.paidAccessActivatedAt) return;

  await activatePaidAccess(orderReference, order);
  await orderRef.set(
    {
      paidAccessActivatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function fetchPortmoneOrderStatus(orderReference: string): Promise<PortmoneReportRow> {
  const response = await fetch(PORTMONE_GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "result",
      params: {
        data: {
          login: PORTMONE_LOGIN,
          password: PORTMONE_PASSWORD,
          payeeId: PORTMONE_PAYEE_ID,
          shopOrderNumber: orderReference,
          status: "",
        },
      },
      id: "1",
    }),
  });

  if (!response.ok) {
    throw httpError(502, `Portmone status request failed with ${response.status}.`);
  }

  const data = (await response.json()) as unknown;
  const row = extractReportRow(data, orderReference);
  if (!row) throw httpError(404, "Portmone did not return this order in the status report.");
  return row;
}

function extractReportRow(data: unknown, orderReference: string): PortmoneReportRow | null {
  if (!Array.isArray(data)) return null;
  return (
    data.find((item): item is PortmoneReportRow => {
      if (!item || typeof item !== "object") return false;
      const row = item as PortmoneReportRow;
      return row.shopOrderNumber === orderReference;
    }) ?? null
  );
}

function signPortmoneCheckout(orderReference: string, billAmount: string, dt: string) {
  const base =
    `${PORTMONE_PAYEE_ID}${dt}${toHex(orderReference)}${billAmount}`.toUpperCase() +
    toHex(PORTMONE_LOGIN!).toUpperCase();
  return createHmac("sha256", PORTMONE_SIGNATURE_KEY!).update(base, "utf8").digest("hex").toUpperCase();
}

function renderAutoSubmitForm(action: string, bodyRequest: string) {
  return `<!doctype html>
<html lang="uk">
  <head><meta charset="utf-8"><title>Redirecting to Portmone</title></head>
  <body>
    <form id="portmone-checkout" action="${escapeHtml(action)}" method="post">
      <input type="hidden" name="bodyRequest" value="${escapeHtml(bodyRequest)}">
      <input type="hidden" name="typeRequest" value="json">
    </form>
    <script>document.getElementById("portmone-checkout").submit();</script>
  </body>
</html>`;
}

function sendPortmoneCallbackResponse(req: Request, res: Response, orderReference: string) {
  if (req.is("application/json")) {
    res.json({ errorCode: "0", reason: "OK", responseId: orderReference });
    return;
  }

  res.redirect(
    303,
    `${APP_URL}/payment-result?status=success&orderReference=${encodeURIComponent(orderReference)}`,
  );
}

function getPortmonePlanAmount(plan: Extract<PlanId, "starter" | "pro">) {
  const value =
    plan === "starter" ? process.env.PORTMONE_STARTER_AMOUNT : process.env.PORTMONE_PRO_AMOUNT;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw httpError(500, `PORTMONE_${plan.toUpperCase()}_AMOUNT is not configured.`);
  }
  return amount;
}

function ensurePortmoneCheckoutConfig() {
  if (!PORTMONE_PAYEE_ID || !PORTMONE_LOGIN || !PORTMONE_SIGNATURE_KEY) {
    throw httpError(500, "PORTMONE_PAYEE_ID, PORTMONE_LOGIN and PORTMONE_SIGNATURE_KEY are required.");
  }
}

function ensurePortmoneStatusConfig() {
  ensurePortmoneCheckoutConfig();
  if (!PORTMONE_PASSWORD) {
    throw httpError(500, "PORTMONE_PASSWORD is required to verify payment status.");
  }
}

function readString(payload: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === "string" && item.trim());
      if (typeof first === "string") return first.trim();
    }
  }
  return null;
}

function normalizePortmoneStatus(status: unknown) {
  return typeof status === "string" ? status.trim().toUpperCase() : "";
}

function firstRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatAmount(amount: number) {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

function formatPortmoneDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function toHex(value: string) {
  return Buffer.from(value, "utf8").toString("hex");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
