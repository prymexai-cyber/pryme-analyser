# Pryme Analyser

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
