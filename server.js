// server.js — Golf Jobs Upsell API (Render)
// Node 18+ (package.json should set "type": "module")

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 10000;

// ---- Stripe ----
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY is not set');
  process.exit(1);
}
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ---- CORS (allow both root and www) ----
const ALLOWED = new Set([
  'https://golf-jobs.com',
  'https://www.golf-jobs.com',
  process.env.ALLOWED_ORIGIN, // optional extra origin if you need it
].filter(Boolean));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.has(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());

// ---- Config: product IDs from env (comma-separated) ----
const PRODUCT_IDS = (process.env.PRODUCT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!PRODUCT_IDS.length) {
  console.warn('⚠️  No PRODUCT_IDS set. Example: prod_aaa,prod_bbb,prod_ccc');
}

// ---- Price cache (5 min TTL) + single-flight ----
const PRICE_TTL_MS = 5 * 60 * 1000;
let PRICE_CACHE = { data: null, ts: 0, loading: null };

async function getLatestOneTimePrice(productId) {
  // Fast path: use product.default_price if active one-time
  const product = await stripe.products.retrieve(productId);

  if (product.default_price) {
    const price = typeof product.default_price === 'string'
      ? await stripe.prices.retrieve(product.default_price)
      : product.default_price;

    if (price && price.active && price.type === 'one_time') {
      return {
        unit_amount: price.unit_amount,
        currency: price.currency,
        price_id: price.id,
      };
    }
  }

  // Fallback: query prices for this specific product (avoid pagination issues)
  const list = await stripe.prices.list({
    product: productId,
    active: true,
    type: 'one_time',
    limit: 10,
  });

  if (!list.data.length) {
    throw new Error(`No active one-time price for product ${productId}`);
  }

  // Choose newest by created timestamp
  const newest = list.data.sort((a, b) => b.created - a.created)[0];
  return {
    unit_amount: newest.unit_amount,
    currency: newest.currency,
    price_id: newest.id,
  };
}

async function fetchAllPrices() {
  const entries = await Promise.all(
    PRODUCT_IDS.map(async pid => {
      const info = await getLatestOneTimePrice(pid);
      return [pid, info];
    }),
  );
  return Object.fromEntries(entries);
}

async function getCachedPrices() {
  const fresh = PRICE_CACHE.data && (Date.now() - PRICE_CACHE.ts < PRICE_TTL_MS);
  if (fresh) return PRICE_CACHE.data;

  if (PRICE_CACHE.loading) return PRICE_CACHE.loading;

  PRICE_CACHE.loading = (async () => {
    const data = await fetchAllPrices();
    PRICE_CACHE = { data, ts: Date.now(), loading: null };
    return data;
  })();

  return PRICE_CACHE.loading;
}

// ---- Routes ----
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), products: PRODUCT_IDS.length });
});

app.get('/prices', async (req, res) => {
  try {
    const data = await getCachedPrices();
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json(data);
  } catch (e) {
    console.error('GET /prices error:', e);
    res.status(500).json({ error: 'Failed to load prices' });
  }
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { products = [], success_url, cancel_url, metadata = {} } = req.body || {};
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'No products selected' });
    }

    const priceMap = await getCachedPrices();
    const line_items = products.map(pid => {
      const info = priceMap[pid];
      if (!info) throw new Error(`Unknown product: ${pid}`);
      return { price: info.price_id, quantity: 1 };
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: success_url || 'https://golf-jobs.com/upgrade/success',
      cancel_url: cancel_url || 'https://golf-jobs.com/upgrade',
      metadata,
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
    });

    res.json({ id: session.id });
  } catch (e) {
    console.error('POST /create-checkout-session error:', e);
    res.status(500).json({ error: e.message || 'Checkout create failed' });
  }
});

// ---- Boot + warmers ----
app.listen(PORT, () => {
  console.log(`Golf Jobs upsell server running on :${PORT}`);

  // Warm cache now (non-blocking)
  getCachedPrices().catch(err => console.warn('[warm] initial price fetch failed:', err?.message));

  // Refresh periodically
  setInterval(() => {
    getCachedPrices().catch(err => console.warn('[warm] refresh failed:', err?.message));
  }, PRICE_TTL_MS);

  // Self-ping to keep instance responsive
  setInterval(() => {
    fetch(`http://localhost:${PORT}/health`).catch(() => {});
  }, 4 * 60 * 1000);
});
