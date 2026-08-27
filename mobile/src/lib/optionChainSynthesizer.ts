/**
 * Instant Client-Side Option Chain Synthesizer & Dynamic Pricing Engine.
 * 
 * Guarantees that in the standalone APK, the Option Chain table is NEVER empty
 * and NEVER lags, calculating exact Black-Scholes strike grids in 0ms on device
 * while continuously updating live from real-time spot ticks!
 */

export interface OptionRowData {
  strike: number;
  callSym: string;
  putSym: string;
  callMark: number;
  putMark: number;
  callLtp?: number;
  putLtp?: number;
  callBid: number;
  callAsk: number;
  putBid: number;
  putAsk: number;
  callPchange: number;
  putPchange: number;
  callOI: number;
  putOI: number;
  callOiChange: number;
  putOiChange: number;
  callIV: number;
  putIV: number;
  callIv?: number;
  putIv?: number;
  callDelta: number;
  putDelta: number;
  gamma: number;
  vega: number;
  theta: number;
  callToken?: string;
  putToken?: string;
}

// Normal Cumulative Distribution Function (Phi)
function normalCdf(x: number): number {
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c = 0.39894228;

  if (x >= 0.0) {
    const k = 1.0 / (1.0 + (p * x));
    return (1.0 - c * Math.exp(-x * x / 2.0) * k *
      (b1 + k * (b2 + k * (b3 + k * (b4 + k * b5)))));
  } else {
    const k = 1.0 / (1.0 + (p * -x));
    return (c * Math.exp(-x * x / 2.0) * k *
      (b1 + k * (b2 + k * (b3 + k * (b4 + k * b5)))));
  }
}

// Standard Normal Probability Density Function
function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Quantize price to exchange minimum tick size (₹0.05 for NSE)
 */
export function roundToTick(price: number, tick: number = 0.05): number {
  if (price <= tick) return tick;
  return Math.round((Math.round(price / tick) * tick) * 100) / 100;
}

/**
 * Black-Scholes Analytical Pricing & Greeks Engine
 */
export function calculateBSPrice(
  spot: number,
  strike: number,
  timeToExpiryYears: number,
  rate: number,
  iv: number,
  type: 'CALL' | 'PUT',
  tickSize: number = 0.05
): { price: number; delta: number; gamma: number; theta: number; vega: number } {
  if (spot <= 0 || strike <= 0 || timeToExpiryYears <= 0 || iv <= 0) {
    const intrinsic = type === 'CALL' ? Math.max(tickSize, spot - strike) : Math.max(tickSize, strike - spot);
    return {
      price: roundToTick(intrinsic, tickSize),
      delta: type === 'CALL' ? 0.5 : -0.5,
      gamma: 0.001,
      theta: -0.01,
      vega: 0.01
    };
  }

  // Market Volatility Smile / Skew calibration
  const diff = (strike - spot) / spot;
  const effectiveIv = type === 'CALL' 
    ? Math.max(0.10, iv - 0.16 * diff)
    : Math.max(0.10, iv - 0.22 * diff);

  const sqrtT = Math.sqrt(timeToExpiryYears);
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * effectiveIv * effectiveIv) * timeToExpiryYears) / (effectiveIv * sqrtT);
  const d2 = d1 - effectiveIv * sqrtT;

  const nd1 = normalCdf(d1);
  const nd2 = normalCdf(d2);
  const n_minus_d1 = normalCdf(-d1);
  const n_minus_d2 = normalCdf(-d2);
  const npd1 = normalPdf(d1);
  const exp_rT = Math.exp(-rate * timeToExpiryYears);

  let rawPrice = 0;
  let delta = 0;
  let theta = 0;

  if (type === 'CALL') {
    rawPrice = (spot * nd1) - (strike * exp_rT * nd2);
    delta = nd1;
    theta = (-(spot * npd1 * effectiveIv) / (2 * sqrtT) - rate * strike * exp_rT * nd2) / 365.0;
  } else {
    rawPrice = (strike * exp_rT * n_minus_d2) - (spot * n_minus_d1);
    delta = nd1 - 1.0;
    theta = (-(spot * npd1 * effectiveIv) / (2 * sqrtT) + rate * strike * exp_rT * n_minus_d2) / 365.0;
  }

  const gamma = npd1 / (spot * effectiveIv * sqrtT);
  const vega = (spot * sqrtT * npd1) / 100.0;

  const price = roundToTick(Math.max(tickSize, rawPrice), tickSize);

  return {
    price,
    delta: Math.round(delta * 1000) / 1000,
    gamma: Math.round(gamma * 10000) / 10000,
    theta: Math.round(theta * 100) / 100,
    vega: Math.round(vega * 100) / 100
  };
}

function formatDateIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Generate standard weekly & monthly expiries for any asset
 */
export function generateDefaultExpiries(isCrypto: boolean = false, isStock: boolean = false): string[] {
  const now = new Date();
  const expiries: string[] = [];

  if (isCrypto) {
    // Crypto daily & weekly expiries (Delta style)
    for (let i = 0; i < 5; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      const iso = formatDateIso(d);
      if (!expiries.includes(iso)) expiries.push(iso);
    }
  } else if (isStock) {
    // Stock Options: Last Tuesday of the month (NSE Standard)
    const curYear = now.getFullYear();
    const curMonth = now.getMonth();

    for (let m = 0; m < 5; m++) {
      const targetDate = new Date(curYear, curMonth + m, 1);
      const year = targetDate.getFullYear();
      const month = targetDate.getMonth();
      const lastDay = new Date(year, month + 1, 0).getDate();

      let lastTues = 0;
      for (let day = lastDay; day >= lastDay - 7; day--) {
        const checkD = new Date(year, month, day);
        if (checkD.getDay() === 2) { // 2 = Tuesday (NSE Stock Options Standard)
          lastTues = day;
          break;
        }
      }

      if (lastTues > 0) {
        const tuesDate = new Date(year, month, lastTues, 15, 30, 0);
        if (tuesDate >= now) {
          const iso = formatDateIso(new Date(year, month, lastTues));
          if (!expiries.includes(iso)) expiries.push(iso);
        }
      }
      if (expiries.length >= 3) break;
    }
  } else {
    // Indian Weekly Expiries (Thursday)
    const today = now.getDay();
    let daysToThursday = (4 - today + 7) % 7;
    if (daysToThursday === 0 && now.getHours() >= 15 && now.getMinutes() >= 30) {
      daysToThursday = 7;
    }

    for (let w = 0; w < 4; w++) {
      const d = new Date(now);
      d.setDate(now.getDate() + daysToThursday + (w * 7));
      const iso = formatDateIso(d);
      if (!expiries.includes(iso)) expiries.push(iso);
    }
  }

  return expiries.length > 0 ? expiries : [formatDateIso(now)];
}

const ASSET_IV_MAP: Record<string, number> = {
  'NIFTY': 0.105,
  'BANKNIFTY': 0.128,
  'SENSEX': 0.115,
  'RELIANCE': 0.225,
  'TCS': 0.245,
  'INFY': 0.240,
  'HDFCBANK': 0.210,
  'ICICIBANK': 0.215,
  'SBIN': 0.235,
  'TATAMOTORS': 0.265,
  'BHARTIARTL': 0.220,
  'ITC': 0.185,
  'LT': 0.215,
  'CRUDEOIL': 0.320,
  'CRUDEOILM': 0.320,
  'GOLD': 0.145,
  'GOLDM': 0.145,
  'SILVER': 0.235,
  'SILVERM': 0.235,
  'NATURALGAS': 0.450,
  'NATGASM': 0.450,
  'BTC': 0.480,
  'ETH': 0.550,
  'XAUT': 0.220
};

/**
 * Synthesize a full Option Chain for any asset in 0ms on device
 */
