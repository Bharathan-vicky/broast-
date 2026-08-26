import { useEffect, useRef, useState, useMemo } from 'react';
import Constants from 'expo-constants';

const getApiBase = (): string => {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '');
  }
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(':')[0];
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return `http://${host}:8000`;
    }
  }
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
  if (prev.expiries.length !== nextExpiries.length) return true;
  if (prev.expiries.length > 0 && prev.expiries[0] !== nextExpiries[0]) return true;
  
  const prevExpKeys = Object.keys(prev.chainByExpiry);
  const nextExpKeys = Object.keys(nextChainByExp);
  if (prevExpKeys.length !== nextExpKeys.length) return true;
  
  // Sample check first expiry strike prices
  if (prevExpKeys.length > 0) {
    const firstExp = prevExpKeys[0];
    const pRows = prev.chainByExpiry[firstExp] || [];
    const nRows = nextChainByExp[firstExp] || [];
    if (pRows.length !== nRows.length) return true;
    if (pRows.length > 0 && nRows.length > 0) {
      const pMid = pRows[Math.floor(pRows.length / 2)];
      const nMid = nRows[Math.floor(nRows.length / 2)];
      if (pMid && nMid) {
        if (Math.abs((pMid.callMark || 0) - (nMid.callMark || 0)) > 0.01 || Math.abs((pMid.putMark || 0) - (nMid.putMark || 0)) > 0.01) {
          return true;
        }
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
  const lastMsgTs = useRef(0);
  const assetRef = useRef(asset);
  assetRef.current = asset;

  useEffect(() => {
    let cancelled = false;

    const scheduleReconnect = () => {
      if (cancelled) return;
      reconnectAttempt.current = Math.min(reconnectAttempt.current + 1, 6);
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 15000);
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
        setState((s) => (s.connected ? s : { ...s, connected: true }));
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
                return prevChain; // Return exact same reference!
              }
              return {
                expiries: newExpiries,
                chainByExpiry: newChainByExp,
              };
            });
          }
        } catch (e) {
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

    // Stale detector: flag the feed if no message arrives for >3.0s.
    staleTimer.current = setInterval(() => {
      if (lastMsgTs.current && Date.now() - lastMsgTs.current > 3000) {
        setState((s) => (s.stale ? s : { ...s, stale: true }));
      }
    }, 1000);

    return () => {
      cancelled = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (staleTimer.current) clearInterval(staleTimer.current);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch (e) {
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
