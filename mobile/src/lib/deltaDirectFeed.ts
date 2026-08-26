/**
 * Direct Delta Exchange Public Market Data Client
 * 
 * Provides direct, zero-dependency public market data streaming directly from Delta Exchange.
 * Requires NO API keys or secrets (100% public REST / WebSocket).
 * Ensures crypto spots (BTC, ETH, XAUT) and option chains ALWAYS stream in the standalone APK,
 * even if the primary cloud backend is asleep or restarting.
 */

const DELTA_REST_URLS = [
  'https://api.india.delta.exchange',
  'https://api.delta.exchange'
];

const DELTA_WS_URL = 'wss://socket.india.delta.exchange';

export interface DeltaSpotData {
  spot: number;
  change: number;
  pctChange: number;
}

/**
 * Fetch live 24h ticker info directly from Delta Exchange public API.
 */
export async function fetchDirectDeltaTickers(): Promise<Record<string, DeltaSpotData>> {
  for (const baseUrl of DELTA_REST_URLS) {
    try {
      const resp = await fetch(`${baseUrl}/v2/tickers`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      const result = json.result || [];

      const spots: Record<string, DeltaSpotData> = {};

      for (const item of result) {
        const sym = item.symbol;
        if (sym === 'BTCUSD' || sym === 'BTCUSDT') {
          const spot = parseFloat(item.mark_price || item.close || item.spot_price || 0);
          const chg = parseFloat(item.price_change || 0);
          const pct = parseFloat(item.price_change_percent || 0);
          if (spot > 0) spots['BTC'] = { spot, change: chg, pctChange: pct };
        } else if (sym === 'ETHUSD' || sym === 'ETHUSDT') {
          const spot = parseFloat(item.mark_price || item.close || item.spot_price || 0);
          const chg = parseFloat(item.price_change || 0);
          const pct = parseFloat(item.price_change_percent || 0);
          if (spot > 0) spots['ETH'] = { spot, change: chg, pctChange: pct };
        } else if (sym === 'XAUTUSD' || sym === 'XAUTUSDT') {
          const spot = parseFloat(item.mark_price || item.close || item.spot_price || 0);
          const chg = parseFloat(item.price_change || 0);
          const pct = parseFloat(item.price_change_percent || 0);
          if (spot > 0) spots['XAUT'] = { spot, change: chg, pctChange: pct };
        }
      }

      if (Object.keys(spots).length > 0) {
        return spots;
      }
    } catch {
      // Try next mirror
    }
  }
  return {};
}

/**
 * Fetch live Option Chain for BTC/ETH directly from Delta Exchange public API.
 */
export async function fetchDirectDeltaOptionChain(asset: 'BTC' | 'ETH'): Promise<{
  expiries: string[];
  chainByExpiry: Record<string, any[]>;
}> {
  for (const baseUrl of DELTA_REST_URLS) {
    try {
      const resp = await fetch(`${baseUrl}/v2/products`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      const products = json.result || [];

      const expiriesSet = new Set<string>();
      const rawRowsByExpiry: Record<string, Record<number, any>> = {};

      for (const p of products) {
        if (!p.contract_type || (p.contract_type !== 'call_options' && p.contract_type !== 'put_options')) continue;
        const und = p.underlying_asset?.symbol;
        if (und !== asset) continue;

        const strike = parseFloat(p.strike_price);
        const expiry = p.settlement_time ? p.settlement_time.split('T')[0] : '';
        if (!expiry || isNaN(strike)) continue;

        expiriesSet.add(expiry);
        if (!rawRowsByExpiry[expiry]) rawRowsByExpiry[expiry] = {};
        if (!rawRowsByExpiry[expiry][strike]) {
          rawRowsByExpiry[expiry][strike] = {
            strike,
            callMark: 0,
            putMark: 0,
            callOI: 0,
            putOI: 0,
            callSym: '',
            putSym: ''
          };
        }

        const isCall = p.contract_type === 'call_options';
        const mark = parseFloat(p.mark_price || p.quotes?.mark_price || 0);
        const oi = parseFloat(p.open_interest || 0);

        if (isCall) {
          rawRowsByExpiry[expiry][strike].callMark = mark;
          rawRowsByExpiry[expiry][strike].callOI = oi;
          rawRowsByExpiry[expiry][strike].callSym = p.symbol;
        } else {
          rawRowsByExpiry[expiry][strike].putMark = mark;
          rawRowsByExpiry[expiry][strike].putOI = oi;
          rawRowsByExpiry[expiry][strike].putSym = p.symbol;
        }
      }

      const sortedExpiries = Array.from(expiriesSet).sort();
      const chainByExpiry: Record<string, any[]> = {};

      for (const exp of sortedExpiries) {
        const strikesMap = rawRowsByExpiry[exp] || {};
        const sortedStrikes = Object.keys(strikesMap).map(Number).sort((a, b) => a - b);
        chainByExpiry[exp] = sortedStrikes.map(s => strikesMap[s]);
      }

      if (sortedExpiries.length > 0) {
        return { expiries: sortedExpiries, chainByExpiry };
      }
    } catch {
      // Try next mirror
    }
  }
  return { expiries: [], chainByExpiry: {} };
}
