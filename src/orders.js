import crypto from 'node:crypto';
import { transaction } from './db.js';
import { buildStkCallback, MpesaError, parseStkCallback } from './mpesa.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// A customer may retry a still-pending payment after this long (e.g. they dismissed the prompt).
const RETRY_PENDING_AFTER_MS = 60 * 1000;
// In live mode, ask Daraja for the status if no callback has arrived after this long.
const QUERY_AFTER_MS = 30 * 1000;
const QUERY_INTERVAL_MS = 15 * 1000;

export class OrderError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function orderCode() {
  let code = 'VA-';
  for (let i = 0; i < 6; i += 1) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

function maskPhone(phone) {
  return `${phone.slice(0, 6)}***${phone.slice(-3)}`;
}

export function createOrderService({ db, mpesa, config, logger = console }) {
  const mockTimers = new Set();

  const statements = {
    activeProducts: db.prepare(
      'SELECT id, slug, name, category, description, price, image FROM products WHERE active = 1 ORDER BY id',
    ),
    insertOrder: db.prepare(`
      INSERT INTO orders (public_id, code, customer_name, phone, location, notes, subtotal,
        delivery_fee, total, status, created_at, updated_at)
      VALUES (:publicId, :code, :name, :phone, :location, :notes, :subtotal, :deliveryFee,
        :total, 'pending_payment', :now, :now)
    `),
    insertItem: db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    orderByPublicId: db.prepare('SELECT * FROM orders WHERE public_id = ?'),
    orderById: db.prepare('SELECT * FROM orders WHERE id = ?'),
    orderItems: db.prepare(
      'SELECT product_name AS name, unit_price AS unitPrice, quantity, line_total AS lineTotal FROM order_items WHERE order_id = ? ORDER BY id',
    ),
    latestPayment: db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1'),
    paymentByCheckoutId: db.prepare('SELECT * FROM payments WHERE checkout_request_id = ?'),
    insertPayment: db.prepare(`
      INSERT INTO payments (order_id, checkout_request_id, merchant_request_id, phone, amount,
        status, result_desc, created_at, updated_at)
      VALUES (:orderId, :checkoutRequestId, :merchantRequestId, :phone, :amount, :status,
        :resultDesc, :now, :now)
    `),
    finalizePayment: db.prepare(`
      UPDATE payments SET status = :status, result_code = :resultCode, result_desc = :resultDesc,
        mpesa_receipt = COALESCE(:receipt, mpesa_receipt), updated_at = :now
      WHERE id = :id AND status = 'pending'
    `),
    touchPaymentCheck: db.prepare('UPDATE payments SET last_checked_at = ? WHERE id = ?'),
    setOrderStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'),
  };

  function listProducts() {
    return statements.activeProducts.all().map((p) => ({ ...p }));
  }

  function createOrder({ customer, items }) {
    const products = new Map(listProducts().map((p) => [p.id, p]));
    const lines = items.map(({ productId, quantity }) => {
      const product = products.get(productId);
      if (!product) {
        throw new OrderError(400, 'Some items in your cart are no longer available.', {
          items: 'Please refresh the shop and add the items again.',
        });
      }
      return { product, quantity, lineTotal: product.price * quantity };
    });
    const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const deliveryFee = config.deliveryFee;
    const now = new Date().toISOString();

    return transaction(db, () => {
      const { lastInsertRowid } = statements.insertOrder.run({
        publicId: crypto.randomUUID(),
        code: orderCode(),
        ...customer,
        subtotal,
        deliveryFee,
        total: subtotal + deliveryFee,
        now,
      });
      for (const line of lines) {
        statements.insertItem.run(
          lastInsertRowid,
          line.product.id,
          line.product.name,
          line.product.price,
          line.quantity,
          line.lineTotal,
        );
      }
      return statements.orderById.get(lastInsertRowid);
    });
  }

  /** Records a final payment result and updates the order status accordingly. */
  function applyPaymentResult(payment, { status, resultCode, resultDesc, receipt = null }) {
    const now = new Date().toISOString();
    transaction(db, () => {
      const { changes } = statements.finalizePayment.run({
        id: payment.id,
        status,
        resultCode: resultCode === undefined || resultCode === null ? null : String(resultCode),
        resultDesc: resultDesc ?? null,
        receipt,
        now,
      });
      if (changes === 0) return; // Already finalised (duplicate callback).
      const order = statements.orderById.get(payment.order_id);
      if (status === 'paid') {
        statements.setOrderStatus.run('paid', now, order.id);
      } else if (order.status !== 'paid') {
        const latest = statements.latestPayment.get(order.id);
        // Only fail the order if this was its most recent payment attempt.
        if (latest.id === payment.id) statements.setOrderStatus.run('failed', now, order.id);
      }
    });
  }

  function scheduleMockCallback(payment, phone) {
    const body = buildStkCallback({
      checkoutRequestId: payment.checkoutRequestId,
      merchantRequestId: payment.merchantRequestId,
      success: mpesa.shouldMockSucceed(phone),
      amount: payment.amount,
      phone,
    });
    const timer = setTimeout(() => {
      mockTimers.delete(timer);
      try {
        handleCallback(body);
      } catch (error) {
        logger.error('Mock callback failed', error);
      }
    }, mpesa.mockDelayMs);
    timer.unref?.();
    mockTimers.add(timer);
  }

  /** Sends an STK push for the order and records the payment attempt. */
  async function startPayment(order) {
    if (order.status === 'paid') {
      throw new OrderError(409, 'This order has already been paid.');
    }
    const latest = statements.latestPayment.get(order.id);
    if (
      order.status === 'pending_payment' &&
      latest &&
      latest.status === 'pending' &&
      Date.now() - Date.parse(latest.created_at) < RETRY_PENDING_AFTER_MS
    ) {
      throw new OrderError(
        409,
        'A payment request was just sent. Please check your phone or wait a minute before retrying.',
      );
    }

    const now = new Date().toISOString();
    let result;
    try {
      result = await mpesa.initiateStkPush({
        phone: order.phone,
        amount: order.total,
        accountReference: order.code.replace('-', ''),
        description: `Order ${order.code}`,
      });
    } catch (error) {
      const message =
        error instanceof MpesaError ? error.message : 'Could not start the M-Pesa payment.';
      logger.error(`STK push failed for ${order.code}:`, error.message, error.details ?? '');
      transaction(db, () => {
        statements.insertPayment.run({
          orderId: order.id,
          checkoutRequestId: null,
          merchantRequestId: null,
          phone: order.phone,
          amount: order.total,
          status: 'failed',
          resultDesc: message,
          now,
        });
        statements.setOrderStatus.run('failed', now, order.id);
      });
      throw new OrderError(502, `${message} You can try again.`);
    }

    transaction(db, () => {
      statements.insertPayment.run({
        orderId: order.id,
        checkoutRequestId: result.checkoutRequestId,
        merchantRequestId: result.merchantRequestId,
        phone: order.phone,
        amount: order.total,
        status: 'pending',
        resultDesc: null,
        now,
      });
      statements.setOrderStatus.run('pending_payment', now, order.id);
    });
    logger.info(`STK push sent for ${order.code} to ${maskPhone(order.phone)}`);

    if (mpesa.mode === 'mock') {
      scheduleMockCallback({ ...result, amount: order.total }, order.phone);
    }
    return { customerMessage: result.customerMessage };
  }

  async function checkout(input) {
    const order = createOrder(input);
    let payment;
    try {
      payment = await startPayment(order);
    } catch (error) {
      if (error instanceof OrderError) error.orderId = order.public_id;
      throw error;
    }
    return { order: getOrderSummary(order.public_id), message: payment.customerMessage };
  }

  async function retryPayment(publicId) {
    const order = statements.orderByPublicId.get(publicId);
    if (!order) throw new OrderError(404, 'Order not found.');
    const payment = await startPayment(order);
    return { order: getOrderSummary(publicId), message: payment.customerMessage };
  }

  /** Handles a Daraja STK callback. Returns false when the callback was not recognised. */
  function handleCallback(body) {
    const result = parseStkCallback(body);
    if (!result) return false;
    const payment = statements.paymentByCheckoutId.get(result.checkoutRequestId);
    if (!payment) {
      logger.warn(`Callback for unknown CheckoutRequestID ${result.checkoutRequestId}`);
      return false;
    }
    if (result.resultCode === 0) {
      if (result.amount !== null && result.amount !== payment.amount) {
        applyPaymentResult(payment, {
          status: 'failed',
          resultCode: result.resultCode,
          resultDesc: `Amount mismatch: expected ${payment.amount}, received ${result.amount}`,
          receipt: result.receipt,
        });
      } else {
        applyPaymentResult(payment, {
          status: 'paid',
          resultCode: 0,
          resultDesc: result.resultDesc,
          receipt: result.receipt,
        });
      }
    } else {
      applyPaymentResult(payment, {
        status: 'failed',
        resultCode: result.resultCode,
        resultDesc: result.resultDesc,
      });
    }
    return true;
  }

  /** In live mode, asks Daraja for the status of a payment whose callback has not arrived. */
  async function refreshPendingPayment(payment) {
    if (mpesa.mode === 'mock' || !payment || payment.status !== 'pending') return;
    if (!payment.checkout_request_id) return;
    const now = Date.now();
    if (now - Date.parse(payment.created_at) < QUERY_AFTER_MS) return;
    if (payment.last_checked_at && now - Date.parse(payment.last_checked_at) < QUERY_INTERVAL_MS) {
      return;
    }
    statements.touchPaymentCheck.run(new Date(now).toISOString(), payment.id);
    try {
      const result = await mpesa.queryStkStatus(payment.checkout_request_id);
      if (result.status !== 'pending') applyPaymentResult(payment, result);
    } catch (error) {
      logger.warn(`STK status query failed for payment ${payment.id}:`, error.message);
    }
  }

  function getOrderSummary(publicId) {
    const order = statements.orderByPublicId.get(publicId);
    if (!order) return null;
    const payment = statements.latestPayment.get(order.id);
    return {
      id: order.public_id,
      code: order.code,
      status: order.status,
      customerName: order.customer_name,
      subtotal: order.subtotal,
      deliveryFee: order.delivery_fee,
      total: order.total,
      createdAt: order.created_at,
      items: statements.orderItems.all(order.id).map((item) => ({ ...item })),
      payment: payment
        ? {
            status: payment.status,
            message: payment.result_desc,
            receipt: payment.mpesa_receipt,
            canRetry:
              order.status === 'failed' ||
              (order.status === 'pending_payment' &&
                Date.now() - Date.parse(payment.created_at) >= RETRY_PENDING_AFTER_MS),
          }
        : null,
    };
  }

  async function getOrderStatus(publicId) {
    const order = statements.orderByPublicId.get(publicId);
    if (!order) return null;
    if (order.status === 'pending_payment') {
      await refreshPendingPayment(statements.latestPayment.get(order.id));
    }
    return getOrderSummary(publicId);
  }

  function listRecentOrders({ status, limit = 50 } = {}) {
    const params = [];
    let sql = 'SELECT * FROM orders';
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);
    const orders = db.prepare(sql).all(...params);
    return orders.map((order) => {
      const payment = statements.latestPayment.get(order.id);
      return {
        code: order.code,
        status: order.status,
        customerName: order.customer_name,
        phone: order.phone,
        location: order.location,
        notes: order.notes,
        total: order.total,
        createdAt: order.created_at,
        items: statements.orderItems.all(order.id).map((item) => ({ ...item })),
        payment: payment
          ? {
              status: payment.status,
              receipt: payment.mpesa_receipt,
              resultCode: payment.result_code,
              message: payment.result_desc,
              updatedAt: payment.updated_at,
            }
          : null,
      };
    });
  }

  function orderStats() {
    const rows = db.prepare('SELECT status, COUNT(*) AS count FROM orders GROUP BY status').all();
    const paidTotal = db
      .prepare("SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE status = 'paid'")
      .get().total;
    const stats = { pending_payment: 0, paid: 0, failed: 0, paidTotal };
    for (const row of rows) stats[row.status] = row.count;
    return stats;
  }

  function close() {
    for (const timer of mockTimers) clearTimeout(timer);
    mockTimers.clear();
  }

  return {
    listProducts,
    checkout,
    retryPayment,
    handleCallback,
    getOrderStatus,
    listRecentOrders,
    orderStats,
    close,
  };
}
