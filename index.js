require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────────────────────
const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,      // Production Till: 3291421
  MPESA_PASSKEY,        // Production passkey from Daraja
  CALLBACK_URL,         // e.g. https://sipcycle.onrender.com/callback
  APPS_SCRIPT_URL,      // Google Apps Script Web App URL
  PORT = 3000,
} = process.env;

// Sandbox constants
const SANDBOX_SHORTCODE = '174379';
const SANDBOX_PASSKEY   = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
// Support both MPESA_ENVIRONMENT and MPESA_ENV
const MPESA_ENV_VALUE = (process.env.MPESA_ENVIRONMENT || process.env.MPESA_ENV || 'sandbox').toLowerCase();
const IS_SANDBOX = MPESA_ENV_VALUE === 'sandbox';

const STK_SHORTCODE = IS_SANDBOX ? SANDBOX_SHORTCODE : MPESA_SHORTCODE;
const STK_PASSKEY   = IS_SANDBOX ? SANDBOX_PASSKEY   : MPESA_PASSKEY;
const MPESA_BASE    = IS_SANDBOX
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

// ─── HELPERS ───────────────────────────────────────────────────────────────
function getTimestamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

async function getAccessToken() {
  const credentials = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(
    `${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );
  return res.data.access_token;
}

async function appendToSheet(rowData) {
  if (!APPS_SCRIPT_URL) return;
  await axios.post(APPS_SCRIPT_URL, { row: rowData });
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', env: IS_SANDBOX ? 'sandbox' : 'production', shortcode: STK_SHORTCODE });
});

// STK Push (for customer-initiated payments)
app.post('/stk-push', async (req, res) => {
  try {
    const { phone, amount, accountRef = 'SipCycle' } = req.body;
    const token = await getAccessToken();
    const timestamp = getTimestamp();
    const password = Buffer.from(`${STK_SHORTCODE}${STK_PASSKEY}${timestamp}`).toString('base64');

    const payload = {
      BusinessShortCode: STK_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: STK_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL || `https://sipcycle.onrender.com/callback`,
      AccountReference: accountRef,
      TransactionDesc: 'Water Purchase',
    };

    const response = await axios.post(
      `${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json(response.data);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('STK Push error:', JSON.stringify(detail));
    res.status(500).json({ error: detail });
  }
});

// STK Callback
app.post('/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) return;
    const { ResultCode, CallbackMetadata } = body;
    if (ResultCode !== 0) {
      console.log(`STK failed with code ${ResultCode}`);
      return;
    }
    const items = CallbackMetadata?.Item || [];
    const get = name => items.find(i => i.Name === name)?.Value;

    const amount    = get('Amount');
    const mpesaRef  = get('MpesaReceiptNumber');
    const phone     = get('PhoneNumber');
    const transTime = get('TransactionDate');

    const d = String(transTime);
    const formattedDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
    const formattedTime = `${d.slice(8,10)}:${d.slice(10,12)}:${d.slice(12,14)}`;

    let notes = 'STK Push';
    const amt = parseFloat(amount);
    if (amt === 150) notes = '20L Dispenser';
    else if (amt === 90)  notes = '10L Jerry Can';
    else if (amt === 40)  notes = '5L Bottle';
    else if (amt === 20)  notes = '2L Bottle';
    else if (amt === 10)  notes = '1L Bottle';

    await appendToSheet([formattedDate, formattedTime, String(phone), amount, mpesaRef, notes]);
    console.log(`STK logged: ${mpesaRef} | KES ${amount} | ${phone}`);
  } catch (err) {
    console.error('Callback error:', err.message);
  }
});

// C2B Validation
app.post('/c2b/validate', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// C2B Confirmation — logs till payments to Google Sheet
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
    if (amt === 150) notes = '20L Dispenser';
    else if (amt === 90)  notes = '10L Jerry Can';
    else if (amt === 40)  notes = '5L Bottle';
    else if (amt === 20)  notes = '2L Bottle';
    else if (amt === 10)  notes = '1L Bottle';

    await appendToSheet([formattedDate, formattedTime, customer, TransAmount, TransID, notes]);
    console.log(`Till payment logged: ${TransID} | KES ${TransAmount} | ${customer}`);
  } catch (err) {
    console.error('C2B confirm error:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Sip Cycle M-Pesa server running on port ${PORT} [${IS_SANDBOX ? 'SANDBOX' : 'PRODUCTION'}]`);
});
