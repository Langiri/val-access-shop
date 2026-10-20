import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildStkCallback, MpesaError } from '../src/mpesa.js';
import { startTestServer, validCustomer, waitFor } from './helpers.js';

const CALLBACK_SECRET = 'test-callback-secret-1234567890';
const basicAuth = (password) => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;

describe('shop in mock mode', () => {
  let server;
  before(async () => {
    server = await startTestServer({ env: { ADMIN_PASSWORD: 'secret-pass' } });
  });
  after(() => server.close());

  test('serves pages and products', async () => {
    const home = await server.request('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /Val Access/);
    for (const page of ['/shop', '/cart', '/checkout', '/order']) {
      assert.equal((await server.request(page)).status, 200, page);
    }
    assert.equal((await server.request('/nope')).status, 404);

    const { status, body } = await server.request('/api/products');
    assert.equal(status, 200);
    assert.equal(body.products.length, 8);
    const categories = new Set(body.products.map((p) => p.category));
    assert.deepEqual([...categories].sort(), ['Bows', 'Clips', 'Headbands', 'Scrunchies']);
    for (const product of body.products) {
      assert.ok(product.name && product.image && product.description && product.price > 0);
    }

    const config = await server.request('/api/config');
    assert.equal(config.body.mpesaMode, 'mock');
  });

  test('rejects invalid checkout with friendly field errors', async () => {
    const { status, body } = await server.request('/api/orders', {
      method: 'POST',
      body: { customer: { name: '', phone: '0812' }, items: [] },
    });
    assert.equal(status, 400);
    assert.ok(body.fields.name && body.fields.phone && body.fields.location && body.fields.items);

    const badJson = await server.request('/api/orders', { method: 'POST', body: '{oops' });
    assert.equal(badJson.status, 400);

    const unknownProduct = await server.request('/api/orders', {
      method: 'POST',
      body: { customer: validCustomer, items: [{ productId: 999, quantity: 1 }] },
    });
    assert.equal(unknownProduct.status, 400);
    assert.ok(unknownProduct.body.fields.items);
  });

  test('creates an order with server-side prices and completes mock payment', async () => {
    const { body: catalog } = await server.request('/api/products');
    const [first, second] = catalog.products;
    const { status, body } = await server.request('/api/orders', {
      method: 'POST',
      body: {
        customer: validCustomer,
        items: [
          { productId: first.id, quantity: 2, price: 1 },
          { productId: second.id, quantity: 1 },
        ],
      },
    });
    assert.equal(status, 201);
    assert.equal(body.order.total, first.price * 2 + second.price);
    assert.equal(body.order.status, 'pending_payment');
    assert.equal(body.order.payment.status, 'pending');
    assert.match(body.order.code, /^VA-[A-Z0-9]{6}$/);
    assert.equal(body.order.phone, undefined, 'customer phone is not exposed');

    const paid = await waitFor(async () => {
      const res = await server.request(`/api/orders/${body.order.id}`);
      return res.body.order.status === 'paid' ? res.body.order : null;
    });
    assert.match(paid.payment.receipt, /^MOCK/);

    const retry = await server.request(`/api/orders/${body.order.id}/pay`, { method: 'POST' });
    assert.equal(retry.status, 409);
  });

  test('simulates a cancelled payment and allows retrying', async () => {
    const { body: catalog } = await server.request('/api/products');
    const { body } = await server.request('/api/orders', {
      method: 'POST',
      body: {
        customer: { ...validCustomer, phone: '0700001111' },
        items: [{ productId: catalog.products[0].id, quantity: 1 }],
      },
    });
    const failed = await waitFor(async () => {
      const res = await server.request(`/api/orders/${body.order.id}`);
      return res.body.order.status === 'failed' ? res.body.order : null;
    });
    assert.equal(failed.payment.status, 'failed');
    assert.equal(failed.payment.canRetry, true);
    assert.match(failed.payment.message, /cancelled/i);

    const retry = await server.request(`/api/orders/${body.order.id}/pay`, { method: 'POST' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.order.status, 'pending_payment');
  });

  test('returns 404 for unknown orders', async () => {
    assert.equal((await server.request('/api/orders/not-a-uuid')).status, 404);
    assert.equal(
      (await server.request('/api/orders/00000000-0000-4000-8000-000000000000')).status,
      404,
    );
  });

  test('protects the admin page and API with ADMIN_PASSWORD', async () => {
    const noAuth = await server.request('/api/admin/orders');
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers.get('www-authenticate'), /Basic/);

    const wrong = await server.request('/admin', {
      headers: { Authorization: basicAuth('wrong') },
    });
    assert.equal(wrong.status, 401);

    const page = await server.request('/admin', {
      headers: { Authorization: basicAuth('secret-pass') },
    });
    assert.equal(page.status, 200);
    assert.match(page.text, /Recent orders/);

    const { status, body } = await server.request('/api/admin/orders', {
      headers: { Authorization: basicAuth('secret-pass') },
    });
    assert.equal(status, 200);
    assert.ok(body.orders.length >= 2);
    assert.equal(body.orders[0].phone, '254700001111');
    assert.ok(body.stats.paid >= 1);

    const paidOnly = await server.request('/api/admin/orders?status=paid', {
      headers: { Authorization: basicAuth('secret-pass') },
    });
    assert.ok(paidOnly.body.orders.every((o) => o.status === 'paid'));
  });

  test('admin.html is not served as a public static file', async () => {
    assert.equal((await server.request('/admin.html')).status, 404);
  });

  test('callback route is disabled without a callback secret', async () => {
    const res = await server.request('/api/mpesa/callback/anything', { method: 'POST', body: {} });
    assert.equal(res.status, 404);
  });
});

test('admin is disabled when ADMIN_PASSWORD is not set', async () => {
  const server = await startTestServer();
  try {
    const res = await server.request('/api/admin/orders', {
      headers: { Authorization: basicAuth('') },
    });
    assert.equal(res.status, 503);
  } finally {
    await server.close();
  }
});

describe('live-style M-Pesa flow (fake Daraja client)', () => {
  let server;
  let counter = 0;
  let failNext = false;
  let queryResult = { status: 'pending' };
  const fakeClient = {
    mode: 'sandbox',
    async initiateStkPush() {
      if (failNext) {
        failNext = false;
        throw new MpesaError('M-Pesa is unavailable right now.');
      }
      counter += 1;
      return {
        merchantRequestId: `m-${counter}`,
        checkoutRequestId: `ws_CO_${counter}`,
        customerMessage: 'Success. Request accepted for processing',
      };
    },
    async queryStkStatus() {
      return queryResult;
    },
  };

  before(async () => {
    server = await startTestServer({
      env: { MPESA_CALLBACK_SECRET: CALLBACK_SECRET },
      mpesa: fakeClient,
    });
  });
  after(() => server.close());

  async function placeOrder() {
    const { body: catalog } = await server.request('/api/products');
    return server.request('/api/orders', {
      method: 'POST',
      body: {
        customer: validCustomer,
        items: [{ productId: catalog.products[2].id, quantity: 1 }],
      },
    });
  }

  test('marks an order paid from a valid Safaricom callback (idempotently)', async () => {
    const { body } = await placeOrder();
    const callback = buildStkCallback({
      checkoutRequestId: `ws_CO_${counter}`,
      merchantRequestId: `m-${counter}`,
      success: true,
      amount: body.order.total,
      phone: '254712345678',
    });

    const forged = await server.request('/api/mpesa/callback/wrong-secret', {
      method: 'POST',
      body: callback,
    });
    assert.equal(forged.status, 404);
    assert.equal(
      (await server.request(`/api/orders/${body.order.id}`)).body.order.status,
      'pending_payment',
    );

    const res = await server.request(`/api/mpesa/callback/${CALLBACK_SECRET}`, {
      method: 'POST',
      body: callback,
    });
    assert.deepEqual(res.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    const order = (await server.request(`/api/orders/${body.order.id}`)).body.order;
    assert.equal(order.status, 'paid');

    // A later failure callback for the same request must not undo the payment.
    await server.request(`/api/mpesa/callback/${CALLBACK_SECRET}`, {
      method: 'POST',
      body: {
        Body: {
          stkCallback: { CheckoutRequestID: `ws_CO_${counter}`, ResultCode: 1, ResultDesc: 'x' },
        },
      },
    });
    assert.equal((await server.request(`/api/orders/${body.order.id}`)).body.order.status, 'paid');
  });

  test('rejects callbacks whose amount does not match the order', async () => {
    const { body } = await placeOrder();
    await server.request(`/api/mpesa/callback/${CALLBACK_SECRET}`, {
      method: 'POST',
      body: buildStkCallback({
        checkoutRequestId: `ws_CO_${counter}`,
        merchantRequestId: `m-${counter}`,
        success: true,
        amount: 1,
        phone: '254712345678',
      }),
    });
    const order = (await server.request(`/api/orders/${body.order.id}`)).body.order;
    assert.equal(order.status, 'failed');
    assert.match(order.payment.message, /Amount mismatch/);
  });

  test('acknowledges unknown or malformed callbacks without changing orders', async () => {
    const res = await server.request(`/api/mpesa/callback/${CALLBACK_SECRET}`, {
      method: 'POST',
      body: { hello: 'world' },
    });
    assert.equal(res.status, 200);
  });

  test('keeps the order and reports a retryable error when STK push fails', async () => {
    failNext = true;
    const res = await placeOrder();
    assert.equal(res.status, 502);
    assert.match(res.body.error, /unavailable/);
    assert.ok(res.body.orderId);
    const order = (await server.request(`/api/orders/${res.body.orderId}`)).body.order;
    assert.equal(order.status, 'failed');
    assert.equal(order.payment.canRetry, true);
  });

  test('status endpoint queries Daraja when the callback is late', async () => {
    const { body } = await placeOrder();
    const old = new Date(Date.now() - 60 * 1000).toISOString();
    server.db
      .prepare('UPDATE payments SET created_at = ? WHERE checkout_request_id = ?')
      .run(old, `ws_CO_${counter}`);

    queryResult = {
      status: 'failed',
      resultCode: '1037',
      resultDesc: 'DS timeout user cannot be reached',
    };
    const order = (await server.request(`/api/orders/${body.order.id}`)).body.order;
    assert.equal(order.status, 'failed');
    assert.match(order.payment.message, /timeout/);
  });
});
