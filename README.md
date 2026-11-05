# Pryme Quant

AI chart analyser for **Forex, Crypto, Sri Lanka CSE and international stocks** — dark theme, live chart, 3–4 entries per timeframe with **Entry / SL / TP1 / TP2 / TP3** drawn on the chart, position size from your wallet balance, today's news, and a **demo account** to test the trades.

## Features
- **Live chart** (TradingView Lightweight Charts) with EMA 20/50/200, volume, and setup lines. Crypto streams in real time (Binance WebSocket); forex/stocks/CSE refresh every 10–20 s. A **TradingView live** tab is also included.
- **Markets**: Forex + Gold/Silver/Oil/Indices (XAUUSD, EURUSD, NAS100, US30…), Crypto (BTCUSDT…), CSE (JKH.N0000…), US stocks (AAPL…).
- **Analysis engine**: market structure (HH/HL, BOS), S/R clustering, Fibonacci, FVGs, RSI divergence, MACD, ADX, Bollinger, ATR stops, candle patterns, higher-timeframe bias, plus today's headlines → sent to the AI, which returns 3–4 setups. Every AI level is validated (SL/TP on the correct side, realistic distance). If no key is set, the built-in quant engine still gives setups.
- **Free AI keys with auto-failover**: Groq, Gemini, OpenRouter, Mistral, Cerebras. Add as many as you want; if one hits its limit, the next one is used. Keys are stored only in your browser.
- **Risk sizing**: balance + risk % → lots / units / shares, risk $ and profit at each TP.
- **Demo account** (USD + LKR wallets): place any setup as market / limit / stop. TP1 closes half and moves SL to break-even; TP2 closes the rest. Edit or reset the balance anytime.

## Run locally
```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy on Render (from GitHub)
1. Push this folder to a new GitHub repo.
2. Render → **New → Blueprint** → pick the repo (it reads `render.yaml`).
   Or **New → Web Service** → Build: `npm install`, Start: `npm start`, Region: **Singapore**.
3. Open the URL → ⚙️ Settings → add your free API keys.

> Region **Singapore** matters: Binance blocks US-based servers.
> Render free plan sleeps after inactivity — the first load can take ~30–50 s.

## Notes
- CSE data comes from cse.lk's public (unofficial) JSON API. If CSE history is thin, the chart fills in as live prices arrive; use the TradingView tab for full CSE history.
- Forex data comes from Yahoo Finance and may be slightly delayed.
- This is an analysis and practice tool. No AI can guarantee profit — always test on demo first and manage risk.

## Positions on the real TradingView chart (Advanced Charts)
TradingView's free embed chart can't be drawn on by other websites. To see your Demo/Real trades
(entry, SL, TP box + TP1 line + Entry/TP/SL markers) on a full TradingView chart:

1. Apply for the free **Advanced Charts** library: https://www.tradingview.com/advanced-charts/ → "Get the library".
2. When approved, you get access to the private GitHub repo `tradingview/charting_library`.
3. Copy the contents of its `charting_library` folder into `public/charting_library/` in this project
   (so `public/charting_library/charting_library.standalone.js` exists).
4. Make your GitHub repo **private** (licence rule), commit, push. Render redeploys.

Pryme detects the library automatically: the tab becomes **"TradingView (positions)"**, fed with Pryme's live data.
Without the library everything still works (TradingView embed + the Positions chart tab).

## Google login + cloud save (Firebase, free)
Render's free disk is wiped on every restart/deploy, so Pryme saves your data (accounts, trades, signals,
settings, AI keys, profile) in **Firebase Firestore** under your Google account.

1. https://console.firebase.google.com → **Add project** (Google Analytics not needed).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable → Save.**
3. Authentication → **Settings → Authorized domains → Add domain** → your Render domain (e.g. `pryme-analyser.onrender.com`).
4. **Build → Firestore Database → Create database** → Production mode → location `asia-south1` (Mumbai) → Enable.
5. Firestore → **Rules** → paste the contents of `firestore.rules` → **Publish**.
6. Project settings (⚙️) → **Your apps → Web (</>)** → register app → copy the config values.
7. Render → your service → **Environment** → add:
   - `FIREBASE_API_KEY` = apiKey
   - `FIREBASE_AUTH_DOMAIN` = authDomain
   - `FIREBASE_PROJECT_ID` = projectId
   - `FIREBASE_APP_ID` = appId
   Save → Render redeploys. Open the site → **Continue with Google**.

Without these variables Pryme runs in "this device only" mode (no login).

## Android APK + Windows app (free, built on GitHub)
1. Push this project to GitHub (the `.github/workflows/build-apps.yml` file must be included).
2. GitHub → your repo → **Actions** → **Build Pryme Quant apps** → **Run workflow** (check the site URL) → **Run**.
3. Wait ~8–12 minutes. Open the finished run → **Artifacts**:
   - **PrymeQuant-Android** → `PrymeQuant.apk` (install on the phone) + `assetlinks.json`
   - **PrymeQuant-Windows** → `PrymeQuant-Setup-1.0.0.exe` (install on Windows)
4. Copy the contents of `assetlinks.json` into Render → Environment → `ASSETLINKS_JSON` (so the Android app opens full-screen, without a browser bar).
Both apps load the live website, so every GitHub update reaches them automatically.

## Pryme Agent (AI chat + background alerts)
- **Agent tab**: chat in Sinhala, Singlish or English. It reads the live chart, your setups, trades and balances,
  and can act for you: open a symbol, give a signal, take a limit / market entry, set price alerts, add symbols to its watch list.
  It uses the same free AI keys (Account → AI keys). Without a key it still understands simple requests like "gold 1h signal".
- **Background alerts**: Account → Notifications → *Agent alerts*. The server scans the agent's watch list every 4 minutes and
  sends a push notification to your phone / PC when it finds a clean setup — even when the app is closed
  (Android app / Chrome / Edge, and iPhone when added to the home screen).
- So phones stay subscribed after Render restarts, add two env vars on Render once:
  open `https://YOUR-SITE.onrender.com/api/push/newkeys`, copy `publicKey` → `VAPID_PUBLIC_KEY` and `privateKey` → `VAPID_PRIVATE_KEY`.

## Render free plan "restarts"
Render's free web service goes to sleep after 15 minutes without visitors, and the first visit afterwards takes about a minute to wake it.
Every GitHub upload also redeploys it. Your data is safe (it lives in Firebase), but the agent can only scan while the server is awake.
- Free fix: create a free monitor on **UptimeRobot** (uptimerobot.com) or **cron-job.org** that opens
  `https://YOUR-SITE.onrender.com/api/health` every 10 minutes. One service running all month fits inside Render's 750 free hours.
- Paid fix: Render → your service → change the instance type to **Starter** — it never sleeps.
