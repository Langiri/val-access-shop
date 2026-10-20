import { api, el, formatKes, showMessage } from './common.js';

const container = document.getElementById('orders');
const stats = document.getElementById('stats');
const filter = document.getElementById('status-filter');
const refresh = document.getElementById('refresh');
const mode = document.getElementById('mode');

const STATUS_LABELS = { pending_payment: 'Pending', paid: 'Paid', failed: 'Failed' };

function statusBadge(status) {
  return el('span', {
    class: `status-badge status-${status}`,
    text: STATUS_LABELS[status] || status,
  });
}

function stat(label, value) {
  return el('div', { class: 'stat card' }, [
    el('span', { class: 'muted', text: label }),
    el('strong', { text: String(value) }),
  ]);
}

function orderCard(order) {
  const created = new Date(order.createdAt).toLocaleString('en-KE');
  return el('article', { class: 'card admin-order' }, [
    el('div', { class: 'admin-order-head' }, [
      el('strong', { text: order.code }),
      statusBadge(order.status),
    ]),
    el('p', { class: 'muted', text: created }),
    el('dl', { class: 'details' }, [
      el('dt', { text: 'Customer' }),
      el('dd', { text: order.customerName }),
      el('dt', { text: 'Phone' }),
      el('dd', {}, el('a', { href: `tel:+${order.phone}`, text: `+${order.phone}` })),
      el('dt', { text: 'Location' }),
      el('dd', { text: order.location }),
      order.notes ? el('dt', { text: 'Notes' }) : null,
      order.notes ? el('dd', { text: order.notes }) : null,
      el('dt', { text: 'Items' }),
      el('dd', { text: order.items.map((i) => `${i.quantity} × ${i.name}`).join(', ') }),
      el('dt', { text: 'Total' }),
      el('dd', { text: formatKes(order.total) }),
      el('dt', { text: 'Payment' }),
      el('dd', {
        text: order.payment
          ? [order.payment.receipt && `Receipt ${order.payment.receipt}`, order.payment.message]
              .filter(Boolean)
              .join(' · ') || 'Awaiting customer'
          : 'Not started',
      }),
    ]),
  ]);
}

async function load() {
  refresh.disabled = true;
  try {
    const query = filter.value ? `?status=${encodeURIComponent(filter.value)}` : '';
    const data = await api(`/api/admin/orders${query}`);
    mode.textContent = `M-Pesa mode: ${data.mpesaMode}`;
    stats.replaceChildren(
      stat('Pending', data.stats.pending_payment),
      stat('Paid', data.stats.paid),
      stat('Failed', data.stats.failed),
      stat('Paid revenue', formatKes(data.stats.paidTotal)),
    );
    container.replaceChildren(
      ...(data.orders.length
        ? data.orders.map(orderCard)
        : [el('p', { class: 'muted', text: 'No orders yet.' })]),
    );
  } catch (error) {
    showMessage(container, 'error', `Could not load orders. ${error.message}`);
  } finally {
    refresh.disabled = false;
  }
}

filter.addEventListener('change', load);
refresh.addEventListener('click', load);
load();
setInterval(load, 30000);
