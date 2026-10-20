import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { products as seedProducts } from './seed-data.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  image TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  location TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  line_total INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  checkout_request_id TEXT UNIQUE,
  merchant_request_id TEXT,
  phone TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  result_code TEXT,
  result_desc TEXT,
  mpesa_receipt TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
`;

/** Opens (and creates if needed) the SQLite database, applies the schema and seeds products. */
export function openDatabase(databasePath) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM products').get();
  if (count === 0) {
    seedDatabase(db);
  }
  return db;
}

/** Inserts or updates the starter products (matched by slug). */
export function seedDatabase(db, list = seedProducts) {
  const upsert = db.prepare(`
    INSERT INTO products (slug, name, category, description, price, image, active)
    VALUES (:slug, :name, :category, :description, :price, :image, 1)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      description = excluded.description,
      price = excluded.price,
      image = excluded.image,
      active = 1
  `);
  transaction(db, () => {
    for (const product of list) {
      upsert.run(product);
    }
  });
  return list.length;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
