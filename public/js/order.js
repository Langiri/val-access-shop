import { api, el, formatKes, showMessage } from './common.js';

const container = document.getElementById('order');
const orderId = new URLSearchParams(window.location.search).get('id') || '';
const POLL_MS = 3000;
const MAX_WAIT_MS = 3 * 60 * 1000;
let waitStartedAt = Date.now();
let timer;

function itemsList(order) {
  return el('div', { class: 'card' }, [
    el('h2', { text: `Order ${order.code}` }),
    el(
      'ul',
      { class: 'summary-list' },
      order.items.map((item) =>
        el('li', {}, [
          el('span', { text: `${item.quantity} × ${item.name}` }),
          el('span', { text: formatKes(item.lineTotal) }),
        ]),
      ),
    ),
    order.deliveryFee
      ? el('div', { class: 'total-row' }, [
          el('span', { text: 'Delivery' }),
          el('span', { text: formatKes(order.deliveryFee) }),
        ])
      : null,
    el('div', { class: 'total-row grand' }, [
      el('span', { text: 'Total' }),
      el('span', { text: formatKes(order.total) }),
    ]),
  ]);
}

function retryButton(label = 'Try payment again') {
  const button = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, label);
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.classList.add('is-loading');
    button.textContent = 'Sending M-Pesa request…';
    try {
      await api(`/api/orders/${encodeURIComponent(orderId)}/pay`, { method: 'POST' });
      poll(true);
    } catch (error) {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.textContent = label;
      const note =
        button.parentElement.querySelector('.retry-error') ||
        el('p', { class: 'field-error retry-error' });
      note.textContent = error.message;
      button.after(note);
    }
  });
  return button;
}

function statusPanel(order, timedOut) {
  if (order.status === 'paid') {
    return el('div', { class: 'status status-paid card center' }, [
      el('div', { class: 'status-icon', 'aria-hidden': 'true', text: '✓' }),
      el('h1', { text: 'Payment received!' }),
      el('p', {
        text: `Thank you ${order.customerName}. We are preparing your order and will call you to confirm delivery.`,
      }),
      order.payment?.receipt
        ? el('p', { class: 'muted', text: `M-Pesa receipt: ${order.payment.receipt}` })
        : null,
      el('a', { class: 'btn btn-ghost', href: '/shop' }, 'Continue shopping'),
    ]);
  }
  if (order.status === 'failed') {
    return el('div', { class: 'status status-failed card center' }, [
      el('div', { class: 'status-icon', 'aria-hidden': 'true', text: '!' }),
      el('h1', { text: 'Payment not completed' }),
      el('p', { text: order.payment?.message || 'The M-Pesa payment did not go through.' }),
      el('p', {
        class: 'muted',
        text: 'Your order is saved. Make sure your phone is on and you have enough M-Pesa balance, then try again.',
      }),
      retryButton(),
    ]);
  }
  return el('div', { class: 'status status-pending card center' }, [
    el('div', { class: 'spinner', 'aria-hidden': 'true' }),
    el('h1', { text: 'Check your phone' }),
    el('p', {
      text: 'We sent an M-Pesa prompt to your phone. Enter your M-Pesa PIN to complete the payment.',
    }),
    el('p', { class: 'muted', text: 'This page updates automatically.' }),
    timedOut || order.payment?.canRetry
      ? el('div', {}, [
          el('p', { text: "Didn't get the prompt?" }),
          retryButton('Send the prompt again'),
        ])
      : null,
  ]);
}

async function poll(reset = false) {
  clearTimeout(timer);
  if (reset) waitStartedAt = Date.now();
  try {
    const { order } = await api(`/api/orders/${encodeURIComponent(orderId)}`);
    const timedOut = Date.now() - waitStartedAt > MAX_WAIT_MS;
    container.replaceChildren(statusPanel(order, timedOut), itemsList(order));
    if (order.status === 'pending_payment' && !timedOut) {
      timer = setTimeout(() => poll(), POLL_MS);
    }
  } catch (error) {
    if (error.status === 404) {
      showMessage(container, 'error', 'We could not find that order. Please check the link.');
      return;
    }
    showMessage(container, 'error', `${error.message} Retrying…`);
    timer = setTimeout(() => poll(), POLL_MS * 2);
  }
}

if (!orderId) {
  showMessage(container, 'error', 'No order selected.');
} else {
  poll();
}
