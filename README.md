# Sip Cycle M-Pesa Integration

Handles M-Pesa STK Push payments and logs them to Google Sheets.

## Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/` | Health check |
| POST | `/stkpush` | Initiate STK Push to customer's phone |
| POST | `/callback` | M-Pesa callback after STK Push payment |
| POST | `/c2b/confirm` | Till Number walk-in payment notification |
| POST | `/c2b/validate` | Till Number payment validation |

## Deploy to Render

1. Push this folder to a GitHub repo
2. Go to render.com → New → Web Service
3. Connect your GitHub repo
4. Set environment variables (from .env.example)
5. Deploy — your URL is your CALLBACK_URL

## Environment Variables

See `.env.example` for all required variables.
