import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildStkCallback,
  createMpesaClient,
  darajaTimestamp,
  MpesaError,
  parseStkCallback,
  stkPassword,
} from '../src/mpesa.js';

const settings = {
  mode: 'sandbox',
  baseUrl: 'https://daraja.test',
  consumerKey: 'key',
  consumerSecret: 'secret',
  shortcode: '174379',
  passkey: 'passkey',
  transactionType: 'CustomerPayBillOnline',
  partyB: '174379',
  publicBaseUrl: 'https://shop.example.com',
  callbackSecret: 'a-very-long-callback-secret',
  accountReference: '',
};

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    const next = responses.shift();
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  fn.calls = calls;
  return fn;
}

test('darajaTimestamp uses Kenyan time', () => {
  assert.equal(darajaTimestamp(new Date('2026-01-31T22:05:09Z')), '20260201010509');
});

test('stkPassword is base64(shortcode + passkey + timestamp)', () => {
  const password = stkPassword('174379', 'abc', '20260101000000');
  assert.equal(Buffer.from(password, 'base64').toString(), '174379abc20260101000000');
});

test('parseStkCallback reads success and failure callbacks', () => {
  const success = parseStkCallback(
    buildStkCallback({
      checkoutRequestId: 'ws_1',
      merchantRequestId: 'm_1',
      success: true,
      amount: 500,
      phone: '254712345678',
    }),
  );
  assert.equal(success.resultCode, 0);
  assert.equal(success.amount, 500);
  assert.match(success.receipt, /^MOCK/);

  const failure = parseStkCallback({
    Body: { stkCallback: { CheckoutRequestID: 'ws_2', ResultCode: 1032, ResultDesc: 'Cancelled' } },
  });
  assert.equal(failure.resultCode, 1032);
  assert.equal(failure.amount, null);
  assert.equal(parseStkCallback({ foo: 'bar' }), null);
});

test('Daraja client sends a correct STK push and caches the token', async () => {
  const fetch = fakeFetch([
    { status: 200, body: { access_token: 'tok', expires_in: '3599' } },
    {
      status: 200,
      body: {
        MerchantRequestID: 'm1',
        CheckoutRequestID: 'ws_CO_1',
        ResponseCode: '0',
        CustomerMessage: 'Success. Request accepted for processing',
      },
    },
    { status: 200, body: { ResultCode: '0', ResultDesc: 'processed successfully' } },
  ]);
  const client = createMpesaClient(settings, { fetch });
  const result = await client.initiateStkPush({
    phone: '254712345678',
    amount: 650,
    accountReference: 'VAABC123',
    description: 'Order VA-ABC123',
  });
  assert.equal(result.checkoutRequestId, 'ws_CO_1');

  const [tokenCall, pushCall] = fetch.calls;
  assert.equal(
    tokenCall.url,
    'https://daraja.test/oauth/v1/generate?grant_type=client_credentials',
  );
  assert.equal(
    tokenCall.options.headers.Authorization,
    `Basic ${Buffer.from('key:secret').toString('base64')}`,
  );
  assert.equal(pushCall.url, 'https://daraja.test/mpesa/stkpush/v1/processrequest');
  assert.equal(pushCall.options.headers.Authorization, 'Bearer tok');
  assert.equal(pushCall.body.Amount, 650);
  assert.equal(pushCall.body.PartyA, '254712345678');
  assert.equal(pushCall.body.PartyB, '174379');
  assert.equal(pushCall.body.TransactionType, 'CustomerPayBillOnline');
  assert.equal(pushCall.body.TransactionDesc.length <= 13, true);
  assert.equal(
    pushCall.body.CallBackURL,
    'https://shop.example.com/api/mpesa/callback/a-very-long-callback-secret',
  );
  assert.equal(
    Buffer.from(pushCall.body.Password, 'base64').toString(),
    `174379passkey${pushCall.body.Timestamp}`,
  );

  const status = await client.queryStkStatus('ws_CO_1');
  assert.equal(status.status, 'paid');
  assert.equal(fetch.calls.length, 3, 'token is reused');
  assert.equal(fetch.calls[2].url, 'https://daraja.test/mpesa/stkpushquery/v1/query');
});

test('Daraja client reports errors and pending queries', async () => {
  const fetch = fakeFetch([
    { status: 200, body: { access_token: 'tok', expires_in: '3599' } },
    {
      status: 400,
      body: { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid Amount' },
    },
    {
      status: 500,
      body: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' },
    },
    { status: 200, body: { ResultCode: '1032', ResultDesc: 'Request cancelled by user' } },
  ]);
  const client = createMpesaClient(settings, { fetch });
  await assert.rejects(
    client.initiateStkPush({
      phone: '254712345678',
      amount: 1,
      accountReference: 'x',
      description: 'x',
    }),
    (error) => error instanceof MpesaError && /Invalid Amount/.test(error.message),
  );
  assert.deepEqual(await client.queryStkStatus('ws'), { status: 'pending' });
  const failed = await client.queryStkStatus('ws');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.resultCode, '1032');
});

test('Daraja client reports authentication failures', async () => {
  const client = createMpesaClient(settings, {
    fetch: fakeFetch([{ status: 400, body: { errorMessage: 'Invalid credentials' } }]),
  });
  await assert.rejects(
    client.initiateStkPush({
      phone: '254712345678',
      amount: 1,
      accountReference: 'x',
      description: 'x',
    }),
    /authentication failed/,
  );
});
