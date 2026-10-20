// Shared helpers for all pages: cart storage, formatting, DOM building and API calls.
const CART_KEY = 'valaccess.cart.v1';
const MAX_QUANTITY = 20;

/** Cart is stored as { [productId]: quantity }. Prices always come from the server. */
export function getCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '{}');
    const cart = {};
    for (const [id, qty] of Object.entries(raw)) {
      const quantity = Math.min(MAX_QUANTITY, Math.floor(Number(qty)));
      if (Number(id) > 0 && quantity > 0) cart[id] = quantity;
    }
    return cart;
  } catch {
    return {};
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
}

export function addToCart(productId, quantity = 1) {
  const cart = getCart();
  cart[productId] = Math.min(MAX_QUANTITY, (cart[productId] || 0) + quantity);
  saveCart(cart);
}

export function setQuantity(productId, quantity) {
  const cart = getCart();
  if (quantity <= 0) delete cart[productId];
  else cart[productId] = Math.min(MAX_QUANTITY, quantity);
  saveCart(cart);
}

export function clearCart() {
  saveCart({});
}

export function cartCount() {
  return Object.values(getCart()).reduce((sum, qty) => sum + qty, 0);
}

export function updateCartBadge() {
  const count = cartCount();
  for (const badge of document.querySelectorAll('[data-cart-count]')) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
}

export const MAX_ITEM_QUANTITY = MAX_QUANTITY;

/** Returns the cart lines with current server prices, dropping products that no longer exist. */
export function cartLines(productList, cart = getCart()) {
  const byId = new Map(productList.map((p) => [String(p.id), p]));
  return Object.entries(cart)
    .filter(([id]) => byId.has(id))
    .map(([id, quantity]) => {
      const product = byId.get(id);
      return { product, quantity, lineTotal: product.price * quantity };
    });
}

export function formatKes(amount) {
  return `KES ${Number(amount).toLocaleString('en-KE')}`;
}

/** Tiny DOM builder that only ever sets text (never HTML), so user data is always escaped. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch {
    const error = new Error('Network error. Check your internet connection and try again.');
    error.network = true;
    throw error;
  }
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

let productsPromise;
export function loadProducts() {
  productsPromise ||= api('/api/products').then((data) => data.products);
  return productsPromise;
}

export function showMessage(container, type, text) {
  container.replaceChildren(el('div', { class: `notice notice-${type}`, role: 'alert', text }));
}

function initFooter() {
  const year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
}

updateCartBadge();
initFooter();
window.addEventListener('storage', updateCartBadge);
