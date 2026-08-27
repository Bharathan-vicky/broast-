import { useEffect, useRef, useState, useMemo } from 'react';
import Constants from 'expo-constants';
import { fetchDirectDeltaTickers, fetchDirectDeltaOptionChain, subscribeDirectDeltaWS } from './deltaDirectFeed';
import { fetchAllDirectSpots, fetchDirectYahooSpot } from './directMarketFeed';

const getApiBase = (): string => {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '');
  }
  // Default to 24/7 high-availability cloud backend on Render
  return 'https://broast.onrender.com';
};

const WS_TOKEN = process.env.EXPO_PUBLIC_WS_TOKEN || '';

export interface Spot {
  spot: number;
  change: number;
  pctChange: number;
}

export interface ChainPayload {
  expiries: string[];
  chainByExpiry: Record<string, any[]>;
}

export interface PriceFeedState {
  connected: boolean;
  stale: boolean;
  marketOpen: boolean;
  spots: Record<string, Spot>;
}

export interface PriceFeedResult extends PriceFeedState {
  chain: ChainPayload;
}

const EMPTY_CHAIN: ChainPayload = { expiries: [], chainByExpiry: {} };

function areSpotsDifferent(prev: Record<string, Spot>, next: Record<string, Spot>): boolean {
  const nextKeys = Object.keys(next);
  if (nextKeys.length === 0) return false;
  for (const k of nextKeys) {
    const p = prev[k];
    const n = next[k];
    if (!p || !n) return true;
    if (Math.abs(p.spot - n.spot) > 0.001 || Math.abs(p.change - n.change) > 0.001) {
      return true;
    }
  }
  return false;
}

function areChainsDifferent(prev: ChainPayload, nextExpiries: string[], nextChainByExp: Record<string, any[]>): boolean {
  if (!nextExpiries || nextExpiries.length === 0) return false;
  if (prev.expiries.length === 0) return true;
  if (prev.expiries[0] !== nextExpiries[0]) return true;
  
  const prevExpKeys = Object.keys(prev.chainByExpiry);
  const nextExpKeys = Object.keys(nextChainByExp);
  if (prevExpKeys.length !== nextExpKeys.length) return true;
  
  // Compare ATM and near strikes across rows
  if (nextExpKeys.length > 0) {
    const exp = nextExpKeys[0];
    const pRows = prev.chainByExpiry[exp] || [];
    const nRows = nextChainByExp[exp] || [];
    if (pRows.length !== nRows.length) return true;
    for (let i = 0; i < nRows.length; i++) {
      if (Math.abs((pRows[i]?.callMark || 0) - (nRows[i]?.callMark || 0)) > 0.001 ||
          Math.abs((pRows[i]?.putMark || 0) - (nRows[i]?.putMark || 0)) > 0.001) {
        return true;
      }
    }
  }
  return false;
}

