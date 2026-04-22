require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,        // Till Number: 3291421
  MPESA_PASSKEY,          // From Daraja production app
  CALLBACK_URL,           // e.g. https://sipcycle.onrender.com/callback
  APPS_SCRIPT_URL,        // Google Apps Script Web App URL
  PORT = 3000
} = process.env;

const MPESA_BASE = 'https://api.safaricom.co.ke'; // Production

// ─── HELPERS ───────────────────────────────────────────────────────────────

// Get M-Pesa OAuth token
async function getToken() {
  const creds = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(
    `${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${creds}` } }
  );
  return res.data.access_token;
}

// Generate STK Push password (Base64 of shortcode+passkey+timestamp)
function getPassword(timestamp) {
  const str = `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`;
  return Buffer.from(str).toString('base64');
}

// Get current timestamp in format YYYYMMDDHHmmss
function getTimestamp() {
  return new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
}

// Send a row to Google Sheets via Apps Script Web App
async function appendToSheet(row) {
  if (!APPS_SCRIPT_URL) {
    console.warn('⚠️  APPS_SCRIPT_URL not set — skipping sheet logging');
    return;
  }
  await axios.post(APPS_SCRIPT_URL, {
    date:     row[0],
    time:     row[1],
    customer: row[2],
    amount:   row[3],
    ref:      row[4],
    notes:    row[5]
  });
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Sip Cycle M-Pesa Server Running ✅' });
});

// Initiate STK Push (called by your app/admin panel)
// POST /stkpush  { phone: "2547XXXXXXXX", amount: 150, description: "20L Water" }
app.post('/stkpush', async (req, res) => {
  try {
    const { phone, amount, description = 'Water Purchase' } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: 'phone and amount are required' });
    }

    const token = await getToken();
    const timestamp = getTimestamp();
    const password = getPassword(timestamp);

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',  // For Till Number (Buy Goods)
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL,
      AccountReference: 'SipCycle',
      TransactionDesc: description
    };

    const response = await axios.post(
      `${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({
      success: true,
      CheckoutRequestID: response.data.CheckoutRequestID,
      ResponseDescription: response.data.ResponseDescription
    });

  } catch (err) {
    console.error('STK Push error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// M-Pesa STK Push Callback (Safaricom calls this after payment)
app.post('/callback', async (req, res) => {
  // Always respond 200 immediately so Safaricom doesn't retry
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) return;

    const { ResultCode, ResultDesc, CallbackMetadata } = body;

    if (ResultCode !== 0) {
      console.log(`Payment failed: ${ResultDesc}`);
      return;
    }

    // Extract payment details from callback
    const items = CallbackMetadata?.Item || [];
    const get = (name) => items.find(i => i.Name === name)?.Value ?? '';

    const amount   = get('Amount');
    const mpesaRef = get('MpesaReceiptNumber');
    const phone    = get('PhoneNumber');
    const date     = get('TransactionDate');

    // Format date: 20260422143022 → 2026-04-22 / 14:30:22
    const d = String(date);
    const formattedDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
    const formattedTime = `${d.slice(8,10)}:${d.slice(10,12)}:${d.slice(12,14)}`;

    // Determine water volume from amount
    let notes = 'M-Pesa STK Push';
    if (amount == 150)      notes = '20L Dispenser';
    else if (amount == 90)  notes = '10L Jerry Can';
    else if (amount == 40)  notes = '5L Bottle';
    else if (amount == 20)  notes = '2L Bottle';
    else if (amount == 10)  notes = '1L Bottle';

    await appendToSheet([formattedDate, formattedTime, String(phone), amount, mpesaRef, notes]);
    console.log(`✅ STK payment logged: ${mpesaRef} | KES ${amount} | ${phone}`);

  } catch (err) {
    console.error('Callback processing error:', err.message);
  }
});

// C2B Confirmation (for Till Number walk-in payments)
// Register this URL on Daraja as your Confirmation URL
app.post('/c2b/confirm', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const {
      TransID,
      TransTime,
      TransAmount,
      MSISDN,
      FirstName,
      LastName
    } = req.body;

    const d = String(TransTime);
    const formattedDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
    const formattedTime = `${d.slice(8,10)}:${d.slice(10,12)}:${d.slice(12,14)}`;
    const customer = `${FirstName || ''} ${LastName || ''}`.trim() || String(MSISDN);

    let notes = 'Till Payment';
    const amt = parseFloat(TransAmount);
    if (amt == 150)      notes = '20L Dispenser';
    else if (amt == 90)  notes = '10L Jerry Can';
    else if (amt == 40)  notes = '5L Bottle';
    else if (amt == 20)  notes = '2L Bottle';
    else if (amt == 10)  notes = '1L Bottle';

    await appendToSheet([formattedDate, formattedTime, customer, TransAmount, TransID, notes]);
    console.log(`✅ Till payment logged: ${TransID} | KES ${TransAmount} | ${customer}`);

  } catch (err) {
    console.error('C2B confirm error:', err.message);
  }
});

// C2B Validation (approve/reject before payment — always accept)
app.post('/c2b/validate', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ─── START ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚰 Sip Cycle M-Pesa server running on port ${PORT}`);
});
