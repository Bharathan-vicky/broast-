import { useState, useEffect, useMemo, useCallback } from 'react';
import { usePriceFeed } from './lib/priceFeed';
import { synthesizeOptionChain, fuseLiveOptionChain, generateDefaultExpiries } from './lib/optionChainSynthesizer';
import type { OptionRowData } from './lib/optionChainSynthesizer';
import { CATEGORIZED_STRATEGIES, buildStrategyBasket } from './strategies';
import type { OptionLeg } from './strategies';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:8000';

interface AssetConfig {
  symbol: string;
  name: string;
  currency: 'INR' | 'USD';
  lotSize: number;
  strikeStep: number;
  defaultSpot: number;
  category: 'INDICES' | 'STOCKS' | 'CRYPTO' | 'COMMODITIES';
}

const ASSET_CONFIG: Record<string, AssetConfig> = {
  NIFTY: { symbol: 'NIFTY', name: 'NIFTY 50', currency: 'INR', lotSize: 65, strikeStep: 50, defaultSpot: 24175.65, category: 'INDICES' },
  BANKNIFTY: { symbol: 'BANKNIFTY', name: 'BANK NIFTY', currency: 'INR', lotSize: 30, strikeStep: 100, defaultSpot: 57496.30, category: 'INDICES' },
  SENSEX: { symbol: 'SENSEX', name: 'SENSEX', currency: 'INR', lotSize: 20, strikeStep: 100, defaultSpot: 77264.51, category: 'INDICES' },
  RELIANCE: { symbol: 'RELIANCE', name: 'Reliance Industries', currency: 'INR', lotSize: 250, strikeStep: 10, defaultSpot: 1398.50, category: 'STOCKS' },
  TCS: { symbol: 'TCS', name: 'Tata Consultancy Services', currency: 'INR', lotSize: 175, strikeStep: 20, defaultSpot: 3090.00, category: 'STOCKS' },
  INFY: { symbol: 'INFY', name: 'Infosys Limited', currency: 'INR', lotSize: 400, strikeStep: 20, defaultSpot: 1350.00, category: 'STOCKS' },
  HDFCBANK: { symbol: 'HDFCBANK', name: 'HDFC Bank Limited', currency: 'INR', lotSize: 550, strikeStep: 10, defaultSpot: 1680.00, category: 'STOCKS' },
  ICICIBANK: { symbol: 'ICICIBANK', name: 'ICICI Bank Limited', currency: 'INR', lotSize: 700, strikeStep: 10, defaultSpot: 1220.00, category: 'STOCKS' },
  SBIN: { symbol: 'SBIN', name: 'State Bank of India', currency: 'INR', lotSize: 750, strikeStep: 5, defaultSpot: 745.00, category: 'STOCKS' },
  BTC: { symbol: 'BTC', name: 'Bitcoin 24/7', currency: 'USD', lotSize: 0.001, strikeStep: 500, defaultSpot: 86450.00, category: 'CRYPTO' },
  ETH: { symbol: 'ETH', name: 'Ethereum 24/7', currency: 'USD', lotSize: 0.01, strikeStep: 25, defaultSpot: 2680.00, category: 'CRYPTO' },
  XAUT: { symbol: 'XAUT', name: 'Tether Gold 24/7', currency: 'USD', lotSize: 1.0, strikeStep: 10, defaultSpot: 2890.00, category: 'CRYPTO' },
  CRUDEOIL: { symbol: 'CRUDEOIL', name: 'MCX Crude Oil', currency: 'INR', lotSize: 100, strikeStep: 50, defaultSpot: 8315.00, category: 'COMMODITIES' },
  CRUDEOILM: { symbol: 'CRUDEOILM', name: 'MCX Crude Mini', currency: 'INR', lotSize: 10, strikeStep: 50, defaultSpot: 8315.00, category: 'COMMODITIES' },
  GOLD: { symbol: 'GOLD', name: 'MCX Gold (1kg)', currency: 'INR', lotSize: 100, strikeStep: 100, defaultSpot: 161690.00, category: 'COMMODITIES' },
  GOLDM: { symbol: 'GOLDM', name: 'MCX Gold Mini (100g)', currency: 'INR', lotSize: 10, strikeStep: 100, defaultSpot: 161690.00, category: 'COMMODITIES' },
  SILVER: { symbol: 'SILVER', name: 'MCX Silver (30kg)', currency: 'INR', lotSize: 30, strikeStep: 250, defaultSpot: 246274.00, category: 'COMMODITIES' },
  SILVERM: { symbol: 'SILVERM', name: 'MCX Silver Mini (5kg)', currency: 'INR', lotSize: 5, strikeStep: 250, defaultSpot: 246274.00, category: 'COMMODITIES' },
  NATURALGAS: { symbol: 'NATURALGAS', name: 'MCX Natural Gas', currency: 'INR', lotSize: 1250, strikeStep: 5, defaultSpot: 240.50, category: 'COMMODITIES' },
  NATGASM: { symbol: 'NATGASM', name: 'MCX NatGas Mini', currency: 'INR', lotSize: 250, strikeStep: 5, defaultSpot: 240.50, category: 'COMMODITIES' },
};

interface Account {
  id: number;
  name: string;
  margin_type: 'Cross' | 'Isolated';
  balance: number;
  currency: string;
  market?: string;
}

