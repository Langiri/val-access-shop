import { loadProducts } from './common.js';
import { productCard, productsError } from './product-card.js';

const container = document.getElementById('featured');

loadProducts()
  .then((products) => {
    container.replaceChildren(...products.slice(0, 4).map(productCard));
  })
  .catch((error) => productsError(container, error));
