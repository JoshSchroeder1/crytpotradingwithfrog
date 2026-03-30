/**
 * Crypto Trading with Frog — Autonomous Trading Bot
 * ──────────────────────────────────────────────────
 * Mirrors the signal engine from the browser app exactly.
 * Runs every 30 seconds, writes all trades to Supabase so
 * they appear instantly in the browser app on any device.
 *
 * Setup:
 *   1. npm init -y
 *   2. npm install node-fetch
 *   3. node bot.js
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  supabaseUrl:  'https://mslpattxlevxrcwkxrtl.supabase.co',
  supabaseKey:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zbHBhdHR4bGV2eHJjd2t4cnRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4Mzg3MzIsImV4cCI6MjA5MDQxNDczMn0.LqAfaqVyMlJLZhQBJ0d_Y4Jf3y9u91ofC9yy5sQog6Q',
  riskLevel:    'high',        // 'low' | 'med' | 'high'
  tradeSize:    1000,          // base USD per trade
  scanInterval: 30 * 1000,    // 30 seconds
  logLevel:     'verbose',     // 'verbose' | 'trades' | 'silent'
};

// ── COINS ─────────────────────────────────────────────────────────────────────
const COINS = [
  { id:'btc',  sym:'BTC',  name:'Bitcoin',    p:67420,  col:'#f7931a' },
  { id:'eth',  sym:'ETH',  name:'Ethereum',   p:3521,   col:'#627eea' },
  { id:'sol',  sym:'SOL',  name:'Solana',     p:182.4,  col:'#9945ff' },
  { id:'bnb',  sym:'BNB',  name:'BNB',        p:594,    col:'#f3ba2f' },
  { id:'xrp',  sym:'XRP',  name:'XRP',        p:0.587,  col:'#00aae4' },
  { id:'ada',  sym:'ADA',  name:'Cardano',    p:0.512,  col:'#0d6efd' },
  { id:'avax', sym:'AVAX', name:'Avalanche',  p:38.7,   col:'#e84142' },
  { id:'dot',  sym:'DOT',  name:'Polkadot',   p:8.12,   col:'#e6007a' },
  { id:'link', sym:'LINK', name:'Chainlink',  p:15.2,   col:'#2a5ada' },
  { id:'matic',sym:'MATIC',name:'Polygon',    p:0.728,  col:'#8247e5' },
  { id:'uni',  sym:'UNI',  name:'Uniswap',    p:9.84,   col:'#ff007a' },
  { id:'atom', sym:'ATOM', name:'Cosmos',     p:9.22,   col:'#6f7390' },
  { id:'near', sym:'NEAR', name:'NEAR',       p:7.14,   col:'#00c08b' },
  { id:'arb',  sym:'ARB',  name:'Arbitrum',   p:1.24,   col:'#28a0f0' },
  { id:'op',   sym:'OP',   name:'Optimism',   p:2.87,   col:'#ff0420' },
];

// ── RISK PROFILES (mirrored from app) ─────────────────────────────────────────
const RISK_PROFILES = {
  low: {
    buyThresh:          68,
    sellThresh:         55,
    maxPositions:       3,
    sellFraction:       1.0,
    stopLossPct:        -3,
    takeProfitPct:      8,
    momentumSellThresh: -1.0,
    pbOversoldBuy:      0.15,
    pbOverboughtSell:   0.78,
    rsiOversoldBuy:     32,
    rsiOverboughtSell:  65,
    sizeMultiplier:     0.75,
  },
  med: {
    buyThresh:          52,
    sellThresh:         48,
    maxPositions:       6,
    sellFraction:       1.0,
    stopLossPct:        -6,
    takeProfitPct:      15,
    momentumSellThresh: -1.5,
    pbOversoldBuy:      0.22,
    pbOverboughtSell:   0.82,
    rsiOversoldBuy:     38,
    rsiOverboughtSell:  68,
    sizeMultiplier:     1.0,
  },
  high: {
    buyThresh:          35,
    sellThresh:         38,
    maxPositions:       12,
    sellFraction:       0.5,
    stopLossPct:        -12,
    takeProfitPct:      30,
    minMovePct:         5,        // never sell unless price moved ≥ 5% from avg entry
    momentumSellThresh: -2.5,
    pbOversoldBuy:      0.30,
    pbOverboughtSell:   0.90,
    rsiOversoldBuy:     45,
    rsiOverboughtSell:  75,
    sizeMultiplier:     1.5,
  },
};

// ── STATE ─────────────────────────────────────────────────────────────────────
let live         = {};   // { coinId: currentPrice }
let port         = {};   // { coinId: { units, cost, avg, sym, name, col } }
let ledger       = [];   // array of trade objects
let realizedPnL  = {};   // { coinId: { gains[], sym, col, totalBought, totalSold } }
let priceHistory = {};   // { coinId: number[] }  — last 20 prices for momentum
let scanCount    = 0;

COINS.forEach(c => {
  live[c.id]         = c.p;
  priceHistory[c.id] = [];
});

// ── LOGGING ───────────────────────────────────────────────────────────────────
function log(level, ...args) {
  if (CONFIG.logLevel === 'silent') return;
  if (CONFIG.logLevel === 'trades' && level === 'info') return;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const prefix = { info: '·', trade: '▶', warn: '⚠', error: '✖' }[level] || '·';
  console.log(`[${ts}] ${prefix}`, ...args);
}

function fmt(n) {
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(2)  + 'M';
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n < 0.001) return '$' + n.toFixed(6);
  if (n < 1)     return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

// ── PRICE SIMULATION ──────────────────────────────────────────────────────────
// In production, replace this with a real exchange API (e.g. CoinGecko, Binance)
function tickPrices() {
  COINS.forEach(c => {
    const change = (Math.random() - 0.499) * 0.003;
    live[c.id] = parseFloat((live[c.id] * (1 + change)).toFixed(c.p < 1 ? 6 : 2));
    priceHistory[c.id].push(live[c.id]);
    if (priceHistory[c.id].length > 20) priceHistory[c.id].shift();
  });
}

// ── TECHNICAL INDICATORS ──────────────────────────────────────────────────────
function calcSMA(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = (gains / period) / ((losses / period) || 0.001);
  return 100 - 100 / (1 + rs);
}

function calcBollingerBands(prices, period = 20, mult = 2.0) {
  const result = { upper: [], mid: [], lower: [], pb: [], bw: [] };
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      result.upper.push(null); result.mid.push(null);
      result.lower.push(null); result.pb.push(null); result.bw.push(null);
      continue;
    }
    const slice = prices.slice(i - period + 1, i + 1);
    const sma   = slice.reduce((a, b) => a + b, 0) / period;
    const sd    = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period);
    const upper = sma + mult * sd;
    const lower = sma - mult * sd;
    result.upper.push(upper);
    result.mid.push(sma);
    result.lower.push(lower);
    result.pb.push((prices[i] - lower) / (upper - lower || 1));
    result.bw.push((upper - lower) / sma);
  }
  return result;
}

function isSqueeze(bwArr, lookback = 60) {
  const valid = bwArr.filter(v => v !== null);
  if (valid.length < lookback) return false;
  const cur = valid[valid.length - 1];
  const min = Math.min(...valid.slice(-lookback));
  return cur <= min * 1.06;
}

// ── SIGNAL ENGINE (mirrors getSignalScore in app exactly) ─────────────────────
function getSignalScore(coinId, riskLevel) {
  const p      = RISK_PROFILES[riskLevel];
  const ph     = priceHistory[coinId];
  if (ph.length < 25) return { action: 'hold', buyScore: 0, sellScore: 0, reasons: [], rsiV: 50, pbN: 0.5, sq: false, momentum: 0 };

  const bb     = calcBollingerBands(ph, 20, 2.0);
  const sq     = isSqueeze(bb.bw);
  const validPB = bb.pb.filter(v => v !== null);
  const pbN    = validPB.length ? validPB[validPB.length - 1] : 0.5;
  const rsiV   = calcRSI(ph);
  const s20    = calcSMA(ph, 20);
  const s50    = calcSMA(ph, Math.min(50, ph.length));
  const momentum = ph.length >= 5
    ? (ph[ph.length - 1] - ph[ph.length - 5]) / ph[ph.length - 5] * 100
    : 0;

  let buyScore = 0, sellScore = 0, reasons = [];

  // ── Buy signals ──
  if (pbN <= p.pbOversoldBuy) {
    const pts = pbN <= 0.10 ? 40 : pbN <= 0.15 ? 30 : 20;
    buyScore += pts;
    reasons.push(`%B ${pbN <= 0.10 ? 'deep ' : ''}oversold (${pbN.toFixed(2)})`);
  }
  if (sq) { buyScore += 22; reasons.push('BB squeeze'); }
  if (rsiV < p.rsiOversoldBuy) {
    const pts = rsiV < 25 ? 30 : rsiV < 30 ? 22 : 12;
    buyScore += pts;
    reasons.push(`RSI oversold (${rsiV.toFixed(0)})`);
  }
  if (s20 && s50 && s20 > s50) { buyScore += 14; reasons.push('golden cross'); }
  if (momentum > 1.0 && riskLevel === 'high') { buyScore += 15; reasons.push(`momentum +${momentum.toFixed(1)}%`); }
  if (momentum > 0.5 && riskLevel !== 'low')  { buyScore += 8; }

  // ── Sell signals ──
  if (pbN >= p.pbOverboughtSell) {
    const pts = pbN >= 0.92 ? 40 : pbN >= 0.85 ? 28 : 18;
    sellScore += pts;
    reasons.push(`%B overbought (${pbN.toFixed(2)})`);
  }
  if (rsiV > p.rsiOverboughtSell) {
    const pts = rsiV > 80 ? 35 : rsiV > 72 ? 22 : 12;
    sellScore += pts;
    reasons.push(`RSI overbought (${rsiV.toFixed(0)})`);
  }
  if (momentum < p.momentumSellThresh) { sellScore += 28; reasons.push(`downtrend ${momentum.toFixed(1)}%`); }
  else if (momentum < -0.4 && riskLevel !== 'high') { sellScore += 10; reasons.push('slight downtrend'); }
  if (s20 && s50 && s20 < s50) { sellScore += 10; reasons.push('death cross'); }

  const action = buyScore >= p.buyThresh ? 'buy' : sellScore >= p.sellThresh ? 'sell' : 'hold';
  return { action, buyScore, sellScore, reasons, rsiV, pbN, sq, momentum };
}

// ── SUPABASE CLIENT ───────────────────────────────────────────────────────────
const SB_HDR = {
  'Content-Type':  'application/json',
  'apikey':        CONFIG.supabaseKey,
  'Authorization': 'Bearer ' + CONFIG.supabaseKey,
  'Prefer':        'return=minimal',
};

async function sbUpsert(table, id, data) {
  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${table}`, {
    method:  'POST',
    headers: { ...SB_HDR, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify({ id, data, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`sbUpsert ${table}: ${res.status} ${txt}`);
  }
}

async function sbGet(table, id) {
  const res = await fetch(
    `${CONFIG.supabaseUrl}/rest/v1/${table}?id=eq.${id}&select=data`,
    { headers: SB_HDR }
  );
  if (!res.ok) throw new Error(`sbGet ${table}: ${res.status}`);
  const rows = await res.json();
  return rows.length ? rows[0].data : null;
}

// ── LOAD STATE FROM SUPABASE ──────────────────────────────────────────────────
async function loadState() {
  log('info', 'Loading state from Supabase…');
  try {
    const [trData, portData, setData] = await Promise.all([
      sbGet('trades',    'ledger'),
      sbGet('portfolio', 'positions'),
      sbGet('settings',  'app'),
    ]);
    if (trData?.ledger)       ledger = trData.ledger;
    if (portData?.port)       port   = portData.port;
    if (setData?.realizedPnL) realizedPnL = setData.realizedPnL;
    // Bot always uses CONFIG.riskLevel — ignore stored setting
    log('info', `Loaded: ${ledger.length} trades, ${Object.keys(port).length} open positions`);
    return true;
  } catch (e) {
    log('warn', 'Could not load from Supabase, starting fresh:', e.message);
    return false;
  }
}

// ── SAVE STATE TO SUPABASE ────────────────────────────────────────────────────
async function saveState() {
  try {
    await Promise.all([
      sbUpsert('trades',    'ledger',    { ledger }),
      sbUpsert('portfolio', 'positions', { port }),
      sbUpsert('settings',  'app',       { realizedPnL, riskLevel: CONFIG.riskLevel }),
    ]);
    log('info', `💾 Saved to Supabase (${ledger.length} trades, ${Object.keys(port).length} positions)`);
  } catch (e) {
    log('error', 'Save failed:', e.message);
  }
}

// ── EXECUTE TRADE ─────────────────────────────────────────────────────────────
function executeBuy(ci, sig, amt) {
  const price = live[ci.id];
  const units = amt / price;
  const trade = {
    id:     `bot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    date:   new Date().toLocaleString(),
    coin:   ci.sym,
    name:   ci.name,
    action: 'buy',
    units:  parseFloat(units.toFixed(6)),
    pr:     price,
    amt,
    col:    ci.col,
    auto:   true,
    bot:    true,
    risk:   CONFIG.riskLevel,
    reason: sig.reasons.slice(0, 2).join(', '),
    score:  sig.buyScore,
  };
  ledger.unshift(trade);

  if (!port[ci.id]) port[ci.id] = { units: 0, cost: 0, avg: 0, sym: ci.sym, name: ci.name, col: ci.col };
  port[ci.id].units += units;
  port[ci.id].cost  += amt;
  port[ci.id].avg    = port[ci.id].cost / port[ci.id].units;

  if (!realizedPnL[ci.id]) realizedPnL[ci.id] = { gains: [], sym: ci.sym, col: ci.col, totalBought: 0, totalSold: 0 };
  realizedPnL[ci.id].totalBought += amt;

  log('trade', `BUY  ${ci.sym.padEnd(5)} ${units.toFixed(4)} units @ ${fmt(price)}  |  score ${sig.buyScore}  |  ${sig.reasons.slice(0,2).join(', ')}`);
}

function executeSell(ci, sig, p, reason) {
  const price     = live[ci.id];
  const pos       = port[ci.id];
  const sellUnits = pos.units * p.sellFraction;
  const proceeds  = sellUnits * price;
  const pnl       = (price - pos.avg) * sellUnits;

  const trade = {
    id:     `bot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    date:   new Date().toLocaleString(),
    coin:   ci.sym,
    name:   ci.name,
    action: 'sell',
    units:  parseFloat(sellUnits.toFixed(6)),
    pr:     price,
    amt:    proceeds,
    col:    ci.col,
    auto:   true,
    bot:    true,
    risk:   CONFIG.riskLevel,
    reason,
    score:  sig.sellScore,
    pnl,
  };
  ledger.unshift(trade);

  if (!realizedPnL[ci.id]) realizedPnL[ci.id] = { gains: [], sym: ci.sym, col: ci.col, totalBought: 0, totalSold: 0 };
  realizedPnL[ci.id].gains.push({ date: trade.date, pnl, price });
  realizedPnL[ci.id].totalSold += proceeds;

  const pnlStr = (pnl >= 0 ? '+' : '') + fmt(Math.abs(pnl));
  const emoji  = pnl >= 0 ? '✓' : '✗';
  log('trade', `SELL ${ci.sym.padEnd(5)} ${sellUnits.toFixed(4)} units @ ${fmt(price)}  |  P&L ${pnlStr} ${emoji}  |  ${reason}`);

  if (p.sellFraction >= 1.0) {
    delete port[ci.id];
  } else {
    pos.units -= sellUnits;
    pos.cost   = pos.avg * pos.units;
    if (pos.units < 0.000001) delete port[ci.id];
  }
}

// ── MAIN SCAN LOOP ────────────────────────────────────────────────────────────
async function scan() {
  scanCount++;
  tickPrices();

  const p            = RISK_PROFILES[CONFIG.riskLevel];
  const amt          = CONFIG.tradeSize * p.sizeMultiplier;
  const openPos      = Object.keys(port).length;
  const now          = new Date().toLocaleTimeString('en-US', { hour12: false });
  let   buys         = 0;
  let   sells        = 0;
  let   tradesThisTick = 0;

  if (CONFIG.logLevel === 'verbose') {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  Scan #${scanCount}  |  ${now}  |  Risk: ${CONFIG.riskLevel.toUpperCase()}  |  Positions: ${openPos}/${p.maxPositions}`);
    console.log(`${'─'.repeat(60)}`);
  }

  for (const ci of COINS) {
    const sig = getSignalScore(ci.id, CONFIG.riskLevel);

    if (CONFIG.logLevel === 'verbose') {
      const held = port[ci.id] ? `held ${fmt(port[ci.id].units * live[ci.id])}` : 'no pos';
      console.log(
        `  ${ci.sym.padEnd(5)}` +
        `  $${String(live[ci.id].toFixed(ci.p < 1 ? 4 : 2)).padStart(10)}` +
        `  RSI ${sig.rsiV.toFixed(0).padStart(3)}` +
        `  %B ${sig.pbN.toFixed(2)}` +
        `  mom ${(sig.momentum >= 0 ? '+' : '') + sig.momentum.toFixed(2).padStart(5)}%` +
        `  buy ${String(sig.buyScore).padStart(3)}  sell ${String(sig.sellScore).padStart(3)}` +
        `  → ${sig.action.toUpperCase().padEnd(4)}` +
        `  ${held}`
      );
    }

    // ── BUY ──
    if (sig.action === 'buy' && sig.buyScore >= p.buyThresh && openPos < p.maxPositions && !port[ci.id]) {
      executeBuy(ci, sig, amt);
      buys++;
      tradesThisTick++;
    }
    // ── SELL ──
    else if (port[ci.id] && port[ci.id].units > 0.000001) {
      const price   = live[ci.id];
      const pnlPct  = (price - port[ci.id].avg) / port[ci.id].avg * 100;
      const absPct  = Math.abs(pnlPct);
      const stopHit = pnlPct <= p.stopLossPct;
      const tpHit   = pnlPct >= p.takeProfitPct;
      // HIGH risk: only sell on signals if price has moved ≥ minMovePct (stop/TP always override)
      const minMoveCleared = !p.minMovePct || absPct >= p.minMovePct;
      const sigSell = sig.action === 'sell' && sig.sellScore >= p.sellThresh && minMoveCleared;

      if (stopHit || tpHit || sigSell) {
        const reason = stopHit
          ? `stop-loss ${pnlPct.toFixed(1)}%`
          : tpHit
          ? `take-profit +${pnlPct.toFixed(1)}%`
          : sig.reasons.slice(0, 2).join(', ');
        executeSell(ci, sig, p, reason);
        sells++;
        tradesThisTick++;
      }
    }
  }

  // ── PORTFOLIO SUMMARY ──
  if (CONFIG.logLevel === 'verbose') {
    const holdings = Object.entries(port);
    if (holdings.length) {
      console.log(`\n  Portfolio:`);
      let totalValue = 0, totalCost = 0;
      holdings.forEach(([id, pos]) => {
        const val  = pos.units * live[id];
        const pnl  = val - pos.cost;
        const pct  = (pnl / pos.cost * 100).toFixed(1);
        totalValue += val;
        totalCost  += pos.cost;
        console.log(
          `    ${pos.sym.padEnd(5)}  ${fmt(val).padStart(10)}` +
          `  cost ${fmt(pos.cost).padStart(10)}` +
          `  P&L ${(pnl >= 0 ? '+' : '') + fmt(Math.abs(pnl)).padStart(8)} (${pnl >= 0 ? '+' : ''}${pct}%)`
        );
      });
      const totalPnL = totalValue - totalCost;
      console.log(`    ${'─'.repeat(50)}`);
      console.log(
        `    Total  ${fmt(totalValue).padStart(10)}` +
        `  cost ${fmt(totalCost).padStart(10)}` +
        `  P&L ${(totalPnL >= 0 ? '+' : '') + fmt(Math.abs(totalPnL)).padStart(8)}`
      );
    }
    const closed = ledger.filter(t => t.pnl != null);
    const totalRealized = closed.reduce((s, t) => s + t.pnl, 0);
    const wins = closed.filter(t => t.pnl > 0).length;
    const winRate = closed.length ? Math.round(wins / closed.length * 100) : 0;
    console.log(`\n  Realized P&L: ${(totalRealized >= 0 ? '+' : '') + fmt(Math.abs(totalRealized))}  |  Trades: ${ledger.length}  |  Win rate: ${winRate}%`);
    if (tradesThisTick) console.log(`  Executed: ${buys} buy${buys !== 1 ? 's' : ''}, ${sells} sell${sells !== 1 ? 's' : ''} this scan`);
  }

  // Save to Supabase after any trades
  if (tradesThisTick > 0) {
    await saveState();
  }
}

// ── STARTUP ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║        Crypto Trading with Frog — Autonomous Bot        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`  Risk Level  : ${CONFIG.riskLevel.toUpperCase()}`);
  console.log(`  Trade Size  : $${CONFIG.tradeSize} (×${RISK_PROFILES[CONFIG.riskLevel].sizeMultiplier} = $${CONFIG.tradeSize * RISK_PROFILES[CONFIG.riskLevel].sizeMultiplier})`);
  console.log(`  Scan Every  : ${CONFIG.scanInterval / 1000}s`);
  console.log(`  Max Positions: ${RISK_PROFILES[CONFIG.riskLevel].maxPositions}`);
  console.log(`  Stop-Loss   : ${RISK_PROFILES[CONFIG.riskLevel].stopLossPct}%`);
  console.log(`  Take-Profit : +${RISK_PROFILES[CONFIG.riskLevel].takeProfitPct}%`);
  console.log(`  Supabase    : ${CONFIG.supabaseUrl}\n`);

  // Seed price history with warm-up ticks before first scan
  console.log('  Warming up price history (25 ticks)…');
  for (let i = 0; i < 25; i++) tickPrices();

  // Load existing state from Supabase
  await loadState();

  console.log(`\n  Starting scan loop — Ctrl+C to stop\n`);

  // Run first scan immediately then on interval
  await scan();
  setInterval(scan, CONFIG.scanInterval);
}

// Handle graceful shutdown — save state before exiting
async function shutdown() {
  console.log('\n\n  Shutting down — saving final state…');
  await saveState();
  console.log('  Done. Goodbye.\n');
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
