# Val Access Shop

A simple, mobile-first online shop for **Val Access** – girls' hair accessories (bows, headbands,
clips and scrunchies) – with **M-Pesa (Lipa Na M-Pesa Online / STK push)** checkout.

- **Stack:** Node.js + Express, built-in SQLite (`node:sqlite`), plain HTML/CSS/JavaScript (no build step)
- **Customer pages:** home, shop (with category filters), cart, checkout and a live order status page
- **Payments:** Safaricom Daraja STK push, callback webhook and status query, with a **mock mode** for development
- **Admin:** password-protected page listing recent orders and their payment status

## Requirements

- Node.js **22.13 or newer** (uses the built-in `node:sqlite` module – nothing native to compile)
- npm

## Run locally

```bash
npm install
cp .env.example .env      # then edit .env (at least set ADMIN_PASSWORD)
npm run dev               # http://localhost:3000 (auto-restarts when you edit files)
```

The database file (`./data/val-access.db` by default) and the starter products are created
automatically on first start. Out of the box `MPESA_MODE=mock`, so you can place test orders
without any M-Pesa credentials.

To test on your phone, open `http://<your-computer-ip>:3000` while on the same Wi-Fi.

### Scripts

| Command          | What it does                                                |
| ---------------- | ----------------------------------------------------------- |
| `npm run dev`    | Start the server in watch mode for development              |
| `npm start`      | Start the server for production                             |
| `npm run seed`   | Insert/update the starter products (safe to run any time)   |
| `npm test`       | Run the automated tests (`node:test`, in-memory database)   |
| `npm run lint`   | Lint with ESLint                                            |
| `npm run format` | Format with Prettier (`npm run format:check` to only check) |

## Environment variables

All settings live in `.env` (see [`.env.example`](.env.example)). Real environment variables
always win over `.env`. **Never commit your `.env` file** – it is already in `.gitignore`.

| Variable                  | Required             | Description                                                                                  |
| ------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `PORT`                    | no (3000)            | HTTP port                                                                                    |
| `NODE_ENV`                | no                   | Set to `production` in production (enables HSTS / HTTPS upgrade headers)                     |
| `DATABASE_PATH`           | no                   | SQLite file path (default `./data/val-access.db`)                                            |
| `TRUST_PROXY`             | no (0)               | Set to `1` behind a proxy/PaaS so rate limiting sees real client IPs                         |
| `DELIVERY_FEE_KES`        | no (0)               | Flat delivery fee added to each order (0 = free / arranged on call)                          |
| `ADMIN_PASSWORD`          | for admin            | Password for `/admin`. Admin is disabled when empty                                          |
| `MPESA_MODE`              | no (`mock`)          | `mock`, `sandbox` or `production`                                                            |
| `MPESA_CONSUMER_KEY`      | sandbox / production | Daraja app consumer key                                                                      |
| `MPESA_CONSUMER_SECRET`   | sandbox / production | Daraja app consumer secret                                                                   |
| `MPESA_SHORTCODE`         | sandbox / production | Business shortcode (Paybill number, or the store/head-office number for a till)              |
| `MPESA_PASSKEY`           | sandbox / production | Lipa Na M-Pesa Online passkey                                                                |
| `MPESA_TRANSACTION_TYPE`  | no                   | `CustomerPayBillOnline` (Paybill, default) or `CustomerBuyGoodsOnline` (Till)                |
| `MPESA_PARTY_B`           | Till only            | Till number that receives the money (defaults to `MPESA_SHORTCODE`)                          |
| `MPESA_ACCOUNT_REFERENCE` | no                   | Fixed account reference (max 12 chars). Default: the order code, e.g. `VAK7P2QX`             |
| `PUBLIC_BASE_URL`         | sandbox / production | Public **https** URL of this app, e.g. `https://shop.valaccess.co.ke`                        |
| `MPESA_CALLBACK_SECRET`   | sandbox / production | Long random string (16+ chars) placed in the callback URL so payment results can't be forged |
| `MPESA_MOCK_DELAY_MS`     | no (4000)            | Mock mode: delay before a simulated payment completes                                        |

The server refuses to start in `sandbox`/`production` mode if a required M-Pesa variable is
missing, and tells you which one.