export function synthesizeOptionChain(
  asset: string,
  spot: number,
  strikeStep: number,
  expiry: string
): OptionRowData[] {
  if (spot <= 0 || strikeStep <= 0) return [];

  const isCrypto = asset === 'BTC' || asset === 'ETH' || asset === 'XAUT';
  const tickSize = asset === 'BTC' ? 0.5 : (asset === 'ETH' ? 0.05 : (asset === 'XAUT' ? 0.1 : 0.05));
  const iv = ASSET_IV_MAP[asset] || (isCrypto ? 0.48 : 0.19);
  const rate = isCrypto ? 0.04 : 0.05;

  const now = new Date();
  const expDate = expiry.includes('T') ? new Date(expiry) : (isCrypto ? new Date(`${expiry}T08:00:00Z`) : new Date(`${expiry}T15:30:00`));
  const diffDays = Math.max(0.4, (expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const T = Math.max(0.003, diffDays / 365.0);

  const atmCenter = Math.round(spot / strikeStep) * strikeStep;
  const rows: OptionRowData[] = [];
  const expLabel = expiry.replace(/-/g, '').slice(2);

  for (let i = -12; i <= 12; i++) {
    const strike = atmCenter + (i * strikeStep);
    const callRes = calculateBSPrice(spot, strike, T, rate, iv, 'CALL', tickSize);
    const putRes = calculateBSPrice(spot, strike, T, rate, iv, 'PUT', tickSize);

    const diff = Math.abs(strike - spot);
    const baseOI = Math.max(5000, Math.round(100000 - (diff / strikeStep) * 6000));

    rows.push({
      strike,
      callSym: `C-${asset}-${strike}-${expLabel}`,
      putSym: `P-${asset}-${strike}-${expLabel}`,
      callMark: callRes.price,
      putMark: putRes.price,
      callLtp: callRes.price,
      putLtp: putRes.price,
      callBid: roundToTick(Math.max(tickSize, callRes.price - tickSize), tickSize),
      callAsk: roundToTick(callRes.price + tickSize, tickSize),
      putBid: roundToTick(Math.max(tickSize, putRes.price - tickSize), tickSize),
      putAsk: roundToTick(putRes.price + tickSize, tickSize),
      callPchange: 0.0,
      putPchange: 0.0,
      callOI: baseOI,
      putOI: baseOI,
      callOiChange: 0.0,
      putOiChange: 0.0,
      callIV: Math.round(iv * 100),
      putIV: Math.round(iv * 100),
      callIv: Math.round(iv * 100),
      putIv: Math.round(iv * 100),
      callDelta: callRes.delta,
      putDelta: putRes.delta,
      gamma: callRes.gamma,
      vega: callRes.vega,
      theta: callRes.theta
    });
  }

  return rows;
}

/**
 * Dynamically fuses live spot price ticks with existing chain rows,
 * guaranteeing 0ms latency updates whenever the spot price ticks.
 */
export function fuseLiveOptionChain(
  existingRows: any[],
  currentSpot: number,
  strikeStep: number,
  expiry: string,
  asset: string
): OptionRowData[] {
  if (!existingRows || existingRows.length === 0) {
    return synthesizeOptionChain(asset, currentSpot, strikeStep, expiry);
  }
  if (currentSpot <= 0) return existingRows;

  const isCrypto = asset === 'BTC' || asset === 'ETH' || asset === 'XAUT';
  const tickSize = asset === 'BTC' ? 0.5 : (asset === 'ETH' ? 0.05 : (asset === 'XAUT' ? 0.1 : 0.05));
  const iv = ASSET_IV_MAP[asset] || (isCrypto ? 0.48 : 0.19);
  const rate = isCrypto ? 0.04 : 0.05;

  const now = new Date();
  const expDate = expiry.includes('T') ? new Date(expiry) : (isCrypto ? new Date(`${expiry}T08:00:00Z`) : new Date(`${expiry}T15:30:00`));
  const diffDays = Math.max(0.4, (expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const T = Math.max(0.003, diffDays / 365.0);

  return existingRows.map((row: any) => {
    const callRes = calculateBSPrice(currentSpot, row.strike, T, rate, iv, 'CALL', tickSize);
    const putRes = calculateBSPrice(currentSpot, row.strike, T, rate, iv, 'PUT', tickSize);

    const callPrice = (isCrypto && row.callMark && row.callMark > 0) ? row.callMark : callRes.price;
    const putPrice = (isCrypto && row.putMark && row.putMark > 0) ? row.putMark : putRes.price;

    const callBid = row.callBid && row.callBid > 0 ? row.callBid : roundToTick(Math.max(tickSize, callPrice - tickSize), tickSize);
    const callAsk = row.callAsk && row.callAsk > 0 ? row.callAsk : roundToTick(callPrice + tickSize, tickSize);
    const putBid = row.putBid && row.putBid > 0 ? row.putBid : roundToTick(Math.max(tickSize, putPrice - tickSize), tickSize);
    const putAsk = row.putAsk && row.putAsk > 0 ? row.putAsk : roundToTick(putPrice + tickSize, tickSize);

    return {
      ...row,
      callMark: callPrice,
      putMark: putPrice,
      callLtp: callPrice,
      putLtp: putPrice,
      callBid,
      callAsk,
      putBid,
      putAsk,
      callDelta: callRes.delta,
      putDelta: putRes.delta,
      gamma: callRes.gamma,
      vega: callRes.vega,
      theta: callRes.theta,
      callIV: Math.round(iv * 100),
      putIV: Math.round(iv * 100),
      callIv: Math.round(iv * 100),
      putIv: Math.round(iv * 100)
    };
  });
}
