import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePhone, validateCheckout } from '../src/validation.js';

test('normalizePhone accepts common Kenyan formats', () => {
  assert.equal(normalizePhone('0712345678'), '254712345678');
  assert.equal(normalizePhone('0712 345 678'), '254712345678');
  assert.equal(normalizePhone('+254712345678'), '254712345678');
  assert.equal(normalizePhone('254112345678'), '254112345678');
  assert.equal(normalizePhone('712345678'), '254712345678');
  assert.equal(normalizePhone('0110-345-678'), '254110345678');
});

test('normalizePhone rejects invalid numbers', () => {
  for (const value of ['', '12345', '0812345678', '25471234567', 'abc', '+1 555 123 4567', null]) {
    assert.equal(normalizePhone(value), null, String(value));
  }
});

test('validateCheckout returns field errors', () => {
  const { errors } = validateCheckout({ customer: { name: 'A', phone: '123' }, items: [] });
  assert.ok(errors.name);
  assert.ok(errors.phone);
  assert.ok(errors.location);
  assert.ok(errors.items);
});

test('validateCheckout merges duplicate items and enforces limits', () => {
  const customer = { name: 'Amina', phone: '0712345678', location: 'Westlands' };
  const { value } = validateCheckout({
    customer,
    items: [
      { productId: 1, quantity: 2 },
      { productId: 1, quantity: 3 },
      { productId: 2, quantity: 1 },
    ],
  });
  assert.deepEqual(value.items, [
    { productId: 1, quantity: 5 },
    { productId: 2, quantity: 1 },
  ]);
  assert.equal(value.customer.phone, '254712345678');

  for (const items of [
    [{ productId: 1, quantity: 0 }],
    [{ productId: 1, quantity: 1.5 }],
    [{ productId: 'x', quantity: 1 }],
    [{ productId: 1, quantity: 21 }],
  ]) {
    assert.ok(validateCheckout({ customer, items }).errors.items, JSON.stringify(items));
  }
});
