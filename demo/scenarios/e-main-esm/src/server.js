import express from 'express';
import createDebug from 'debug';
import * as log from './log.js';

const debug = createDebug('shop:server');
const products = [{ id: 1, name: 'Mug', price: 12 }, { id: 2, name: 'Shirt', price: 25 }];
const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/products', (req, res) => {
  debug('list %d products', products.length);
  res.json(products);
});

app.listen(process.env.PORT || 3000, () => log.info('shop listening'));
