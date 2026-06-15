require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

const client = new Client();
const CHANNEL_ID = process.env.CHANNEL_ID;
const TEST_CHANNEL_ID = process.env.TEST_CHANNEL_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BITGET_API_KEY = process.env.BITGET_API_KEY;
const BITGET_SECRET = process.env.BITGET_SECRET;
const BITGET_PASSPHRASE = process.env.BITGET_PASSPHRASE;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Dashboard Login ───────────────────────────────────────
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || 'Erik';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'pumper2026';

// ─── Risk als PROZENT vom Kontostand ───────────────────────
let RISK_PERCENT = 1;        // Default 1%
let TEST_RISK_PERCENT = 1;   // Default 1%
let MAX_POSITION_USD = parseFloat(process.env.MAX_POSITION_USD) || 5000;
const LEVERAGE = '1';
let botPaused = false;
let waitingForRisk = false;
let waitingForTestRisk = false;
let lastReportDate = null;
let manualTrade = null;

const TRADES_FILE = '/data/trades.json';
const BALANCE_FILE = '/data/balance_history.json';
const SETTINGS_FILE = '/data/settings.json';

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (s.RISK_PERCENT != null) { RISK_PERCENT = s.RISK_PERCENT; console.log(`⚙️ Risk geladen: ${RISK_PERCENT}%`); }
      if (s.TEST_RISK_PERCENT != null) { TEST_RISK_PERCENT = s.TEST_RISK_PERCENT; console.log(`⚙️ Test Risk geladen: ${TEST_RISK_PERCENT}%`); }
    }
  } catch (e) { console.error('Settings load Fehler:', e.message); }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ RISK_PERCENT, TEST_RISK_PERCENT, updatedAt: new Date().toISOString() }));
  } catch (e) { console.error('Settings save Fehler:', e.message); }
}

let trades = [];
let lastPositionSizes = {};

function loadTrades() {
  try {
    if (fs.existsSync(TRADES_FILE)) {
      trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
      console.log(`📂 ${trades.length} Trades geladen`);
    }
  } catch (e) { trades = []; }
}

