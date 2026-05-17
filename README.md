# Task Manager AI Proxy

Node.js proxy server for the public Task Manager app.

It keeps AI keys on the server, verifies Firebase users, applies monthly AI and storage limits, and grants paid access through Portmone payments.

## Plans

| Plan | Price | AI requests / month | Storage |
| --- | ---: | ---: | ---: |
| `free` | 7-day trial | 30 | 100 MB |
| `starter` | configured in `PORTMONE_STARTER_AMOUNT` | 250 | 1 GB |
| `pro` | configured in `PORTMONE_PRO_AMOUNT` | 800 | 5 GB |

The `free` plan is a trial, not a forever-free AI plan. After `FREE_TRIAL_DAYS`, AI requests return `402 Payment Required`, and `/api/me` returns `plan.paymentRequired: true`.

Every verified Portmone payment grants `PAID_ACCESS_DAYS` days of access. If the user already has active access, the new period is added to the current access end date.

## Setup

```bash
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
vercel env add PORTMONE_PAYEE_ID production
vercel env add PORTMONE_LOGIN production
vercel env add PORTMONE_PASSWORD production
vercel env add PORTMONE_STARTER_AMOUNT production
vercel env add PORTMONE_PRO_AMOUNT production
vercel env add APP_URL production
vercel env add PROXY_URL production
vercel env add CORS_ORIGINS production
vercel env add FREE_TRIAL_DAYS production
vercel env add PAID_ACCESS_DAYS production
vercel --prod
```

Required environment variables:

- `GEMINI_API_KEY`
- `PORTMONE_PAYEE_ID`
- `PORTMONE_LOGIN`
- `PORTMONE_PASSWORD`
- `PORTMONE_STARTER_AMOUNT`
- `PORTMONE_PRO_AMOUNT`
- `FIREBASE_STORAGE_BUCKET`
- `APP_URL`
- `PROXY_URL`
- `CORS_ORIGINS`
- `FREE_TRIAL_DAYS` defaults to `7`
- `PAID_ACCESS_DAYS` defaults to `30`
- either `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_JSON`

Optional Portmone variables:

- `PORTMONE_GATEWAY_URL` defaults to `https://www.portmone.com.ua/gateway/`
- `PORTMONE_SIGNATURE_KEY` enables signed JSON checkout; if omitted, the proxy uses standard Portmone POST fields
- `PORTMONE_CURRENCY` defaults to `UAH`
- `PORTMONE_LANGUAGE` defaults to `uk`

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
- `GET /api/portmone/checkout/:orderReference`
- `POST /api/portmone/callback`
- `POST /api/portmone/sync`
- `POST /api/admin/portmone/refund`

## Portmone

`POST /api/billing/checkout` accepts:

```json
{ "plan": "starter" }
```

It creates a `billingOrders/{orderReference}` record and returns:

```json
{
  "provider": "portmone",
  "orderReference": "lf-starter-...",
  "checkoutUrl": "https://your-proxy-domain.com/api/portmone/checkout/lf-starter-..."
}
```

Open `checkoutUrl` in the browser. The proxy renders a small auto-submit form because Portmone's payment gateway expects a browser POST. If `PORTMONE_SIGNATURE_KEY` is configured, the proxy sends a signed JSON `bodyRequest`; otherwise it sends standard Portmone POST fields.

Set the Portmone success URL to:

```txt
https://your-proxy-domain.com/api/portmone/callback
```

The callback does not trust the browser payload by itself. It calls Portmone's `result` API with `PORTMONE_LOGIN`, `PORTMONE_PASSWORD`, `PORTMONE_PAYEE_ID`, checks that status is `PAYED`, validates the amount, and then updates `billingUsers/{uid}` with:

```txt
billingProvider=portmone
subscriptionStatus=active
portmoneOrderReference={orderReference}
accessEndsAt={now + PAID_ACCESS_DAYS}
```

Admin refund endpoint:

```http
POST /api/admin/portmone/refund
Authorization: Bearer <Firebase ID token>
Content-Type: application/json

{
  "orderReference": "lf-starter-...",
  "amount": 120,
  "message": "Customer refund"
}
```

`amount` is optional. When omitted, the proxy requests a full refund and marks the user's subscription as `refunded`.

Recommended UAH pricing:

```bash
PORTMONE_CURRENCY=UAH
PORTMONE_STARTER_AMOUNT=120
PORTMONE_PRO_AMOUNT=200
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