## How the M-Pesa flow works

1. The customer fills the checkout form. The server validates it, **recalculates prices from the
   database** (cart prices from the browser are never trusted), saves the order as
   `pending_payment` and sends an STK push (`POST /mpesa/stkpush/v1/processrequest`).
2. The customer gets a prompt on their phone and enters their M-Pesa PIN. The order page polls
   `GET /api/orders/:id` and shows a spinner, then a success or failure message.
3. Safaricom calls `POST /api/mpesa/callback/<MPESA_CALLBACK_SECRET>`. The app matches the
   `CheckoutRequestID`, checks the paid amount, and marks the payment and order `paid` (with the
   M-Pesa receipt number) or `failed` (with Safaricom's reason, e.g. "Request cancelled by user").
   Duplicate callbacks are ignored.
4. If no callback has arrived after ~30 seconds, the status endpoint asks Daraja directly
   (`POST /mpesa/stkpushquery/v1/query`, at most every 15 seconds).
5. If a payment fails (or the prompt never arrived), the customer can tap **Try again** – the
   order is kept and a new STK push is sent.

### API endpoints

| Method & path                       | Purpose                                            |
| ----------------------------------- | -------------------------------------------------- |
| `GET /api/products`                 | Product catalogue                                  |
| `POST /api/orders`                  | Validate checkout, create order, start STK push    |
| `GET /api/orders/:id`               | Order + payment status (optionally queries Daraja) |
| `POST /api/orders/:id/pay`          | Retry the STK push for a failed/stuck order        |
| `POST /api/mpesa/callback/:secret`  | Daraja STK callback (webhook)                      |
| `GET /api/admin/orders?status=paid` | Recent orders for admin (password protected)       |
| `GET /api/health`                   | Health check                                       |

Payment-starting endpoints are rate limited (10 requests per 15 minutes per IP) so nobody can
spam M-Pesa prompts to other people's phones.

## Testing payments

### Mock mode (no credentials)

Set `MPESA_MODE=mock` (the default). No request is sent to Safaricom:

- Any valid Kenyan number (e.g. `0712 345 678`) is **approved** after `MPESA_MOCK_DELAY_MS`
  with a fake receipt like `MOCK3F9A1C`.
- Numbers ending in **`1111`** (e.g. `0700 001 111`) simulate a **cancelled** payment, so you can
  see the failure screen and the retry button.

The checkout page shows a "Test mode" note while mock mode is on.

### Sandbox mode (Safaricom test environment)

1. Create an account at <https://developer.safaricom.co.ke>, create an app with **M-Pesa Express**
   (Lipa Na M-Pesa Sandbox) enabled, and copy its **Consumer Key** and **Consumer Secret**.
2. Use the sandbox test shortcode `174379` and the sandbox **passkey** shown on the Daraja
   "M-Pesa Express" simulator page.
3. Safaricom must be able to reach your callback over **HTTPS**. Locally, use a tunnel such as
   `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, and put the https URL
   it gives you in `PUBLIC_BASE_URL`.
4. Example `.env`:

   ```env
   MPESA_MODE=sandbox
   MPESA_CONSUMER_KEY=your-sandbox-key
   MPESA_CONSUMER_SECRET=your-sandbox-secret
   MPESA_SHORTCODE=174379
   MPESA_PASSKEY=your-sandbox-passkey
   MPESA_TRANSACTION_TYPE=CustomerPayBillOnline
   PUBLIC_BASE_URL=https://your-tunnel.trycloudflare.com
   MPESA_CALLBACK_SECRET=paste-a-long-random-string-here
   ```

   Generate a callback secret with
   `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

5. Restart the app and check out using your own Safaricom number. Sandbox does not take real
   money. If the callback does not arrive, the order page still updates through the status query.

### Going live (production)

1. On the Daraja portal, **"Go Live"** with your business shortcode (Paybill or Till). Safaricom
   emails you the production **passkey**; create a production app for the consumer key/secret.
2. Set `MPESA_MODE=production`, your real `MPESA_SHORTCODE`, `MPESA_PASSKEY`, keys and
   `PUBLIC_BASE_URL`.
3. **Paybill:** `MPESA_TRANSACTION_TYPE=CustomerPayBillOnline` and leave `MPESA_PARTY_B` empty.
   **Till (Buy Goods):** `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline`, `MPESA_SHORTCODE` = your
   store/head-office number, `MPESA_PARTY_B` = your till number.
4. Place a small real order (e.g. KES 1 product in a test catalogue) to confirm everything works.

> A plain personal "Send Money" number cannot receive STK push payments – you need a Paybill or
> Till (Lipa Na M-Pesa) number registered with Safaricom.

## Admin

Set `ADMIN_PASSWORD` and open `/admin`. Your browser asks for a username (anything) and the
password. The page shows order totals by status, paid revenue, and each order's customer, phone,
delivery location, notes, items, total and payment status / M-Pesa receipt. It refreshes every
30 seconds and can be filtered by status. This is starter-level auth: use a long password and
always serve the site over HTTPS.

## Products

Starter products live in [`src/seed-data.js`](src/seed-data.js) and images in
[`public/images`](public/images). To change products, edit that file (prices are whole KES) and run
`npm run seed` – existing products are updated by `slug`, new ones are added.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Langiri/val-access-shop)

