import { addToCart, el, formatKes } from './common.js';

export function productCard(product) {
  const button = el(
    'button',
    { class: 'btn btn-primary btn-small', type: 'button' },
    'Add to cart',
  );
  button.addEventListener('click', () => {
    addToCart(product.id, 1);
    button.textContent = 'Added ✓';
    button.classList.add('added');
    setTimeout(() => {
      button.textContent = 'Add to cart';
      button.classList.remove('added');
    }, 1500);
  });

  return el('article', { class: 'product-card' }, [
    el('img', {
      src: product.image,
      alt: product.name,
      loading: 'lazy',
      width: '320',
      height: '240',
    }),
    el('div', { class: 'product-body' }, [
      el('p', { class: 'product-category', text: product.category }),
      el('h3', { text: product.name }),
      el('p', { class: 'product-description', text: product.description }),
      el('div', { class: 'product-footer' }, [
        el('span', { class: 'price', text: formatKes(product.price) }),
        button,
      ]),
    ]),
  ]);
}

export function productsError(container, error) {
  container.replaceChildren(
    el('div', { class: 'notice notice-error', role: 'alert' }, [
      `Could not load products. ${error.message} `,
      el('a', { href: '' }, 'Reload'),
    ]),
  );
}
