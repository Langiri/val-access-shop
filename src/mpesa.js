import crypto from 'node:crypto';

// Result codes from STK query that mean "still waiting for the customer".
const PENDING_QUERY_CODES = new Set(['4999']);
const PENDING_ERROR_CODES = new Set(['500.001.1001']);

export class MpesaError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MpesaError';
    this.details = details;
  }
}

/** Daraja timestamp (YYYYMMDDHHmmss) in Kenyan time (EAT, UTC+3). */
export function darajaTimestamp(date = new Date()) {
  const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    eat.getUTCFullYear() +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  );
}

/** STK password = base64(shortcode + passkey + timestamp). */
export function stkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

/**
 * Extracts the useful fields from a Daraja STK callback body.
 * Returns null when the body does not look like an STK callback.
 */
export function parseStkCallback(body) {
  const callback = body?.Body?.stkCallback;
  if (!callback || typeof callback.CheckoutRequestID !== 'string') return null;
  const items = Array.isArray(callback.CallbackMetadata?.Item)
    ? callback.CallbackMetadata.Item
    : [];
  const meta = Object.fromEntries(items.filter((i) => i && i.Name).map((i) => [i.Name, i.Value]));
  return {
    checkoutRequestId: callback.CheckoutRequestID,
    merchantRequestId: callback.MerchantRequestID,
    resultCode: Number(callback.ResultCode),
    resultDesc: String(callback.ResultDesc ?? ''),
    amount: meta.Amount === undefined ? null : Number(meta.Amount),
    receipt: meta.MpesaReceiptNumber ? String(meta.MpesaReceiptNumber) : null,
    phone: meta.PhoneNumber ? String(meta.PhoneNumber) : null,
  };
}

/** Builds a callback body in the same shape Safaricom sends (used by mock mode and tests). */
export function buildStkCallback({ checkoutRequestId, merchantRequestId, success, amount, phone }) {
  const stkCallback = {
    MerchantRequestID: merchantRequestId,
    CheckoutRequestID: checkoutRequestId,
    ResultCode: success ? 0 : 1032,
    ResultDesc: success
      ? 'The service request is processed successfully.'
      : 'Request cancelled by user',
  };
  if (success) {
    stkCallback.CallbackMetadata = {
      Item: [
        { Name: 'Amount', Value: amount },
        {
          Name: 'MpesaReceiptNumber',
          Value: `MOCK${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        },
        { Name: 'TransactionDate', Value: Number(darajaTimestamp()) },
        { Name: 'PhoneNumber', Value: Number(phone) },
      ],
    };
  }
  return { Body: { stkCallback } };
}

/** Mock client: never calls Safaricom. Phone numbers ending in 1111 simulate a cancelled payment. */
function createMockClient(settings) {
  return {
    mode: 'mock',
    mockDelayMs: settings.mockDelayMs,
    async initiateStkPush({ phone }) {
      const id = crypto.randomUUID();
      return {
        merchantRequestId: `mock-merchant-${id}`,
        checkoutRequestId: `ws_CO_MOCK_${id}`,
        customerMessage: phone.endsWith('1111')
          ? 'Mock mode: this payment will be simulated as cancelled.'
          : 'Mock mode: this payment will be approved automatically in a few seconds.',
      };
    },
    shouldMockSucceed(phone) {
      return !phone.endsWith('1111');
    },
    async queryStkStatus() {
      return { status: 'pending' };
    },
  };
}

function createDarajaClient(settings, fetchImpl) {
  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function request(pathname, options) {
    let response;
    try {
      response = await fetchImpl(`${settings.baseUrl}${pathname}`, {
        ...options,
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new MpesaError('Could not reach M-Pesa. Please try again.', { cause: error.message });
    }
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    return { ok: response.ok, status: response.status, data };
  }

  async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    const credentials = Buffer.from(`${settings.consumerKey}:${settings.consumerSecret}`).toString(
      'base64',
    );
    const { ok, data } = await request('/oauth/v1/generate?grant_type=client_credentials', {
      method: 'GET',
      headers: { Authorization: `Basic ${credentials}` },
    });
    if (!ok || !data.access_token) {
      throw new MpesaError('M-Pesa authentication failed. Check your Daraja credentials.', data);
    }
    cachedToken = data.access_token;
    // Refresh one minute before expiry (tokens normally last 3599 seconds).
    tokenExpiresAt = Date.now() + (Number(data.expires_in || 3599) - 60) * 1000;
    return cachedToken;
  }

  async function authorizedPost(pathname, payload) {
    const token = await getAccessToken();
    return request(pathname, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  const callbackUrl = `${settings.publicBaseUrl}/api/mpesa/callback/${encodeURIComponent(
    settings.callbackSecret,
  )}`;

  return {
    mode: settings.mode,
    async initiateStkPush({ phone, amount, accountReference, description }) {
      const timestamp = darajaTimestamp();
      const { ok, data } = await authorizedPost('/mpesa/stkpush/v1/processrequest', {
        BusinessShortCode: settings.shortcode,
        Password: stkPassword(settings.shortcode, settings.passkey, timestamp),
        Timestamp: timestamp,
        TransactionType: settings.transactionType,
        Amount: amount,
        PartyA: phone,
        PartyB: settings.partyB,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: (settings.accountReference || accountReference).slice(0, 12),
        TransactionDesc: description.slice(0, 13),
      });
      if (!ok || String(data.ResponseCode) !== '0' || !data.CheckoutRequestID) {
        throw new MpesaError(
          data.errorMessage || data.ResponseDescription || 'M-Pesa could not start the payment.',
          data,
        );
      }
      return {
        merchantRequestId: data.MerchantRequestID,
        checkoutRequestId: data.CheckoutRequestID,
        customerMessage: data.CustomerMessage || 'Check your phone and enter your M-Pesa PIN.',
      };
    },
    async queryStkStatus(checkoutRequestId) {
      const timestamp = darajaTimestamp();
      const { data } = await authorizedPost('/mpesa/stkpushquery/v1/query', {
        BusinessShortCode: settings.shortcode,
        Password: stkPassword(settings.shortcode, settings.passkey, timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      });
      if (data.ResultCode !== undefined && !PENDING_QUERY_CODES.has(String(data.ResultCode))) {
        return {
          status: String(data.ResultCode) === '0' ? 'paid' : 'failed',
          resultCode: String(data.ResultCode),
          resultDesc: String(data.ResultDesc ?? ''),
        };
      }
      if (data.errorCode && !PENDING_ERROR_CODES.has(data.errorCode)) {
        throw new MpesaError(data.errorMessage || 'M-Pesa status check failed.', data);
      }
      return { status: 'pending' };
    },
  };
}

export function createMpesaClient(settings, { fetch: fetchImpl = globalThis.fetch } = {}) {
  return settings.mode === 'mock'
    ? createMockClient(settings)
    : createDarajaClient(settings, fetchImpl);
}
