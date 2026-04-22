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

const MPESA_ENV = (process.env.MPESA_ENVIRONMENT || 'sandbox').toLowerCase();
const MPESA_BASE = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// ─── HELPERS ───────────────────────────────────────────────────────────────

async function getToken() {
  const creds = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(
    `${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${creds}` } }
  );
  return res.data.access_token;
}

function getTimestamp() {
  return new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
}

async function appendToSheet(row) {
  if (!APPS_SCRIPT_URL) {
    console.warn('APPS_SCRIPT_URL not set - skipping sheet logging');
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

app.get('/', (req, res) => {
  res.json({ status: 'Sip Cycle M-Pesa Server Running' });
});

app.post('/stkpush', async (req, res) => {
  try {
    const { phone, amount, description = 'Water Purchase' } = req.body;
    if (!phone || !amount) {
      return res.status(400).json({ error: 'phone and amount are required' });
    }

    const token = await getToken();
    const timestamp = getTimestamp();

    const shortcode = MPESA_ENV === 'production' ? MPESA_SHORTCODE : '174379';
    const txType = MPESA_ENV === 'production' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline';

    const payload = {
      BusinessShortCode: shortcode,
      Password: Buffer.from(`${shortcode}${MPESA_PASSKEY}${timestamp}`).toString('base64'),
      Timestamp: timestamp,
      TransactionType: txType,
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: shortcode,
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

app.post('/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) return;
    const { ResultCode, ResultDesc, CallbackMetadata } = body;
    if (ResultCode !== 0) {
      console.log(`Payment failed: ${ResultDesc}`);
      return;
    }
    const items = CallbackMetadata?.Item || [];
    const get = (name) => items.find(i => i.Name === name)?.Value ?? '';
    const amount   = get('Amount');
    const mpesaRef = get('MpesaReceiptNumber');
    const phone    = get('PhoneNumber');
    const date     = get('TransactionDate');
    const d = String(date);
    const formattedDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
    const formattedTime = `${d.slice(8,10)}:${d.slice(10,12)}:${d.slice(12,14)}`;
    let notes = 'M-Pesa STK Push';
    if (amount == 150)      notes = '20L Dispenser';
    else if (amount == 90)  notes = '10L Jerry Can';
    else if (amount == 40)  notes = '5L Bottle';
    else if (amount == 20)  notes = '2L Bottle';
    else if (amount == 10)  notes = '1L Bottle';
    await appendToSheet([formattedDate, formattedTime, String(phone), amount, mpesaRef, notes]);
    console.log(`STK payment logged: ${mpesaRef} | KES ${amount} | ${phone}`);
  } catch (err) {
    console.error('Callback processing error:', err.message);
  }
});

app.post('/c2b/confirm', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const { TransID, TransTime, TransAmount, MSISDN, FirstName, LastName } = req.body;
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
    console.log(`Till payment logged: ${TransID} | KES ${TransAmount} | ${customer}`);
  } catch (err) {
    console.error('C2B confirm error:', err.message);
  }
});

app.post('/c2b/validate', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.listen(PORT, () => {
  console.log(`Sip Cycle M-Pesa server running on port ${PORT}`);
});
