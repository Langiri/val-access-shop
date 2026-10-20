import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { OrderError } from './orders.js';
import { validateCheckout } from './validation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_STATUSES = ['pending_payment', 'paid', 'failed'];

/** Constant-time string comparison (only the length can be inferred from timing). */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function adminAuth(config) {
  return (req, res, next) => {
    if (!config.adminPassword) {
      res.status(503).type('text').send('Admin is disabled. Set ADMIN_PASSWORD to enable it.');
      return;
    }
    const header = req.get('authorization') || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const password = separator === -1 ? null : decoded.slice(separator + 1);
      if (password !== null && safeEqual(password, config.adminPassword)) {
        next();
        return;
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="Val Access Admin", charset="UTF-8"');
    res.status(401).type('text').send('Admin password required.');
  };
}

function sendOrderError(res, error) {
  res.status(error.status).json({
    error: error.message,
    fields: error.details,
    orderId: error.orderId,
  });
}

export function createApp({ config, orders, logger = console }) {
  const app = express();
  const isProduction = config.nodeEnv === 'production';

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'data:'],
          // Allow plain-http access on a LAN (e.g. testing on a phone) outside production.
          'upgrade-insecure-requests': isProduction ? [] : null,
        },
      },
      strictTransportSecurity: isProduction,
    }),
  );

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down and try again shortly.' },
  });
  // Each payment request sends a prompt to a phone, so keep this strict.
  const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many payment attempts. Please wait a few minutes and try again.' },
  });
  const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });

  const api = express.Router();
  api.use(apiLimiter);
  api.use(express.json({ limit: '50kb' }));

  api.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  api.get('/config', (req, res) => {
    res.json({ currency: 'KES', deliveryFee: config.deliveryFee, mpesaMode: config.mpesa.mode });
  });

  api.get('/products', (req, res) => {
    res.json({ products: orders.listProducts() });
  });

  api.post('/orders', paymentLimiter, async (req, res, next) => {
    const { errors, value } = validateCheckout(req.body);
    if (errors) {
      res.status(400).json({ error: 'Please check the highlighted fields.', fields: errors });
      return;
    }
    try {
      const result = await orders.checkout(value);
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof OrderError) sendOrderError(res, error);
      else next(error);
    }
  });

  api.get('/orders/:id', async (req, res, next) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    try {
      const order = await orders.getOrderStatus(req.params.id);
      if (!order) res.status(404).json({ error: 'Order not found.' });
      else res.json({ order });
    } catch (error) {
      next(error);
    }
  });

  api.post('/orders/:id/pay', paymentLimiter, async (req, res, next) => {
    if (!UUID_PATTERN.test(req.params.id)) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    try {
      res.json(await orders.retryPayment(req.params.id));
    } catch (error) {
      if (error instanceof OrderError) sendOrderError(res, error);
      else next(error);
    }
  });

  // Safaricom posts STK results here. The secret path segment stops forged callbacks.
  api.post('/mpesa/callback/:token', (req, res) => {
    const secret = config.mpesa.callbackSecret;
    if (!secret || !safeEqual(req.params.token, secret)) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    try {
      orders.handleCallback(req.body);
    } catch (error) {
      logger.error('Failed to process M-Pesa callback', error);
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  });

  api.get('/admin/orders', adminLimiter, adminAuth(config), (req, res) => {
    const status = ORDER_STATUSES.includes(req.query.status) ? req.query.status : undefined;
    res.json({
      orders: orders.listRecentOrders({ status, limit: 100 }),
      stats: orders.orderStats(),
      mpesaMode: config.mpesa.mode,
    });
  });

  api.use((req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use('/api', api);

  app.get('/admin', adminLimiter, adminAuth(config), (req, res) => {
    res.sendFile(path.join(ROOT, 'views', 'admin.html'));
  });

  app.use(
    express.static(path.join(ROOT, 'public'), {
      extensions: ['html'],
      maxAge: '1h',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use((req, res) => {
    res.status(404).sendFile(path.join(ROOT, 'public', '404.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request is too large.' });
      return;
    }
    logger.error(error);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}
