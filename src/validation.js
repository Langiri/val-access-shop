const MAX_ITEMS = 30;
const MAX_QUANTITY = 20;

/**
 * Normalises Kenyan mobile numbers to the 2547XXXXXXXX / 2541XXXXXXXX format required by M-Pesa.
 * Accepts 07.., 01.., 7.., 1.., 2547.., +2547.. (spaces and dashes are ignored).
 * Returns null when the number is not a valid Kenyan mobile number.
 */
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/[\s-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.startsWith('0')) digits = `254${digits.slice(1)}`;
  else if (/^[17]\d{8}$/.test(digits)) digits = `254${digits}`;
  return /^254[17]\d{8}$/.test(digits) ? digits : null;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/**
 * Validates a checkout request body.
 * Returns { errors } (field -> message) or { value } with cleaned customer data and cart items.
 */
export function validateCheckout(body) {
  const errors = {};
  const customer = body && typeof body.customer === 'object' && body.customer ? body.customer : {};

  const name = cleanText(customer.name);
  if (name.length < 2 || name.length > 80) {
    errors.name = 'Please enter your name (2-80 characters).';
  }

  const phone = normalizePhone(customer.phone);
  if (!phone) {
    errors.phone = 'Enter a valid Safaricom number, e.g. 0712 345 678.';
  }

  const location = cleanText(customer.location);
  if (location.length < 3 || location.length > 200) {
    errors.location = 'Please enter your delivery location (3-200 characters).';
  }

  const notes = typeof customer.notes === 'string' ? customer.notes.trim() : '';
  if (notes.length > 500) {
    errors.notes = 'Notes must be 500 characters or fewer.';
  }

  const rawItems = Array.isArray(body?.items) ? body.items : [];
  const quantities = new Map();
  let itemsValid = rawItems.length > 0 && rawItems.length <= MAX_ITEMS;
  for (const item of rawItems) {
    const productId = Number(item?.productId);
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantity)) {
      itemsValid = false;
      break;
    }
    const total = (quantities.get(productId) || 0) + quantity;
    if (quantity < 1 || total > MAX_QUANTITY) {
      itemsValid = false;
      break;
    }
    quantities.set(productId, total);
  }
  if (!itemsValid) {
    errors.items = `Your cart is empty or invalid (max ${MAX_QUANTITY} of each item).`;
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    value: {
      customer: { name, phone, location, notes },
      items: [...quantities.entries()].map(([productId, quantity]) => ({ productId, quantity })),
    },
  };
}