export default function MobileTerminal() {
  // Active Navigation & Market
  const [selectedMarket, setSelectedMarket] = useState<'INDIAN' | 'CRYPTO' | 'COMMODITY'>('INDIAN');
  const [activeAsset, setActiveAsset] = useState<string>('NIFTY');
  const [activeTab, setActiveTab] = useState<'watchlist' | 'terminal' | 'strategy' | 'tradelab'>('terminal');
  const [tradeLabSubTab, setTradeLabSubTab] = useState<'positions' | 'performance' | 'journal'>('positions');

  // Account State
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<number>(1);
  const [activeAccountsByMarket, setActiveAccountsByMarket] = useState<Record<string, number>>({
    INDIAN: 1,
    CRYPTO: 101,
    COMMODITY: 201
  });
  const [selectedAccountForView, setSelectedAccountForView] = useState<number | null>(null);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editAccountName, setEditAccountName] = useState('');
  const [editAccountBalance, setEditAccountBalance] = useState('');

  // Modals & Panels
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showAssetModal, setShowAssetModal] = useState(false);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [showPayoffModal, setShowPayoffModal] = useState(false);
  const [showReadyModal, setShowReadyModal] = useState(false);

  // Strategy & Order State
  const [stratBasket, setStratBasket] = useState<OptionLeg[]>([]);
  const [orderModalLeg, setOrderModalLeg] = useState<OptionLeg | null>(null);
  const [orderMode, setOrderMode] = useState<'REGULAR' | 'AMO'>('REGULAR');
  const [productType, setProductType] = useState<'NRML' | 'MIS'>('NRML');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT' | 'SL' | 'SL-M'>('MARKET');
  const [orderLots, setOrderLots] = useState<number>(1);
  const [limitPrice, setLimitPrice] = useState<string>('');
  const [triggerPrice, setTriggerPrice] = useState<string>('');
  const [isTrading, setIsTrading] = useState(false);
  const [tradeMessage, setTradeMessage] = useState<string>('');

  // Portfolio & History
  const [portfolio, setPortfolio] = useState<any>(null);
  const [orderHistory, setOrderHistory] = useState<any[]>([]);

  // Expiry & Chain State
  const [expiries, setExpiries] = useState<string[]>([]);
  const [activeExpiry, setActiveExpiry] = useState<string>('');
  const [chainByExpiry, setChainByExpiry] = useState<Record<string, OptionRowData[]>>({});

  const currConfig = ASSET_CONFIG[activeAsset] || ASSET_CONFIG['NIFTY'];
  const currency = currConfig.currency;
  const strikeStep = currConfig.strikeStep;
  const lotSize = currConfig.lotSize;

  // Real-Time Price Feed Hook
  const priceFeed = usePriceFeed(activeAsset);

  // Computed Spot & Active Account
  const spotPrice = useMemo(() => {
    const liveSpot = priceFeed.spots[activeAsset]?.spot;
    return (liveSpot && liveSpot > 0) ? liveSpot : currConfig.defaultSpot;
  }, [priceFeed.spots, activeAsset, currConfig.defaultSpot]);

  const spotChange = priceFeed.spots[activeAsset]?.change || 0.0;
  const spotPercentChange = priceFeed.spots[activeAsset]?.pctChange || 0.0;

  const activeAccount = useMemo(() => {
    const currentActiveId = activeAccountsByMarket[selectedMarket] || activeAccountId;
    const acc = accounts.find(a => a.id === currentActiveId);
    if (acc) return acc;
    const firstMatching = accounts.find(a => a.market === selectedMarket || (selectedMarket === 'CRYPTO' ? a.currency === 'USD' : a.currency === 'INR'));
    if (firstMatching) return firstMatching;
    return {
      id: currentActiveId,
      name: `Acc ${currentActiveId}`,
      margin_type: 'Cross',
      balance: selectedMarket === 'CRYPTO' ? 100000.0 : 1000000.0,
      currency,
      market: selectedMarket
    } as Account;
  }, [accounts, activeAccountsByMarket, selectedMarket, activeAccountId, currency]);

  // Load Accounts from backend
  const fetchAccounts = useCallback(() => {
    fetch(`${BACKEND_URL}/api/accounts?market=${selectedMarket}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setAccounts(data);
          setActiveAccountsByMarket(prev => {
            const cur = prev[selectedMarket];
            if (cur && data.some((a: any) => a.id === cur)) return prev;
            return { ...prev, [selectedMarket]: data[0].id };
          });
        }
      })
      .catch(() => {});
  }, [selectedMarket]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Synchronize Expiries and Chain from PriceFeed
  useEffect(() => {
    const c = priceFeed.chain;
    if (c?.expiries && c.expiries.length > 0) {
      setExpiries(c.expiries);
      setActiveExpiry(prev => (prev && c.expiries.includes(prev)) ? prev : c.expiries[0]);
    }
    if (c?.chainByExpiry && Object.keys(c.chainByExpiry).length > 0) {
      setChainByExpiry(c.chainByExpiry);
    }
  }, [priceFeed.chain]);

  // Periodic Portfolio Poller (every 3000ms)
  useEffect(() => {
    let isMounted = true;
    const accId = activeAccount?.id || 1;

    const syncPortfolio = () => {
      fetch(`${BACKEND_URL}/api/portfolio?account_id=${accId}`)
        .then(r => r.json())
        .then(data => { if (isMounted && data) setPortfolio(data); })
        .catch(() => {});

      fetch(`${BACKEND_URL}/api/history?account_id=${accId}`)
        .then(r => r.json())
        .then(data => { if (isMounted && Array.isArray(data)) setOrderHistory(data); })
        .catch(() => {});
    };

    syncPortfolio();
    const interval = setInterval(syncPortfolio, 3000);
    return () => { isMounted = false; clearInterval(interval); };
  }, [activeAccount?.id]);

  // Hardened Zero-Failure Option Chain
  const currentChain = useMemo(() => {
    let rows: OptionRowData[] = [];
    if (activeExpiry && chainByExpiry[activeExpiry]) {
      rows = chainByExpiry[activeExpiry];
    } else if (expiries.length > 0 && chainByExpiry[expiries[0]]) {
      rows = chainByExpiry[expiries[0]];
    }

    const isCrypto = activeAsset === 'BTC' || activeAsset === 'ETH' || activeAsset === 'XAUT';
    const isStock = currConfig.category === 'STOCKS';
    const activeExp = activeExpiry || expiries[0] || generateDefaultExpiries(isCrypto, isStock, activeAsset)[0];
    const sp = spotPrice || currConfig.defaultSpot;

    let result = (rows && rows.length > 0)
      ? fuseLiveOptionChain(rows, sp, strikeStep, activeExp, activeAsset)
      : synthesizeOptionChain(activeAsset, sp, strikeStep, activeExp);

    if (!result || result.length === 0) {
      result = synthesizeOptionChain(activeAsset, sp, strikeStep, activeExp);
    }
    return result;
  }, [chainByExpiry, activeExpiry, expiries, activeAsset, spotPrice, strikeStep, currConfig]);

  // ATM Strike Calculation
  const atmStrike = useMemo(() => {
    if (!currentChain || currentChain.length === 0) return 0;
    const sp = spotPrice || currConfig.defaultSpot;
    let closest = currentChain[0].strike;
    let minDiff = Math.abs(closest - sp);
    currentChain.forEach((r: any) => {
      const diff = Math.abs(r.strike - sp);
      if (diff < minDiff) {
        minDiff = diff;
        closest = r.strike;
      }
    });
    return closest;
  }, [currentChain, spotPrice, currConfig.defaultSpot]);

  // Account Management Actions
  const startEditingAccount = (acc: Account) => {
    setEditingAccount(acc);
    setEditAccountName(acc.name || `Acc ${acc.id}`);
    setEditAccountBalance(String(acc.balance || 1000000));
  };

  const handleUpdateAccount = () => {
    if (!editingAccount || !editAccountName.trim() || isNaN(parseFloat(editAccountBalance))) return;
    const updatedBalance = parseFloat(editAccountBalance);
    const updatedName = editAccountName.trim();

    setAccounts(prev => prev.map(a => a.id === editingAccount.id ? { ...a, name: updatedName, balance: updatedBalance } : a));
    setEditingAccount(null);
    setTradeMessage(`⚡ Account updated: ${updatedName} (Balance: ₹${updatedBalance.toLocaleString('en-IN')})`);
    setTimeout(() => setTradeMessage(''), 3000);

    fetch(`${BACKEND_URL}/api/accounts/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: editingAccount.id,
        name: updatedName,
        balance: updatedBalance,
        margin_type: editingAccount.margin_type
      })
    })
      .then(r => r.json())
      .then(data => { if (data.status === 'success') fetchAccounts(); })
      .catch(() => {});
  };

  // Trade Execution Handlers
  const handleExecuteSingleTrade = (side: 'BUY' | 'SELL') => {
    if (!orderModalLeg) return;
    setIsTrading(true);

    const price = orderType === 'LIMIT' ? parseFloat(limitPrice) || (orderModalLeg.entry_price ?? orderModalLeg.price ?? 0.0) : (orderModalLeg.entry_price ?? orderModalLeg.price ?? 0.0);
    const legPayload = {
      symbol: orderModalLeg.symbol,
      underlying: orderModalLeg.underlying,
      strike: orderModalLeg.strike,
      expiry: orderModalLeg.expiry,
      option_type: orderModalLeg.option_type,
      side,
      size: orderLots * lotSize,
      price,
      stoploss: 0.0,
      target: 0.0,
      product_type: productType,
      order_mode: orderMode,
      trigger_price: orderType === 'SL' || orderType === 'SL-M' ? parseFloat(triggerPrice) || 0.0 : 0.0
    };

    fetch(`${BACKEND_URL}/api/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        basket_name: `${orderModalLeg.underlying} ${orderModalLeg.strike} ${orderModalLeg.option_type}`,
        legs: [legPayload],
        account_id: activeAccount.id
      })
    })
      .then(r => r.json())
      .then(data => {
        setIsTrading(false);
        if (data.status === 'success') {
          setShowOrderModal(false);
          setTradeMessage(`✓ Order Executed: ${side} ${orderLots} Lot(s) @ ${currency === 'INR' ? '₹' : '$'}${price}`);
          setTimeout(() => setTradeMessage(''), 4000);
        } else {
          setTradeMessage(`❌ Error: ${data.message || 'Order failed'}`);
          setTimeout(() => setTradeMessage(''), 4000);
        }
      })
      .catch(() => {
        setIsTrading(false);
        setTradeMessage('❌ Network Error');
        setTimeout(() => setTradeMessage(''), 3000);
      });
  };

  const handleExecuteBasket = () => {
    if (stratBasket.length === 0) return;
    setIsTrading(true);

    const legsPayload = stratBasket.map(leg => ({
      symbol: leg.symbol,
      underlying: leg.underlying,
      strike: leg.strike,
      expiry: leg.expiry,
      option_type: leg.option_type,
      side: leg.side,
      size: (leg.size || 1) * lotSize,
      price: leg.entry_price ?? leg.price ?? 0.0,
      stoploss: 0.0,
      target: 0.0,
      product_type: productType,
      order_mode: orderMode,
      trigger_price: 0.0
    }));

    fetch(`${BACKEND_URL}/api/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        basket_name: `Strategy Basket (${stratBasket.length} Legs)`,
        legs: legsPayload,
        account_id: activeAccount.id
      })
    })
      .then(r => r.json())
      .then(data => {
        setIsTrading(false);
        if (data.status === 'success') {
          setStratBasket([]);
          setTradeMessage('✓ Strategy Basket Executed Successfully!');
          setTimeout(() => setTradeMessage(''), 4000);
        } else {
          setTradeMessage(`❌ Error: ${data.message || 'Failed'}`);
          setTimeout(() => setTradeMessage(''), 4000);
        }
      })
      .catch(() => {
        setIsTrading(false);
        setTradeMessage('❌ Basket Execution Failed');
        setTimeout(() => setTradeMessage(''), 3000);
      });
  };

  // Payoff Curve Dataset
  const payoffData = useMemo(() => {
    if (stratBasket.length === 0) return [];
    const minStrike = Math.min(...stratBasket.map(l => l.strike));
    const maxStrike = Math.max(...stratBasket.map(l => l.strike));
    const start = Math.floor(minStrike * 0.94);
    const end = Math.ceil(maxStrike * 1.06);
    const step = Math.max(1, Math.round((end - start) / 50));

    const points: any[] = [];
    for (let p = start; p <= end; p += step) {
      let totalPnl = 0;
      stratBasket.forEach(leg => {
        const isCall = leg.option_type === 'CALL';
        const isBuy = leg.side === 'BUY';
        const intrinsic = isCall ? Math.max(0, p - leg.strike) : Math.max(0, leg.strike - p);
        const legPrice = leg.entry_price ?? leg.price ?? 0.0;
        const pnl = isBuy ? (intrinsic - legPrice) : (legPrice - intrinsic);
        totalPnl += pnl * (leg.size || 1) * lotSize;
      });
      points.push({ price: p, pnl: Math.round(totalPnl) });
    }
    return points;
  }, [stratBasket, lotSize]);

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#07090e', color: '#e2e8f0', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Top Banner / Notification Toast */}
      {tradeMessage && (
        <div style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', backgroundColor: '#0284c7', color: 'white', padding: '10px 20px', borderRadius: 8, zIndex: 99999, fontWeight: 'bold', boxShadow: '0 8px 30px rgba(0,0,0,0.5)', fontSize: 13 }}>
          {tradeMessage}
        </div>
      )}

      {/* Header Bar */}
      <header style={{ backgroundColor: '#0c101a', borderBottom: '1px solid #1a2234', padding: '12px 18px', position: 'sticky', top: 0, zIndex: 1000, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button 
            onClick={() => setShowAssetModal(true)}
            style={{ backgroundColor: '#131b2c', border: '1px solid #24324f', borderRadius: 8, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6, color: 'white', cursor: 'pointer' }}
          >
            <span style={{ fontWeight: 800, fontSize: 15, color: '#38bdf8' }}>{currConfig.name}</span>
            <span style={{ fontSize: 11, color: '#64748b' }}>▼</span>
          </button>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 18, fontWeight: 900, color: spotChange >= 0 ? '#10b981' : '#ef4444' }}>
              {currency === 'INR' ? '₹' : '$'}{Number(spotPrice).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </span>
            <span style={{ fontSize: 12, fontWeight: 'bold', color: spotChange >= 0 ? '#10b981' : '#ef4444' }}>
              {spotChange >= 0 ? '+' : ''}{spotChange.toFixed(2)} ({spotPercentChange >= 0 ? '+' : ''}{spotPercentChange.toFixed(2)}%)
            </span>
          </div>
        </div>

        {/* Right Header Actions: Account Badge + Menu (⋮) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div 
            onClick={() => setShowProfileModal(true)}
            style={{ backgroundColor: '#101726', border: '1px solid #1e293b', padding: '5px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'right' }}
          >
            <div style={{ fontSize: 9.5, color: '#64748b', fontWeight: 'bold' }}>{activeAccount.name || `Acc ${activeAccount.id}`}</div>
            <div style={{ fontSize: 12, fontWeight: 'bold', color: '#10b981' }}>
              {currency === 'INR' ? '₹' : '$'}{Number(activeAccount.balance).toLocaleString('en-IN')}
            </div>
          </div>

          <button 
            onClick={() => setShowProfileModal(true)}
            style={{ backgroundColor: '#1e293b', border: 'none', borderRadius: 8, width: 36, height: 36, color: 'white', fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Profile & Settings"
          >
            ⋮
          </button>
        </div>
      </header>

      {/* Expiry Selector Bar */}
      <div style={{ backgroundColor: '#090d15', borderBottom: '1px solid #172033', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, overflowX: 'auto' }}>
        <span style={{ fontSize: 11, color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' }}>Expiry:</span>
        {expiries.slice(0, 5).map(exp => (
          <button
            key={exp}
            onClick={() => setActiveExpiry(exp)}
            style={{
              backgroundColor: activeExpiry === exp ? '#0284c7' : '#101726',
              color: activeExpiry === exp ? 'white' : '#94a3b8',
              border: activeExpiry === exp ? '1px solid #38bdf8' : '1px solid #1e293b',
              padding: '4px 12px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 'bold',
              cursor: 'pointer',
              whiteSpace: 'nowrap'
            }}
          >
            {exp}
          </button>
        ))}
      </div>

      {/* Main Content Area Based on activeTab */}
      <main style={{ padding: '16px', maxWidth: '1200px', margin: '0 auto', paddingBottom: '90px' }}>
        {/* 1. WATCHLIST TAB */}
        {activeTab === 'watchlist' && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 12, color: 'white' }}>Market Watchlist</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {Object.entries(ASSET_CONFIG).filter(([_, cfg]) => cfg.category === (selectedMarket === 'CRYPTO' ? 'CRYPTO' : selectedMarket === 'COMMODITY' ? 'COMMODITIES' : 'INDICES')).map(([key, cfg]) => {
                const quote = priceFeed.spots[key];
                const spot = quote?.spot || cfg.defaultSpot;
                const chg = quote?.change || 0;
                const pct = quote?.pctChange || 0;
                return (
                  <div
                    key={key}
                    onClick={() => { setActiveAsset(key); setActiveTab('terminal'); }}
                    style={{ backgroundColor: '#0e1422', border: activeAsset === key ? '1.5px solid #0284c7' : '1px solid #1c263c', borderRadius: 10, padding: '14px', cursor: 'pointer', transition: 'all 0.2s' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontWeight: 'bold', fontSize: 14, color: 'white' }}>{cfg.name}</span>
                      <span style={{ fontSize: 10, color: '#64748b', backgroundColor: '#182236', padding: '2px 6px', borderRadius: 4 }}>{cfg.category}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: 17, fontWeight: 900, color: chg >= 0 ? '#10b981' : '#ef4444' }}>
                        {cfg.currency === 'INR' ? '₹' : '$'}{Number(spot).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 'bold', color: chg >= 0 ? '#10b981' : '#ef4444' }}>
                        {chg >= 0 ? '+' : ''}{chg.toFixed(2)} ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 2. OPTIONS TERMINAL TAB */}
        {activeTab === 'terminal' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 'bold', color: 'white' }}>Option Chain Matrix</span>
                <span style={{ fontSize: 11, color: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', padding: '2px 8px', borderRadius: 4, fontWeight: 'bold' }}>⚡ 0ms Zero-Lag Stream</span>
              </div>
              <button 
                onClick={() => setShowReadyModal(true)}
                style={{ backgroundColor: '#0284c7', color: 'white', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 11.5, fontWeight: 'bold', cursor: 'pointer' }}
              >
                + Strategy Builder
              </button>
            </div>

            {/* Strike Grid Table */}
            <div style={{ overflowX: 'auto', backgroundColor: '#0b0f19', border: '1px solid #1a2336', borderRadius: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, textAlign: 'right' }}>
                <thead>
                  <tr style={{ backgroundColor: '#101726', color: '#64748b', fontSize: 10.5, borderBottom: '1px solid #1e2a40' }}>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#10b981' }}>CALL OI</th>
                    <th style={{ padding: '8px', color: '#10b981' }}>CALL Δ</th>
                    <th style={{ padding: '8px', color: '#10b981' }}>CALL LTP</th>
                    <th style={{ padding: '8px', textAlign: 'center', color: '#f8fafc', fontWeight: 900 }}>STRIKE</th>
                    <th style={{ padding: '8px', textAlign: 'left', color: '#ef4444' }}>PUT LTP</th>
                    <th style={{ padding: '8px', color: '#ef4444' }}>PUT Δ</th>
                    <th style={{ padding: '8px', color: '#ef4444' }}>PUT OI</th>
                  </tr>
                </thead>
                <tbody>
                  {currentChain.map((row: any) => {
                    const isAtm = row.strike === atmStrike;
                    return (
                      <tr 
                        key={row.strike}
                        style={{ 
                          backgroundColor: isAtm ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                          borderBottom: '1px solid #131b2c',
                          transition: 'background-color 0.15s'
                        }}
                      >
                        {/* Call Side */}
                        <td style={{ padding: '8px', textAlign: 'left', color: '#94a3b8' }}>{row.callOI?.toLocaleString()}</td>
                        <td style={{ padding: '8px', color: '#38bdf8' }}>{row.callDelta?.toFixed(2) || '0.50'}</td>
                        <td 
                          onClick={() => {
                            const p = row.callLtp || row.callMark || 0.0;
                            setOrderModalLeg({
                              symbol: row.callSym,
                              underlying: activeAsset,
                              strike: row.strike,
                              expiry: activeExpiry || expiries[0],
                              option_type: 'CALL',
                              side: 'BUY',
                              price: p,
                              entry_price: p,
                              size: 1
                            });
                            setShowOrderModal(true);
                          }}
                          style={{ padding: '8px', fontWeight: 'bold', color: '#10b981', cursor: 'pointer', backgroundColor: 'rgba(16,185,129,0.06)' }}
                        >
                          {currency === 'INR' ? '₹' : '$'}{(row.callLtp || row.callMark || 0).toFixed(2)}
                        </td>

                        {/* Strike Center */}
                        <td style={{ padding: '8px', textAlign: 'center', fontWeight: 900, color: isAtm ? '#38bdf8' : 'white', backgroundColor: isAtm ? 'rgba(56, 189, 248, 0.25)' : '#0f1624' }}>
                          {row.strike}
                        </td>

                        {/* Put Side */}
                        <td 
                          onClick={() => {
                            const p = row.putLtp || row.putMark || 0.0;
                            setOrderModalLeg({
                              symbol: row.putSym,
                              underlying: activeAsset,
                              strike: row.strike,
                              expiry: activeExpiry || expiries[0],
                              option_type: 'PUT',
                              side: 'BUY',
                              price: p,
                              entry_price: p,
                              size: 1
                            });
                            setShowOrderModal(true);
                          }}
                          style={{ padding: '8px', textAlign: 'left', fontWeight: 'bold', color: '#ef4444', cursor: 'pointer', backgroundColor: 'rgba(239,68,68,0.06)' }}
                        >
                          {currency === 'INR' ? '₹' : '$'}{(row.putLtp || row.putMark || 0).toFixed(2)}
                        </td>
                        <td style={{ padding: '8px', color: '#38bdf8' }}>{row.putDelta?.toFixed(2) || '-0.50'}</td>
                        <td style={{ padding: '8px', color: '#94a3b8' }}>{row.putOI?.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 3. STRATEGY BUILDER TAB */}
        {activeTab === 'strategy' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ fontSize: 16, fontWeight: 'bold', color: 'white' }}>Multi-Leg Strategy Builder</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button 
                  onClick={() => setShowReadyModal(true)}
                  style={{ backgroundColor: '#1e293b', color: '#38bdf8', border: '1px solid #38bdf8', padding: '6px 12px', borderRadius: 6, fontSize: 11.5, fontWeight: 'bold', cursor: 'pointer' }}
                >
                  ⚡ Preset Strategies
                </button>
                {stratBasket.length > 0 && (
                  <button 
                    onClick={() => setShowPayoffModal(true)}
                    style={{ backgroundColor: '#059669', color: 'white', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 11.5, fontWeight: 'bold', cursor: 'pointer' }}
                  >
                    📈 View Payoff Chart
                  </button>
                )}
              </div>
            </div>

            {/* Active Legs in Basket */}
            {stratBasket.length === 0 ? (
              <div style={{ backgroundColor: '#0e1422', border: '1px dashed #24324f', borderRadius: 10, padding: 30, textAlign: 'center', color: '#64748b' }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>📐</div>
                <div style={{ fontSize: 14, fontWeight: 'bold', color: '#94a3b8' }}>No strategy legs added yet</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>Select strikes from the Option Chain or use a Preset Strategy</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                {stratBasket.map((leg, idx) => (
                  <div key={idx} style={{ backgroundColor: '#0e1422', border: '1px solid #1c263c', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ backgroundColor: leg.side === 'BUY' ? '#065f46' : '#991b1b', color: leg.side === 'BUY' ? '#34d399' : '#f87171', padding: '2px 8px', borderRadius: 4, fontWeight: 'bold', fontSize: 11 }}>
                        {leg.side}
                      </span>
                      <span style={{ fontWeight: 'bold', color: 'white', fontSize: 13 }}>
                        {leg.strike} {leg.option_type}
                      </span>
                      <span style={{ color: '#64748b', fontSize: 11 }}>({leg.expiry})</span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontWeight: 'bold', color: '#10b981', fontSize: 13 }}>
                        {currency === 'INR' ? '₹' : '$'}{(leg.entry_price ?? leg.price ?? 0).toFixed(2)}
                      </span>
                      <button 
                        onClick={() => setStratBasket(prev => prev.filter((_, i) => i !== idx))}
                        style={{ backgroundColor: 'transparent', border: 'none', color: '#ef4444', fontSize: 16, cursor: 'pointer' }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}

                <button 
                  onClick={handleExecuteBasket}
                  disabled={isTrading}
                  style={{ backgroundColor: '#0284c7', color: 'white', border: 'none', padding: '12px', borderRadius: 8, fontWeight: 'bold', fontSize: 14, cursor: 'pointer', marginTop: 10 }}
                >
                  {isTrading ? 'Executing Basket...' : `Execute Strategy (${stratBasket.length} Legs)`}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 4. TRADELAB / POSITIONS TAB */}
        {activeTab === 'tradelab' && (
          <div>
            {/* Sub Tabs */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, borderBottom: '1px solid #1c263c', paddingBottom: 8 }}>
              {['positions', 'performance', 'journal'].map(sub => (
                <button
                  key={sub}
                  onClick={() => setTradeLabSubTab(sub as any)}
                  style={{
                    backgroundColor: tradeLabSubTab === sub ? '#0284c7' : 'transparent',
                    color: tradeLabSubTab === sub ? 'white' : '#94a3b8',
                    border: 'none',
                    padding: '6px 14px',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    textTransform: 'capitalize'
                  }}
                >
                  {sub}
                </button>
              ))}
            </div>

            {/* Positions View */}
            {tradeLabSubTab === 'positions' && (
              <div>
                {(!portfolio?.baskets || portfolio.baskets.length === 0) ? (
                  <div style={{ backgroundColor: '#0e1422', border: '1px dashed #24324f', borderRadius: 10, padding: 30, textAlign: 'center', color: '#64748b' }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>💼</div>
                    <div style={{ fontSize: 14, fontWeight: 'bold', color: '#94a3b8' }}>No Open Positions</div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>Execute an order to start tracking live P&L</div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {portfolio.baskets.map((basket: any) => (
                      <div key={basket.id} style={{ backgroundColor: '#0e1422', border: '1px solid #1c263c', borderRadius: 10, padding: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, borderBottom: '1px solid #182236', paddingBottom: 6 }}>
                          <span style={{ fontWeight: 'bold', color: 'white', fontSize: 13 }}>{basket.name}</span>
                          <span style={{ fontSize: 11, color: '#64748b' }}>Account #{basket.account_id}</span>
                        </div>
                        {basket.legs?.map((leg: any) => (
                          <div key={leg.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, margin: '4px 0' }}>
                            <span>{leg.side} {leg.size}x {leg.symbol}</span>
                            <span style={{ fontWeight: 'bold' }}>Entry: {leg.entry_price}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Journal / Audit History View */}
            {tradeLabSubTab === 'journal' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {orderHistory.length === 0 ? (
                  <div style={{ backgroundColor: '#0e1422', padding: 24, borderRadius: 8, textAlign: 'center', color: '#64748b' }}>No trade history recorded yet</div>
                ) : (
                  orderHistory.map((item, i) => (
                    <div key={i} style={{ backgroundColor: '#0e1422', border: '1px solid #1c263c', borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between' }}>
                      <div>
                        <div style={{ fontWeight: 'bold', color: 'white', fontSize: 12.5 }}>{item.basket_name}</div>
                        <div style={{ fontSize: 10.5, color: '#64748b' }}>{item.closed_at || item.created_at}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 'bold', fontSize: 13, color: (item.realized_pnl || 0) >= 0 ? '#10b981' : '#ef4444' }}>
                          {currency === 'INR' ? '₹' : '$'}{Number(item.realized_pnl || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </div>
                        <div style={{ fontSize: 10, color: '#64748b' }}>Realized PnL</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Bottom Navigation Bar */}
      <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, backgroundColor: '#0c101a', borderTop: '1px solid #1a2234', display: 'flex', justifyContent: 'space-around', padding: '10px 0', zIndex: 1000 }}>
        {[
          { key: 'watchlist', label: 'Watchlist', icon: '🏠' },
          { key: 'terminal', label: 'Terminal', icon: '⚡' },
          { key: 'strategy', label: 'Strategies', icon: '📐' },
          { key: 'tradelab', label: 'TradeLab', icon: '💼' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as any)}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              color: activeTab === tab.key ? '#38bdf8' : '#64748b',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontWeight: 'bold',
              cursor: 'pointer'
            }}
          >
            <span style={{ fontSize: 18 }}>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* 5. MODAL: PROFILE & SUB-ACCOUNT MANAGER (Acc 1..10) */}
      {showProfileModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ backgroundColor: '#101624', border: '1px solid #24324f', borderRadius: 14, padding: 22, width: '90%', maxWidth: 520, maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid #1c263c', paddingBottom: 10 }}>
              <span style={{ fontSize: 16, fontWeight: 'bold', color: 'white' }}>Profile & Account Management</span>
              <button onClick={() => setShowProfileModal(false)} style={{ backgroundColor: 'transparent', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>

            {/* Multi-Market Switcher */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 'bold', color: '#64748b', marginBottom: 6 }}>MARKET THEATER</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {[
                  { id: 'INDIAN', label: 'Indian F&O (NSE/BSE)' },
                  { id: 'CRYPTO', label: 'Crypto 24/7' },
                  { id: 'COMMODITY', label: 'MCX Commodities' }
                ].map(m => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setSelectedMarket(m.id as any);
                      setActiveAsset(m.id === 'CRYPTO' ? 'BTC' : m.id === 'COMMODITY' ? 'CRUDEOIL' : 'NIFTY');
                    }}
                    style={{
                      flex: 1,
                      backgroundColor: selectedMarket === m.id ? '#0284c7' : '#090d15',
                      color: selectedMarket === m.id ? 'white' : '#94a3b8',
                      border: selectedMarket === m.id ? '1px solid #38bdf8' : '1px solid #1e293b',
                      padding: '8px 4px',
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 'bold',
                      cursor: 'pointer'
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Trading Accounts List (Acc 1 to Acc 10) */}
            <div style={{ backgroundColor: '#090d15', border: '1px solid #1e293b', borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 'bold', color: 'white' }}>Principal Accounts (Acc 1–10)</span>
                <span style={{ fontSize: 10, color: '#10b981', fontWeight: 'bold' }}>🟢 ACTIVE TRADING ACCOUNT</span>
              </div>

              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 12 }}>
                {accounts.map(acc => {
                  const isCurrentActive = acc.id === (activeAccountsByMarket[selectedMarket] || activeAccountId);
                  const isSelected = acc.id === (selectedAccountForView || activeAccountId);
                  return (
                    <button
                      key={acc.id}
                      onClick={() => setSelectedAccountForView(acc.id)}
                      style={{
                        backgroundColor: isSelected ? '#0284c7' : (isCurrentActive ? '#064e3b' : '#141d2e'),
                        color: isSelected || isCurrentActive ? 'white' : '#94a3b8',
                        border: isSelected ? '1px solid #38bdf8' : (isCurrentActive ? '1px solid #10b981' : '1px solid #1e293b'),
                        padding: '6px 12px',
                        borderRadius: 6,
                        fontSize: 11.5,
                        fontWeight: 'bold',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {isCurrentActive && '● '}{acc.name || `Acc ${acc.id}`}
                    </button>
                  );
                })}
              </div>

              {/* View/Edit Card */}
              {(() => {
                const viewedAcc = accounts.find(a => a.id === (selectedAccountForView || activeAccountId)) || activeAccount;
                const isViewingActive = viewedAcc?.id === (activeAccountsByMarket[selectedMarket] || activeAccountId);
                return (
                  <div style={{ backgroundColor: '#0f1624', borderRadius: 8, padding: 12, border: '1px solid #1c263c' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 'bold' }}>ACCOUNT NAME</div>
                        <div style={{ fontSize: 14, fontWeight: 'bold', color: 'white' }}>{viewedAcc?.name || `Acc ${viewedAcc?.id}`}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 'bold' }}>BALANCE</div>
                        <div style={{ fontSize: 15, fontWeight: 900, color: '#10b981' }}>
                          {selectedMarket === 'CRYPTO' ? '$' : '₹'}{Number(viewedAcc?.balance || 0).toLocaleString('en-IN')}
                        </div>
                      </div>
                    </div>

                    {/* Inline Editor */}
                    {editingAccount?.id === viewedAcc?.id ? (
                      <div style={{ backgroundColor: '#090d15', border: '1px solid #38bdf8', borderRadius: 6, padding: 10, marginTop: 8 }}>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Account Name:</div>
                        <input
                          type="text"
                          value={editAccountName}
                          onChange={e => setEditAccountName(e.target.value)}
                          style={{ width: '100%', backgroundColor: '#141d2e', border: '1px solid #24324f', borderRadius: 4, padding: '6px 8px', color: 'white', fontSize: 12, marginBottom: 8, outline: 'none' }}
                        />
                        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Capital Balance:</div>
                        <input
                          type="number"
                          value={editAccountBalance}
                          onChange={e => setEditAccountBalance(e.target.value)}
                          style={{ width: '100%', backgroundColor: '#141d2e', border: '1px solid #24324f', borderRadius: 4, padding: '6px 8px', color: 'white', fontSize: 12, marginBottom: 10, outline: 'none' }}
                        />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={handleUpdateAccount} style={{ flex: 1, backgroundColor: '#059669', color: 'white', border: 'none', padding: '6px', borderRadius: 4, fontSize: 11, fontWeight: 'bold', cursor: 'pointer' }}>💾 Save Changes</button>
                          <button onClick={() => setEditingAccount(null)} style={{ flex: 1, backgroundColor: '#1e293b', color: '#94a3b8', border: 'none', padding: '6px', borderRadius: 4, fontSize: 11, fontWeight: 'bold', cursor: 'pointer' }}>✕ Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        {!isViewingActive ? (
                          <button
                            onClick={() => {
                              if (viewedAcc) {
                                setActiveAccountsByMarket(prev => ({ ...prev, [selectedMarket]: viewedAcc.id }));
                                setActiveAccountId(viewedAcc.id);
                                setTradeMessage(`⚡ Active Trading Account set to: ${viewedAcc.name}`);
                                setTimeout(() => setTradeMessage(''), 3000);
                              }
                            }}
                            style={{ flex: 1.2, backgroundColor: '#0284c7', color: 'white', border: 'none', padding: '8px', borderRadius: 6, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}
                          >
                            🎯 Set as Trading Account
                          </button>
                        ) : (
                          <div style={{ flex: 1.2, backgroundColor: '#064e3b', color: '#10b981', border: '1px solid #10b981', padding: '8px', borderRadius: 6, fontSize: 12, fontWeight: 'bold', textAlign: 'center' }}>
                            ✓ Active Trading Account
                          </div>
                        )}

                        <button
                          onClick={() => { if (viewedAcc) startEditingAccount(viewedAcc); }}
                          style={{ flex: 1, backgroundColor: '#141d2e', color: '#38bdf8', border: '1px solid #24324f', padding: '8px', borderRadius: 6, fontSize: 12, fontWeight: 'bold', cursor: 'pointer' }}
                        >
                          ✏️ Edit Name & Capital
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* 6. MODAL: ORDER PLACEMENT (Zerodha / Groww Style) */}
      {showOrderModal && orderModalLeg && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ backgroundColor: '#101624', border: '1px solid #24324f', borderRadius: 14, padding: 22, width: '90%', maxWidth: 440 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div>
                <span style={{ fontSize: 15, fontWeight: 'bold', color: 'white' }}>{orderModalLeg.underlying} {orderModalLeg.strike} {orderModalLeg.option_type}</span>
                <div style={{ fontSize: 11, color: '#64748b' }}>Expiry: {orderModalLeg.expiry}</div>
              </div>
              <button onClick={() => setShowOrderModal(false)} style={{ backgroundColor: 'transparent', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>

            {/* Mode (REGULAR / AMO) */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {['REGULAR', 'AMO'].map(m => (
                <button
                  key={m}
                  onClick={() => setOrderMode(m as any)}
                  style={{ flex: 1, backgroundColor: orderMode === m ? '#1e293b' : '#090d15', color: orderMode === m ? '#38bdf8' : '#64748b', border: orderMode === m ? '1px solid #38bdf8' : '1px solid #1e293b', padding: '5px', borderRadius: 4, fontSize: 10.5, fontWeight: 'bold', cursor: 'pointer' }}
                >
                  {m}
                </button>
              ))}
            </div>

            {/* Product Type (NRML / MIS) */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {['NRML', 'MIS'].map(pt => (
                <button
                  key={pt}
                  onClick={() => setProductType(pt as any)}
                  style={{ flex: 1, backgroundColor: productType === pt ? '#0284c7' : '#090d15', color: productType === pt ? 'white' : '#94a3b8', border: '1px solid #1e293b', padding: '6px', borderRadius: 4, fontSize: 11, fontWeight: 'bold', cursor: 'pointer' }}
                >
                  {pt}
                </button>
              ))}
            </div>

            {/* Order Type (MARKET / LIMIT / SL / SL-M) */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
              {['MARKET', 'LIMIT', 'SL', 'SL-M'].map(ot => (
                <button
                  key={ot}
                  onClick={() => setOrderType(ot as any)}
                  style={{ flex: 1, backgroundColor: orderType === ot ? '#334155' : '#090d15', color: orderType === ot ? 'white' : '#64748b', border: '1px solid #1e293b', padding: '5px', borderRadius: 4, fontSize: 10.5, fontWeight: 'bold', cursor: 'pointer' }}
                >
                  {ot}
                </button>
              ))}
            </div>

            {orderType === 'LIMIT' && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Limit Price:</div>
                <input
                  type="number"
                  placeholder={String(orderModalLeg.entry_price ?? orderModalLeg.price ?? 0)}
                  value={limitPrice}
                  onChange={e => setLimitPrice(e.target.value)}
                  style={{ width: '100%', backgroundColor: '#090d15', border: '1px solid #1e293b', borderRadius: 4, padding: '6px 8px', color: 'white', fontSize: 12, outline: 'none' }}
                />
              </div>
            )}

            {(orderType === 'SL' || orderType === 'SL-M') && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Trigger Price:</div>
                <input
                  type="number"
                  placeholder={String(orderModalLeg.entry_price ?? orderModalLeg.price ?? 0)}
                  value={triggerPrice}
                  onChange={e => setTriggerPrice(e.target.value)}
                  style={{ width: '100%', backgroundColor: '#090d15', border: '1px solid #1e293b', borderRadius: 4, padding: '6px 8px', color: 'white', fontSize: 12, outline: 'none' }}
                />
              </div>
            )}

            {/* Lots & Quantity */}
            <div style={{ backgroundColor: '#090d15', padding: 12, borderRadius: 8, border: '1px solid #1e293b', marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>Lots ({lotSize} Qty/Lot):</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button onClick={() => setOrderLots(Math.max(1, orderLots - 1))} style={{ backgroundColor: '#141d2e', border: 'none', color: 'white', width: 28, height: 28, borderRadius: 4, cursor: 'pointer' }}>-</button>
                  <span style={{ fontSize: 14, fontWeight: 'bold', color: 'white' }}>{orderLots}</span>
                  <button onClick={() => setOrderLots(orderLots + 1)} style={{ backgroundColor: '#141d2e', border: 'none', color: 'white', width: 28, height: 28, borderRadius: 4, cursor: 'pointer' }}>+</button>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b' }}>
                <span>Total Quantity: {orderLots * lotSize}</span>
                <span>Execution Price: {currency === 'INR' ? '₹' : '$'}{(orderModalLeg.entry_price ?? orderModalLeg.price ?? 0).toFixed(2)}</span>
              </div>
            </div>

            {/* Buy / Sell Buttons */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => handleExecuteSingleTrade('BUY')}
                disabled={isTrading}
                style={{ flex: 1, backgroundColor: '#059669', color: 'white', border: 'none', padding: '12px', borderRadius: 6, fontWeight: 'bold', fontSize: 13, cursor: 'pointer' }}
              >
                BUY @ {currency === 'INR' ? '₹' : '$'}{(orderModalLeg.entry_price ?? orderModalLeg.price ?? 0).toFixed(2)}
              </button>
              <button
                onClick={() => handleExecuteSingleTrade('SELL')}
                disabled={isTrading}
                style={{ flex: 1, backgroundColor: '#dc2626', color: 'white', border: 'none', padding: '12px', borderRadius: 6, fontWeight: 'bold', fontSize: 13, cursor: 'pointer' }}
              >
                SELL @ {currency === 'INR' ? '₹' : '$'}{(orderModalLeg.entry_price ?? orderModalLeg.price ?? 0).toFixed(2)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. MODAL: ASSET SELECTOR */}
      {showAssetModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ backgroundColor: '#101624', border: '1px solid #24324f', borderRadius: 14, padding: 22, width: '90%', maxWidth: 440, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 15, fontWeight: 'bold', color: 'white' }}>Select Underlying Asset</span>
              <button onClick={() => setShowAssetModal(false)} style={{ backgroundColor: 'transparent', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Object.entries(ASSET_CONFIG).map(([key, cfg]) => (
                <button
                  key={key}
                  onClick={() => { setActiveAsset(key); setShowAssetModal(false); }}
                  style={{
                    backgroundColor: activeAsset === key ? '#0284c7' : '#090d15',
                    color: activeAsset === key ? 'white' : '#94a3b8',
                    border: '1px solid #1e293b',
                    padding: '10px 14px',
                    borderRadius: 6,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'pointer'
                  }}
                >
                  <span style={{ fontWeight: 'bold' }}>{cfg.name}</span>
                  <span style={{ fontSize: 11, color: '#64748b' }}>{cfg.category}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 8. MODAL: READY-MADE STRATEGY SELECTOR */}
      {showReadyModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ backgroundColor: '#101624', border: '1px solid #24324f', borderRadius: 14, padding: 22, width: '90%', maxWidth: 500, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 15, fontWeight: 'bold', color: 'white' }}>⚡ Preset Options Strategies</span>
              <button onClick={() => setShowReadyModal(false)} style={{ backgroundColor: 'transparent', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {Object.entries(CATEGORIZED_STRATEGIES).map(([category, strats]) => (
                <div key={category}>
                  <div style={{ fontSize: 11, fontWeight: 'bold', color: '#38bdf8', marginBottom: 6, textTransform: 'uppercase' }}>{category}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                    {strats.map((strat: any) => (
                      <button
                        key={strat.name}
                        onClick={() => {
                          const basket = buildStrategyBasket(strat.name, currentChain, atmStrike, activeAsset, activeExpiry || expiries[0], 1, undefined, 0, 0, expiries);
                          if (basket.length > 0) {
                            setStratBasket(basket);
                            setShowReadyModal(false);
                            setActiveTab('strategy');
                            setTradeMessage(`✓ Loaded ${strat.name} (${basket.length} Legs)`);
                            setTimeout(() => setTradeMessage(''), 3000);
                          }
                        }}
                        style={{ backgroundColor: '#090d15', border: '1px solid #1e293b', padding: '8px 10px', borderRadius: 6, color: 'white', textAlign: 'left', cursor: 'pointer' }}
                      >
                        <div style={{ fontWeight: 'bold', fontSize: 12 }}>{strat.name}</div>
                        <div style={{ fontSize: 10, color: '#64748b' }}>{strat.legs?.length || 2} Legs</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 9. MODAL: PAYOFF CHART */}
      {showPayoffModal && payoffData.length > 0 && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ backgroundColor: '#101624', border: '1px solid #24324f', borderRadius: 14, padding: 22, width: '90%', maxWidth: 580 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 15, fontWeight: 'bold', color: 'white' }}>📈 Expiry Payoff Curve</span>
              <button onClick={() => setShowPayoffModal(false)} style={{ backgroundColor: 'transparent', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ height: 260, width: '100%' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={payoffData}>
                  <XAxis dataKey="price" stroke="#64748b" fontSize={10} />
                  <YAxis stroke="#64748b" fontSize={10} />
                  <Tooltip contentStyle={{ backgroundColor: '#090d15', border: '1px solid #1e293b', color: 'white' }} />
                  <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="pnl" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
