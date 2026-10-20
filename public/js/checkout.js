import {
  api,
  cartLines,
  clearCart,
  el,
  formatKes,
  getCart,
  loadProducts,
  showMessage,
} from './common.js';

const form = document.getElementById('checkout-form');
const button = document.getElementById('pay-button');
const summary = document.getElementById('summary');
const message = document.getElementById('checkout-message');
const modeHint = document.getElementById('mode-hint');
const PHONE_PATTERN = /^(?:\+?254|0)?[17]\d{8}$/;
let lines = [];

function renderSummary(deliveryFee) {
  if (lines.length === 0) {
    form.hidden = true;
    summary.replaceChildren(
      el('div', { class: 'center' }, [
        el('p', { text: 'Your cart is empty.' }),
        el('a', { class: 'btn btn-primary', href: '/shop' }, 'Browse accessories'),
      ]),
    );
    return;
  }
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  summary.replaceChildren(
    el('h2', { text: 'Order summary' }),
    el(
      'ul',
      { class: 'summary-list' },
      lines.map((line) =>
        el('li', {}, [
          el('span', { text: `${line.quantity} × ${line.product.name}` }),
          el('span', { text: formatKes(line.lineTotal) }),
        ]),
      ),
    ),
    el('div', { class: 'total-row' }, [
      el('span', { text: 'Delivery' }),
      el('span', { text: deliveryFee ? formatKes(deliveryFee) : 'Free / arranged on call' }),
    ]),
    el('div', { class: 'total-row grand' }, [
      el('span', { text: 'Total' }),
      el('span', { text: formatKes(subtotal + deliveryFee) }),
    ]),
    el('a', { href: '/cart', class: 'small-link' }, 'Edit cart'),
  );
  button.textContent = `Pay ${formatKes(subtotal + deliveryFee)} with M-Pesa`;
}

function setFieldErrors(errors = {}) {
  for (const node of form.querySelectorAll('[data-error-for]')) {
    const field = node.dataset.errorFor;
    node.textContent = errors[field] || '';
    const input = form.elements[field];
    if (input) input.setAttribute('aria-invalid', errors[field] ? 'true' : 'false');
  }
  const first = Object.keys(errors)
    .map((f) => form.elements[f])
    .find(Boolean);
  if (first) first.focus();
}

function validate(data) {
  const errors = {};
  if (data.name.length < 2) errors.name = 'Please enter your name.';
  if (!PHONE_PATTERN.test(data.phone.replace(/[\s-]/g, ''))) {
    errors.phone = 'Enter a valid Safaricom number, e.g. 0712 345 678.';
  }
  if (data.location.length < 3) errors.location = 'Please enter your delivery location.';
  return errors;
}

function setLoading(loading) {
  button.disabled = loading;
  button.classList.toggle('is-loading', loading);
  if (loading) {
    button.dataset.label = button.textContent;
    button.textContent = 'Sending M-Pesa request…';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.replaceChildren();
  const data = {
    name: form.elements.name.value.trim(),
    phone: form.elements.phone.value.trim(),
    location: form.elements.location.value.trim(),
    notes: form.elements.notes.value.trim(),
  };
  const errors = validate(data);
  setFieldErrors(errors);
  if (Object.keys(errors).length > 0) return;

  setLoading(true);
  try {
    const items = Object.entries(getCart()).map(([productId, quantity]) => ({
      productId: Number(productId),
      quantity,
    }));
    const result = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ customer: data, items }),
    });
    clearCart();
    window.location.assign(`/order?id=${encodeURIComponent(result.order.id)}`);
  } catch (error) {
    setLoading(false);
    if (error.data?.orderId) {
      // The order was saved but the payment prompt failed; the order page lets them retry.
      clearCart();
      window.location.assign(`/order?id=${encodeURIComponent(error.data.orderId)}`);
      return;
    }
    if (error.data?.fields) setFieldErrors(error.data.fields);
    showMessage(message, 'error', error.message);
  }
});

Promise.all([loadProducts(), api('/api/config')])
  .then(([products, config]) => {
    lines = cartLines(products);
    renderSummary(config.deliveryFee || 0);
    if (config.mpesaMode === 'mock') {
      modeHint.hidden = false;
      modeHint.textContent =
        'Test mode: no real money is charged. Numbers ending in 1111 simulate a cancelled payment.';
    }
  })
  .catch((error) => showMessage(summary, 'error', `Could not load your cart. ${error.message}`));