### Option A – Render (one click, recommended)

The repo includes a [`render.yaml`](render.yaml) Blueprint that sets up everything for you:
the web service, a 1 GB persistent disk for the database, a health check, HTTPS, and
randomly generated `ADMIN_PASSWORD` and `MPESA_CALLBACK_SECRET`.

1. Click **Deploy to Render** above (sign in with GitHub and allow access to this repo).
2. Leave the M-Pesa fields empty for now and click **Apply**. The first deploy takes a few minutes.
   The **Starter** plan (about USD 7/month) is needed because free instances can't have a
   persistent disk, and without one your orders would be lost on every redeploy.
3. Open the URL Render gives you (e.g. `https://val-access-shop.onrender.com`).
4. To log in to `/admin`, find the generated password under **Environment → ADMIN_PASSWORD**
   in the Render dashboard.
5. **Turn on real payments:** in **Environment**, set `MPESA_MODE` (`sandbox` first, then
   `production`), `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`,
   `MPESA_PASSKEY`, `PUBLIC_BASE_URL` (your Render URL or custom domain, with `https://`) and,
   for a Till, `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline` and `MPESA_PARTY_B`. Save and Render
   redeploys automatically.

> ⚠️ The Blueprint starts in **mock mode**: orders are marked "paid" without any money moving.
> Don't share the link with customers until you've switched to `production` and placed a real
> test order. The admin page and checkout both show which mode is active.

Every push to `main` redeploys automatically. A custom domain (e.g. `shop.valaccess.co.ke`) can be
added under **Settings → Custom Domains**; then update `PUBLIC_BASE_URL` to match.

### Option B – Docker (Fly.io, Railway, any VPS)

```bash
docker build -t val-access-shop .
docker run -d --name val-access -p 3000:3000 \
  -v val-access-data:/data \
  --env-file .env -e NODE_ENV=production \
  val-access-shop
```

The image stores the database at `/data/val-access.db`. Always mount a volume on `/data`.
Put the container behind HTTPS (Caddy, Nginx + Let's Encrypt, or your platform's proxy) and set
`TRUST_PROXY=1`.

### Deployment notes

- **SQLite needs a persistent disk.** Point `DATABASE_PATH` at a mounted volume. Back the file up
  regularly.
- Serve over **HTTPS** (Safaricom requires it for callbacks) and set `NODE_ENV=production`.
- Set all secrets in your host's environment settings, never in the repository.
- Run a single instance (SQLite and in-memory rate limiting are designed for one server).
- GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint, format
  check and tests on every push and pull request.

## Project structure

```
src/
  server.js      # entry point: loads config, opens DB, starts Express
  app.js         # routes, security headers, rate limits, admin auth
  config.js      # environment variables + validation
  db.js          # SQLite schema and product seeding
  orders.js      # orders, payments, callbacks and status logic
  mpesa.js       # Daraja client (OAuth, STK push, STK query) + mock client
  validation.js  # checkout + Kenyan phone number validation
  seed-data.js   # starter products
  seed.js        # `npm run seed`
public/          # customer pages, CSS, browser JS and product images
views/admin.html # admin page (served only after password check)
test/            # automated tests
```
