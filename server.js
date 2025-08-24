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

// Human-friendly diagnostics (don't expose publicly if you're worried)
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

// ===== NEW CHECKOUT ENDPOINT =====
app.get("/checkout", async (req, res) => {
  try {
    // Check if Stripe is configured
    if (!stripe) {
      return res.status(500).json({ error: "Server missing STRIPE_SECRET_KEY" });
    }

    const { pid, success, cancel } = req.query;
    
    if (!pid) {
      return res.status(400).json({ error: "Missing price ID parameter" });
    }
    
    // Parse price IDs (handle single or comma-separated)
    const priceIds = pid.split(",").filter(Boolean);
    
    if (priceIds.length === 0) {
      return res.status(400).json({ error: "No valid price IDs provided" });
    }
    
    console.log("Creating checkout session for prices:", priceIds);
    
    // Create line items for Stripe Checkout
    const lineItems = priceIds.map(priceId => ({
      price: priceId,
      quantity: 1,
    }));
    
    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: success || "https://golf-jobs.com/upgrade?success=true",
      cancel_url: cancel || "https://golf-jobs.com/upgrade",
      allow_promotion_codes: true,  // Allow discount codes
      billing_address_collection: "required",
      metadata: {
        source: "golf-jobs-upgrade"
      }
    });
    
    console.log("Checkout session created:", session.id);
    
    // Redirect to Stripe Checkout
    res.redirect(303, session.url);
    
  } catch (error) {
    console.error("Checkout error:", error);
    
    // More detailed error response
    if (error.type === "StripeInvalidRequestError") {
      res.status(400).json({ 
        error: "Invalid request to Stripe",
        message: error.message,
        details: error.raw?.message
      });
    } else {
      res.status(500).json({ 
        error: "Failed to create checkout session",
        message: error.message 
      });
    }
  }
});

// Fallback for root (not used by your front-end)
app.get("/", (req, res) => {
  res.status(404).send("Use /prices, /checkout, or /health");
});

