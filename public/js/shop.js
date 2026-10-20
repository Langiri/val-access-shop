import { el, loadProducts } from './common.js';
import { productCard, productsError } from './product-card.js';

const container = document.getElementById('products');
const filters = document.getElementById('filters');

function render(products, category) {
  const visible = category ? products.filter((p) => p.category === category) : products;
  container.replaceChildren(...visible.map(productCard));
  for (const chip of filters.querySelectorAll('button')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.category === (category || '')));
  }
}

loadProducts()
  .then((products) => {
    const categories = [...new Set(products.map((p) => p.category))];
    const chips = [['All', ''], ...categories.map((c) => [c, c])].map(([label, value]) => {
      const chip = el('button', { class: 'chip', type: 'button', 'data-category': value }, label);
      chip.addEventListener('click', () => render(products, value));
      return chip;
    });
    filters.replaceChildren(...chips);
    render(products, '');
  })
  .catch((error) => productsError(container, error));
