import fs from 'node:fs';
import path from 'node:path';

const MPESA_MODES = ['mock', 'sandbox', 'production'];
const TRANSACTION_TYPES = ['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'];

const DARAJA_BASE_URLS = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
};

/** Loads variables from a local .env file (if present) without overriding real env vars. */
export function loadEnvFile(file = path.resolve(process.cwd(), '.env')) {
  if (fs.existsSync(file)) {
    process.loadEnvFile(file);
  }
}

function intFromEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Builds the app configuration from environment variables.
 * Throws a descriptive error when live M-Pesa mode is missing required settings.
 */
export function getConfig(env = process.env) {
  const mode = (env.MPESA_MODE || 'mock').toLowerCase();
  if (!MPESA_MODES.includes(mode)) {
    throw new Error(`MPESA_MODE must be one of: ${MPESA_MODES.join(', ')} (got "${mode}")`);
  }

  const transactionType = env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline';
  if (!TRANSACTION_TYPES.includes(transactionType)) {
    throw new Error(`MPESA_TRANSACTION_TYPE must be one of: ${TRANSACTION_TYPES.join(', ')}`);
  }

  const shortcode = env.MPESA_SHORTCODE || '';
  const config = {
    port: intFromEnv(env.PORT, 3000),
    nodeEnv: env.NODE_ENV || 'development',
    databasePath: env.DATABASE_PATH || './data/val-access.db',
    adminPassword: env.ADMIN_PASSWORD || '',
    trustProxy: intFromEnv(env.TRUST_PROXY, 0),
    deliveryFee: intFromEnv(env.DELIVERY_FEE_KES, 0),
    mpesa: {
      mode,
      baseUrl: env.MPESA_BASE_URL || DARAJA_BASE_URLS[mode] || '',
      consumerKey: env.MPESA_CONSUMER_KEY || '',
      consumerSecret: env.MPESA_CONSUMER_SECRET || '',
      shortcode,
      passkey: env.MPESA_PASSKEY || '',
      transactionType,
      // Till number for Buy Goods; defaults to the shortcode for Paybill.
      partyB: env.MPESA_PARTY_B || shortcode,
      publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
      callbackSecret: env.MPESA_CALLBACK_SECRET || '',
      accountReference: (env.MPESA_ACCOUNT_REFERENCE || '').slice(0, 12),
      mockDelayMs: intFromEnv(env.MPESA_MOCK_DELAY_MS, 4000),
    },
  };

  if (mode !== 'mock') {
    const required = {
      MPESA_CONSUMER_KEY: config.mpesa.consumerKey,
      MPESA_CONSUMER_SECRET: config.mpesa.consumerSecret,
      MPESA_SHORTCODE: config.mpesa.shortcode,
      MPESA_PASSKEY: config.mpesa.passkey,
      PUBLIC_BASE_URL: config.mpesa.publicBaseUrl,
      MPESA_CALLBACK_SECRET: config.mpesa.callbackSecret,
    };
    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `MPESA_MODE=${mode} requires these environment variables: ${missing.join(', ')}. ` +
          'Set MPESA_MODE=mock to run without M-Pesa credentials.',
      );
    }
    if (!config.mpesa.publicBaseUrl.startsWith('https://')) {
      throw new Error(
        'PUBLIC_BASE_URL must be an https:// URL so Safaricom can deliver callbacks.',
      );
    }
    if (config.mpesa.callbackSecret.length < 16) {
      throw new Error('MPESA_CALLBACK_SECRET must be at least 16 characters long.');
    }
  }

  return config;
}
