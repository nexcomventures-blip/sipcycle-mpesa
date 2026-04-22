# Sip Cycle M-Pesa Callback Server

A Node.js server that handles M-Pesa STK Push payments for the Sip Cycle water vending machine.

## What it does
- Receives M-Pesa payment confirmations from Safaricom
- Automatically logs every payment to the Sip Cycle Google Sheet (Transactions tab)
- Identifies what was purchased based on the amount (1L, 2L, 5L, 10L, 20L)
- Supports both STK Push and C2B payment methods

## Endpoints
| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Health check |
| `/stk-push` | POST | Trigger STK Push payment prompt on customer's phone |
| `/callback` | POST | M-Pesa STK Push result (Safaricom posts here) |
| `/c2b/confirmation` | POST | C2B payment confirmation |
| `/c2b/validation` | POST | C2B payment validation |

## Deploy on Render.com (Free)

1. Push this folder to a GitHub repository
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Set **Start Command:** `npm start`
5. Add these **Environment Variables:**

| Variable | Value |
|---|---|
| `MPESA_CONSUMER_KEY` | Your production consumer key (from Daraja) |
| `MPESA_CONSUMER_SECRET` | Your production consumer secret (from Daraja) |
| `MPESA_SHORTCODE` | `3291421` |
| `MPESA_PASSKEY` | Assigned by Safaricom after Go Live |
| `CALLBACK_BASE_URL` | Your Render URL e.g. `https://sipcycle.onrender.com` |
| `SHEET_ID` | `1EVDcXDdVbk8sLIYs3tJtVzP9Dml9L2nJCaOD1PDWU5I` |
| `GOOGLE_SERVICE_ACCOUNT` | JSON string of your Google Service Account key |

6. Deploy — your callback URL will be: `https://sipcycle.onrender.com/callback`

## Trigger STK Push (test)
```bash
curl -X POST https://sipcycle.onrender.com/stk-push \
  -H "Content-Type: application/json" \
  -d '{"phone": "254712345678", "amount": 10, "description": "1L Water"}'
```

## Water Prices
| Amount (KES) | Product |
|---|---|
| 10 | 1L Water |
| 20 | 2L Water |
| 40 | 5L Water |
| 90 | 10L Water |
| 150 | 20L Dispenser Refill |
