import { createApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { createMpesaClient } from '../src/mpesa.js';
import { createOrderService } from '../src/orders.js';

export const silentLogger = { info() {}, warn() {}, error() {} };

/** Starts the app on a random port with an in-memory database. */
export async function startTestServer({ env = {}, mpesa } = {}) {
  const config = getConfig({ MPESA_MODE: 'mock', MPESA_MOCK_DELAY_MS: '20', ...env });
  // Allow exercising the callback route in tests without full live configuration.
  if (env.MPESA_CALLBACK_SECRET) config.mpesa.callbackSecret = env.MPESA_CALLBACK_SECRET;
  const db = openDatabase(':memory:');
  const client = mpesa || createMpesaClient(config.mpesa);
  const orders = createOrderService({ db, mpesa: client, config, logger: silentLogger });
  const app = createApp({ config, orders, logger: silentLogger });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, body: json, text, headers: response.headers };
  }

  async function close() {
    orders.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }

  return { request, close, db, config };
}

export const validCustomer = {
  name: 'Wanjiku Mwangi',
  phone: '0712 345 678',
  location: 'Kilimani, Nairobi',
  notes: 'Pink please',
};

export async function waitFor(check, { timeout = 2000, interval = 20 } = {}) {
  const started = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
