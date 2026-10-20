import { getConfig, loadEnvFile } from './config.js';
import { openDatabase, seedDatabase } from './db.js';

loadEnvFile();
const config = getConfig();
const db = openDatabase(config.databasePath);
const count = seedDatabase(db);
db.close();
console.log(`Seeded ${count} products into ${config.databasePath}`);
