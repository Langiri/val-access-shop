import { createApp } from './app.js';
import { getConfig, loadEnvFile } from './config.js';
import { openDatabase } from './db.js';
import { createMpesaClient } from './mpesa.js';
import { createOrderService } from './orders.js';

loadEnvFile();

let config;
try {
  config = getConfig();
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}

const db = openDatabase(config.databasePath);
const mpesa = createMpesaClient(config.mpesa);
const orders = createOrderService({ db, mpesa, config });
const app = createApp({ config, orders });

const server = app.listen(config.port, () => {
  console.log(`Val Access shop running on http://localhost:${config.port}`);
  console.log(`M-Pesa mode: ${config.mpesa.mode}`);
  if (!config.adminPassword) {
    console.warn('ADMIN_PASSWORD is not set - the admin page is disabled.');
  }
});

function shutdown() {
  server.close(() => {
    orders.close();
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
