// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---- CORS ----
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true); // allow same-origin/fetch
      if (allowed.length === 0) return cb(null, true); // allow all if not set
      const ok = allowed.some(a =>
        a === origin ||
        (a.includes("*") && new RegExp("^" + a.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$").test(origin))
      );
      cb(ok ? null : new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());

// ---- Stripe ----
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.warn("⚠️  STRIPE_SECRET_KEY is not set. /prices will return an error.");
}
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-04-10" }) : null;

// Product IDs (comma-separated)
const PRODUCT_IDS = (process.env.PRODUCT_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Small helper: fetch the first active price for a product
async function getActivePriceForProduct(productId) {
  try {
    const prices = await stripe.prices.list({ product: productId, active: true, limit: 1 });
    if (prices.data.length > 0) {
      const p = prices.data[0];
      return {
        unit_amount: p.unit_amount,
        currency: p.currency,
        price_id: p.id,
      };
    }
    // If none, check whether the product even exists to give a better error
    await stripe.products.retrieve(productId);
    return { error: "No active prices found for this product" };
  } catch (err) {
    // If product retrieval failed or auth failed, bubble a helpful error
    const msg =
      err?.raw?.message ||
      err?.message ||
      "Stripe error (check key/account/test-vs-live/product IDs)";
    return { error: msg };
  }
}

// ---- Routes ----
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    stripe: !!STRIPE_SECRET_KEY,
    productIds: PRODUCT_IDS.length,
  });
});

// Human-friendly diagnostics (don’t expose publicly if you’re worried)
app.get("/diag", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    env: {
      hasStripeKey: !!STRIPE_SECRET_KEY,
      productIdsCount: PRODUCT_IDS.length,
      mode: STRIPE_SECRET_KEY?.startsWith("sk_live") ? "live" : STRIPE_SECRET_KEY ? "test" : "unknown",
    },
    allowedOrigins: allowed,
  });
});

// Prices endpoint consumed by your front-end
app.get("/prices", async (req, res) => {
  res.set("Cache-Control", "public, max-age=60"); // cache 60s at edge/browsers
  if (!stripe) {
    return res.status(500).json({ error: "Server missing STRIPE_SECRET_KEY" });
  }
  if (PRODUCT_IDS.length === 0) {
    return res.json({}); // graceful empty map if none configured
  }

  const results = {};
  await Promise.all(
    PRODUCT_IDS.map(async (pid) => {
      results[pid] = await getActivePriceForProduct(pid);
    })
  );

  res.json(results);
});

// Fallback for root (not used by your front-end)
app.get("/", (req, res) => {
  res.status(404).send("Use /prices or /health");
});

app.listen(PORT, () => {
  console.log(`Golf Jobs upsell server running on :${PORT}`);
});