// Logo carousel endpoint (keeping your existing code)
app.get('/logo-carousel', (req, res) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL'); // Allow iframe embedding
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          background: white;
          overflow: hidden;
        }
        
        .carousel-container {
          padding: 15px;
          text-align: center;
          background: white;
        }
        
        .title {
          font-size: 12px;
          color: #6b7280;
          text-transform: uppercase;
          letter-spacing: 1.2px;
          margin-bottom: 20px;
          font-weight: 600;
        }
        
        .carousel-wrapper {
          width: 100%;
          overflow: hidden;
          position: relative;
          background: white;
        }
        
        /* Gradient masks for smooth edges */
        .carousel-wrapper::before,
        .carousel-wrapper::after {
          content: '';
          position: absolute;
          top: 0;
          bottom: 0;
          width: 80px;
          z-index: 2;
          pointer-events: none;
        }
        
        .carousel-wrapper::before {
          left: 0;
          background: linear-gradient(to right, white, transparent);
        }
        
        .carousel-wrapper::after {
          right: 0;
          background: linear-gradient(to left, white, transparent);
        }
        
        .logo-track {
          display: flex;
          align-items: center;
          gap: 60px;
          animation: scroll 35s linear infinite;
          width: fit-content;
          padding: 10px 0;
        }
        
        .logo-track:hover {
          animation-play-state: paused;
        }
        
        .logo-item {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 120px;
          height: 50px;
          padding: 5px;
        }
        
        .logo-item img {
          max-width: 100%;
          max-height: 100%;
          width: auto;
          height: auto;
          filter: grayscale(100%);
          opacity: 0.7;
          transition: all 0.3s ease;
          object-fit: contain;
        }
        
        .logo-item:hover img {
          filter: grayscale(0%);
          opacity: 1;
          transform: scale(1.05);
        }
        
        @keyframes scroll {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-50%);
          }
        }
        
        /* Mobile adjustments */
        @media (max-width: 640px) {
          .logo-track {
            gap: 40px;
          }
          .logo-item {
            width: 100px;
            height: 40px;
          }
          .carousel-wrapper::before,
          .carousel-wrapper::after {
            width: 40px;
          }
        }
      </style>
    </head>
    <body>
      <div class="carousel-container">
        <div class="title">Trusted by Leading Golf Employers</div>
        <div class="carousel-wrapper">
          <div class="logo-track">
            <!-- First set of 12 logos -->
            <div class="logo-item">
              <img src="https://chapel-york.com/wp-content/uploads/2024/06/RandA-Foundation.png" alt="R&A" />
            </div>
            <div class="logo-item">
              <img src="https://blog.americangolf.co.uk/content/images/2023/09/AG-full-Length-2023.webp" alt="American Golf" />
            </div>
            <div class="logo-item">
              <img src="https://d1f00kj7ad54bu.cloudfront.net/Pictures/1024x536/2/5/4/26254_acushnetcompanylogo_146410.jpg" alt="Acushnet Company" />
            </div>
            <div class="logo-item">
              <img src="https://www.scottsdalegolf.co.uk/img/logos/sg-main.svg" alt="Scottsdale Golf" />
            </div>
            <div class="logo-item">
              <img src="https://upload.wikimedia.org/wikipedia/en/2/20/St_Andrews_Links.png" alt="St Andrews Links" />
            </div>
            <div class="logo-item">
              <img src="https://images.squarespace-cdn.com/content/v1/63c7e373ff4f92106ce379ce/b0f5385d-7847-477f-9419-0e8b09376c68/Medium+Grey.png" alt="Trackman" />
            </div>
            <div class="logo-item">
              <img src="https://www.tagmarshal.com/wp-content/uploads/2023/10/golf-cart-gps-oakmont.jpg" alt="Oakmont Country Club" />
            </div>
            <div class="logo-item">
              <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTvzMx5T5m1rexhm__NOW22_3f_rAFA_h3-0A&s" alt="PXG" />
            </div>
            <div class="logo-item">
              <img src="https://www.carnoustiegolflinks.com/wp-content/uploads/2019/07/Carnoustie-Golf-Links-Logo-e1563970809539.png" alt="Carnoustie Golf Links" />
            </div>
            <div class="logo-item">
              <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTHVCxcpeqd407A1LvnGZKoQI0T6pYhvPIlJw&s" alt="PING" />
            </div>
            <div class="logo-item">
              <img src="https://about.puma.com/sites/default/files/styles/dd_text_media/public/media/text-media/m-18-logo-2023.png?itok=mnFQa0cl" alt="Cobra Puma Golf" />
            </div>
            <div class="logo-item">
              <img src="https://www.lpga.com/-/media/images/global/authors/lpgalogo24_470x486.jpg" alt="LPGA" />
            </div>
            
            <!-- Duplicate set for continuous scrolling -->
            <div class="logo-item">
              <img src="https://chapel-york.com/wp-content/uploads/2024/06/RandA-Foundation.png" alt="R&A" />
            </div>
            <div class="logo-item">
              <img src="https://blog.americangolf.co.uk/content/images/2023/09/AG-full-Length-2023.webp" alt="American Golf" />
            </div>
            <div class="logo-item">
              <img src="https://d1f00kj7ad54bu.cloudfront.net/Pictures/1024x536/2/5/4/26254_acushnetcompanylogo_146410.jpg" alt="Acushnet Company" />
            </div>
            <div class="logo-item">
              <img src="https://www.scottsdalegolf.co.uk/img/logos/sg-main.svg" alt="Scottsdale Golf" />
            </div>
            <div class="logo-item">
              <img src="https://upload.wikimedia.org/wikipedia/en/2/20/St_Andrews_Links.png" alt="St Andrews Links" />
            </div>
            <div class="logo-item">
              <img src="https://images.squarespace-cdn.com/content/v1/63c7e373ff4f92106ce379ce/b0f5385d-7847-477f-9419-0e8b09376c68/Medium+Grey.png" alt="Trackman" />
            </div>
            <div class="logo-item">
              <img src="https://www.tagmarshal.com/wp-content/uploads/2023/10/golf-cart-gps-oakmont.jpg" alt="Oakmont Country Club" />
            </div>
            <div class="logo-item">
              <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTvzMx5T5m1rexhm__NOW22_3f_rAFA_h3-0A&s" alt="PXG" />
            </div>
            <div class="logo-item">
              <img src="https://www.carnoustiegolflinks.com/wp-content/uploads/2019/07/Carnoustie-Golf-Links-Logo-e1563970809539.png" alt="Carnoustie Golf Links" />
            </div>
            <div class="logo-item">
              <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTHVCxcpeqd407A1LvnGZKoQI0T6pYhvPIlJw&s" alt="PING" />
            </div>
            <div class="logo-item">
              <img src="https://about.puma.com/sites/default/files/styles/dd_text_media/public/media/text-media/m-18-logo-2023.png?itok=mnFQa0cl" alt="Cobra Puma Golf" />
            </div>
            <div class="logo-item">
              <img src="https://www.lpga.com/-/media/images/global/authors/lpgalogo24_470x486.jpg" alt="LPGA" />
            </div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Golf Jobs upsell server running on :${PORT}`);
});
