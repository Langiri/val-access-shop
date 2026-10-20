import {
  api,
  cartLines,
  el,
  formatKes,
  loadProducts,
  MAX_ITEM_QUANTITY,
  setQuantity,
  showMessage,
} from './common.js';

const container = document.getElementById('cart');
let products = [];
let deliveryFee = 0;

function quantityControl(line) {
  const { product, quantity } = line;
  return el('div', { class: 'qty', role: 'group', 'aria-label': `Quantity for ${product.name}` }, [
    el(
      'button',
      {
        type: 'button',
        class: 'qty-btn',
        'aria-label': 'Decrease quantity',
        onclick: () => update(product.id, quantity - 1),
      },
      '−',
    ),
    el('span', { class: 'qty-value', 'aria-live': 'polite', text: String(quantity) }),
    el(
      'button',
      {
        type: 'button',
        class: 'qty-btn',
        'aria-label': 'Increase quantity',
        disabled: quantity >= MAX_ITEM_QUANTITY,
        onclick: () => update(product.id, quantity + 1),
      },
      '+',
    ),
  ]);
}

function update(productId, quantity) {
  setQuantity(productId, quantity);
  render();
}

function render() {
  const lines = cartLines(products);
  if (lines.length === 0) {
    container.replaceChildren(
      el('div', { class: 'empty card center' }, [
        el('p', { text: 'Your cart is empty.' }),
        el('a', { class: 'btn btn-primary', href: '/shop' }, 'Browse accessories'),
      ]),
    );
    return;
  }

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const list = el(
    'ul',
    { class: 'cart-list' },
    lines.map((line) =>
      el('li', { class: 'cart-item card' }, [
        el('img', { src: line.product.image, alt: '', width: '80', height: '80' }),
        el('div', { class: 'cart-item-info' }, [
          el('h3', { text: line.product.name }),
          el('p', { class: 'muted', text: `${formatKes(line.product.price)} each` }),
          el('div', { class: 'cart-item-actions' }, [
            quantityControl(line),
            el(
              'button',
              {
                type: 'button',
                class: 'link-btn',
                onclick: () => update(line.product.id, 0),
              },
              'Remove',
            ),
          ]),
        ]),
        el('strong', { class: 'cart-item-total', text: formatKes(line.lineTotal) }),
      ]),
    ),
  );

  const totals = el('div', { class: 'card totals' }, [
    el('div', { class: 'total-row' }, [
      el('span', { text: 'Subtotal' }),
      el('span', { text: formatKes(subtotal) }),
    ]),
    el('div', { class: 'total-row' }, [
      el('span', { text: 'Delivery' }),
      el('span', { text: deliveryFee ? formatKes(deliveryFee) : 'Free / arranged on call' }),
    ]),
    el('div', { class: 'total-row grand' }, [
      el('span', { text: 'Total' }),
      el('span', { text: formatKes(subtotal + deliveryFee) }),
    ]),
    el('a', { class: 'btn btn-primary btn-block', href: '/checkout' }, 'Proceed to checkout'),
    el('a', { class: 'btn btn-ghost btn-block', href: '/shop' }, 'Continue shopping'),
  ]);

  container.replaceChildren(list, totals);
}

Promise.all([loadProducts(), api('/api/config')])
  .then(([productList, config]) => {
    products = productList;
    deliveryFee = config.deliveryFee || 0;
    render();
  })
  .catch((error) => showMessage(container, 'error', `Could not load your cart. ${error.message}`));
