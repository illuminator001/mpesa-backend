require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const {
  PORT = 3000,
  MPESA_ENV = "sandbox",
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_CALLBACK_URL,
  MPESA_TRANSACTION_TYPE = "CustomerPayBillOnline",
  ORION_PAYMENT_WEBHOOK_URL,
} = process.env;

const mpesaBaseUrl =
  MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

const normalizedCallbackUrl = MPESA_CALLBACK_URL?.trim();

function requiredEnv() {
  return [
    "MPESA_CONSUMER_KEY",
    "MPESA_CONSUMER_SECRET",
    "MPESA_SHORTCODE",
    "MPESA_PASSKEY",
    "MPESA_CALLBACK_URL",
    "ORION_PAYMENT_WEBHOOK_URL",
  ].filter((key) => !process.env[key]?.trim());
}

function getTimestamp() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];

  return parts.join("");
}

function normalizePhone(phone) {
  const cleaned = String(phone || "").replace(/\D/g, "");

  if (cleaned.startsWith("254") && cleaned.length === 12) {
    return cleaned;
  }

  if (cleaned.startsWith("0") && cleaned.length === 10) {
    return `254${cleaned.slice(1)}`;
  }

  throw new Error("Phone number must be in format 07XXXXXXXX or 2547XXXXXXXX.");
}

function getErrorMessage(error, fallbackMessage) {
  if (!error) {
    return fallbackMessage;
  }

  const parts = [error.message, error.cause?.message].filter(Boolean);
  return parts.length > 0 ? parts.join(": ") : fallbackMessage;
}

async function forwardCallbackToOrion(payload) {
  const webhookUrl = ORION_PAYMENT_WEBHOOK_URL?.trim();

  if (!webhookUrl) {
    return { forwarded: false, reason: "ORION_PAYMENT_WEBHOOK_URL is not set." };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(
      `Forwarding callback failed with status ${response.status}${
        data?.error ? `: ${data.error}` : ""
      }`
    );
  }

  return { forwarded: true, data };
}

async function getAccessToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString(
    "base64"
  );

  const response = await fetch(
    `${mpesaBaseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
      },
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.errorMessage || "Failed to get M-Pesa access token.");
  }

  return data.access_token;
}

app.get("/", (_req, res) => {
  res.json({
    message: "M-Pesa API is running.",
    environment: MPESA_ENV,
  });
});

app.get("/health", (_req, res) => {
  const missing = requiredEnv();

  res.json({
    ok: missing.length === 0,
    missingEnv: missing,
  });
});

app.post("/mpesa/stkpush", async (req, res) => {
  try {
    const missing = requiredEnv();
    if (missing.length > 0) {
      return res.status(500).json({
        error: "Missing required M-Pesa environment variables.",
        missingEnv: missing,
      });
    }

    const body = req.body ?? {};

    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(body).length === 0
    ) {
      return res.status(400).json({
        error:
          "Request body is missing or invalid. Send JSON or form data with phone, amount, accountReference, and transactionDesc.",
      });
    }

    const { phone, amount, accountReference, transactionDesc } = body;

    if (!phone || !amount || !accountReference || !transactionDesc) {
      return res.status(400).json({
        error:
          "phone, amount, accountReference, and transactionDesc are required.",
      });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: "amount must be a valid number greater than 0.",
      });
    }

    const formattedPhone = normalizePhone(phone);
    const timestamp = getTimestamp();
    const password = Buffer.from(
      `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
    ).toString("base64");
    const accessToken = await getAccessToken();

    const response = await fetch(`${mpesaBaseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: MPESA_TRANSACTION_TYPE,
        Amount: Math.round(numericAmount),
        PartyA: formattedPhone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: normalizedCallbackUrl,
        AccountReference: accountReference,
        TransactionDesc: transactionDesc,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Failed to initiate STK push.",
        details: data,
      });
    }

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      error: getErrorMessage(
        error,
        "Unexpected error while initiating STK push."
      ),
    });
  }
});

app.post("/mpesa/callback", async (req, res) => {
  console.log("M-Pesa callback received:", JSON.stringify(req.body, null, 2));

  try {
    const forwardResult = await forwardCallbackToOrion(req.body);
    console.log("Orion callback forward result:", JSON.stringify(forwardResult, null, 2));
  } catch (error) {
    console.error(
      "Failed to forward M-Pesa callback to Orion:",
      getErrorMessage(error, "Unknown forwarding error.")
    );
  }

  res.json({
    ResultCode: 0,
    ResultDesc: "Callback received successfully",
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
