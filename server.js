// server.js
// Golf Jobs – Upsell server for Stripe Checkout
// Requires Node 18+
// Env var: STRIPE_SECRET_KEY=sk_live_xxx

import express from "express";
import cors from "cors";
import Stripe from "stripe";

const app = express();

// Allow only your production domains to call this API
app.use(cors({
  origin: ["https://golf-jobs.com", "https://www.golf-jobs.com"],
}));
app.use(express.json());

// --- Stripe ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// Your Stripe Product IDs (each must have a default one-time price set in GBP)
const PRODUCT_IDS = [
  "prod_Sr8RuJ5aSrA0G0", // Featured & pinned
  "prod_Sr8TOcXn6xbp1J", // Social + Email
  "prod_Sr8WwjuRvqKFYR", // Extend to 30 days
  "prod_Sr8Vo6ZUsN19bB", // Best-practice rewrite
  "prod_Sr8ZrpgM228waD", // Max Visibility Bundle
];

const BUNDLE_ID = "prod_Sr8ZrpgM228waD";

// Simple in-memory cache so we don’t hammer Stripe for the same data
const priceCache = new Map(); // productId -> { price_id, unit_amount, currency, name }

async function getProductInfo(productId) {
  if (priceCache.has(productId)) return priceCache.get(productId);

  const product = await stripe.products.retrieve(productId, { expand: ["default_price"] });
  const p = product.default_price;

  if (!p || p.type !== "one_time") {
    throw new Error(`Product ${productId} is missing a default one-time price.`);
  }

  const info = {
    price_id: p.id,
    unit_amount: p.unit_amount,
    currency: (p.currency || "gbp").toLowerCase(),
    name: product.name,
  };

  priceCache.set(productId, info);
  return info;
}

// --- Routes ---

// Health check (useful for Render/uptime checks)
app.get("/health", (req, res) => res.status(200).send("OK"));

// GET /prices -> { productId: { unit_amount, currency, price_id } }
app.get("/prices", async (req, res) => {
  try {
    const entries = await Promise.all(PRODUCT_IDS.map(async (pid) => [pid, await getProductInfo(pid)]));
    const out = {};
    entries.forEach(([pid, info]) => {
      out[pid] = {
        unit_amount: info.unit_amount,
        currency: info.currency,
        price_id: info.price_id,
      };
    });
    res.json(out);
  } catch (err) {
    console.error("GET /prices error:", err);
    res.status(500).json({ error: "Failed to load prices" });
  }
});

// POST /create-checkout-session
// Body: { products: [productId,...], success_url?, cancel_url?, metadata? }
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { products, success_url, cancel_url, metadata } = req.body || {};

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: "No products selected" });
    }

    // If bundle is selected, ignore individuals; otherwise de-dup items
    const finalProductIds = products.includes(BUNDLE_ID) ? [BUNDLE_ID] : [...new Set(products)];

    // Build line items
    const line_items = [];
    for (const pid of finalProductIds) {
      const info = await getProductInfo(pid);
      line_items.push({ price: info.price_id, quantity: 1 });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: success_url || "https://golf-jobs.com/upgrade/success",
      cancel_url: cancel_url || "https://golf-jobs.com/upgrade",
      metadata: metadata || {},
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error("POST /create-checkout-session error:", err);
    res.status(500).json({ error: err.message || "Checkout session error" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Golf Jobs upsell server running on :${port}`);
});
