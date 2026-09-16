import { logger } from "./logger";

// M-Pesa / Safaricom Daraja client.
//
// CRITICAL DISTINCTION enforced by the return types below: "we could not
// reach Daraja" is NOT a payment result. It is an infrastructure
// failure. Collapsing it into UNKNOWN would destroy the audit
// distinction the reconciliation design depends on, so `unreachable` is
// a separate discriminated-union variant, not an enum value alongside
// the provider's own answers.

const DARAJA_BASE_URL = process.env.DARAJA_BASE_URL || "https://sandbox.safaricom.co.ke";
const DARAJA_CONSUMER_KEY = process.env.DARAJA_CONSUMER_KEY || "";
const DARAJA_CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET || "";
const DARAJA_SHORTCODE = process.env.DARAJA_SHORTCODE || "";
const DARAJA_PASSKEY = process.env.DARAJA_PASSKEY || "";
const DARAJA_CALLBACK_URL = process.env.DARAJA_CALLBACK_URL || "";
const REQUEST_TIMEOUT_MS = Number(process.env.DARAJA_TIMEOUT_MS || 20000);

export type DarajaStatusResult =
  | { kind: "success"; receipt?: string; raw: unknown }
  | { kind: "failure"; reason?: string; raw: unknown }
  | { kind: "ambiguous"; raw: unknown }        // provider ANSWERED, answer was not definitive
  | { kind: "unreachable"; error: string };     // provider did NOT answer — infra failure

export type StkPushResult =
  | { kind: "initiated"; merchantRequestId?: string; checkoutRequestId?: string; raw: unknown }
  | { kind: "rejected"; error: string; raw: unknown }
  | { kind: "unreachable"; error: string };

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Normalizes a Kenyan number to Daraja's required 2547XXXXXXXX form.
 * Accepts 07XX, 7XX, +2547XX, 2547XX.
 */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits;
}

export function isValidKenyanPhone(input: string): boolean {
  return /^254[17]\d{8}$/.test(normalizePhone(input));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(): Promise<string> {
  const auth = Buffer.from(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`).toString("base64");
  const res = await fetchWithTimeout(
    `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { method: "GET", headers: { Authorization: `Basic ${auth}` } }
  );
  if (!res.ok) throw new Error(`Daraja auth failed: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Daraja auth returned no access_token");
  return body.access_token;
}

export async function initiateStkPush(params: {
  phoneNumber: string;
  amount: number;
  accountReference: string;
  description: string;
}): Promise<StkPushResult> {
  try {
    const token = await getAccessToken();
    const ts = timestamp();
    const password = Buffer.from(`${DARAJA_SHORTCODE}${DARAJA_PASSKEY}${ts}`).toString("base64");
    const phone = normalizePhone(params.phoneNumber);

    const res = await fetchWithTimeout(`${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: DARAJA_SHORTCODE,
        Password: password,
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        // Daraja requires a whole-number amount.
        Amount: Math.ceil(params.amount),
        PartyA: phone,
        PartyB: DARAJA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: DARAJA_CALLBACK_URL,
        AccountReference: params.accountReference,
        TransactionDesc: params.description,
      }),
    });

    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { kind: "rejected", error: `HTTP ${res.status}`, raw };
    }

    const body = raw as { MerchantRequestID?: string; CheckoutRequestID?: string; ResponseCode?: string };
    if (body.ResponseCode && body.ResponseCode !== "0") {
      return { kind: "rejected", error: `ResponseCode ${body.ResponseCode}`, raw };
    }

    return {
      kind: "initiated",
      merchantRequestId: body.MerchantRequestID,
      checkoutRequestId: body.CheckoutRequestID,
      raw,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "Daraja STK Push unreachable");
    return { kind: "unreachable", error: message };
  }
}

/**
 * Queries Daraja's authoritative Transaction Status. This — never a
 * callback payload — is the sole source of payment truth.
 */
export async function queryTransactionStatus(checkoutRequestId: string): Promise<DarajaStatusResult> {
  try {
    const token = await getAccessToken();
    const ts = timestamp();
    const password = Buffer.from(`${DARAJA_SHORTCODE}${DARAJA_PASSKEY}${ts}`).toString("base64");

    const res = await fetchWithTimeout(`${DARAJA_BASE_URL}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: DARAJA_SHORTCODE,
        Password: password,
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      }),
    });

    const raw = await res.json().catch(() => ({}));

    // Daraja returns HTTP 500 with ResultCode 1037/1032 etc. for
    // legitimate "still processing"/"cancelled" answers, so a non-2xx
    // here does NOT automatically mean the provider was unreachable —
    // it answered, and we must read the body before deciding.
    const body = raw as { ResultCode?: string | number; ResultDesc?: string; MpesaReceiptNumber?: string };
    const code = body.ResultCode !== undefined ? String(body.ResultCode) : undefined;

    if (code === "0") {
      return { kind: "success", receipt: body.MpesaReceiptNumber, raw };
    }

    // Definitive user/provider-side failures.
    // 1032 = cancelled by user, 1 = insufficient funds, 2001 = wrong PIN.
    if (code === "1032" || code === "1" || code === "2001" || code === "1037") {
      // 1037 (timeout, user never responded) is a definitive provider
      // outcome for THIS attempt: no money moved.
      return { kind: "failure", reason: body.ResultDesc ?? `ResultCode ${code}`, raw };
    }

    if (code === undefined) {
      // Provider answered but with nothing we can interpret.
      return { kind: "ambiguous", raw };
    }

    // Answered, but with a code we do not definitively map (e.g. 500.001
    // "request being processed"). Ambiguous — retry, do not guess.
    return { kind: "ambiguous", raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, checkoutRequestId }, "Daraja Transaction Status unreachable");
    return { kind: "unreachable", error: message };
  }
}
