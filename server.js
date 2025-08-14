import express from "express";
import cors from "cors";
import Stripe from "stripe";

const app = express();
const port = process.env.PORT || 10000;

// Make sure you’ve set this in Render’s Environment tab
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  console.error("❌ STRIPE_SECRET_KEY not set in environment variables");
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2023-10-16",
});

app.use(cors());
app.use(express.json());

// List of product IDs you want to display in your upsell page
const productIds = [
  "prod_Sr8RuJ5aSrA0G0", // Featured and Pinned
  "prod_Sr8TOcXn6xbp1J", // Social + Email
  "prod_Sr8WwjuRvqKFYR", // Extend
  "prod_Sr8Vo6ZUsN19bB", // Best Practice Rewrite
  "prod_Sr8ZrpgM228waD", // Max Visibility Bundle
];

// Endpoint to fetch product prices quickly
app.get("/prices", async (req, res) => {
  try {
    const prices = await stripe.prices.list({
      expand: ["data.product"],
      active: true,
    });

    // Filter prices by our known product IDs
    const filtered = {};
    prices.data.forEach((price) => {
      if (productIds.includes(price.product.id)) {
        filtered[price.product.id] = {
          unit_amount: price.unit_amount,
          currency: price.currency,
          price_id: price.id,
        };
      }
    });

    res.json(filtered);
  } catch (err) {
    console.error("GET /prices error:", err);
    res.status(500).json({ error: "Unable to fetch prices" });
  }
});

// Create checkout session
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: items.map((item) => ({
        price: item.price_id,
        quantity: 1,
      })),
      mode: "payment",
      success_url: "https://golf-jobs.com/upgrade-success",
      cancel_url: "https://golf-jobs.com/upgrade-cancelled",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("POST /create-checkout-session error:", err);
    res.status(500).json({ error: "Unable to create checkout session" });
  }
});

app.listen(port, () => {
  console.log(`Golf Jobs upsell server running on :${port}`);
});
