const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── CONFIG (set these as Environment Variables on Render) ───────────────────
const MPESA_CONSUMER_KEY    = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE       = process.env.MPESA_SHORTCODE;       // Till: 3291421
const MPESA_PASSKEY         = process.env.MPESA_PASSKEY;         // Assigned after Go Live
const CALLBACK_BASE_URL     = process.env.CALLBACK_BASE_URL;     // e.g. https://sipcycle.onrender.com
const SHEET_ID              = process.env.SHEET_ID;              // Google Sheets ID for sales tracker
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT; // JSON string of service account key

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "✅ Sip Cycle M-Pesa Server is running", time: new Date().toISOString() });
});

// ─── STK PUSH INITIATE ────────────────────────────────────────────────────────
// Call this endpoint from the vending machine or frontend to trigger payment prompt
// POST /stk-push  { phone: "2547XXXXXXXX", amount: 10, description: "1L Water" }
app.post("/stk-push", async (req, res) => {
  try {
    const { phone, amount, description } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: "phone and amount are required" });
    }

    const token = await getMpesaToken();
    const timestamp = getTimestamp();
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString("base64");

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline",  // For Till numbers
      Amount: Math.ceil(amount),
      PartyA: phone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: `${CALLBACK_BASE_URL}/callback`,
      AccountReference: "SipCycle",
      TransactionDesc: description || "Water Purchase",
    };

    const response = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error("STK Push error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ─── M-PESA CALLBACK ──────────────────────────────────────────────────────────
// Safaricom posts payment results here
app.post("/callback", async (req, res) => {
  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) return res.status(400).json({ error: "Invalid callback body" });

    const resultCode = body.ResultCode;
    const resultDesc = body.ResultDesc;
    const merchantRef = body.MerchantRequestID;
    const checkoutRef  = body.CheckoutRequestID;

    if (resultCode !== 0) {
      console.log(`❌ Payment failed [${resultCode}]: ${resultDesc}`);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    // Extract payment details
    const items = body.CallbackMetadata?.Item || [];
    const get   = (name) => items.find((i) => i.Name === name)?.Value;

    const amount    = get("Amount");
    const mpesaRef  = get("MpesaReceiptNumber");
    const phone     = get("PhoneNumber");
    const transTime = get("TransactionDate"); // Format: 20240422103000

    // Format date and time
    const ts  = String(transTime);
    const date = `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`;
    const time = `${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)}`;

    console.log(`✅ Payment received: KES ${amount} from ${phone} | Ref: ${mpesaRef}`);

    // Determine what was purchased based on amount
    const waterDesc = getWaterDescription(amount);

    // Log to Google Sheets
    await logToSheets({ date, time, phone, amount, mpesaRef, description: waterDesc });

    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("Callback error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── C2B CONFIRMATION (alternative payment notification) ─────────────────────
app.post("/c2b/confirmation", async (req, res) => {
  try {
    const data = req.body;
    console.log("C2B Confirmation:", JSON.stringify(data));

    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toTimeString().slice(0, 8);
    const waterDesc = getWaterDescription(data.TransAmount);

    await logToSheets({
      date,
      time,
      phone: data.MSISDN,
      amount: data.TransAmount,
      mpesaRef: data.TransID,
      description: waterDesc,
    });

    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("C2B error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/c2b/validation", (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString("base64");
  const response = await axios.get(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return response.data.access_token;
}

function getTimestamp() {
  const now = new Date();
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function getWaterDescription(amount) {
  const amt = Number(amount);
  if (amt >= 150) return "20L Dispenser Refill";
  if (amt >= 90)  return "10L Water";
  if (amt >= 40)  return "5L Water";
  if (amt >= 20)  return "2L Water";
  if (amt >= 10)  return "1L Water";
  return `Water Purchase (KES ${amt})`;
}

async function logToSheets({ date, time, phone, amount, mpesaRef, description }) {
  try {
    if (!GOOGLE_SERVICE_ACCOUNT || !SHEET_ID) {
      console.log("Sheets not configured — skipping log.");
      return;
    }

    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Transactions!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[date, time, String(phone), Number(amount), mpesaRef, description]],
      },
    });

    console.log(`📊 Logged to Sheets: ${mpesaRef} | KES ${amount} | ${description}`);
  } catch (err) {
    console.error("Sheets log error:", err.message);
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚰 Sip Cycle M-Pesa Server running on port ${PORT}`);
});