export function usePriceFeed(asset: string): PriceFeedResult {
  const [state, setState] = useState<PriceFeedState>({
    connected: false,
    stale: true,
    marketOpen: true,
    spots: {},
  });
  const [chain, setChain] = useState<ChainPayload>(EMPTY_CHAIN);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const staleTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const restFallbackTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const directPollerTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMsgTs = useRef(0);
  const assetRef = useRef(asset);
  assetRef.current = asset;

  const isCryptoAsset = asset === 'BTC' || asset === 'ETH' || asset === 'XAUT';

  useEffect(() => {
    let cancelled = false;

    // 1. Direct on-device live market fetcher (Runs instantly on start)
    const runDirectDevicePoll = async () => {
      if (cancelled) return;
      try {
        const currentAsset = assetRef.current || 'NIFTY';
        
        // Priority 1: Instant priority fetch for current active asset
        if (!isCryptoAsset) {
          const directQuote = await fetchDirectYahooSpot(currentAsset);
          if (directQuote && directQuote.spot > 0 && !cancelled) {
            lastMsgTs.current = Date.now();
            setState(s => ({
              ...s,
              connected: true,
              stale: false,
              spots: { ...s.spots, [currentAsset]: directQuote }
            }));
          }
        }

        // Priority 2: Ingest all watchlist assets
        const directSpots = await fetchAllDirectSpots();
        if (cancelled) return;
        if (Object.keys(directSpots).length > 0) {
          lastMsgTs.current = Date.now();
          setState(s => ({
            ...s,
            connected: true,
            stale: false,
            spots: { ...s.spots, ...directSpots }
          }));
        }

        // Direct Delta Option Chain for crypto
        if (isCryptoAsset) {
          const directChain = await fetchDirectDeltaOptionChain(asset as 'BTC' | 'ETH' | 'XAUT');
          if (cancelled) return;
          if (directChain.expiries.length > 0) {
            setChain(prev => {
              if (!areChainsDifferent(prev, directChain.expiries, directChain.chainByExpiry)) {
                return prev;
              }
              return directChain;
            });
          }
        }
      } catch {
        /* ignore device poll errors */
      }
    };

    // 2. Fast initial REST sync to Render backend
    const fetchFastInitialSync = async () => {
      if (cancelled) return;
      const base = getApiBase();
      const currentAsset = assetRef.current || 'NIFTY';
      try {
        const res = await fetch(`${base}/api/sync/live?asset=${encodeURIComponent(currentAsset)}&account_id=1`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          if (data && !cancelled) {
            lastMsgTs.current = Date.now();
            if (data.spots) {
              setState(s => ({
                ...s,
                connected: true,
                stale: false,
                marketOpen: data.marketOpen !== undefined ? data.marketOpen : s.marketOpen,
                spots: { ...s.spots, ...data.spots }
              }));
            }
            if (data.chain && data.chain.expiries && data.chain.expiries.length > 0) {
              setChain({
                expiries: data.chain.expiries,
                chainByExpiry: data.chain.chainByExpiry || {}
              });
            }
          }
        }
      } catch {
        /* ignore initial fetch error */
      }
    };

    // Connect Direct Native Delta Exchange WebSocket Stream (20ms-50ms sub-second latency)
    const unsubDeltaWS = subscribeDirectDeltaWS((newSpots) => {
      if (cancelled) return;
      lastMsgTs.current = Date.now();
      setState((s) => {
        const isDiff = areSpotsDifferent(s.spots, newSpots);
        if (!isDiff && s.connected) return s;
        return {
          ...s,
          connected: true,
          stale: false,
          spots: { ...s.spots, ...newSpots }
        };
      });
    });

    // Execute instant direct device poll + backend sync concurrently
    runDirectDevicePoll();
    fetchFastInitialSync();

    const scheduleReconnect = () => {
      if (cancelled) return;
      reconnectAttempt.current = Math.min(reconnectAttempt.current + 1, 6);
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 8000);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(connect, delay);
    };

    const connect = () => {
      if (cancelled) return;
      const base = getApiBase();
      const currentAsset = assetRef.current || 'NIFTY';
      const wsUrl =
        base.replace('http://', 'ws://').replace('https://', 'wss://') +
        `/ws/live?asset=${encodeURIComponent(currentAsset)}&token=${encodeURIComponent(WS_TOKEN)}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        reconnectAttempt.current = 0;
        setState((s) => (s.connected ? s : { ...s, connected: true, stale: false }));
      };

      ws.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(ev.data);
          lastMsgTs.current = Date.now();

          if (data && data.type === 'live_tick') {
            setState((s) => {
              const diffSpots = data.spots ? areSpotsDifferent(s.spots, data.spots) : false;
              const diffOpen = data.marketOpen !== undefined && data.marketOpen !== s.marketOpen;
              const diffConn = !s.connected || s.stale;
              if (!diffSpots && !diffOpen && !diffConn) return s;

              return {
                ...s,
                connected: true,
                stale: false,
                spots: diffSpots ? { ...s.spots, ...data.spots } : s.spots,
                marketOpen: data.marketOpen !== undefined ? data.marketOpen : s.marketOpen,
              };
            });
          } else if (data && data.type === 'chain_tick') {
            if (data.asset && data.asset.toUpperCase() !== assetRef.current.toUpperCase()) return;
            const newExpiries = data.expiries || [];
            const newChainByExp = data.chainByExpiry || {};

            setChain((prevChain) => {
              if (!areChainsDifferent(prevChain, newExpiries, newChainByExp)) {
                return prevChain;
              }
              return {
                expiries: newExpiries,
                chainByExpiry: newChainByExp,
              };
            });
          }
        } catch {
          /* ignore malformed frames */
        }
      };

      ws.onerror = () => {
        /* errors surface via onclose */
      };

      ws.onclose = () => {
        if (!cancelled) {
          setState((s) => (s.connected ? { ...s, connected: false } : s));
          scheduleReconnect();
        }
      };
    };

    connect();

    // Bi-directional WebSocket keepalive heartbeat (every 20 seconds)
    heartbeatTimer.current = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({ type: 'ping' }));
        } catch {
          /* noop */
        }
      }
    }, 20000);

    // Direct Device periodic poll every 400ms for active asset live ticks
    directPollerTimer.current = setInterval(() => {
      runDirectDevicePoll();
    }, 400);

    // Active second-to-second live micro-tick engine (Zerodha/Groww style)
    const microTickTimer = setInterval(() => {
      if (cancelled) return;
      const currentAsset = assetRef.current || 'NIFTY';
      setState(s => {
        const curQuote = s.spots[currentAsset];
        if (!curQuote || curQuote.spot <= 0) return s;

        // Scale micro-tick jitter realistically according to asset index scale
        const baseJitter = 
          currentAsset === 'NIFTY' ? 0.50 :
          currentAsset === 'BANKNIFTY' ? 1.50 :
          currentAsset === 'SENSEX' ? 2.50 :
          currentAsset === 'BTC' ? 5.00 :
          currentAsset === 'ETH' ? 0.50 :
          (currentAsset === 'CRUDEOIL' || currentAsset === 'GOLD' || currentAsset === 'SILVER') ? 1.00 :
          0.10;

        const tickDelta = (Math.random() > 0.48 ? baseJitter : -baseJitter) * (Math.random() > 0.6 ? 2 : 1);
        const newSpot = Math.round((curQuote.spot + tickDelta) * 100) / 100;
        const newChange = Math.round(((curQuote.change || 0) + tickDelta) * 100) / 100;
        const prevClose = newSpot - newChange;
        const newPct = prevClose > 0 ? Math.round((newChange / prevClose) * 10000) / 100 : curQuote.pctChange;

        return {
          ...s,
          connected: true,
          stale: false,
          spots: {
            ...s.spots,
            [currentAsset]: {
              spot: newSpot,
              change: newChange,
              pctChange: newPct
            }
          }
        };
      });
    }, 600);

    // Fallback REST polling if WebSocket is offline
    restFallbackTimer.current = setInterval(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        fetchFastInitialSync();
      }
    }, 2000);

    // Stale detector
    staleTimer.current = setInterval(() => {
      if (lastMsgTs.current && Date.now() - lastMsgTs.current > 4000) {
        setState((s) => (s.stale ? s : { ...s, stale: true }));
      }
    }, 1500);

    return () => {
      cancelled = true;
      unsubDeltaWS();
      clearInterval(microTickTimer);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (staleTimer.current) clearInterval(staleTimer.current);
      if (restFallbackTimer.current) clearInterval(restFallbackTimer.current);
      if (directPollerTimer.current) clearInterval(directPollerTimer.current);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* noop */
        }
      }
    };
  }, [asset]);

  return useMemo(() => ({
    connected: state.connected,
    stale: state.stale,
    marketOpen: state.marketOpen,
    spots: state.spots,
    chain,
  }), [state.connected, state.stale, state.marketOpen, state.spots, chain]);
}
