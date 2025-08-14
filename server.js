import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const PORT = process.env.PORT || 10000;

const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json());

/** --------------------------
 * Config
 ---------------------------*/
const PRODUCT_IDS = (process.env.PRODUCT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PRICE_TTL_MS = 5 * 60 * 1000; // 5 min cache

/** --------------------------
 * In-memory price cache + single-flight loader
 ---------------------------*/
let PRICE_CACHE = { data: null, ts: 0, loading: null };

async function getLatestOneTimePrice(productId) {
  // Try default_price first (fast path)
  const product = await stripe.products.retrieve(productId);
  if (product.default_price) {
    const price = typeof product.default_price === 'string'
      ? await stripe.prices.retrieve(product.default_price)
      : product.default_price;
    if (price && price.active && price.type === 'one_time') {
      return {
        unit_amount: price.unit_amount,
        currency: price.currency,
        price_id: price.id
      };
    }
  }
  // Fallback: list active one-time prices (most-recent)
  const list = await stripe.prices.list({
    product: productId,
    active: true,
    type: 'one_time',
    limit: 1,
    expand: ['data.tiers'],
    // Note: Stripe doesn't sort by created desc server-side, but our limit=1 with active prices
    // typically returns the default/most recent. If needed, increase limit and sort client-side.
  });
  const p = list.data[0];
  if (!p) throw new Error(`No active one-time price for product ${productId}`);
  return {
    unit_amount: p.unit_amount,
    currency: p.currency,
    price_id: p.id
  };
}

async function fetchAllPrices() {
  const entries = await Promise.all(PRODUCT_IDS.map(async pid => {
    const info = await getLatestOneTimePrice(pid);
    return [pid, info];
  }));
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

/** --------------------------
 * Routes
 ---------------------------*/
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/prices', async (req, res) => {
  try {
    const data = await getCachedPrices();
    // allow client/browser caching too
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json(data);
  } catch (e) {
    console.error('GET /prices:', e);
    res.status(500).json({ error: 'Failed to load prices' });
  }
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { products = [], success_url, cancel_url, metadata = {} } = req.body || {};

    if (!products.length) {
      return res.status(400).json({ error: 'No products selected' });
    }

    // Make sure we’re using fresh prices for the selected products
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
      // Optional niceties:
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
      automatic_tax: { enabled: false }
    });

    res.json({ id: session.id });
  } catch (e) {
    console.error('POST /create-checkout-session:', e);
    res.status(500).json({ error: e.message || 'Checkout create failed' });
  }
});

/** --------------------------
 * Boot warmers
 ---------------------------*/
app.listen(PORT, () => {
  console.log(`Golf Jobs upsell server running on :${PORT}`);
  // Warm cache now (don’t block)
  getCachedPrices().catch(() => {});
  // Refresh in background every TTL
  setInterval(() => { getCachedPrices().catch(() => {}); }, PRICE_TTL_MS);
  // Self-ping health to keep instance active (helps on sleeping tiers/crons)
  setInterval(() => {
    fetch(`http://localhost:${PORT}/health`).catch(() => {});
  }, 4 * 60 * 1000);
});
