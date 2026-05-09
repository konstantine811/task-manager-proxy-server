# Task Manager AI Proxy

Node.js proxy server for the public Task Manager app.

It keeps AI keys on the server, verifies Firebase users, applies monthly AI and storage limits, and updates paid plans through WayForPay callbacks.

## Plans

| Plan | Price | AI requests / month | Storage |
| --- | ---: | ---: | ---: |
| `free` | 7-day trial | 30 | 100 MB |
| `starter` | $3 / month | 250 | 1 GB |
| `pro` | $5 / month | 800 | 5 GB |

The `free` plan is a trial, not a forever-free AI plan. After `FREE_TRIAL_DAYS`, AI requests return `402 Payment Required`, and `/api/me` returns `plan.paymentRequired: true`.

WayForPay subscription payments grant `PAID_ACCESS_DAYS` days of access on every successful callback. This works with the hosted WayForPay subscription page.

You can change limits in `src/index.ts` in the `PLANS` object, the trial length through `FREE_TRIAL_DAYS`, and the paid access period through `PAID_ACCESS_DAYS`.

## Setup

```bash
cd ai-proxy-server
npm install
cp .env.example .env
npm run dev
```

## Deploy to Vercel

Deploy this proxy as its own Vercel project, separate from the frontend app.

```bash
vercel
vercel env add GEMINI_API_KEY production
vercel env add FIREBASE_SERVICE_ACCOUNT_JSON production
vercel env add FIREBASE_STORAGE_BUCKET production
vercel env add WAYFORPAY_SUBSCRIPTION_URL production
vercel env add WAYFORPAY_MERCHANT_ACCOUNT production
vercel env add WAYFORPAY_SECRET_KEY production
vercel env add WAYFORPAY_CURRENCY production
vercel env add WAYFORPAY_STARTER_AMOUNT production
vercel env add WAYFORPAY_PRO_AMOUNT production
vercel env add APP_URL production
vercel env add CORS_ORIGINS production
vercel env add FREE_TRIAL_DAYS production
vercel env add PAID_ACCESS_DAYS production
vercel env add BILLING_PROVIDER production
vercel --prod
```

After deploy, set the frontend env to the proxy URL:

```bash
VITE_AI_PROXY_URL=https://your-proxy-project.vercel.app
```

Required environment variables:

- `GEMINI_API_KEY`
- `WAYFORPAY_SUBSCRIPTION_URL`
- `WAYFORPAY_MERCHANT_ACCOUNT`
- `WAYFORPAY_SECRET_KEY`
- `WAYFORPAY_CURRENCY`
- `WAYFORPAY_STARTER_AMOUNT`
- `WAYFORPAY_PRO_AMOUNT`
- `FIREBASE_STORAGE_BUCKET`
- `APP_URL`
- `CORS_ORIGINS`
- `FREE_TRIAL_DAYS` defaults to `7`
- `PAID_ACCESS_DAYS` defaults to `30`
- `BILLING_PROVIDER` defaults to `wayforpay`
- either `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_JSON`

For Vercel, `FIREBASE_SERVICE_ACCOUNT_JSON` is usually simpler than `GOOGLE_APPLICATION_CREDENTIALS`. Paste the full Firebase service account JSON as one environment variable.

## Firebase Auth From Frontend

Send the Firebase ID token with each request:

```ts
const token = await auth.currentUser?.getIdToken();

const response = await fetch(`${import.meta.env.VITE_AI_PROXY_URL}/api/ai/parse-tasks`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ text }),
});
```

## Useful Endpoints

- `GET /health`
- `GET /api/me`
- `POST /api/ai/parse-tasks`
- `POST /api/ai/advisor/advice`
- `POST /api/ai/advisor/tasks`
- `POST /api/storage/check-capacity`
- `POST /api/storage/sync`
- `POST /api/billing/checkout`
- `POST /api/billing/portal`
- `POST /api/wayforpay/callback`

## WayForPay

Use the hosted subscription page:

```txt
https://secure.wayforpay.com/sub/s1a4266d903dc
```

Set this as the frontend env:

```bash
VITE_WAYFORPAY_SUBSCRIPTION_URL=https://secure.wayforpay.com/sub/s1a4266d903dc
```

In the WayForPay subscription page settings, set Service URL:

```txt
https://your-proxy-domain.com/api/wayforpay/callback
```

The callback verifies WayForPay `merchantSignature` with `WAYFORPAY_SECRET_KEY` using HMAC-MD5, then matches the payer email to `billingUsers.email`.

Important: make email required on the WayForPay subscription page and tell users to enter the same email as their Life Focus login.

By default, plan mapping is:

- product name contains `Starter` -> `starter`
- product name contains `Pro` -> `pro`
- otherwise amount >= `WAYFORPAY_PRO_AMOUNT` -> `pro`
- otherwise amount >= `WAYFORPAY_STARTER_AMOUNT` -> `starter`

Recommended UAH pricing:

```bash
WAYFORPAY_CURRENCY=UAH
WAYFORPAY_STARTER_AMOUNT=120
WAYFORPAY_PRO_AMOUNT=200
```

## Storage

The proxy expects Firebase Storage objects under:

```txt
task-manager-life-focus/{uid}/
```

`POST /api/storage/sync` scans that prefix and stores the total in:

```txt
billingUsers/{uid}.storageBytes
```

Use `POST /api/storage/check-capacity` before uploads if you want to block uploads before the user exceeds the plan limit.
