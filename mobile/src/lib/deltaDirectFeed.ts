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
  'https://api.delta.exchange',
  'https://cdn.india.delta.exchange',
  'https://cdn.delta.exchange'
];

const DELTA_WS_URLS = [
  'wss://socket.india.delta.exchange',
  'wss://socket.delta.exchange'
];

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
      const t = Date.now();
      const resp = await fetch(`${baseUrl}/v2/tickers?_t=${t}`, {
        headers: { 
          'Accept': 'application/json',
          'Cache-Control': 'no-cache, no-store'
        },
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
export async function fetchDirectDeltaOptionChain(asset: 'BTC' | 'ETH' | 'XAUT'): Promise<{
  expiries: string[];
  chainByExpiry: Record<string, any[]>;
}> {
  const assetKey = asset === 'XAUT' ? 'XAUT' : (asset === 'ETH' ? 'ETH' : 'BTC');
  const tickSize = asset === 'BTC' ? 0.5 : (asset === 'ETH' ? 0.05 : 0.1);

  for (const baseUrl of DELTA_REST_URLS) {
    try {
      const t = Date.now();
      const resp = await fetch(`${baseUrl}/v2/tickers?_t=${t}`, {
        headers: { 
          'Accept': 'application/json',
          'Cache-Control': 'no-cache, no-store' 
        },
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      const tickers = json.result || [];

      const expiriesSet = new Set<string>();
      const rawRowsByExpiry: Record<string, Record<number, any>> = {};

      for (const t of tickers) {
        const sym = t.symbol || '';
        if (!sym.startsWith(`C-${assetKey}-`) && !sym.startsWith(`P-${assetKey}-`)) continue;

        const parts = sym.split('-');
        if (parts.length < 4) continue;

        const isCall = parts[0] === 'C';
        const strike = parseFloat(parts[2]);
        const rawExp = parts[3];
        if (isNaN(strike) || !rawExp || rawExp.length !== 6) continue;

        // Parse DDMMYY -> YYYY-MM-DD
        const day = rawExp.slice(0, 2);
        const month = rawExp.slice(2, 4);
        const year = '20' + rawExp.slice(4, 6);
        const expiry = `${year}-${month}-${day}`;

        expiriesSet.add(expiry);
        if (!rawRowsByExpiry[expiry]) rawRowsByExpiry[expiry] = {};
        if (!rawRowsByExpiry[expiry][strike]) {
          rawRowsByExpiry[expiry][strike] = {
            strike,
            callMark: 0,
            putMark: 0,
            callBid: 0,
            callAsk: 0,
            putBid: 0,
            putAsk: 0,
            callOI: 0,
            putOI: 0,
            callSym: '',
            putSym: ''
          };
        }

        const mark = parseFloat(t.mark_price || t.close || 0);
        const bestBid = parseFloat(t.best_bid || 0);
        const bestAsk = parseFloat(t.best_ask || 0);
        const oi = parseFloat(t.open_interest || 0);

        if (isCall) {
          rawRowsByExpiry[expiry][strike].callMark = mark;
          rawRowsByExpiry[expiry][strike].callBid = bestBid > 0 ? bestBid : (mark > 0 ? Math.max(tickSize, mark - tickSize) : 0);
          rawRowsByExpiry[expiry][strike].callAsk = bestAsk > 0 ? bestAsk : (mark > 0 ? mark + tickSize : 0);
          rawRowsByExpiry[expiry][strike].callOI = oi;
          rawRowsByExpiry[expiry][strike].callSym = sym;
        } else {
          rawRowsByExpiry[expiry][strike].putMark = mark;
          rawRowsByExpiry[expiry][strike].putBid = bestBid > 0 ? bestBid : (mark > 0 ? Math.max(tickSize, mark - tickSize) : 0);
          rawRowsByExpiry[expiry][strike].putAsk = bestAsk > 0 ? bestAsk : (mark > 0 ? mark + tickSize : 0);
          rawRowsByExpiry[expiry][strike].putOI = oi;
          rawRowsByExpiry[expiry][strike].putSym = sym;
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

/**
 * Direct High-Speed Native WebSocket Streamer for Delta Exchange
 */
export function subscribeDirectDeltaWS(
  onTick: (spots: Record<string, DeltaSpotData>) => void
): () => void {
  let ws: WebSocket | null = null;
  let timer: any = null;
  let heartbeat: any = null;
  let isClosed = false;
  let wsIndex = 0;

  const connect = () => {
    if (isClosed) return;
    try {
      const activeWsUrl = DELTA_WS_URLS[wsIndex % DELTA_WS_URLS.length];
      wsIndex++;
      ws = new WebSocket(activeWsUrl);

      ws.onopen = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const subMsg = {
          type: 'subscribe',
          payload: {
            channels: [
              { name: 'v2/ticker', symbols: ['BTCUSD', 'ETHUSD', 'XAUTUSD'] }
            ]
          }
        };
        ws.send(JSON.stringify(subMsg));
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data && data.type === 'v2/ticker') {
            const sym = data.symbol;
            const mark = parseFloat(data.mark_price || data.close || 0);
            const pct = parseFloat(data.price_change_percent || 0);
            const chg = parseFloat(data.price_change || 0);

            if (mark > 0) {
              const assetKey = sym.includes('BTC') ? 'BTC' : (sym.includes('ETH') ? 'ETH' : (sym.includes('XAUT') ? 'XAUT' : ''));
              if (assetKey) {
                onTick({
                  [assetKey]: { spot: mark, change: chg, pctChange: pct }
                });
              }
            }
          }
        } catch {
          /* noop */
        }
      };

      ws.onerror = () => {
        try { ws?.close(); } catch {}
      };

      ws.onclose = () => {
        if (!isClosed) {
          timer = setTimeout(connect, 2000);
        }
      };
    } catch {
      if (!isClosed) timer = setTimeout(connect, 3000);
    }
  };

  connect();

  heartbeat = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* noop */
      }
    }
  }, 25000);

  return () => {
    isClosed = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    if (ws) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
  };
}
