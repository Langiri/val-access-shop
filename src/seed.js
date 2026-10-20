import { getConfig, loadEnvFile } from './config.js';
import { openDatabase, seedDatabase } from './db.js';

loadEnvFile();
// Seeding only needs the database path, so don't require M-Pesa credentials here.
const config = getConfig({ ...process.env, MPESA_MODE: 'mock' });
const db = openDatabase(config.databasePath);
const count = seedDatabase(db);
db.close();
console.log(`Seeded ${count} products into ${config.databasePath}`);