function saveTrades() {
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

function addTrade(signal, entryPrice, totalSize, isTest = false) {
  const trade = {
    id: Date.now().toString(),
    asset: signal.asset,
    direction: signal.direction,
    entry: entryPrice,
    stopLoss: signal.stopLoss,
    targets: signal.targets || [],
    totalSize,
    isTest,
    openTime: new Date().toISOString(),
    status: 'open',
    closeTime: null,
    closeReason: null,
    pnl: 0,
    beSet: false,
    events: []
  };
  trades.push(trade);
  saveTrades();
  return trade;
}

function getOpenTrade(asset) {
  return trades.find(t => t.asset === asset && t.status === 'open');
}

function getWinRate() {
  const closed = trades.filter(t => t.status === 'closed');
  if (closed.length === 0) return { total: 0, wins: 0, losses: 0, rate: 0, totalPnl: 0 };
  const wins = closed.filter(t => t.pnl > 0).length;
  const losses = closed.filter(t => t.pnl <= 0).length;
  const totalPnl = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
  return { total: closed.length, wins, losses, rate: ((wins / closed.length) * 100).toFixed(1), totalPnl: totalPnl.toFixed(2) };
}

let balanceHistory = [];

function loadBalanceHistory() {
  try {
    if (fs.existsSync(BALANCE_FILE)) {
      balanceHistory = JSON.parse(fs.readFileSync(BALANCE_FILE, 'utf8'));
      console.log(`📈 ${balanceHistory.length} Balance Snapshots geladen`);
    }
  } catch (e) { balanceHistory = []; }
}

async function saveBalanceSnapshot() {
  try {
    const b = await getBalance();
    if (!b) return;
    const pos = await getPositions();
    const upnl = pos.reduce((s, p) => s + parseFloat(p.unrealizedPL || 0), 0);
    balanceHistory.push({ time: new Date().toISOString(), equity: parseFloat(b.accountEquity || 0), upnl: parseFloat(upnl.toFixed(2)) });
    if (balanceHistory.length > 10000) balanceHistory = balanceHistory.slice(-10000);
    fs.writeFileSync(BALANCE_FILE, JSON.stringify(balanceHistory));
  } catch (e) { console.error('Balance snapshot Fehler:', e.message); }
}

// ─── Express + Basic Auth ──────────────────────────────────
function basicAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) { res.set('WWW-Authenticate', 'Basic realm="Trading Dashboard"'); return res.status(401).send('Login erforderlich'); }
  try {
    const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
    if (user === DASHBOARD_USERNAME && pass === DASHBOARD_PASSWORD) return next();
  } catch (e) {}
  res.set('WWW-Authenticate', 'Basic realm="Trading Dashboard"');
  return res.status(401).send('Falsche Login-Daten');
}
app.use(basicAuth);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', bot: 'running', paused: botPaused }));
app.get('/api/trades', (req, res) => res.json(trades));
app.get('/api/stats', (req, res) => res.json(getWinRate()));
app.get('/api/positions', async (req, res) => {
  try { res.json(await getPositions()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/balance', async (req, res) => {
  try { res.json(await getBalance()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/equity', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  res.json(balanceHistory.filter(b => new Date(b.time) >= cutoff));
});
app.listen(PORT, () => console.log(`🌐 Web Server läuft auf Port ${PORT}`));

// ─── Telegram ──────────────────────────────────────────────
const tg = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

tg.on('polling_error', (error) => {
  console.error('TG Polling Error:', error.message);
  if (error.message.includes('401') || error.message.includes('Unauthorized')) tg.stopPolling();
});

async function notify(msg) {
  try { await tg.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML' }); }
  catch (e) { console.error('TG Error:', e.message); }
}

// Berechnet die aktuelle Risk in Dollar aus dem %-Wert
async function getRiskUSD(isTest = false) {
  const percent = isTest ? TEST_RISK_PERCENT : RISK_PERCENT;
  try {
    const balance = await getBalance();
    const equity = parseFloat(balance.accountEquity || 0);
    return { riskUSD: equity * percent / 100, equity, percent };
  } catch (e) {
    return { riskUSD: 0, equity: 0, percent };
  }
}

async function sendDailyReport() {
  try {
    const now = new Date();
    const todayStr = now.toDateString();
    const todayTrades = trades.filter(t => new Date(t.openTime).toDateString() === todayStr);
    const runningTrades = trades.filter(t => t.status === 'open' && new Date(t.openTime).toDateString() !== todayStr);
    const allOpen = trades.filter(t => t.status === 'open');
    let positions = [];
    try { positions = await getPositions(); } catch (e) {}

    let report = `📊 <b>Daily Report – ${now.toLocaleDateString('de-DE')}</b>\n\n`;
    report += `📂 <b>Heute geöffnet (${todayTrades.length})</b>\n`;
    if (!todayTrades.length) { report += `Keine\n`; }
    else { for (const t of todayTrades) { const pos = positions.find(p => p.symbol === t.asset + 'USDT'); const pnl = pos ? parseFloat(pos.unrealizedPL) : t.pnl; report += `${t.isTest ? '🧪 ' : ''}${pnl >= 0 ? '🟢' : '🔴'} ${t.asset} ${t.direction} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`; } }
    report += `\n📌 <b>Laufende Trades (${runningTrades.length})</b>\n`;
    if (!runningTrades.length) { report += `Keine\n`; }
    else { for (const t of runningTrades) { const pos = positions.find(p => p.symbol === t.asset + 'USDT'); const pnl = pos ? parseFloat(pos.unrealizedPL) : t.pnl; const d = Math.floor((now - new Date(t.openTime)) / 86400000); report += `${t.isTest ? '🧪 ' : ''}${pnl >= 0 ? '🟢' : '🔴'} ${t.asset} ${t.direction} | ${d}d | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`; } }
    report += `\n📈 <b>Entwicklung</b>\n`;
    if (!allOpen.length) { report += `Keine offenen Positionen`; }
    else {
      let total = 0;
      for (const t of allOpen) { const pos = positions.find(p => p.symbol === t.asset + 'USDT'); if (pos) { const pnl = parseFloat(pos.unrealizedPL); total += pnl; report += `${pnl >= 0 ? '🟢' : '🔴'} ${t.asset}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`; } }
      report += `\n💰 <b>Gesamt: ${total >= 0 ? '🟢 +' : '🔴 '}$${total.toFixed(2)}</b>`;
    }
    await notify(report);
  } catch (e) { console.error('Report Fehler:', e.message); }
}

function checkDailyReport() {
  const now = new Date();
  const today = now.toDateString();
  if (now.getUTCHours() === 18 && now.getUTCMinutes() >= 30 && now.getUTCMinutes() < 31 && lastReportDate !== today) {
    lastReportDate = today;
    sendDailyReport();
  }
}

function extractMessageContent(message) {
  let text = message.content || '';
  let imageUrl = null;
  if (message.attachments?.size > 0) {
    const att = message.attachments.first();
    if (att.contentType?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/i.test(att.url)) imageUrl = att.url;
  }
  if (message.embeds?.length > 0) {
    for (const embed of message.embeds) {
      const parts = [];
      if (embed.title) parts.push(embed.title);
      if (embed.description) parts.push(embed.description);
      if (embed.fields) embed.fields.forEach(f => parts.push(`${f.name}: ${f.value}`));
      if (parts.length > 0) text += (text ? '\n' : '') + parts.join('\n');
      if (!imageUrl) {
        if (embed.image?.url) imageUrl = embed.image.url;
        else if (embed.thumbnail?.url) imageUrl = embed.thumbnail.url;
      }
    }
  }
  return { text: text.trim(), imageUrl };
}

// FIX: Echten Bildtyp aus Magic Bytes erkennen
function detectMediaType(buffer) {
  const arr = new Uint8Array(buffer).subarray(0, 4);
  let header = '';
  for (const b of arr) header += b.toString(16).padStart(2, '0');
  if (header.startsWith('ffd8ff')) return 'image/jpeg';
  if (header.startsWith('89504e47')) return 'image/png';
  if (header.startsWith('47494638')) return 'image/gif';
  if (header.startsWith('52494646')) return 'image/webp';
  return 'image/jpeg';
}

// ─── Bitget Helpers ────────────────────────────────────────
function createSignature(timestamp, method, requestPath, body) {
  const message = timestamp + method + requestPath + (body || '');
  return crypto.createHmac('sha256', BITGET_SECRET).update(message).digest('base64');
}

function bitgetHeaders(timestamp, path, body) {
  const sign = createSignature(timestamp, 'POST', path, body);
  return { 'ACCESS-KEY': BITGET_API_KEY, 'ACCESS-SIGN': sign, 'ACCESS-TIMESTAMP': timestamp, 'ACCESS-PASSPHRASE': BITGET_PASSPHRASE, 'Content-Type': 'application/json', 'locale': 'en-US' };
}

function bitgetGetHeaders(timestamp, path, queryString = '') {
  const sign = createSignature(timestamp, 'GET', path + queryString, '');
  return { 'ACCESS-KEY': BITGET_API_KEY, 'ACCESS-SIGN': sign, 'ACCESS-TIMESTAMP': timestamp, 'ACCESS-PASSPHRASE': BITGET_PASSPHRASE, 'Content-Type': 'application/json', 'locale': 'en-US' };
}

function getTPDistribution(count) {
  const distributions = { 1: [100], 2: [60, 40], 3: [50, 30, 20], 4: [40, 25, 20, 15], 5: [30, 25, 20, 15, 10] };
  return distributions[count] || distributions[5];
}

async function getPrice(symbol) {
  const r = await axios.get('https://api.bitget.com/api/v2/mix/market/ticker', { params: { symbol: symbol + 'USDT', productType: 'USDT-FUTURES' } });
  return parseFloat(r.data.data[0].lastPr);
}

async function getSizePrecision(symbol) {
  const r = await axios.get('https://api.bitget.com/api/v2/mix/market/contracts', { params: { symbol: symbol + 'USDT', productType: 'USDT-FUTURES' } });
  return parseInt(r.data.data[0].volumePlace);
}

async function getBalance() {
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/account/accounts';
  const queryString = '?productType=USDT-FUTURES';
  const r = await axios.get(`https://api.bitget.com${path}${queryString}`, { headers: bitgetGetHeaders(timestamp, path, queryString) });
  return r.data.data.find(a => a.marginCoin === 'USDT');
}

async function getPositions() {
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/position/all-position';
  const queryString = '?productType=USDT-FUTURES&marginCoin=USDT';
  const r = await axios.get(`https://api.bitget.com${path}${queryString}`, { headers: bitgetGetHeaders(timestamp, path, queryString) });
  return r.data.data.filter(p => parseFloat(p.total) > 0);
}

async function getPlanOrders(fullSymbol) {
  try {
    const timestamp = Date.now().toString();
    const path = '/api/v2/mix/order/orders-plan-pending';
    const queryString = `?symbol=${fullSymbol}&productType=USDT-FUTURES`;
    const r = await axios.get(`https://api.bitget.com${path}${queryString}`, { headers: bitgetGetHeaders(timestamp, path, queryString) });
    const orders = r.data.data?.entrustedList || r.data.data || [];
    return orders.sort((a, b) => parseFloat(a.triggerPrice) - parseFloat(b.triggerPrice));
  } catch (e) { return []; }
}

async function setLeverage(symbol) {
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/account/set-leverage';
  const body = JSON.stringify({ symbol: symbol + 'USDT', productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage: LEVERAGE });
  await axios.post(`https://api.bitget.com${path}`, body, { headers: bitgetHeaders(timestamp, path, body) });
}

// ─── AI Error Recovery ─────────────────────────────────────
async function aiRetry(action, failedBody, failedPath, direction, asset, errorMsg, attempt = 1) {
  if (attempt > 3) {
    console.log(`🛑 AI Retry aufgegeben nach 3 Versuchen | ${asset}`);
    await notify(`🛑 <b>AI Retry gescheitert (3x)</b>\nAsset: ${asset}\nAction: ${action}\nFehler: ${errorMsg}`);
    return false;
  }
  console.log(`🤖 AI Retry Versuch ${attempt}/3 | ${asset} | ${action}`);
  try {
    let positionContext = 'keine offene Position';
    try {
      const positions = await getPositions();
      const pos = positions.find(p => p.symbol === asset + 'USDT');
      if (pos) positionContext = `holdSide: ${pos.holdSide}, size: ${pos.total}, entry: ${pos.openPriceAvg}, markPrice: ${pos.markPrice}`;
    } catch (e) {}

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Du bist ein Bitget Futures API Experte. Ein API-Call ist fehlgeschlagen. Analysiere und gib einen korrigierten Call zurück.

Fehlgeschlagener Call:
- Action: ${action}
- Path: ${failedPath}
- Body: ${JSON.stringify(failedBody)}
- Fehlermeldung: ${errorMsg}
- Asset: ${asset}
- Direction: ${direction}
- Aktuelle Position: ${positionContext}

Bekannte korrekte Bitget V2 Endpoints:
- Order: /api/v2/mix/order/place-order
- Plan Order (TP): /api/v2/mix/order/place-plan-order
- SL/TP auf Position: /api/v2/mix/order/place-tpsl-order (braucht size!)
- Position schließen: /api/v2/mix/order/close-positions
- Plan Order canceln: /api/v2/mix/order/cancel-plan-order

Häufige Fixes:
- "order quantity too small" → size erhöhen
- "holdSide" Fehler → Long="long", Short="short"
- "position not exist" → close-positions
- "plan order already triggered" → direkt market close
- "Parameter size cannot be empty" → size aus Position hinzufügen

Antworte NUR in JSON:
{"fixDescription":"1 Satz","path":"/api/v2/...","body":{...},"skip":false}
Wenn nicht fixbar: {"skip":true,"fixDescription":"Grund"}`
      }]
    }, { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

    const raw = response.data.content[0].text.replace(/```json|```/g, '').trim();
    const fix = JSON.parse(raw);
    if (fix.skip) { console.log(`⏭️ AI Retry skip: ${fix.fixDescription}`); return false; }
    console.log(`🤖 AI Fix V${attempt}: ${fix.fixDescription}`);
    const fixBodyStr = JSON.stringify(fix.body);
    await axios.post(`https://api.bitget.com${fix.path}`, fixBodyStr, { headers: bitgetHeaders(Date.now().toString(), fix.path, fixBodyStr) });
    console.log(`✅ AI Retry V${attempt} erfolgreich: ${fix.fixDescription}`);
    await notify(`🤖 <b>AI Retry erfolgreich (V${attempt})</b>\n${asset} | ${fix.fixDescription}`);
    return true;
  } catch (retryErr) {
    const retryErrMsg = retryErr.response?.data?.msg || retryErr.message;
    console.error(`❌ AI Retry V${attempt} fehlgeschlagen: ${retryErrMsg}`);
    console.error(`❌ Bitget Response:`, JSON.stringify(retryErr.response?.data));
    await new Promise(r => setTimeout(r, 2000));
    return aiRetry(action, failedBody, failedPath, direction, asset, retryErrMsg, attempt + 1);
  }
}

// ─── Order Placement ───────────────────────────────────────
async function placeOrder(symbol, direction, stopLoss, targets, riskUSD) {
  const fullSymbol = symbol + 'USDT';
  const price = await getPrice(symbol);
  const precision = await getSizePrecision(symbol);
  const riskPerUnit = Math.abs(price - stopLoss);
  let totalSize = riskUSD / riskPerUnit;
  if (totalSize * price > MAX_POSITION_USD) totalSize = MAX_POSITION_USD / price;

  console.log(`📐 Size: ${totalSize.toFixed(precision)} ${symbol} | Notional: $${(totalSize * price).toFixed(2)} | Risk: $${riskUSD.toFixed(2)}`);

  const mainBody = {
    symbol: fullSymbol, productType: 'USDT-FUTURES', marginMode: 'isolated',
    marginCoin: 'USDT', size: totalSize.toFixed(precision),
    side: direction === 'Long' ? 'buy' : 'sell', tradeSide: 'open',
    orderType: 'market', presetStopLossPrice: stopLoss.toString()
  };
  const mainPath = '/api/v2/mix/order/place-order';

  try {
    await axios.post(`https://api.bitget.com${mainPath}`, JSON.stringify(mainBody), { headers: bitgetHeaders(Date.now().toString(), mainPath, JSON.stringify(mainBody)) });
    console.log(`✅ Haupt-Order platziert`);
  } catch (e) {
    const errMsg = e.response?.data?.msg || e.message;
    console.error(`❌ Haupt-Order Fehler: ${errMsg}`, JSON.stringify(e.response?.data));
    const fixed = await aiRetry('place_order', mainBody, mainPath, direction, symbol, errMsg);
    if (!fixed) throw new Error(`Haupt-Order fehlgeschlagen: ${errMsg}`);
  }

  await new Promise(r => setTimeout(r, 5000));

  let validTargets = (targets || []).filter(tp =>
    direction === 'Long' ? tp.price > price : tp.price < price
  );
  const filtered = (targets?.length || 0) - validTargets.length;
  if (filtered > 0) console.log(`⚠️ ${filtered} TP(s) gegen Live-Preis gefiltert`);

  if (validTargets.length > 0) {
    const distribution = getTPDistribution(validTargets.length);
    const holdSide = direction === 'Long' ? 'long' : 'short';
    const closeSide = direction === 'Long' ? 'sell' : 'buy';

    for (let i = 0; i < validTargets.length; i++) {
      const tp = validTargets[i];
      const tpSize = (totalSize * distribution[i] / 100).toFixed(precision);
      await new Promise(r => setTimeout(r, 800));
      const tpBody = {
        symbol: fullSymbol, productType: 'USDT-FUTURES', marginMode: 'isolated',
        marginCoin: 'USDT', side: closeSide, holdSide,
        tradeSide: 'close', orderType: 'market', size: tpSize,
        triggerPrice: tp.price.toString(), triggerType: 'mark_price', planType: 'normal_plan'
      };
      const tpPath = '/api/v2/mix/order/place-plan-order';
      try {
        await axios.post(`https://api.bitget.com${tpPath}`, JSON.stringify(tpBody), { headers: bitgetHeaders(Date.now().toString(), tpPath, JSON.stringify(tpBody)) });
        console.log(`🎯 TP${i + 1}: ${tpSize} ${symbol} @ $${tp.price} (${distribution[i]}%)`);
      } catch (e) {
        const errMsg = e.response?.data?.msg || e.message;
        console.error(`❌ TP${i + 1} Fehler: ${errMsg}`, JSON.stringify(e.response?.data));
        await aiRetry(`place_tp${i + 1}`, tpBody, tpPath, direction, symbol, errMsg);
      }
    }
  }

  return { totalSize, price };
}

async function closePosition(symbol) {
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/order/close-positions';
  const body = JSON.stringify({ symbol: symbol + 'USDT', productType: 'USDT-FUTURES', marginCoin: 'USDT' });
  const r = await axios.post(`https://api.bitget.com${path}`, body, { headers: bitgetHeaders(timestamp, path, body) });
  return r.data;
}

async function moveSlToBreakeven(symbol, direction, entryPrice) {
  const fullSymbol = symbol + 'USDT';
  const positions = await getPositions();
  const pos = positions.find(p => p.symbol === fullSymbol);
  if (!pos) throw new Error(`Position ${symbol} nicht gefunden für BE`);
  const precision = await getSizePrecision(symbol);
  const size = parseFloat(pos.total).toFixed(precision);

  const slPath = '/api/v2/mix/order/place-tpsl-order';
  const slBody = {
    symbol: fullSymbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
    planType: 'loss_plan', triggerPrice: entryPrice.toString(),
    triggerType: 'mark_price', holdSide: direction === 'Long' ? 'long' : 'short',
    size: size
  };
  const r = await axios.post(`https://api.bitget.com${slPath}`, JSON.stringify(slBody), { headers: bitgetHeaders(Date.now().toString(), slPath, JSON.stringify(slBody)) });
  console.log(`↔️ BE gesetzt: ${symbol} @ $${entryPrice} | Size: ${size}`);
  return r.data;
}

async function takeTp1AndBreakeven(symbol, direction) {
  const fullSymbol = symbol + 'USDT';
  const planOrders = await getPlanOrders(fullSymbol);

  if (planOrders.length === 0) {
    const positions = await getPositions();
    const position = positions.find(p => p.symbol === fullSymbol);
    if (position) {
      const entryPrice = parseFloat(position.openPriceAvg);
      await moveSlToBreakeven(symbol, direction, entryPrice);
      return { tp1AlreadyFilled: true, entryPrice };
    }
    return { tp1AlreadyFilled: true };
  }

  const sorted = [...planOrders].sort((a, b) => {
    const pA = parseFloat(a.triggerPrice), pB = parseFloat(b.triggerPrice);
    return direction === 'Long' ? pA - pB : pB - pA;
  });

  const tp1Order = sorted[0];
  const tp1Size = tp1Order.size;
  const orderId = tp1Order.orderId;
  console.log(`🎯 TP1 gefunden: ${tp1Size} @ $${tp1Order.triggerPrice} | ID: ${orderId}`);

  const cancelPath = '/api/v2/mix/order/cancel-plan-order';
  const cancelBody = { symbol: fullSymbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', orderId };
  try {
    await axios.post(`https://api.bitget.com${cancelPath}`, JSON.stringify(cancelBody), { headers: bitgetHeaders(Date.now().toString(), cancelPath, JSON.stringify(cancelBody)) });
    console.log(`❌ TP1 Order gecancelt`);
  } catch (e) {
    const errMsg = e.response?.data?.msg || e.message;
    console.error(`❌ Cancel TP1 Fehler: ${errMsg}`);
    await aiRetry('cancel_tp1', cancelBody, cancelPath, direction, symbol, errMsg);
  }

  const precision = await getSizePrecision(symbol);
  const closeSide = direction === 'Long' ? 'sell' : 'buy';
  const holdSide = direction === 'Long' ? 'long' : 'short';

  const closeBody = {
    symbol: fullSymbol, productType: 'USDT-FUTURES', marginMode: 'isolated',
    marginCoin: 'USDT', size: parseFloat(tp1Size).toFixed(precision),
    side: closeSide, holdSide, tradeSide: 'close', orderType: 'market'
  };
  const closePath = '/api/v2/mix/order/place-order';
  try {
    await axios.post(`https://api.bitget.com${closePath}`, JSON.stringify(closeBody), { headers: bitgetHeaders(Date.now().toString(), closePath, JSON.stringify(closeBody)) });
    console.log(`✅ TP1 at Market geschlossen`);
  } catch (e) {
    const errMsg = e.response?.data?.msg || e.message;
    console.error(`❌ TP1 Close Fehler: ${errMsg}`);
    await aiRetry('take_tp1_close', closeBody, closePath, direction, symbol, errMsg);
  }

  await new Promise(r => setTimeout(r, 2000));
  const positions = await getPositions();
  const position = positions.find(p => p.symbol === fullSymbol);
  if (position) {
    const entryPrice = parseFloat(position.openPriceAvg);
    await moveSlToBreakeven(symbol, direction, entryPrice);
    return { tp1Closed: true, tp1Size, entryPrice };
  }
  return { tp1Closed: true, tp1Size };
}

// ─── Position Monitor ──────────────────────────────────────
async function monitorPositions() {
  try {
    const positions = await getPositions();
    const currentSymbols = new Set(positions.map(p => p.symbol));

    for (const symbol of Object.keys(lastPositionSizes)) {
      if (!currentSymbols.has(symbol)) {
        const asset = symbol.replace('USDT', '');
        const trade = getOpenTrade(asset);
        if (trade) {
          const currentPrice = await getPrice(asset).catch(() => 0);
          const direction = trade.direction === 'Long' ? 1 : -1;
          const pnl = trade.totalSize * (currentPrice - trade.entry) * direction;

          // Ehrliche Begründung statt blindes TP_FINAL
          const slHit = (currentPrice <= trade.stopLoss && trade.direction === 'Long') ||
                        (currentPrice >= trade.stopLoss && trade.direction === 'Short');
          const nearEntry = Math.abs(currentPrice - trade.entry) / trade.entry < 0.002;
          let closeReason, reasonText;
          if (slHit) { closeReason = 'SL'; reasonText = 'Preis am Stop Loss'; }
          else if (nearEntry && trade.beSet) { closeReason = 'BE'; reasonText = 'Preis am Breakeven (Entry)'; }
          else { closeReason = 'TP_FINAL'; reasonText = 'Position vollständig geschlossen (TP final oder manuell)'; }

          trade.status = 'closed';
          trade.closeTime = new Date().toISOString();
          trade.pnl = parseFloat(pnl.toFixed(2));
          trade.closeReason = closeReason;
          trade.events.push({ time: new Date().toISOString(), type: closeReason, price: currentPrice, pnl: trade.pnl });
          saveTrades();
          await notify(`${trade.isTest ? '🧪 ' : ''}${trade.pnl > 0 ? '🟢' : '🔴'} <b>Position geschlossen</b>\nAsset: ${asset}\nGrund: ${closeReason}\n📋 ${reasonText}\nPreis: $${currentPrice} | Entry: $${trade.entry} | SL: $${trade.stopLoss}\nPnL: ${trade.pnl > 0 ? '+' : ''}$${trade.pnl}`);
        }
        delete lastPositionSizes[symbol];
      }
    }

    for (const position of positions) {
      const symbol = position.symbol;
      const asset = symbol.replace('USDT', '');
      const currentSize = parseFloat(position.total);
      const lastSize = lastPositionSizes[symbol];

      if (lastSize && currentSize < lastSize - 0.0001) {
        const trade = getOpenTrade(asset);
        const currentPrice = parseFloat(position.markPrice || position.openPriceAvg);
        const sizeDecrease = lastSize - currentSize;

        if (trade) {
          const distribution = getTPDistribution(trade.targets.length);
          let tpNumber = '?', isTP1 = false;
          for (let i = 0; i < trade.targets.length; i++) {
            const expectedSize = trade.totalSize * distribution[i] / 100;
            if (Math.abs(sizeDecrease - expectedSize) / expectedSize < 0.15) {
              tpNumber = i + 1;
              if (i === 0) isTP1 = true;
              break;
            }
          }

          const dir = trade.direction === 'Long' ? 1 : -1;
          const partialPnl = sizeDecrease * (currentPrice - trade.entry) * dir;
          trade.pnl += partialPnl;
          trade.events.push({ time: new Date().toISOString(), type: `TP${tpNumber}_HIT`, price: currentPrice, pnl: parseFloat(partialPnl.toFixed(2)) });

          if (isTP1 && !trade.beSet) {
            try {
              await moveSlToBreakeven(asset, trade.direction, trade.entry);
              trade.beSet = true;
              trade.events.push({ time: new Date().toISOString(), type: 'AUTO_BE_SET', price: trade.entry, pnl: 0 });
              await notify(`↔️ <b>Auto-BE gesetzt</b>\n${asset} @ $${trade.entry}\n📋 TP1 wurde getriggert, SL automatisch auf Entry`);
            } catch (e) { console.error('Auto-BE Fehler:', e.message); }
          }

          saveTrades();
          await notify(`${trade.isTest ? '🧪 ' : ''}🎯 <b>TP${tpNumber} getriggert!</b>\n${asset} @ $${currentPrice}\nTeilgewinn: +$${partialPnl.toFixed(2)}`);
        }
      }
      lastPositionSizes[symbol] = currentSize;
    }

    for (const position of positions) {
      if (!(position.symbol in lastPositionSizes)) {
        lastPositionSizes[position.symbol] = parseFloat(position.total);
      }
    }
  } catch (e) { console.error('Monitor Fehler:', e.message); }
}

// ─── Claude Signal Analysis ────────────────────────────────
async function analyzeSignal(text, imageUrl) {
  const content = [];
  if (imageUrl) {
    try {
      const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(imageResponse.data);
      const mediaType = detectMediaType(buffer);
      const base64 = buffer.toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
    } catch (e) { console.log('Bild Fehler:', e.message); }
  }
  content.push({
    type: 'text',
    text: `Du bist ein Trading Signal Analyzer für einen Krypto-Trader. Der Trader schreibt oft auch Smalltalk, Unsinn, Statusberichte oder unklare Nachrichten. Du führst NUR bei 100% eindeutigen, direkten Commands etwas aus. Im Zweifel IMMER signal:false.

Nachricht: "${text}"

Antworte NUR in JSON ohne Markdown. Füge IMMER ein "reason" Feld hinzu (1 kurzer Satz, warum du so entschieden hast).

Neues Trade Signal:
{"signal":true,"action":"open","asset":"BTC","direction":"Long","entry":67000,"stopLoss":65000,"targets":[{"price":68000},{"price":69500}],"confidence":"Hoch","reason":"..."}

Market Order ohne genauen Entry ("market","CMP","current price"):
{"signal":true,"action":"open","asset":"BTC","direction":"Long","entry":null,"stopLoss":65000,"targets":[{"price":68000}],"confidence":"Hoch","reason":"..."}

Close ("close X","closing X now","exit X","out of X manually"):
{"signal":true,"action":"close","asset":"BTC","reason":"..."}

Breakeven ("stops to BE","stops to break even","move stops BE","SL to entry"):
{"signal":true,"action":"breakeven","asset":"BTC","reason":"..."}

Take TP1 + BE ("TP1 here","taking TP1","manually taking TP1","take first profit","TP1 now"):
{"signal":true,"action":"take_tp1_be","asset":"BTC","direction":"Long","reason":"..."}

Kein Signal: {"signal":false,"reason":"..."}

STRIKTE REGELN:
- NUR bei eindeutigem, direktem Command handeln. Unsicher? → signal:false
- "TP1 here on INIT","TP1 now","taking TP1" = take_tp1_be (Trader nimmt jetzt TP1!)
- "TP1 hit","TP2 hit","third TP hit" = NUR Info → signal:false
- "stopped out","closing X in green/red","got stopped","both got inches away","gonna take" = Bericht/Ankündigung → signal:false
- Asset = erstes Coin-Wort, GROSSBUCHSTABEN
- Alle TPs exakt aus Text/Bild, niemals erfinden
- "market","CMP" → entry:null (NICHT als Zahl)
- Long: TPs über Entry | Short: TPs unter Entry
- Confidence "Hoch" nur wenn SL klar erkennbar
- reason Feld ist PFLICHT`
  });

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content }]
  }, { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

  const raw = response.data.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

function buildTestReport(signal, entryPrice, riskUSD) {
  if (!signal.stopLoss) return '⚠️ Kein SL';
  const direction = signal.direction === 'Long' ? 1 : -1;
  const riskPerUnit = Math.abs(entryPrice - signal.stopLoss);
  const totalSize = riskUSD / riskPerUnit;
  let report = `\n💼 <b>Berechnung</b>\nEntry: $${entryPrice.toFixed(4)}\nSize: ${totalSize.toFixed(2)} ${signal.asset}\nNotional: $${(totalSize * entryPrice).toFixed(2)}\n\n❌ SL Hit: -$${riskUSD.toFixed(2)}\n`;
  if (signal.targets?.length > 0) {
    const distribution = getTPDistribution(signal.targets.length);
    let totalProfit = 0;
    report += `\n🎯 <b>Take Profits:</b>\n`;
    for (let i = 0; i < signal.targets.length; i++) {
      const profit = (totalSize * distribution[i] / 100) * (signal.targets[i].price - entryPrice) * direction;
      totalProfit += profit;
      report += `TP${i + 1} ($${signal.targets[i].price}) ${distribution[i]}%: +$${profit.toFixed(2)}\n`;
    }
    report += `\n💰 <b>Gesamt: +$${totalProfit.toFixed(2)} | RR: 1:${(totalProfit / riskUSD).toFixed(2)}</b>`;
  }
  return report;
}

// ─── Telegram Commands (nur Basics) ────────────────────────
tg.onText(/\/h/, (msg) => {
  tg.sendMessage(msg.chat.id, `
📖 <b>Commands Übersicht</b>

/d — Dashboard
/positions — Offene Positionen
/balance — Kontostand
/pnl — Unrealisiertes PnL
/history — Letzte 10 Trades
/winrate — Winrate & Stats
/trade [ASSET] — Trade Details
/manual — Manuellen Trade öffnen
/risk — Live Risiko ändern
/testrisk — Test Risiko ändern
/report — Daily Report jetzt
/close [ASSET] — Position schließen
/pause — Bot pausieren
/resume — Bot reaktivieren
/status — Bot Status
/h — Diese Übersicht
  `, { parse_mode: 'HTML' });
});

tg.onText(/\/positions/, async (msg) => {
  try {
    const positions = await getPositions();
    if (!positions.length) return tg.sendMessage(msg.chat.id, '📭 Keine offenen Positionen.');

    for (const p of positions) {
      const asset = p.symbol.replace('USDT', '');
      const pnl = parseFloat(p.unrealizedPL);
      const rl = parseFloat(p.achievedProfits || 0);
      const isLong = p.holdSide === 'long';
      const trade = getOpenTrade(asset);

      const planOrders = await getPlanOrders(p.symbol);
      let tpText = '';
      if (planOrders.length > 0) {
        const sorted = [...planOrders].sort((a, b) =>
          isLong ? parseFloat(a.triggerPrice) - parseFloat(b.triggerPrice)
                 : parseFloat(b.triggerPrice) - parseFloat(a.triggerPrice)
        );
        tpText = sorted.map((o, i) => `TP${i + 1}: $${parseFloat(o.triggerPrice).toFixed(4)}`).join('\n');
      } else {
        tpText = '— (keine TPs)';
      }

      const text = `${isLong ? '🟢 Long' : '🔴 Short'} <b>${p.symbol}</b>
Entry: $${parseFloat(p.openPriceAvg).toFixed(4)}
SL: $${trade?.stopLoss || '—'}
${tpText}
─────────────
Unrealisiert: ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(2)}
Realisiert: ${rl >= 0 ? '🟢' : '🔴'} $${rl.toFixed(2)}`;

      await tg.sendMessage(msg.chat.id, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❌ Close', callback_data: `close_${asset}` }]] }
      });
    }
  } catch (e) { tg.sendMessage(msg.chat.id, `❌ Fehler: ${e.message}`); }
});

tg.onText(/\/manual/, (msg) => {
  manualTrade = { step: 'coin', data: {}, chatId: msg.chat.id };
  tg.sendMessage(msg.chat.id, `📝 <b>Manueller Trade</b>\n\nWelchen Coin?`, { parse_mode: 'HTML' });
});

tg.onText(/\/report/, async (msg) => { await sendDailyReport(); });

tg.onText(/\/winrate/, (msg) => {
  const stats = getWinRate();
  if (stats.total === 0) return tg.sendMessage(msg.chat.id, '📭 Noch keine Trades.');
  tg.sendMessage(msg.chat.id, `📊 <b>Winrate</b>\n\nTrades: ${stats.total} | 🟢 ${stats.wins} | 🔴 ${stats.losses}\nWinrate: <b>${stats.rate}%</b>\nTotal PnL: ${parseFloat(stats.totalPnl) >= 0 ? '🟢' : '🔴'} $${stats.totalPnl}`, { parse_mode: 'HTML' });
});

tg.onText(/\/history/, (msg) => {
  const closed = trades.filter(t => t.status === 'closed').slice(-10).reverse();
  if (!closed.length) return tg.sendMessage(msg.chat.id, '📭 Keine History.');
  let text = '📋 <b>Letzte Trades</b>\n\n';
  for (const t of closed) {
    text += `${t.isTest ? '🧪 ' : ''}${t.pnl > 0 ? '🟢' : '🔴'} <b>${t.asset}</b> ${t.direction} | ${t.closeReason} | ${t.pnl > 0 ? '+' : ''}$${t.pnl} | ${new Date(t.openTime).toLocaleDateString('de-DE')}\n`;
  }
  tg.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

tg.onText(/\/trade (.+)/, (msg, match) => {
  const asset = match[1].toUpperCase();
  const assetTrades = trades.filter(t => t.asset === asset).slice(-3).reverse();
  if (!assetTrades.length) return tg.sendMessage(msg.chat.id, `📭 Keine Trades für ${asset}.`);
  for (const t of assetTrades) {
    let text = `${t.isTest ? '🧪 ' : ''}📊 <b>${t.asset} ${t.direction}</b>\n`;
    text += `Status: ${t.status === 'open' ? '🟡 Offen' : (t.pnl > 0 ? '🟢 Win' : '🔴 Loss')}\n`;
    text += `Entry: $${t.entry} | SL: $${t.stopLoss}\n`;
    if (t.targets?.length > 0) text += `TPs: ${t.targets.map(tp => '$' + tp.price).join(' | ')}\n`;
    text += `Geöffnet: ${new Date(t.openTime).toLocaleString('de-DE')}\n`;
    if (t.closeTime) text += `Geschlossen: ${new Date(t.closeTime).toLocaleString('de-DE')}\n`;
    text += `PnL: ${t.pnl > 0 ? '+' : ''}$${t.pnl}\n`;
    if (t.events?.length > 0) {
      text += `\n<b>Events:</b>\n`;
      for (const e of t.events) text += `• ${e.type} @ $${e.price} | ${e.pnl >= 0 ? '+' : ''}$${e.pnl || 0}\n`;
    }
    tg.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  }
});

tg.onText(/\/status/, async (msg) => {
  const stats = getWinRate();
  const { equity } = await getRiskUSD(false);
  const liveUSD = (equity * RISK_PERCENT / 100).toFixed(2);
  const testUSD = (equity * TEST_RISK_PERCENT / 100).toFixed(2);
  tg.sendMessage(msg.chat.id, `🤖 <b>Bot Status</b>\n\nStatus: ${botPaused ? '⏸ Pausiert' : '✅ Aktiv'}\nLive Risk: ${RISK_PERCENT}% (≈$${liveUSD})\nTest Risk: ${TEST_RISK_PERCENT}% (≈$${testUSD})\nWinrate: ${stats.total > 0 ? stats.rate + '%' : 'N/A'}`, { parse_mode: 'HTML' });
});

tg.onText(/\/pause/, (msg) => { botPaused = true; tg.sendMessage(msg.chat.id, '⏸ <b>Bot pausiert</b>', { parse_mode: 'HTML' }); });
tg.onText(/\/resume/, (msg) => { botPaused = false; tg.sendMessage(msg.chat.id, '▶️ <b>Bot aktiv</b>', { parse_mode: 'HTML' }); });

tg.onText(/\/risk/, async (msg) => {
  waitingForRisk = true; waitingForTestRisk = false;
  const { equity } = await getRiskUSD(false);
  const cur = (equity * RISK_PERCENT / 100).toFixed(2);
  tg.sendMessage(msg.chat.id, `💰 Live Risk: <b>${RISK_PERCENT}%</b> (≈$${cur})\n\nGib den gewünschten $-Betrag ein.\nIch rechne das % vom aktuellen Kontostand ($${equity.toFixed(2)}) aus und speichere es.`, { parse_mode: 'HTML' });
});

tg.onText(/\/testrisk/, async (msg) => {
  waitingForTestRisk = true; waitingForRisk = false;
  const { equity } = await getRiskUSD(true);
  const cur = (equity * TEST_RISK_PERCENT / 100).toFixed(2);
  tg.sendMessage(msg.chat.id, `🧪 Test Risk: <b>${TEST_RISK_PERCENT}%</b> (≈$${cur})\n\nGib den gewünschten $-Betrag ein.`, { parse_mode: 'HTML' });
});

tg.onText(/\/balance/, async (msg) => {
  try {
    const balance = await getBalance();
    tg.sendMessage(msg.chat.id, `💰 <b>Kontostand</b>\n\nVerfügbar: $${parseFloat(balance.available).toFixed(2)}\nGesamt: $${parseFloat(balance.accountEquity).toFixed(2)}\nUnrealisiert: $${parseFloat(balance.unrealizedPL).toFixed(2)}`, { parse_mode: 'HTML' });
  } catch (e) { tg.sendMessage(msg.chat.id, '❌ Fehler.'); }
});

tg.onText(/\/pnl/, async (msg) => {
  try {
    const positions = await getPositions();
    if (!positions.length) return tg.sendMessage(msg.chat.id, '📭 Keine Positionen.');
    let text = '📊 <b>PnL</b>\n\n';
    let total = 0;
    for (const p of positions) {
      const pnl = parseFloat(p.unrealizedPL);
      total += pnl;
      text += `${p.symbol}: ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(2)}\n`;
    }
    text += `\n<b>Total: ${total >= 0 ? '🟢' : '🔴'} $${total.toFixed(2)}</b>`;
    tg.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  } catch (e) { tg.sendMessage(msg.chat.id, '❌ Fehler.'); }
});

tg.onText(/\/close (.+)/, async (msg, match) => {
  const asset = match[1].toUpperCase();
  try {
    await closePosition(asset);
    const trade = getOpenTrade(asset);
    if (trade) { trade.status = 'closed'; trade.closeTime = new Date().toISOString(); trade.closeReason = 'MANUAL'; saveTrades(); }
    tg.sendMessage(msg.chat.id, `✅ <b>${asset}</b> geschlossen.`, { parse_mode: 'HTML' });
  } catch (e) { tg.sendMessage(msg.chat.id, `❌ ${e.message}`); }
});

tg.onText(/\/d/, async (msg) => {
  try {
    const [positions, balance] = await Promise.all([getPositions(), getBalance()]);
    const totalPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealizedPL), 0);
    const stats = getWinRate();
    const equity = parseFloat(balance.accountEquity);
    let text = `📊 <b>Dashboard</b>\n\n`;
    text += `💰 Balance: $${equity.toFixed(2)}\n`;
    text += `📈 PnL: ${totalPnl >= 0 ? '🟢' : '🔴'} $${totalPnl.toFixed(2)}\n`;
    text += `🎯 Positionen: ${positions.length} | 📊 Winrate: ${stats.total > 0 ? stats.rate + '%' : 'N/A'}\n`;
    text += `⚡ Live: ${RISK_PERCENT}% (≈$${(equity * RISK_PERCENT / 100).toFixed(2)}) | 🧪 Test: ${TEST_RISK_PERCENT}%\n`;
    text += `🤖 ${botPaused ? '⏸ Pausiert' : '✅ Aktiv'}\n`;
    if (positions.length > 0) {
      text += '\n<b>Positionen:</b>\n';
      for (const p of positions) {
        const pnl = parseFloat(p.unrealizedPL);
        text += `• ${p.symbol} ${p.holdSide === 'long' ? '🟢' : '🔴'} $${pnl.toFixed(2)}\n`;
      }
    }
    tg.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  } catch (e) { tg.sendMessage(msg.chat.id, '❌ Fehler.'); }
});

// ─── Callback Queries (nur Close + Manual) ─────────────────
tg.on('callback_query', async (query) => {
  const data = query.data;

  if (data.startsWith('close_')) {
    const asset = data.replace('close_', '');
    try {
      await closePosition(asset);
      const trade = getOpenTrade(asset);
      if (trade) { trade.status = 'closed'; trade.closeTime = new Date().toISOString(); trade.closeReason = 'MANUAL'; saveTrades(); }
      tg.answerCallbackQuery(query.id, { text: `✅ ${asset} geschlossen!` });
      tg.editMessageText(`✅ <b>${asset}</b> geschlossen.`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'HTML' });
    } catch (e) { tg.answerCallbackQuery(query.id, { text: `❌ ${e.message}` }); }
    return;
  }

  if (data === 'manual_long' || data === 'manual_short') {
    if (manualTrade?.step === 'direction') {
      manualTrade.data.direction = data === 'manual_long' ? 'Long' : 'Short';
      manualTrade.step = 'sl';
      tg.answerCallbackQuery(query.id);
      tg.sendMessage(manualTrade.chatId, `✅ ${manualTrade.data.direction}\n\nStop Loss Preis eingeben:`, { parse_mode: 'HTML' });
    }
    return;
  }

  if (data === 'manual_confirm') {
    if (manualTrade?.step === 'confirm') {
      tg.answerCallbackQuery(query.id, { text: 'Trade wird geöffnet...' });
      const d = manualTrade.data;
      manualTrade = null;
      try {
        await setLeverage(d.asset);
        const { riskUSD } = await getRiskUSD(false);
        const result = await placeOrder(d.asset, d.direction, d.stopLoss, d.targets, riskUSD);
        addTrade({ asset: d.asset, direction: d.direction, stopLoss: d.stopLoss, targets: d.targets }, result.price, result.totalSize);
        const tpList = d.targets?.map((t, i) => `TP${i + 1}: $${t.price}`).join('\n') || '–';
        await tg.sendMessage(TELEGRAM_CHAT_ID, `🟢 <b>Manueller Trade eröffnet</b>\n${d.asset} ${d.direction}\nEntry: $${result.price}\nSL: $${d.stopLoss}\n${tpList}\nRisk: ${RISK_PERCENT}% (≈$${riskUSD.toFixed(2)})`, { parse_mode: 'HTML' });
      } catch (e) {
        await tg.sendMessage(TELEGRAM_CHAT_ID, `❌ Fehler: ${e.response?.data?.msg || e.message}`);
      }
    }
    return;
  }

  if (data === 'manual_cancel') {
    manualTrade = null;
    tg.answerCallbackQuery(query.id, { text: 'Abgebrochen' });
    tg.sendMessage(query.message.chat.id, '❌ Abgebrochen.');
  }
});

// ─── Message Handler ───────────────────────────────────────
tg.on('message', async (msg) => {
  if (!msg.text) return;

  // Manual Trade Input
  if (manualTrade && !msg.text.startsWith('/')) {
    const chatId = manualTrade.chatId;

    if (manualTrade.step === 'coin') {
      manualTrade.data.asset = msg.text.toUpperCase().trim();
      manualTrade.step = 'direction';
      tg.sendMessage(chatId, `Asset: <b>${manualTrade.data.asset}</b>\n\nRichtung?`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🟢 Long', callback_data: 'manual_long' }, { text: '🔴 Short', callback_data: 'manual_short' }]] }
      });
      return;
    }

    if (manualTrade.step === 'sl') {
      const sl = parseFloat(msg.text);
      if (isNaN(sl)) { tg.sendMessage(chatId, '❌ Ungültig. Nochmal:'); return; }
      manualTrade.data.stopLoss = sl;
      manualTrade.step = 'tps';
      tg.sendMessage(chatId, `SL: <b>$${sl}</b>\n\nTake Profits (kommagetrennt):\nz.B. <code>68000, 70000, 72000</code>`, { parse_mode: 'HTML' });
      return;
    }

    if (manualTrade.step === 'tps') {
      const tpPrices = msg.text.split(',').map(t => parseFloat(t.trim())).filter(t => !isNaN(t));
      if (!tpPrices.length) { tg.sendMessage(chatId, '❌ Ungültig. Nochmal:'); return; }
      manualTrade.data.targets = tpPrices.map(p => ({ price: p }));
      manualTrade.step = 'confirm';
      const d = manualTrade.data;
      const tpList = d.targets.map((t, i) => `TP${i + 1}: $${t.price}`).join('\n');
      tg.sendMessage(chatId, `📋 <b>Zusammenfassung</b>\n\nAsset: ${d.asset}\nRichtung: ${d.direction}\nSL: $${d.stopLoss}\n${tpList}\nRisk: ${RISK_PERCENT}% vom Kontostand\n\nBestätigen?`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Bestätigen', callback_data: 'manual_confirm' }, { text: '❌ Abbrechen', callback_data: 'manual_cancel' }]] }
      });
      return;
    }
  }

  // Risk Input → Dollar eingeben, % vom Kontostand berechnen & speichern
  if ((waitingForRisk || waitingForTestRisk) && !msg.text.startsWith('/')) {
    const amount = parseFloat(msg.text);
    if (isNaN(amount) || amount <= 0) { tg.sendMessage(msg.chat.id, '❌ Ungültige Zahl.'); return; }
    try {
      const balance = await getBalance();
      const equity = parseFloat(balance.accountEquity || 0);
      if (equity <= 0) { tg.sendMessage(msg.chat.id, '❌ Kontostand konnte nicht ermittelt werden.'); return; }
      const percent = (amount / equity) * 100;

      if (waitingForRisk) {
        RISK_PERCENT = parseFloat(percent.toFixed(4));
        waitingForRisk = false;
        saveSettings();
        tg.sendMessage(msg.chat.id, `✅ <b>Live Risk gesetzt</b>\n\n$${amount.toFixed(2)} von $${equity.toFixed(2)}\n= <b>${RISK_PERCENT}%</b>\n\nKünftige Trades nutzen ${RISK_PERCENT}% vom jeweils aktuellen Kontostand. Bei wachsendem Kapital steigt die $-Risk automatisch mit.`, { parse_mode: 'HTML' });
      } else {
        TEST_RISK_PERCENT = parseFloat(percent.toFixed(4));
        waitingForTestRisk = false;
        saveSettings();
        tg.sendMessage(msg.chat.id, `✅ <b>Test Risk gesetzt</b>\n\n$${amount.toFixed(2)} von $${equity.toFixed(2)}\n= <b>${TEST_RISK_PERCENT}%</b>`, { parse_mode: 'HTML' });
      }
    } catch (e) {
      tg.sendMessage(msg.chat.id, `❌ Fehler: ${e.message}`);
    }
    return;
  }
});

// ─── Discord ───────────────────────────────────────────────
client.on('ready', async () => {
  console.log(`✅ Bot läuft! Eingeloggt als ${client.user.tag}`);
  loadSettings();
  loadTrades();
  loadBalanceHistory();
  setInterval(monitorPositions, 60000);
  setInterval(checkDailyReport, 60000);
  setInterval(saveBalanceSnapshot, 60 * 1000);
  setTimeout(monitorPositions, 5000);
  setTimeout(saveBalanceSnapshot, 5000);
  await notify(`✅ <b>Bot gestartet</b>\nLive Risk: ${RISK_PERCENT}% | Test Risk: ${TEST_RISK_PERCENT}%`);
});

client.on('messageCreate', async (message) => {
  const isLive = message.channel.id === CHANNEL_ID;
  const isTest = TEST_CHANNEL_ID && message.channel.id === TEST_CHANNEL_ID;
  if (!isLive && !isTest) return;
  if (botPaused && isLive) return;

  const { text: textContent, imageUrl } = extractMessageContent(message);
  console.log(`\n${isTest ? '🧪' : '📨'} ${message.author.tag}: ${textContent || '[kein Text]'}`);
  if (!textContent && !imageUrl) return;

  let signal = null;
  try {
    signal = await analyzeSignal(textContent, imageUrl);
    console.log(`📊 Signal:`, JSON.stringify(signal));
    if (signal.reason) console.log(`💭 Grund: ${signal.reason}`);

    if (!signal.signal) return;

    // Close
    if (signal.action === 'close') {
      await closePosition(signal.asset);
      const trade = getOpenTrade(signal.asset);
      if (trade) { trade.status = 'closed'; trade.closeTime = new Date().toISOString(); trade.closeReason = 'MANUAL_DISCORD'; saveTrades(); }
      await notify(`${isTest ? '🧪 ' : ''}🔴 <b>Position geschlossen</b>\n${signal.asset}\n📋 ${signal.reason || 'Close Signal'}`);
      return;
    }

    // Breakeven
    if (signal.action === 'breakeven') {
      let entryPrice = signal.entry;
      if (!entryPrice && signal.asset) {
        const positions = await getPositions();
        const pos = positions.find(p => p.symbol === signal.asset + 'USDT');
        if (pos) entryPrice = parseFloat(pos.openPriceAvg);
      }
      if (!entryPrice) { console.log('⏭️ BE: kein Entry gefunden'); return; }
      const dir = signal.direction || getOpenTrade(signal.asset)?.direction || 'Long';
      await moveSlToBreakeven(signal.asset, dir, entryPrice);
      await notify(`${isTest ? '🧪 ' : ''}↔️ <b>SL auf BE gesetzt</b>\n${signal.asset} @ $${entryPrice}\n📋 ${signal.reason || 'BE Signal'}`);
      return;
    }

    // Take TP1 + BE
    if (signal.action === 'take_tp1_be') {
      const dir = signal.direction || getOpenTrade(signal.asset)?.direction || 'Long';
      const result = await takeTp1AndBreakeven(signal.asset, dir);
      if (result.tp1AlreadyFilled) {
        await notify(`${isTest ? '🧪 ' : ''}↔️ <b>TP1 bereits getriggert – BE gesetzt</b>\n${signal.asset}\n📋 ${signal.reason || ''}`);
      } else {
        await notify(`${isTest ? '🧪 ' : ''}✅ <b>TP1 geschlossen + BE gesetzt</b>\n${signal.asset} | ${result.tp1Size} Units\n📋 ${signal.reason || ''}`);
      }
      return;
    }

    // Open Trade
    if (signal.action === 'open') {
      if (signal.confidence === 'Niedrig' || !signal.stopLoss || !signal.asset) return;

      const existingPosition = (await getPositions()).find(p => p.symbol === signal.asset + 'USDT');
      if (existingPosition) {
        console.log(`⏭️ Duplicate: ${signal.asset} bereits offen`);
        await notify(`⚠️ <b>Duplicate geblockt</b>\n${signal.asset} bereits offen`);
        return;
      }

      // TP Validation – NUR wenn entry eine echte Zahl ist
      if (signal.targets && signal.entry && !isNaN(parseFloat(signal.entry))) {
        const entryRef = parseFloat(signal.entry);
        const before = signal.targets.length;
        signal.targets = signal.targets.filter(tp =>
          signal.direction === 'Long' ? tp.price > entryRef : tp.price < entryRef
        );
        if (signal.targets.length < before)
          console.log(`⚠️ ${before - signal.targets.length} TP(s) gegen Signal-Entry gefiltert`);
      }

      const { riskUSD, equity, percent } = await getRiskUSD(isTest);
      if (riskUSD <= 0) { await notify(`❌ Risk konnte nicht berechnet werden (Kontostand?)`); return; }

      await setLeverage(signal.asset);
      const result = await placeOrder(signal.asset, signal.direction, signal.stopLoss, signal.targets, riskUSD);
      addTrade(signal, result.price, result.totalSize, isTest);

      const tpList = signal.targets?.map((t, i) => `TP${i + 1}: $${t.price}`).join('\n') || '–';
      await notify(`${isTest ? '🧪 ' : ''}🟢 <b>Trade eröffnet</b>\nAsset: ${signal.asset} ${signal.direction}\nEntry: $${result.price}\nSL: $${signal.stopLoss}\n${tpList}\nRisk: ${percent}% (≈$${riskUSD.toFixed(2)} von $${equity.toFixed(2)})`);
    }

  } catch (err) {
    const bitgetError = err.response?.data;
    const errMsg = bitgetError?.msg || err.message;
    console.error(`❌ Fehler: ${errMsg}`);
    console.error(`❌ Response:`, JSON.stringify(bitgetError));

    if (err.response?.status === 400 && signal?.asset && signal?.action === 'open') {
      await notify(`⚠️ <b>Fehler – AI Retry startet</b>\n${signal.asset} | ${errMsg}`);
      await aiRetry('open', null, '/api/v2/mix/order/place-order', signal.direction || 'Long', signal.asset, errMsg);
    } else {
      await notify(`❌ <b>Fehler</b>: ${errMsg}`);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
