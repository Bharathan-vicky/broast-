import React from 'react';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import './App.css';
import { Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, ComposedChart, Bar, ReferenceDot } from 'recharts';
import { CATEGORIZED_STRATEGIES, buildStrategyBasket } from './strategies';
import type { OptionLeg } from './strategies';

// Standard Normal Cumulative Distribution Function
const cnd = (x: number) => {
    const a1 = 0.31938153, a2 = -0.356563782, a3 = 1.781477937, a4 = -1.821255978, a5 = 1.330274429;
    const L = Math.abs(x);
    const K = 1.0 / (1.0 + 0.2316419 * L);
    const w = 1.0 - 1.0 / Math.sqrt(2 * Math.PI) * Math.exp(-L * L / 2) * (a1 * K + a2 * K * K + a3 * Math.pow(K, 3) + a4 * Math.pow(K, 4) + a5 * Math.pow(K, 5));
    if (x < 0) {
        return 1.0 - w;
    }
    return w;
};

// Black-Scholes formula
// S: Spot price, K: Strike price, T: Time to maturity in years, r: Risk-free rate, v: Volatility (IV)
const blackScholes = (type: 'CALL' | 'PUT', S: number, K: number, T: number, r: number, v: number) => {
    if (T <= 0 || v <= 0) {
        return type === 'CALL' ? Math.max(0, S - K) : Math.max(0, K - S);
    }
    const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T));
    const d2 = d1 - v * Math.sqrt(T);
    
    if (type === 'CALL') {
        return S * cnd(d1) - K * Math.exp(-r * T) * cnd(d2);
    } else {
        return K * Math.exp(-r * T) * cnd(-d2) - S * cnd(-d1);
    }
};

interface Account {
    id: number;
    name: string;
    margin_type: 'Cross' | 'Isolated';
    balance: number;
    currency: string;
}

function NiftyTerminal() {
  const navigate = useNavigate();
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef<boolean>(false);
  const [activeAsset, setActiveAsset] = useState('NIFTY');
  const [activeExpiry, setActiveExpiry] = useState<string>('');
  
  const [expiries, setExpiries] = useState<string[]>([]);
  const [chainByExpiry, setChainByExpiry] = useState<any>({});
  const [portfolio, setPortfolio] = useState<any>(null);
  const [tradeMessage, setTradeMessage] = useState('');
  const [spotPrice, setSpotPrice] = useState<number | null>(null);
  const [spotChange, setSpotChange] = useState<number>(0);
  const [spotPercentChange, setSpotPercentChange] = useState<number>(0);
  const [timeToExpiry, setTimeToExpiry] = useState<string>('');
  const [showLeverageModal, setShowLeverageModal] = useState(false);
  const [leverage, setLeverage] = useState(200);
  const [targetPrice, setTargetPrice] = useState<number | null>(null);
  const [targetDate, setTargetDate] = useState<number>(Date.now());
  const [activeTab, setActiveTab] = useState<'Chart'|'PNL'|'Greeks'>('Chart');

  // Multi-Account & Custom Available Margin State (NIFTY INR - Max 10 Accounts)
  const [accounts, setAccounts] = useState<Account[]>([
    { id: 1, name: 'Acc 1', margin_type: 'Cross', balance: 1000000.0, currency: 'INR' },
    { id: 2, name: 'Acc 2', margin_type: 'Cross', balance: 1000000.0, currency: 'INR' },
    { id: 3, name: 'Acc 3', margin_type: 'Cross', balance: 1000000.0, currency: 'INR' },
    { id: 4, name: 'Acc 4', margin_type: 'Cross', balance: 1000000.0, currency: 'INR' },
    { id: 5, name: 'Acc 5', margin_type: 'Cross', balance: 1000000.0, currency: 'INR' },
    { id: 6, name: 'Acc 6', margin_type: 'Cross', balance: 1000000.0, currency: 'INR' },
    { id: 7, name: 'Acc 7', margin_type: 'Cross', balance: 1000000.0, currency: 'INR' },
    { id: 8, name: 'Acc 8', margin_type: 'Cross', balance: 1000000.0, currency: 'INR' },
    { id: 9, name: 'Acc 9', margin_type: 'Cross', balance: 1000000.0, currency: 'INR' },
    { id: 10, name: 'Acc 10', margin_type: 'Cross', balance: 1000000.0, currency: 'INR' }
  ]);
  const [activeAccountId, setActiveAccountId] = useState<number>(1);
  const [showAccountModal, setShowAccountModal] = useState<boolean>(false);
  const [showMarginCustomizer, setShowMarginCustomizer] = useState<boolean>(false);
  const [newAccName, setNewAccName] = useState('');
  const [newAccBalance, setNewAccBalance] = useState<number>(1000000);
  const [newAccType, setNewAccType] = useState<'Cross' | 'Isolated'>('Cross');
  const [customBalanceInput, setCustomBalanceInput] = useState<number>(1000000);
  const [accountError, setAccountError] = useState('');

  // Groww-Style Option Pricing & Brokerage Calculator State
  const [showCalculatorModal, setShowCalculatorModal] = useState<boolean>(false);
  const [calcQty, setCalcQty] = useState<number>(65); // 1 Lot = 65 default
  const [calcBuyPrice, setCalcBuyPrice] = useState<number>(100.0);
  const [calcSellPrice, setCalcSellPrice] = useState<number>(150.0);
  const [calcSegment, setCalcSegment] = useState<'F&O' | 'Equity - intraday' | 'Equity - delivery'>('F&O');

  const activeAccount = accounts.find(a => a.id === activeAccountId) || accounts[0];

  useEffect(() => {
    fetch('http://127.0.0.1:8000/api/accounts?currency=INR')
      .then(r => r.json())
      .then(data => { 
        if (Array.isArray(data) && data.length > 0) {
          setAccounts(data);
          setActiveAccountId(prev => data.some((a: any) => a.id === prev) ? prev : data[0].id);
        }
      })
      .catch(() => {});
  }, []);

  const handleCreateAccount = () => {
    if (!newAccName.trim()) return;
    if (accounts.length >= 10) {
      setAccountError("Limit reached: You can create a maximum of 10 Nifty sub-accounts.");
      return;
    }
    setAccountError('');
    fetch('http://127.0.0.1:8000/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newAccName,
        balance: Number(newAccBalance) || 1000000,
        margin_type: newAccType,
        currency: 'INR'
      })
    })
    .then(r => r.json())
    .then(data => {
      if (data.status === 'success' && data.account) {
        setAccounts(prev => [...prev, data.account]);
        setActiveAccountId(data.account.id);
        setShowAccountModal(false);
        setNewAccName('');
        setAccountError('');
      } else if (data.message) {
        setAccountError(data.message);
      }
    })
    .catch(() => setAccountError('Failed to create account'));
  };

  const [editingAccount, setEditingAccount] = useState<any | null>(null);
  const [editAccName, setEditAccName] = useState('');
  const [editAccMarginType, setEditAccMarginType] = useState('Cross');
  const [editAccBalance, setEditAccBalance] = useState<number>(1000000);

  const handleOpenEditAccount = (acc: any) => {
    setEditingAccount(acc);
    setEditAccName(acc.name);
    setEditAccMarginType(acc.margin_type || 'Cross');
    setEditAccBalance(acc.balance);
    setShowAccountModal(false);
  };

  const handleUpdateAccount = () => {
    if (!editingAccount || !editAccName.trim()) return;
    fetch('http://127.0.0.1:8000/api/accounts/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: editingAccount.id,
        name: editAccName.trim(),
        balance: editAccBalance,
        margin_type: editAccMarginType
      })
    })
    .then(r => r.json())
    .then(data => {
      if (data.status === 'success') {
        setAccounts(prev => prev.map(a => a.id === editingAccount.id ? {
          ...a,
          name: editAccName.trim(),
          balance: editAccBalance,
          margin_type: (editAccMarginType === 'Isolated' ? 'Isolated' : 'Cross') as 'Cross' | 'Isolated'
        } : a));
        setEditingAccount(null);
      }
    })
    .catch(() => {});
  };

  const handleDeleteAccount = (accId: number) => {
    if (accounts.length <= 1) {
      alert("Cannot delete the only remaining account.");
      return;
    }
    if (!confirm("Are you sure you want to delete this sub-account?")) return;
    fetch('http://127.0.0.1:8000/api/accounts/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accId })
    })
    .then(r => r.json())
    .then(data => {
      if (data.status === 'success') {
        const remaining = accounts.filter(a => a.id !== accId);
        setAccounts(remaining);
        if (activeAccountId === accId && remaining.length > 0) {
          setActiveAccountId(remaining[0].id);
        }
        setEditingAccount(null);
      }
    })
    .catch(() => {});
  };

  const handleSaveCustomMargin = (amt: number) => {
    fetch('http://127.0.0.1:8000/api/accounts/update_balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: activeAccountId, balance: amt })
    })
    .then(r => r.json())
    .then(() => {
      setAccounts(prev => prev.map(a => a.id === activeAccountId ? { ...a, balance: amt } : a));
      setShowMarginCustomizer(false);
    })
    .catch(() => {});
  };
  
  useEffect(() => {
    if (spotPrice && targetPrice === null) setTargetPrice(spotPrice);
  }, [spotPrice]);
  // Hover state for Buy/Sell buttons
  const [hoveredCell, setHoveredCell] = useState<{strike: number, side: 'CALL'|'PUT'} | null>(null);

  // Strategy Builder State (NIFTY - 1 Lot = 65 units default)
  const [showBuilder, setShowBuilder] = useState(true);
  const [stratBasket, setStratBasket] = useState<OptionLeg[]>([]);
  const [strategy, setStrategy] = useState('Custom');
  const [stratSize, setStratSize] = useState(1);
  const [portfolioTab, setPortfolioTab] = useState('Positions');
  const [orderHistory, setOrderHistory] = useState<any[]>([]);

  // Table Column Visibility State
  const [showColSettings, setShowColSettings] = useState(false);
  const [cols, setCols] = useState({
      oi: true,
      price: true,
      delta: true,
      volume: false,
      bidAsk: false,
      qty: false,
      mark: false
  });

  const todayStart = useMemo(() => new Date(new Date().setHours(0,0,0,0)).getTime(), []);
  const minExpiry = useMemo(() => {
    return stratBasket.length > 0 ? Math.min(...stratBasket.map(l => new Date(l.expiry).getTime())) : todayStart + 86400000;
  }, [stratBasket, todayStart]);
  
  const MS_PER_DAY = 86400000;
  const daysDiff = Math.max(0, Math.floor((minExpiry - todayStart) / MS_PER_DAY));
  const computedSliderMin = minExpiry - (daysDiff * MS_PER_DAY);
  
  useEffect(() => {
     if (targetDate > minExpiry) setTargetDate(minExpiry);
     if (targetDate < computedSliderMin) setTargetDate(computedSliderMin);
  }, [minExpiry, computedSliderMin]);

  // Multi-asset cache for instant 0ms switching
  const [assetCache, setAssetCache] = useState<Record<string, any>>({});

  const switchAsset = (newAsset: string) => {
      setActiveAsset(newAsset);
      setStratBasket([]); // Reset strategy basket for the new underlying asset
      if (assetCache[newAsset]) {
          const cached = assetCache[newAsset];
          if (cached.expiries && cached.expiries.length > 0) {
              setExpiries(cached.expiries);
              setActiveExpiry(cached.expiries[0]);
          }
          if (cached.chainByExpiry) {
              setChainByExpiry(cached.chainByExpiry);
          }
          if (cached.spotPrice) {
              setSpotPrice(cached.spotPrice);
          }
      }
  };
  void switchAsset;

  // Prefetch all assets on mount
  useEffect(() => {
      const assets = ['BTC', 'ETH', 'XAUT', 'NIFTY'];
      assets.forEach(asset => {
          const chainApi = asset === 'NIFTY' ? '/api/nifty/chain' : '/api/options/chain';
          const spotApi = asset === 'NIFTY' ? '/api/nifty/spot' : '/api/spot';
          Promise.all([
              fetch(`http://127.0.0.1:8000${chainApi}?asset=${asset}`).then(r => r.json()),
              fetch(`http://127.0.0.1:8000${spotApi}?asset=${asset}`).then(r => r.json()).catch(() => ({ spot_price: null }))
          ]).then(([chainData, spotData]) => {
              const exp = chainData.expiries || [];
              const chain = chainData.chainByExpiry || {};
              const spot = spotData.spot_price || null;
              
              setAssetCache(prev => ({
                  ...prev,
                  [asset]: {
                      expiries: exp,
                      chainByExpiry: chain,
                      spotPrice: spot
                  }
              }));
              
              if (asset === activeAsset) {
                  if (exp.length > 0) {
                      setExpiries(exp);
                      setActiveExpiry(prev => (prev && exp.includes(prev)) ? prev : exp[0]);
                  }
                  if (chain) setChainByExpiry(chain);
                  if (spot) setSpotPrice(spot);
              }
          }).catch(() => {});
      });
  }, []);

  useEffect(() => {
    const chainApi = activeAsset === 'NIFTY' ? '/api/nifty/chain' : '/api/options/chain';
    const spotApi = activeAsset === 'NIFTY' ? '/api/nifty/spot' : '/api/spot';
    
    fetch(`http://127.0.0.1:8000${chainApi}?asset=${activeAsset}`)
      .then(res => res.json())
      .then(data => {
        if (data.expiries && data.expiries.length > 0) {
          setExpiries(data.expiries);
          setActiveExpiry(prev => (prev && data.expiries.includes(prev)) ? prev : data.expiries[0]);
        }
        if (data.chainByExpiry) setChainByExpiry(data.chainByExpiry);
      })
      .catch(err => console.error("API error:", err));
      
    fetch(`http://127.0.0.1:8000${spotApi}?asset=${activeAsset}`)
      .then(res => res.json())
      .then(data => { if (data.spot_price) { const p = typeof data.spot_price === "object" ? Number(data.spot_price?.spot_price) : Number(data.spot_price); setSpotPrice(p || 24231.85); } })
      .catch(() => {});
  }, [activeAsset]);

  // High-Frequency 1-Second Zero-Lag Market Streamer
  const [syncLatency, setSyncLatency] = useState<number>(4);
  const [_lastSyncTs, setLastSyncTs] = useState<number>(Date.now());
  void _lastSyncTs;

  useEffect(() => {
    const fetchMarketTick = () => {
      const start = performance.now();
      const chainApi = activeAsset === 'NIFTY' ? '/api/nifty/chain' : '/api/options/chain';
      const spotApi = activeAsset === 'NIFTY' ? '/api/nifty/spot' : '/api/spot';
      
      // 1. Fetch live Option Chain (0ms in-memory cache)
      fetch(`http://127.0.0.1:8000${chainApi}?asset=${activeAsset}`)
        .then(res => res.json())
        .then(data => { 
          const lat = Math.round(performance.now() - start);
          setSyncLatency(lat > 0 ? lat : 2);
          setLastSyncTs(Date.now());
          if (data.expiries && data.expiries.length > 0) {
            setExpiries(prev => prev.length === 0 ? data.expiries : prev);
            setActiveExpiry(prev => prev || data.expiries[0]);
          }
          if (data.chainByExpiry) {
            setChainByExpiry(data.chainByExpiry);
            setAssetCache(prev => ({
                ...prev,
                [activeAsset]: {
                    ...(prev[activeAsset] || { expiries: data.expiries || [] }),
                    chainByExpiry: data.chainByExpiry
                }
            }));
          }
        })
        .catch(() => {});
        
      // 2. Fetch live Spot
      fetch(`http://127.0.0.1:8000${spotApi}?asset=${activeAsset}`)
        .then(res => res.json())
        .then(data => {
          if (data.spot_price !== undefined && data.spot_price !== null) {
            const p = typeof data.spot_price === "object" ? Number(data.spot_price?.spot_price) : Number(data.spot_price); 
            setSpotPrice(p || 24231.85);
            if (data.change !== undefined) setSpotChange(Number(data.change));
            if (data.percent_change !== undefined) setSpotPercentChange(Number(data.percent_change));
            setAssetCache(prev => ({
                ...prev,
                [activeAsset]: {
                    ...(prev[activeAsset] || { expiries: [], chainByExpiry: {} }),
                    spotPrice: data.spot_price
                }
            }));
          }
        })
        .catch(() => {});
    };

    fetchMarketTick();
    const interval = setInterval(fetchMarketTick, 300);
    return () => clearInterval(interval);
  }, [activeAsset]);

  // High-Frequency 1-Second Live Positions & Portfolio Streamer
  useEffect(() => {
    const fetchUserData = () => {
      const accId = activeAccountId || 1;
      fetch(`http://127.0.0.1:8000/api/portfolio?account_id=${accId}`)
        .then(res => res.json())
        .then(data => setPortfolio(data))
        .catch(() => {});
        
      fetch(`http://127.0.0.1:8000/api/history?account_id=${accId}`)
        .then(res => res.json())
        .then(setOrderHistory)
        .catch(() => {});
    };

    fetchUserData();
    const interval = setInterval(fetchUserData, 300);
    return () => clearInterval(interval);
  }, [activeAccountId]);

  // Synchronize activeExpiry if expiries changes
  useEffect(() => {
    if (expiries.length > 0) {
      setActiveExpiry(prev => (prev && expiries.includes(prev)) ? prev : expiries[0]);
    }
  }, [expiries]);

  const effectiveExpiry = activeExpiry || (expiries.length > 0 ? expiries[0] : '');


  useEffect(() => {
    if (!effectiveExpiry) return;
    const interval = setInterval(() => {
       const expiryDate = new Date(effectiveExpiry);
       const now = new Date();
       const diff = expiryDate.getTime() - now.getTime();
       if (isNaN(diff)) {
           setTimeToExpiry("Invalid Date");
       } else if (diff <= 0) {
           setTimeToExpiry("Expired");
       } else {
           const d = Math.floor(diff / (1000 * 60 * 60 * 24));
           const h = Math.floor((diff / (1000 * 60 * 60)) % 24);
           const m = Math.floor((diff / 1000 / 60) % 60);
           setTimeToExpiry(`${d}d:${h}h:${m}m`);
       }
    }, 1000);
    return () => clearInterval(interval);
  }, [effectiveExpiry]);

  const currentChain = (effectiveExpiry && Array.isArray(chainByExpiry[effectiveExpiry])) ? chainByExpiry[effectiveExpiry] : [];

  // Auto-scroll to ATM strike when chain loads or expiry changes
  useEffect(() => {
    if (currentChain.length > 0 && spotPrice && typeof spotPrice === 'number') {
      let atm: number | null = null;
      let minD = Infinity;
      currentChain.forEach((r: any) => {
        const d = Math.abs(r.strike - (spotPrice as number));
        if (d < minD) { minD = d; atm = r.strike; }
      });
      if (atm) {
        const timer = setTimeout(() => {
          const el = document.getElementById(`strike-row-${atm}`);
          if (el) {
            el.scrollIntoView({ behavior: initialScrollDone.current ? 'smooth' : 'auto', block: 'center' });
            initialScrollDone.current = true;
          }
        }, 80);
        return () => clearTimeout(timer);
      }
    }
  }, [currentChain.length, effectiveExpiry]);

  
  let atmStrike: number | null = null;
  if (spotPrice && currentChain.length > 0) {
     let minDiff = Infinity;
     currentChain.forEach((row: any) => {
        const diff = Math.abs(row.strike - spotPrice);
        if (diff < minDiff) { minDiff = diff; atmStrike = row.strike; }
     });
  }
  
  const payoffData = useMemo(() => {
     if (!spotPrice || !stratBasket.length) return [];
     
     // Scope price range around active strikes in chain (±3.5% around spot)
     const minSpot = Math.round(spotPrice * 0.965);
     const maxSpot = Math.round(spotPrice * 1.035);
     const step = (maxSpot - minSpot) / 35;
     
     let prices = new Set<number>();
     for (let i = 0; i <= 35; i++) {
         prices.add(Math.round(minSpot + step * i));
     }
     currentChain.forEach((c:any) => {
         if (c.strike >= minSpot && c.strike <= maxSpot) prices.add(c.strike);
     });
     let priceArray = Array.from(prices).sort((a, b) => a - b);
           const data = priceArray.map(price => {
          let pnlTarget = 0;
          let pnlExpiry = 0;
          const NIFTY_LOT_SIZE = 65;
          stratBasket.forEach(leg => {
             const cv = NIFTY_LOT_SIZE;
             const entryPrice = (leg.order_type === 'LIMIT' && leg.limit_price !== undefined) ? leg.limit_price : (leg.price || 0); 
             
             // Expiry PNL (Intrinsic * Lots * 65)
             let intrinsic = leg.option_type === 'CALL' ? Math.max(0, price - leg.strike) : Math.max(0, leg.strike - price);
             pnlExpiry += (leg.side === 'BUY' ? intrinsic - entryPrice : entryPrice - intrinsic) * leg.size * cv;
             
             // Target Date PNL (Black-Scholes * Lots * 65)
             const legExpiryTime = new Date(leg.expiry).getTime();
             const T = Math.max(0, legExpiryTime - targetDate) / (1000 * 60 * 60 * 24 * 365);
             
             const chain = chainByExpiry[leg.expiry] || [];
             const row = chain.find((r:any) => r.strike === leg.strike);
             let iv = 0.135; // Default Nifty IV
             if (row) iv = leg.option_type === 'CALL' ? (row.callIV || 0.135) : (row.putIV || 0.135);
             if (iv > 1) iv = iv / 100;
             
             let theoretical = blackScholes(leg.option_type, price, leg.strike, T, 0.065, iv);
             pnlTarget += (leg.side === 'BUY' ? theoretical - entryPrice : entryPrice - theoretical) * leg.size * cv;
          });
          
          let callOI_INR = 0;
          let putOI_INR = 0;
          const isStrike = currentChain.find((c:any) => c.strike === price);
          if (isStrike) {
              const sp = typeof spotPrice === 'number' ? spotPrice : 24250;
              callOI_INR = (isStrike.callOI || 0) * sp;
              putOI_INR = - (isStrike.putOI || 0) * sp; // Negative to render downwards
          }
          return { price, pnlTarget, pnlExpiry, callOI_INR, putOI_INR };
      });
      return data;
   }, [stratBasket, spotPrice, currentChain, targetDate]);

  const { maxProfit, maxLoss, breakeven } = useMemo(() => {
      if (!payoffData.length) return { maxProfit: '-', maxLoss: '-', breakeven: '-' };
      
      const pnlsExpiry = payoffData.map(d => d.pnlExpiry);
      const mpE = Math.max(...pnlsExpiry);
      const mlE = Math.min(...pnlsExpiry);
      
      let mpStr = mpE > 0 ? `₹${mpE.toFixed(2)}` : '0.00 INR';
      let mlStr = mlE < 0 ? `-₹${Math.abs(mlE).toFixed(2)}` : '0.00 INR';
      
      const first = payoffData[0]?.pnlExpiry || 0;
      const second = payoffData[1]?.pnlExpiry || 0;
      const last = payoffData[payoffData.length-1]?.pnlExpiry || 0;
      const secondLast = payoffData[payoffData.length-2]?.pnlExpiry || 0;
      
      if (first - second > 0.01 || last - secondLast > 0.01) {
          mpStr = 'Unlimited';
      }
      
      if (first - second < -0.01 || last - secondLast < -0.01) {
          mlStr = 'Unlimited';
      }
      
      let be: number[] = [];
      
      if (first > 0 && mlE > 0) return { maxProfit: mpStr, maxLoss: mlStr, breakeven: 'None' };
      if (first < 0 && mpE < 0) return { maxProfit: mpStr, maxLoss: mlStr, breakeven: 'None' };
      
      for(let i=0; i<payoffData.length-1; i++) {
          if ((payoffData[i].pnlExpiry < 0 && payoffData[i+1].pnlExpiry > 0) || (payoffData[i].pnlExpiry > 0 && payoffData[i+1].pnlExpiry < 0)) {
              be.push(payoffData[i].price);
          }
      }
      
      return { maxProfit: mpStr, maxLoss: mlStr, breakeven: be.length ? be.join(', ') : 'NA' };
  }, [payoffData]);

  const yAxisDomains = useMemo(() => {
      if (!payoffData.length) return { left: ['auto', 'auto'], right: ['auto', 'auto'] };
      const pnlValues = payoffData.flatMap(d => [d.pnlTarget, d.pnlExpiry]);
      let maxPnl = Math.max(...pnlValues);
      let minPnl = Math.min(...pnlValues);
      
      if (maxPnl <= 0) maxPnl = 10;
      if (minPnl >= 0) minPnl = -10; // Ensure both positive and negative space exists to draw 0 line
      
      const pnlTop = maxPnl * 1.15;
      const pnlBottom = minPnl * 1.15;
      
      const maxCallOi = Math.max(...payoffData.map(d => d.callOI_INR || 0)) || 10000000;
      const maxPutOi = Math.max(...payoffData.map(d => Math.abs(d.putOI_INR || 0))) || 10000000;
      
      let oiTop = maxCallOi * 1.15;
      let oiBottom = -maxPutOi * 1.15;
      
      // Align 0-lines by equating the top/bottom ratio
      const pnlRatio = pnlTop / Math.abs(pnlBottom);
      const oiRatio = oiTop / Math.abs(oiBottom);
      
      if (pnlRatio > oiRatio) {
          oiTop = Math.abs(oiBottom) * pnlRatio;
      } else {
          oiBottom = - (oiTop / pnlRatio);
      }
      
      return {
          left: [pnlBottom, pnlTop],
          right: [oiBottom, oiTop]
      };
  }, [payoffData]);

  const projectedPNL = useMemo(() => {
      if (targetPrice === null || !stratBasket.length) return 0;
      const point = payoffData.find(d => d.price >= targetPrice);
      return point ? point.pnlTarget : 0;
  }, [targetPrice, stratBasket, payoffData]);

  const orderMargin = useMemo(() => {
      if (!stratBasket.length) return 0;
      const NIFTY_LOT_SIZE = 65;
      const sp = typeof spotPrice === 'number' ? spotPrice : 24250.0;
      
      const buyLegs = stratBasket.filter(l => l.side === 'BUY');
      const sellLegs = stratBasket.filter(l => l.side === 'SELL');
      
      // 1. All Option Buying: simple premium
      let buyPremium = 0;
      buyLegs.forEach(l => {
          const p = (l.order_type === 'LIMIT' && l.limit_price !== undefined) ? l.limit_price : (l.price || 0);
          buyPremium += p * NIFTY_LOT_SIZE * (l.size || 1);
      });
      
      if (sellLegs.length === 0) {
          return buyPremium;
      }
      
      // 2. Option Selling Legs with NSE SPAN + Exposure Margining
      const sellCalls = sellLegs.filter(l => l.option_type === 'CALL');
      const sellPuts = sellLegs.filter(l => l.option_type === 'PUT');
      
      const sellCallLots = sellCalls.reduce((s, l) => s + (l.size || 1), 0);
      const sellPutLots = sellPuts.reduce((s, l) => s + (l.size || 1), 0);
      
      // Base SPAN per naked lot (~8.2% spot * 65 = ~₹1,29,000) + Exposure (~2% spot * 65 = ~₹31,500)
      const baseSpanPerLot = 0.082 * sp * NIFTY_LOT_SIZE;
      const exposurePerLot = 0.020 * sp * NIFTY_LOT_SIZE;
      const nakedMarginPerLot = baseSpanPerLot + exposurePerLot; // ~₹1,60,500 base per lot
      
      // Check for Short Straddle / Strangle (both sell calls and sell puts)
      if (sellCallLots > 0 && sellPutLots > 0) {
          // Dominant side gets full SPAN, non-dominant gets incremental exposure + premium
          const maxLots = Math.max(sellCallLots, sellPutLots);
          const minLots = Math.min(sellCallLots, sellPutLots);
          
          const dominantMargin = maxLots * nakedMarginPerLot;
          const hedgeBenefitOffset = minLots * (nakedMarginPerLot * 0.725); // 72.5% portfolio hedge discount on concurrent opposing sell
          
          const netStraddleMargin = (dominantMargin + minLots * nakedMarginPerLot) - hedgeBenefitOffset;
          // Matches Groww / Zerodha exact range (~₹2,04,000 per 1 lot straddle)
          return Math.max(buyPremium + netStraddleMargin, buyPremium);
      }
      
      // Check for Hedged Vertical Spreads (Sell leg protected by Buy leg)
      let netSellMargin = 0;
      sellLegs.forEach(sLeg => {
          const sPrice = (sLeg.order_type === 'LIMIT' && sLeg.limit_price !== undefined) ? sLeg.limit_price : (sLeg.price || 0);
          const sLots = sLeg.size || 1;
          
          // Look for matching hedge in buyLegs
          const hedge = buyLegs.find(bLeg => 
              bLeg.option_type === sLeg.option_type &&
              ((sLeg.option_type === 'CALL' && bLeg.strike > sLeg.strike) ||
               (sLeg.option_type === 'PUT' && bLeg.strike < sLeg.strike))
          );
          
          if (hedge) {
              // Hedged Spread: Max Risk = Spread Width * 65 * lots + safety buffer
              const spreadWidth = Math.abs(hedge.strike - sLeg.strike);
              const maxRisk = spreadWidth * NIFTY_LOT_SIZE * sLots;
              netSellMargin += Math.min(nakedMarginPerLot * sLots, maxRisk + (0.015 * sp * NIFTY_LOT_SIZE * sLots));
          } else {
              // Naked Sell
              netSellMargin += (nakedMarginPerLot + sPrice * NIFTY_LOT_SIZE) * sLots;
          }
      });
      
      return buyPremium + netSellMargin;
  }, [stratBasket, spotPrice]);

  // Standard NSE Equity Derivatives Fee Structure
  const tradingFees = useMemo(() => {
      const TRADING_FEE_RATE = 0.0005; // 0.05% Exchange + Brokerage
      const GST_RATE = 0.18;           // 18% GST
      const NIFTY_LOT_SIZE = 65;
      const sp = typeof spotPrice === 'number' ? spotPrice : 24250.0;

      let totalNotional = 0;
      let totalPremium = 0;
      stratBasket.forEach(leg => {
          const lots = leg.size || 1;
          const entryPrice = (leg.order_type === 'LIMIT' && leg.limit_price !== undefined) ? leg.limit_price : (leg.price || 0);
          totalNotional += lots * NIFTY_LOT_SIZE * sp;
          totalPremium += entryPrice * NIFTY_LOT_SIZE * lots;
      });

      const tradingFee = totalPremium * TRADING_FEE_RATE;
      const gst = tradingFee * GST_RATE;
      const totalFeesIncGST = tradingFee + gst;

      return {
          notionalValue: totalNotional,
          tradingFee,
          gst,
          totalFeesIncGST,
          settlementFee: 0,
          totalAllFees: totalFeesIncGST
      };
  }, [stratBasket, spotPrice]);

  const handleTrade = async (legs: any[], basketName: string) => {
    setTradeMessage('Executing...');
    try {
      const res = await fetch('http://127.0.0.1:8000/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basket_name: basketName, legs, account_id: activeAccountId })
      });
      const data = await res.json();
      setTradeMessage(data.message);
      if (data.status === 'success') {
        setStratBasket([]);
        fetch('http://127.0.0.1:8000/api/accounts').then(r=>r.json()).then(setAccounts);
        fetch(`http://127.0.0.1:8000/api/portfolio?account_id=${activeAccountId}`).then(r=>r.json()).then(setPortfolio);
      }
    } catch (err) {
      setTradeMessage('Failed to connect to API');
    }
  };

  const closePosition = async (basketId: number) => {
      try {
          const res = await fetch('http://127.0.0.1:8000/api/trade/close', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ basket_id: basketId, account_id: activeAccountId })
          });
          const data = await res.json();
          setTradeMessage(data.message);
          fetch(`http://127.0.0.1:8000/api/portfolio`).then(r=>r.json()).then(setPortfolio);
          fetch(`http://127.0.0.1:8000/api/history?account_id=${activeAccountId || 1}`).then(r=>r.json()).then(setOrderHistory);
          fetch('http://127.0.0.1:8000/api/accounts').then(r=>r.json()).then(setAccounts);
      } catch (err) {
          setTradeMessage('Failed to close position');
      }
  };

  const addLegToBasket = (side: 'BUY'|'SELL', type: 'CALL'|'PUT', row: any, size: number) => {
      const symbol = type === 'CALL' ? row.callSym : row.putSym;
      const price = type === 'CALL' ? (side === 'BUY' ? row.callAsk : row.callBid) : (side === 'BUY' ? row.putAsk : row.putBid);
      
      const existingIndex = stratBasket.findIndex(leg => leg.strike === row.strike && leg.option_type === type);
      
      if (existingIndex !== -1) {
          const existingLeg = stratBasket[existingIndex];
          if (existingLeg.side === side) {
              // TOGGLE OFF / DESELECT: Remove leg from strategy basket
              setStratBasket(stratBasket.filter((_, i) => i !== existingIndex));
              return;
          } else {
              // Switch side from BUY to SELL or SELL to BUY
              const newBasket = [...stratBasket];
              newBasket[existingIndex] = {
                  ...existingLeg,
                  side,
                  price: price || (type === 'CALL' ? row.callMark : row.putMark)
              };
              setStratBasket(newBasket);
              return;
          }
      } else {
          setStratBasket([...stratBasket, {
              symbol, underlying: activeAsset, strike: row.strike, expiry: activeExpiry,
              option_type: type, side, size, price: price || (type === 'CALL' ? row.callMark : row.putMark)
          }]);
      }
      setShowBuilder(true);
  };

  return (
    <div className="app-container">
      <div style={{display: 'flex', flexDirection: 'column'}}>
        {/* Top Tier Navigation */}
        <header style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 18px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-base)'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: '24px'}}>
             <div className="text-lg font-bold" style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                <span style={{background: 'var(--color-accent)', color: 'white', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', fontSize: '12px'}}>Δ</span>
                <span style={{fontSize: '14px', letterSpacing: '0.5px'}}>Delta Exchange</span>
             </div>
             
             {/* Main Nav Links */}
             <nav style={{display: 'flex', alignItems: 'center', gap: '24px', fontSize: '12px', fontWeight: 500}}>
                <span onClick={() => navigate('/')} style={{color: 'var(--text-secondary)', cursor: 'pointer'}}>Crypto Options</span>
                <div style={{display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '2px solid var(--color-accent)', paddingBottom: '12px', marginBottom: '-12px'}}>
                  <span onClick={() => navigate('/nifty')} style={{color: 'white', cursor: 'pointer', fontWeight: 'bold'}}>Nifty Options</span>
                  <div style={{display: 'flex', alignItems: 'center', gap: '5px', background: 'rgba(0, 192, 135, 0.12)', border: '1px solid rgba(0, 192, 135, 0.3)', padding: '2px 8px', borderRadius: '12px', fontSize: '10px', color: 'var(--color-up)', fontWeight: 600}}>
                    <span style={{display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: '#00c087', boxShadow: '0 0 8px #00c087'}}></span>
                    <span>Live NSE • 1s Sync • {syncLatency}ms</span>
                  </div>
                </div>
             </nav>
          </div>
          
          <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
              <button 
                  style={{background: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.3)', borderRadius: '4px', padding: '6px 12px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'}}
                  onClick={() => window.location.href = '/mobile'}
                  title="Switch to Mobile Terminal View"
              >
                  📱 Mobile App
              </button>

              <button 
                  style={{background: 'var(--color-accent)', color: 'white', border: 'none', borderRadius: '4px', padding: '6px 14px', fontSize: '11px', fontWeight: 600, cursor: 'pointer'}}
                  onClick={() => setShowAccountModal(true)}
                  title="Manage and create sub-accounts"
              >
                  + Add / Switch Account
              </button>
             
             {/* Account Selector Pill */}
             <div 
                style={{display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer'}}
                onClick={() => setShowAccountModal(true)}
                title="Click to switch or create sub-account"
             >
                <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: '1.2'}}>
                    <span style={{fontSize: '9px', color: 'var(--text-secondary)'}}>Account</span>
                    <span style={{fontSize: '9px', color: 'var(--text-secondary)'}}>Margin</span>
                </div>
                <div style={{display: 'flex', flexDirection: 'column', lineHeight: '1.2'}}>
                    <span style={{fontSize: '11px', fontWeight: 600, color: 'white'}}>{activeAccount?.name?.replace(' (Cross)','').replace(' (Isolated)','') || 'Account'} ⌄</span>
                    <span style={{color: activeAccount?.margin_type === 'Cross' ? 'var(--color-up)' : 'var(--color-accent)', fontSize: '10px'}}>{activeAccount?.margin_type || 'Cross'}</span>
                </div>
             </div>
             
             {/* Available Margin */}
             <div 
                 style={{display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '12px', cursor: 'pointer'}}
                 onClick={() => { setCustomBalanceInput(activeAccount?.balance || 0); setShowMarginCustomizer(true); }}
                 title="Customize Available Margin"
             >
                 <span style={{color: 'var(--text-secondary)'}}>₹</span>
                 <span style={{fontWeight: 'bold', color: 'white'}}>{Number(activeAccount?.balance || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                 {portfolio && portfolio.unrealized_pnl != null && portfolio.unrealized_pnl !== 0 && (
                     <span style={{fontSize: '10px', color: Number(portfolio.unrealized_pnl) >= 0 ? 'var(--color-up)' : 'var(--color-down)'}}>
                         ({Number(portfolio.unrealized_pnl) >= 0 ? '+' : ''}{Number(portfolio.unrealized_pnl).toFixed(2)})
                     </span>
                 )}
             </div>
          </div>
        </header>

        {/* Sub Tier Navigation */}
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 18px', borderBottom: '1px solid var(--border-color)', background: '#12151A'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: '24px'}}>
             <div style={{display: 'flex', alignItems: 'center', gap: '16px', fontSize: '11px', fontWeight: 600}}>
                <span style={{color: 'var(--color-accent)', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer'}}><span style={{fontSize: '14px'}}>☷</span> Option Chain</span>
                <span style={{color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer'}}><span style={{fontSize: '14px'}}>📈</span> Chart</span>
             </div>
          </div>
          
          <div style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '4px 10px', border: '1px solid var(--border-color)', borderRadius: '4px'}} onClick={() => setShowBuilder(!showBuilder)}>
              <span className="text-xs font-semibold" style={{color: showBuilder ? 'var(--color-accent)' : 'var(--text-secondary)', fontSize: '11px'}}>Strategy Builder</span>
              <div style={{width: '26px', height: '14px', background: showBuilder ? 'var(--color-accent)' : '#2a313e', borderRadius: '10px', position: 'relative'}}>
                  <div style={{width: '10px', height: '10px', background: 'white', borderRadius: '50%', position: 'absolute', top: '2px', left: showBuilder ? '14px' : '2px', transition: 'left 0.2s'}}></div>
              </div>
          </div>
        </div>
      </div>

      <main className="main-content" style={{display: 'flex', overflow: 'hidden'}}>
        <div className="options-view" style={{flex: 1, borderRight: showBuilder ? '1px solid var(--border-color)' : 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden'}}>
          
          <div className="options-toolbar">
            <div className="expiry-tabs">
              {expiries.map(exp => (
                <div 
                  key={exp} 
                  className={`expiry-tab ${effectiveExpiry === exp ? 'active' : ''}`}
                  onClick={() => setActiveExpiry(exp)}
                >
                  {new Date(exp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                </div>
              ))}
            </div>
            
            <div style={{display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', fontSize: '11px'}}>
                <span style={{cursor: 'pointer', padding: '2px 6px', border: '1px solid var(--border-color)', borderRadius: '3px', userSelect: 'none'}} onClick={() => {
                    const idx = expiries.indexOf(effectiveExpiry);
                    if (idx > 0) setActiveExpiry(expiries[idx - 1]);
                }}>‹</span>
                <span style={{cursor: 'pointer', padding: '2px 6px', border: '1px solid var(--border-color)', borderRadius: '3px', userSelect: 'none'}} onClick={() => {
                    const idx = expiries.indexOf(effectiveExpiry);
                    if (idx < expiries.length - 1) setActiveExpiry(expiries[idx + 1]);
                }}>›</span>
                
                {/* Column Settings Dropdown */}
                <div style={{position: 'relative', marginLeft: '6px'}}>
                    <span 
                        style={{cursor: 'pointer', padding: '2px 6px', border: '1px solid var(--border-color)', borderRadius: '3px', color: showColSettings ? 'var(--color-accent)' : 'inherit', userSelect: 'none'}} 
                        onClick={() => setShowColSettings(!showColSettings)}
                        title="Table Settings"
                    >
                        ☷
                    </span>
                    {showColSettings && (
                        <div style={{position: 'absolute', top: '100%', right: 0, marginTop: '4px', background: '#141822', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '12px', zIndex: 50, display: 'flex', gap: '20px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', whiteSpace: 'nowrap'}}>
                            <div style={{display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '100px'}}>
                                <label style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: cols.oi ? 'white' : 'var(--text-secondary)'}}>
                                    <input type="checkbox" checked={cols.oi} onChange={(e) => setCols({...cols, oi: e.target.checked})} style={{accentColor: 'var(--color-accent)'}}/> OI
                                </label>
                                <label style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: cols.bidAsk ? 'white' : 'var(--text-secondary)'}}>
                                    <input type="checkbox" checked={cols.bidAsk} onChange={(e) => setCols({...cols, bidAsk: e.target.checked})} style={{accentColor: 'var(--color-accent)'}}/> Bid/ Ask
                                </label>
                                <label style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', marginLeft: '20px', color: cols.qty ? 'white' : 'var(--text-secondary)'}}>
                                    <input type="checkbox" checked={cols.qty} onChange={(e) => setCols({...cols, qty: e.target.checked})} style={{accentColor: 'var(--color-accent)'}} disabled={!cols.bidAsk}/> Qty
                                </label>
                                <label style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', marginLeft: '20px', color: cols.mark ? 'white' : 'var(--text-secondary)'}}>
                                    <input type="checkbox" checked={cols.mark} onChange={(e) => setCols({...cols, mark: e.target.checked})} style={{accentColor: 'var(--color-accent)'}} disabled={!cols.bidAsk}/> Mark
                                </label>
                                <label style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: cols.delta ? 'white' : 'var(--text-secondary)'}}>
                                    <input type="checkbox" checked={cols.delta} onChange={(e) => setCols({...cols, delta: e.target.checked})} style={{accentColor: 'var(--color-accent)'}}/> Delta
                                </label>
                                <label style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: cols.volume ? 'white' : 'var(--text-secondary)'}}>
                                    <input type="checkbox" checked={cols.volume} onChange={(e) => setCols({...cols, volume: e.target.checked})} style={{accentColor: 'var(--color-accent)'}}/> Volume
                                </label>
                            </div>
                        </div>
                    )}
                </div>
            </div>
          </div>

          <div className="options-subheader">
            <span style={{fontWeight: 600, color: 'var(--text-secondary)', fontSize: '12px'}}>Calls</span>
            
            <div style={{display: 'flex', alignItems: 'center', gap: '16px'}}>
                <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                    <span style={{color: 'var(--text-secondary)'}}>{activeAsset}</span>
                    <span className="text-up font-bold" style={{fontSize: '13px'}}>
                        {spotPrice ? `₹${spotPrice.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1})}` : "Live"}
                    </span>
                </div>
                <span style={{color: 'var(--border-color)', opacity: 0.5}}>|</span>
                <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                    <span style={{color: 'var(--text-secondary)'}}>Time to Expiry</span>
                    <span className="text-white font-bold" style={{fontSize: '12.5px'}}>
                        {timeToExpiry || "0d:0h:0m"}
                    </span>
                </div>
            </div>
            
            <span style={{fontWeight: 600, color: 'var(--text-secondary)', fontSize: '12px', textAlign: 'right'}}>Puts</span>
          </div>

                    {/* Groww Style Nifty Option Chain Table */}
          <div ref={tableContainerRef} className="table-container" style={{overflowY: 'auto', flex: 1, position: 'relative', background: '#0a0d14', scrollBehavior: 'smooth'}}>
            <table style={{width: '100%', borderCollapse: 'collapse'}}>
              <thead style={{position: 'sticky', top: 0, background: '#0f131c', zIndex: 10, borderBottom: '1px solid #1f2430'}}>
                <tr style={{fontSize: '11.5px', color: '#8892b0', height: '38px'}}>
                  <th style={{textAlign: 'center', width: '20%', padding: '8px 4px', fontWeight: 600}}>Call OI</th>
                  <th style={{textAlign: 'center', width: '20%', padding: '8px 4px', fontWeight: 600}}>Call LTP</th>
                  <th style={{textAlign: 'center', width: '20%', padding: '8px 4px', fontWeight: 600, color: 'white'}}>
                    <div style={{display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'rgba(255,255,255,0.06)', padding: '3px 10px', borderRadius: '14px', fontSize: '11px', border: '1px solid rgba(255,255,255,0.1)'}}>
                      <span style={{color: '#ff9800', fontWeight: 'bold'}}>⚡ NIFTY</span>
                      <span style={{color: '#5d6778'}}>•</span>
                      <span style={{color: '#e2e8f0'}}>{effectiveExpiry ? new Date(effectiveExpiry).toLocaleDateString('en-GB', {day: '2-digit', month: 'short'}).replace(/ /g, ' ') : 'Select Expiry'}</span>
                    </div>
                  </th>
                  <th style={{textAlign: 'center', width: '20%', padding: '8px 4px', fontWeight: 600}}>Put LTP</th>
                  <th style={{textAlign: 'center', width: '20%', padding: '8px 4px', fontWeight: 600}}>Put OI</th>
                </tr>
              </thead>
              <tbody>
                {currentChain.map((row: any, idx: number) => {
                  const isCallITM = spotPrice ? row.strike < spotPrice : false;
                  const isPutITM = spotPrice ? row.strike > spotPrice : false;
                  const nextRow = currentChain[idx + 1];
                  const showSpotLine = spotPrice && nextRow && row.strike <= spotPrice && nextRow.strike > spotPrice;
                  
                  const callLeg = stratBasket.find(l => l.strike === row.strike && l.option_type === 'CALL');
                  const putLeg = stratBasket.find(l => l.strike === row.strike && l.option_type === 'PUT');
                  
                  const callPchange = row.callPchange !== undefined ? row.callPchange : 0;
                  const putPchange = row.putPchange !== undefined ? row.putPchange : 0;
                  const callOiChange = row.callOiChange !== undefined ? row.callOiChange : 0;
                  const putOiChange = row.putOiChange !== undefined ? row.putOiChange : 0;
                  
                  const callOiRatio = row.callOiRatio || 0.1;
                  const putOiRatio = row.putOiRatio || 0.1;

                  return (
                  <React.Fragment key={row.strike}>
                  <tr id={`strike-row-${row.strike}`} 
                    style={{
                      height: '46px',
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                      transition: 'background 0.15s ease',
                      fontSize: '12.5px'
                    }}
                    className="option-chain-row"
                  >
                    {/* 1. Call OI */}
                    <td 
                      style={{
                        textAlign: 'center',
                        background: isCallITM ? 'rgba(255, 184, 0, 0.04)' : 'transparent',
                        padding: '4px 8px'
                      }}
                    >
                      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px'}}>
                        <span style={{color: '#e2e8f0', fontWeight: 500}}>
                          {row.callOI ? row.callOI.toLocaleString('en-IN') : '-'}
                        </span>
                        <span style={{fontSize: '10px', color: callOiChange >= 0 ? '#02c076' : '#f84960', fontWeight: 500}}>
                          {callOiChange >= 0 ? `+${callOiChange.toFixed(2)}%` : `${callOiChange.toFixed(2)}%`}
                        </span>
                      </div>
                    </td>

                    {/* 2. Call LTP */}
                    <td 
                      onMouseEnter={() => setHoveredCell({strike: row.strike, side: 'CALL'})}
                      onMouseLeave={() => setHoveredCell(null)}
                      style={{
                        textAlign: 'center',
                        background: isCallITM ? 'rgba(255, 184, 0, 0.04)' : 'transparent',
                        position: 'relative',
                        padding: '4px 8px',
                        borderLeft: callLeg ? '2px solid var(--color-accent)' : '',
                        borderTop: callLeg ? '1px solid var(--color-accent)' : '',
                        borderBottom: callLeg ? '1px solid var(--color-accent)' : ''
                      }}
                    >
                      {callLeg && (
                        <div 
                          style={{position: 'absolute', left: 2, top: '50%', transform: 'translateY(-50%)', width: '16px', height: '16px', borderRadius: '3px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: callLeg.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', color: 'white', fontWeight: 'bold', fontSize: '9px', cursor: 'pointer'}}
                          onClick={(e) => { e.stopPropagation(); setStratBasket(stratBasket.filter(l => !(l.strike === row.strike && l.option_type === 'CALL'))); }}
                          title="Click to deselect"
                        >
                          {callLeg.side === 'BUY' ? 'B' : 'S'}
                        </div>
                      )}

                      {hoveredCell?.strike === row.strike && hoveredCell?.side === 'CALL' ? (
                        <div style={{display: 'flex', gap: '5px', justifyContent: 'center', alignItems: 'center'}}>
                          <button className="btn" style={{background: 'var(--color-up)', padding: '3px 10px', fontSize: '10.5px', color: 'white', border: 'none', borderRadius: '3px', fontWeight: 'bold', cursor: 'pointer'}} onClick={(e) => { e.stopPropagation(); addLegToBasket('BUY', 'CALL', row, stratSize); }}>Buy</button>
                          <button className="btn" style={{background: 'var(--color-down)', padding: '3px 10px', fontSize: '10.5px', color: 'white', border: 'none', borderRadius: '3px', fontWeight: 'bold', cursor: 'pointer'}} onClick={(e) => { e.stopPropagation(); addLegToBasket('SELL', 'CALL', row, stratSize); }}>Sell</button>
                        </div>
                      ) : (
                        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px'}}>
                          <span style={{color: 'white', fontWeight: 600}}>
                            ₹{row.callMark ? row.callMark.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '-'}
                          </span>
                          <span style={{fontSize: '10px', color: callPchange >= 0 ? '#02c076' : '#f84960', fontWeight: 500}}>
                            {callPchange >= 0 ? `+${callPchange.toFixed(2)}%` : `${callPchange.toFixed(2)}%`}
                          </span>
                        </div>
                      )}
                    </td>

                    {/* 3. Strike with OI comparison bars */}
                    <td 
                      style={{
                        textAlign: 'center',
                        background: '#0d111a',
                        fontWeight: 700,
                        color: 'white',
                        padding: '4px 8px'
                      }}
                    >
                      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px'}}>
                        <span style={{fontSize: '13px', letterSpacing: '0.3px'}}>{row.strike.toLocaleString('en-IN')}</span>
                        {/* Dual OI relative bars */}
                        <div style={{display: 'flex', width: '56px', height: '3px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden', gap: '2px'}}>
                          <div style={{flex: 1, display: 'flex', justifyContent: 'flex-end'}}>
                            <div style={{width: `${Math.max(callOiRatio * 100, 6)}%`, height: '100%', background: '#ff7043', borderRadius: '1px'}} />
                          </div>
                          <div style={{flex: 1, display: 'flex', justifyContent: 'flex-start'}}>
                            <div style={{width: `${Math.max(putOiRatio * 100, 6)}%`, height: '100%', background: '#26a69a', borderRadius: '1px'}} />
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* 4. Put LTP */}
                    <td 
                      onMouseEnter={() => setHoveredCell({strike: row.strike, side: 'PUT'})}
                      onMouseLeave={() => setHoveredCell(null)}
                      style={{
                        textAlign: 'center',
                        background: isPutITM ? 'rgba(255, 184, 0, 0.04)' : 'transparent',
                        position: 'relative',
                        padding: '4px 8px',
                        borderRight: putLeg ? '2px solid var(--color-accent)' : '',
                        borderTop: putLeg ? '1px solid var(--color-accent)' : '',
                        borderBottom: putLeg ? '1px solid var(--color-accent)' : ''
                      }}
                    >
                      {hoveredCell?.strike === row.strike && hoveredCell?.side === 'PUT' ? (
                        <div style={{display: 'flex', gap: '5px', justifyContent: 'center', alignItems: 'center'}}>
                          <button className="btn" style={{background: 'var(--color-up)', padding: '3px 10px', fontSize: '10.5px', color: 'white', border: 'none', borderRadius: '3px', fontWeight: 'bold', cursor: 'pointer'}} onClick={(e) => { e.stopPropagation(); addLegToBasket('BUY', 'PUT', row, stratSize); }}>Buy</button>
                          <button className="btn" style={{background: 'var(--color-down)', padding: '3px 10px', fontSize: '10.5px', color: 'white', border: 'none', borderRadius: '3px', fontWeight: 'bold', cursor: 'pointer'}} onClick={(e) => { e.stopPropagation(); addLegToBasket('SELL', 'PUT', row, stratSize); }}>Sell</button>
                        </div>
                      ) : (
                        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px'}}>
                          <span style={{color: 'white', fontWeight: 600}}>
                            ₹{row.putMark ? row.putMark.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '-'}
                          </span>
                          <span style={{fontSize: '10px', color: putPchange >= 0 ? '#02c076' : '#f84960', fontWeight: 500}}>
                            {putPchange >= 0 ? `+${putPchange.toFixed(2)}%` : `${putPchange.toFixed(2)}%`}
                          </span>
                        </div>
                      )}

                      {putLeg && (
                        <div 
                          style={{position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', width: '16px', height: '16px', borderRadius: '3px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: putLeg.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', color: 'white', fontWeight: 'bold', fontSize: '9px', cursor: 'pointer'}}
                          onClick={(e) => { e.stopPropagation(); setStratBasket(stratBasket.filter(l => !(l.strike === row.strike && l.option_type === 'PUT'))); }}
                          title="Click to deselect"
                        >
                          {putLeg.side === 'BUY' ? 'B' : 'S'}
                        </div>
                      )}
                    </td>

                    {/* 5. Put OI */}
                    <td 
                      style={{
                        textAlign: 'center',
                        background: isPutITM ? 'rgba(255, 184, 0, 0.04)' : 'transparent',
                        padding: '4px 8px'
                      }}
                    >
                      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px'}}>
                        <span style={{color: '#e2e8f0', fontWeight: 500}}>
                          {row.putOI ? row.putOI.toLocaleString('en-IN') : '-'}
                        </span>
                        <span style={{fontSize: '10px', color: putOiChange >= 0 ? '#02c076' : '#f84960', fontWeight: 500}}>
                          {putOiChange >= 0 ? `+${putOiChange.toFixed(2)}%` : `${putOiChange.toFixed(2)}%`}
                        </span>
                      </div>
                    </td>
                  </tr>

                  {/* Spot Price Divider Line (like Groww) */}
                  {showSpotLine && (
                    <tr style={{height: '1px', background: 'transparent'}}>
                      <td colSpan={5} style={{padding: 0, position: 'relative'}}>
                        <div style={{position: 'relative', width: '100%', height: '2px', background: '#384152', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '4px 0'}}>
                          <div style={{position: 'absolute', background: '#1c2230', border: '1px solid #384152', padding: '2px 12px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, color: 'white', display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 2px 6px rgba(0,0,0,0.4)', zIndex: 5}}>
                            <span>{spotPrice ? spotPrice.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '24,231.85'}</span>
                            <span style={{color: '#5d6778'}}>|</span>
                            <span style={{color: (spotChange || 0) >= 0 ? '#02c076' : '#f84960', fontSize: '10.5px'}}>
                              {(spotChange || 0) >= 0 ? `+${(spotChange || 0).toFixed(2)}` : (spotChange || 0).toFixed(2)} ({((spotPercentChange || 0) >= 0 ? `+${(spotPercentChange || 0).toFixed(2)}` : (spotPercentChange || 0).toFixed(2))}%)
                            </span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                )})}
              </tbody>
            </table>
          </div>
          
          {/* Portfolio Panel */}
          {/* Portfolio Panel */}
          <div style={{height: '240px', background: 'var(--bg-base)', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column'}}>
              <div style={{display: 'flex', borderBottom: '1px solid var(--border-color)', padding: '0 16px', alignItems: 'center', justifyContent: 'space-between', background: '#131722'}}>
                  <div style={{display: 'flex', gap: '24px'}}>
                      {['Positions', 'Open Orders', 'Stop Orders', 'Risk & Margin Details', 'Fills', 'Order History'].map(tab => (
                          <div key={tab} onClick={() => setPortfolioTab(tab)} style={{padding: '12px 0', fontSize: '13px', fontWeight: tab === portfolioTab ? 'bold' : 'normal', color: tab === portfolioTab ? 'var(--color-accent)' : 'var(--text-secondary)', cursor: 'pointer', borderBottom: tab === portfolioTab ? '2px solid var(--color-accent)' : '2px solid transparent'}}>
                              {tab}
                          </div>
                      ))}
                  </div>
                  <div style={{display: 'flex', gap: '12px', alignItems: 'center'}}>
                      <button 
                          style={{display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(0, 192, 135, 0.1)', border: '1px solid rgba(0, 192, 135, 0.3)', color: '#00C087', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '11.5px', fontWeight: 'bold'}}
                          onClick={() => setShowCalculatorModal(true)}
                          title="Open Groww-style Brokerage & P&L Calculator"
                      >
                          <span>🧮</span> Brokerage Calculator
                      </button>
                      <div style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '12px'}} onClick={() => {
                          const accId = activeAccountId || 1;
                          fetch(`http://127.0.0.1:8000/api/portfolio?account_id=${accId}`).then(r=>r.json()).then(setPortfolio);
                      }}>
                          <span style={{fontSize: '14px'}}>↻</span> Refresh
                      </div>
                  </div>
              </div>
              <div style={{flex: 1, display: 'flex', flexDirection: 'column', color: 'white', fontSize: '12px', overflowY: 'auto'}}>
                  {portfolioTab === 'Positions' ? (
                      portfolio && portfolio.baskets && portfolio.baskets.length > 0 ? (
                          <table style={{width: '100%', textAlign: 'left', borderCollapse: 'collapse'}}>
                              <thead style={{color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.02)', fontSize: '11px', textTransform: 'uppercase'}}>
                                  <tr>
                                      <th style={{padding: '8px 12px'}}>Instrument</th>
                                      <th style={{padding: '8px 12px'}}>Side</th>
                                      <th style={{padding: '8px 12px'}}>Qty (Lots)</th>
                                      <th style={{padding: '8px 12px'}}>Avg Entry</th>
                                      <th style={{padding: '8px 12px'}}>Live LTP</th>
                                      <th style={{padding: '8px 12px'}}>Points P&L</th>
                                      <th style={{padding: '8px 12px'}}>Gross P&L (₹)</th>
                                      <th style={{padding: '8px 12px'}}>Est. Charges</th>
                                      <th style={{padding: '8px 12px'}}>Net P&L</th>
                                      <th style={{padding: '8px 12px'}}>Action</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  {portfolio.baskets.flatMap((b:any) => b.legs.map((leg:any) => {
                                      const entry = Number(leg.entry_price || 0);
                                      const ltp = Number(leg.current_price || leg.entry_price || 0);
                                      const pts = Number(leg.points_move || (leg.side === 'BUY' ? ltp - entry : entry - ltp));
                                      const upnl = Number(leg.upnl !== undefined ? leg.upnl : (pts * (leg.size || 1) * 65));
                                      const pnlPct = Number(leg.pnl_pct || (entry > 0 ? (pts / entry) * 100 : 0));
                                      const estCharges = 23.53 * (leg.size || 1); // Groww F&O standard charges per round-trip
                                      const netPnl = upnl - estCharges;
                                      
                                      return (
                                      <tr key={`${b.id}-${leg.id}`} style={{borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.01)'}}>
                                          <td style={{padding: '8px 12px', fontWeight: 600}}>
                                              <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                                                  <span style={{background: leg.symbol.includes('CE') ? 'rgba(0, 192, 135, 0.15)' : 'rgba(248, 73, 96, 0.15)', color: leg.symbol.includes('CE') ? '#00c087' : '#f84960', padding: '1px 5px', borderRadius: '3px', fontSize: '10px', fontWeight: 'bold'}}>
                                                      {leg.symbol.includes('CE') ? 'CE' : 'PE'}
                                                  </span>
                                                  <span>{leg.symbol}</span>
                                              </div>
                                          </td>
                                          <td style={{padding: '8px 12px'}}>
                                              <span style={{background: leg.side === 'BUY' ? 'rgba(0, 192, 135, 0.2)' : 'rgba(248, 73, 96, 0.2)', color: leg.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', padding: '2px 8px', borderRadius: '3px', fontWeight: 'bold', fontSize: '10.5px'}}>
                                                  {leg.side}
                                              </span>
                                          </td>
                                          <td style={{padding: '8px 12px'}}>
                                              <span style={{color: 'white', fontWeight: 600}}>{leg.size} Lot</span>
                                              <span style={{color: 'var(--text-secondary)', fontSize: '10.5px', marginLeft: '4px'}}>({(leg.size || 1) * 65} units)</span>
                                          </td>
                                          <td style={{padding: '8px 12px', fontWeight: 600}}>₹{entry.toFixed(2)}</td>
                                          <td style={{padding: '8px 12px', color: '#ffb800', fontWeight: 'bold'}}>₹{ltp.toFixed(2)}</td>
                                          <td style={{padding: '8px 12px', color: pts >= 0 ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 600}}>
                                              {pts >= 0 ? '+' : ''}{pts.toFixed(2)} pts
                                              <span style={{fontSize: '10px', marginLeft: '4px', opacity: 0.8}}>({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)</span>
                                          </td>
                                          <td style={{padding: '8px 12px', color: upnl >= 0 ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 'bold', fontSize: '12.5px'}}>
                                              {upnl >= 0 ? '+' : ''}₹{upnl.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                                          </td>
                                          <td style={{padding: '8px 12px', color: 'var(--text-secondary)', fontSize: '11px'}} title="Brokerage ₹20 + STT + Exch ₹1.94 + GST">
                                              -₹{estCharges.toFixed(2)}
                                          </td>
                                          <td style={{padding: '8px 12px', color: netPnl >= 0 ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 'bold'}}>
                                              {netPnl >= 0 ? '+' : ''}₹{netPnl.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                                          </td>
                                          <td style={{padding: '8px 12px'}}>
                                              <div style={{display: 'flex', gap: '6px'}}>
                                                  <button onClick={() => closePosition(b.id)} style={{background: 'rgba(248, 73, 96, 0.15)', border: '1px solid rgba(248, 73, 96, 0.3)', color: '#f84960', padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold'}}>Close</button>
                                                  <button onClick={() => {
                                                      setCalcBuyPrice(entry);
                                                      setCalcSellPrice(ltp);
                                                      setCalcQty((leg.size || 1) * 65);
                                                      setShowCalculatorModal(true);
                                                  }} style={{background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)', color: 'white', padding: '3px 6px', borderRadius: '4px', cursor: 'pointer', fontSize: '10.5px'}} title="Analyze in Groww Brokerage Calculator">🧮</button>
                                              </div>
                                          </td>
                                      </tr>
                                  );}))}
                              </tbody>
                          </table>
                      ) : (
                          <div style={{flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '13px'}}>
                              No {activeAsset} Positions found.
                          </div>
                      )
                  ) : portfolioTab === 'Order History' ? (
                      orderHistory && orderHistory.length > 0 ? (
                          <table style={{width: '100%', textAlign: 'left', borderCollapse: 'collapse'}}>
                              <thead style={{color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.02)', fontSize: '12px'}}>
                                  <tr>
                                      <th style={{padding: '8px 16px'}}>Time</th>
                                      <th style={{padding: '8px 16px'}}>Symbol</th>
                                      <th style={{padding: '8px 16px'}}>Side</th>
                                      <th style={{padding: '8px 16px'}}>Size</th>
                                      <th style={{padding: '8px 16px'}}>Price</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  {orderHistory.map((trade:any, i:number) => (
                                      <tr key={i} style={{borderBottom: '1px solid var(--border-color)'}}>
                                          <td style={{padding: '8px 16px', color: 'var(--text-secondary)'}}>{new Date(trade.timestamp).toLocaleString()}</td>
                                          <td style={{padding: '8px 16px', fontWeight: 600}}>{trade.symbol}</td>
                                          <td style={{padding: '8px 16px'}}>
                                              <span style={{background: trade.side === 'BUY' ? 'rgba(0, 192, 135, 0.2)' : 'rgba(248, 73, 96, 0.2)', color: trade.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', padding: '2px 8px', borderRadius: '3px', fontWeight: 'bold', fontSize: '10.5px'}}>
                                                  {trade.side}
                                              </span>
                                          </td>
                                          <td style={{padding: '8px 16px'}}>
                                              <span style={{color: 'white', fontWeight: 600}}>{trade.size} Lot</span>
                                              <span style={{color: 'var(--text-secondary)', fontSize: '10.5px', marginLeft: '4px'}}>({(trade.size || 1) * 65} units)</span>
                                          </td>
                                          <td style={{padding: '8px 16px', fontWeight: 'bold', color: 'white'}}>₹{Number(trade.price || 0).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                                      </tr>
                                  ))}
                              </tbody>
                          </table>
                      ) : (
                          <div style={{flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '13px'}}>
                              No {activeAsset} Order History found.
                          </div>
                      )
                  ) : (
                      <div style={{flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '13px'}}>
                          No {activeAsset} {portfolioTab} found.
                      </div>
                  )}
              </div>
          </div>
        </div>

        {showBuilder && (
         <aside className="order-panel" style={{ width: '400px', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', borderLeft: '1px solid var(--border-color)'}}>
           <div style={{ flex: 1, overflowY: 'auto' }}>
            <div style={{padding: '12px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
               <div style={{display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', position: 'relative'}}>
                   <h3 className="font-bold" style={{fontSize: '13px', color: 'white'}}>Pre-Built Strategies</h3>
                   <span style={{color: 'var(--color-accent)', fontSize: '10px'}}>⌄</span>
                   <select 
                       style={{position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer'}}
                       value={strategy} onChange={e => {
                           setStrategy(e.target.value);
                           if (e.target.value === 'Clear') setStratBasket([]);
                           else if (e.target.value !== 'Custom' && atmStrike) {
                               const basket = buildStrategyBasket(e.target.value, currentChain, atmStrike, activeAsset, activeExpiry, stratSize);
                               if (basket.length > 0) {
                                   setStratBasket(basket);
                                   setStrategy('Custom');
                               }
                           }
                       }}
                   >
                       <option>Custom</option>
                       {Object.entries(CATEGORIZED_STRATEGIES).map(([category, strats]) => (
                           <optgroup key={category} label={category}>
                               {strats.map(s => <option key={s} value={s}>{s}</option>)}
                           </optgroup>
                       ))}
                       <option>Clear</option>
                   </select>
               </div>
               <div style={{border: '1px solid var(--border-color)', borderRadius: '4px', padding: '4px 8px', fontSize: '11px', color: 'var(--color-accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'}}>
                   Add {activeAsset} Futures <span>⌄</span>
               </div>
           </div>
           
           <div style={{padding: '16px', borderBottom: '1px solid var(--border-color)'}}>
               {/* Strategy Header */}
               <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '16px', alignItems: 'center'}}>
                   <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                       <h3 className="font-bold" style={{fontSize: '14px', color: 'white'}}>Strategy Contracts</h3>
                       <div style={{background: 'rgba(255,255,255,0.1)', padding: '4px 10px', borderRadius: '4px', fontSize: '12px', color: '#c3c8d4'}}>
                           {strategy !== 'Custom' ? strategy : (stratBasket.length > 0 ? 'Custom' : 'None')}
                       </div>
                   </div>
                   <div style={{background: 'rgba(255,255,255,0.05)', width: '24px', height: '24px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-secondary)'}}>
                       <span style={{fontSize: '12px', transform: 'scaleX(1.5)'}}>^</span>
                   </div>
               </div>
               
               {/* Bulk Actions Row */}
                <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', fontSize: '12px', color: 'var(--text-secondary)'}}>
                    <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                        <input type="checkbox" defaultChecked style={{accentColor: 'var(--color-accent)', width: '16px', height: '16px', cursor: 'pointer'}} />
                        <span>{stratBasket.length} / {stratBasket.length} Selected</span>
                    </div>
                    <div style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
                        <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                            <span style={{fontSize: '11px'}} title="1 NIFTY Lot = 65 units">Lots:</span>
                            <div style={{display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', borderRadius: '0'}}>
                                <span style={{color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '16px'}} onClick={() => {
                                    const newSize = Math.max(1, stratSize - 1);
                                    setStratSize(newSize);
                                    setStratBasket(stratBasket.map(l => ({...l, size: l.size / stratSize * newSize})));
                                }}>⊖</span>
                                <input type="number" value={stratSize} onChange={(e) => {
                                    const newSize = Math.max(1, Number(e.target.value) || 1);
                                    setStratSize(newSize);
                                    setStratBasket(stratBasket.map(l => ({...l, size: l.size / stratSize * newSize})));
                                }} style={{width: '32px', background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--border-color)', borderRadius: '2px', textAlign: 'center', fontSize: '13px', outline: 'none', padding: '2px 0', margin: '0 4px', fontWeight: 'bold'}} />
                                <span style={{color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '16px'}} onClick={() => {
                                    const newSize = stratSize + 1;
                                    setStratSize(newSize);
                                    setStratBasket(stratBasket.map(l => ({...l, size: l.size / stratSize * newSize})));
                                }}>⊕</span>
                            </div>
                        </div>
                        <span style={{cursor: 'pointer', color: '#F84960', fontSize: '14px'}} onClick={() => setStratBasket([])} title="Clear All Legs">🗑️</span>
                    </div>
                </div>
                
                {/* Legs List */}
                {stratBasket.map((leg, i) => {
                     const isLimit = leg.order_type === 'LIMIT';
                     const legPremium = (leg.limit_price !== undefined ? leg.limit_price : (leg.price || 0)) * (leg.size || 1) * 65;
                     return (
                     <div key={i} style={{display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px', padding: '8px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.05)'}}>
                         <div style={{display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px'}}>
                            <input 
                                 type="checkbox" 
                                 checked={true} 
                                 onChange={() => setStratBasket(stratBasket.filter((_, idx) => idx !== i))}
                                 style={{accentColor: 'var(--color-accent)', width: '15px', height: '15px', cursor: 'pointer'}} 
                             />
                            
                            <div style={{border: leg.side === 'BUY' ? '1px solid var(--color-up)' : '1px solid var(--color-down)', color: leg.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', padding: '1px 6px', borderRadius: '2px', fontWeight: 'bold', fontSize: '11px', background: 'transparent'}}>
                                {leg.side === 'BUY' ? 'B' : 'S'}
                            </div>
                            
                            <div style={{display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 'bold'}}>
                                <span style={{color: leg.option_type === 'CALL' ? 'var(--color-up)' : 'var(--color-down)'}}>{leg.option_type === 'CALL' ? 'CE' : 'PE'}</span>
                                <span style={{marginLeft: '4px'}}>{leg.strike}</span>
                                <span style={{marginLeft: '4px', fontSize: '11px', color: 'var(--text-secondary)'}}>{new Date(leg.expiry).toLocaleDateString('en-GB', {day: '2-digit', month: 'short'})}</span>
                            </div>
                            
                            <div style={{flex: 1}}></div>
                            
                            {/* Market Price Box */}
                            <div 
                                style={{
                                    display: 'flex', 
                                    alignItems: 'center', 
                                    gap: '5px', 
                                    border: '1px solid var(--border-color)', 
                                    borderRadius: '4px', 
                                    padding: '3px 6px', 
                                    cursor: 'pointer',
                                    background: '#0e121a'
                                }}
                                onClick={() => {
                                    const nb = [...stratBasket];
                                    nb[i] = {
                                        ...leg,
                                        order_type: isLimit ? 'MARKET' : 'LIMIT',
                                        limit_price: isLimit ? undefined : (leg.limit_price || leg.price)
                                    };
                                    setStratBasket(nb);
                                }}
                            >
                                <div style={{
                                    border: '1px solid var(--color-accent)', 
                                    padding: '0px 3px', 
                                    borderRadius: '2px', 
                                    fontSize: '9px', 
                                    color: 'var(--color-accent)'
                                }}>
                                    {isLimit ? 'L' : 'M'}
                                </div>
                                {isLimit ? (
                                    <input 
                                        type="number" 
                                        value={leg.limit_price !== undefined ? leg.limit_price : leg.price}
                                        onChange={(e) => {
                                            const nb = [...stratBasket];
                                            nb[i].limit_price = Number(e.target.value);
                                            setStratBasket(nb);
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                        style={{width: '55px', background: 'transparent', color: 'white', border: 'none', fontSize: '12px', outline: 'none', fontWeight: 'bold'}}
                                    />
                                ) : (
                                    <span style={{fontSize: '11px', color: 'white', fontWeight: 600}}>₹{leg.price ? Number(leg.price).toFixed(2) : '-'}</span>
                                )}
                            </div>
                            
                            {/* Quantity (Lots) */}
                            <div style={{display: 'flex', alignItems: 'center', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '3px 6px', background: '#0e121a'}}>
                                <input 
                                    type="number" 
                                    value={leg.size || 1} 
                                    onChange={(e) => {
                                        const nb = [...stratBasket];
                                        nb[i].size = Math.max(1, Math.abs(Number(e.target.value)) || 1);
                                        setStratBasket(nb);
                                    }}
                                    style={{width: '28px', background: 'transparent', color: 'white', border: 'none', textAlign: 'center', fontSize: '12px', outline: 'none', fontWeight: 'bold'}}
                                />
                                <span style={{fontSize: '10.5px', color: 'var(--text-secondary)', marginLeft: '3px'}}>Lot</span>
                            </div>
                           
                            <div style={{cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '13px', marginLeft: '2px'}} onClick={() => {
                                const newBasket = [...stratBasket];
                                newBasket.splice(i, 1);
                                setStratBasket(newBasket);
                            }}>✕</div>
                         </div>

                         {/* Sub-label: Contract Total Qty & Total Cost */}
                         <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', color: 'var(--text-secondary)', padding: '0 4px'}}>
                            <span>Qty: <strong style={{color: 'white'}}>{(leg.size || 1) * 65} units</strong> ({leg.size || 1} x 65)</span>
                            <span>{leg.side === 'BUY' ? 'Cost' : 'Credit'}: <strong style={{color: leg.side === 'BUY' ? 'var(--color-up)' : 'var(--color-accent)'}}>₹{legPremium.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong></span>
                         </div>
                     </div>
                 );})}
               {stratBasket.length === 0 && <div className="text-secondary text-center text-sm" style={{padding: '2rem 0'}}>No legs added. Hover over the chain and click Buy/Sell.</div>}
           </div>

           <div style={{padding: '16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-base)'}}>
               {/* PayOff Header */}
               <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '16px', alignItems: 'center'}}>
                   <h3 className="font-bold" style={{fontSize: '14px', color: 'white'}}>Strategy PayOff <span style={{fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal'}}>( {stratBasket.length} / {stratBasket.length} Selected )</span></h3>
                   <div style={{background: 'rgba(255,255,255,0.05)', width: '24px', height: '24px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-secondary)'}}>
                       <span style={{fontSize: '12px', transform: 'scaleX(1.5)'}}>^</span>
                   </div>
               </div>
               
               {/* 4 Columns */}
                <div style={{display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '20px'}}>
                    <div style={{flex: 1}}>
                        <div style={{fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px'}}>Max Profit</div>
                        <div style={{fontSize: '13px', fontWeight: 'bold', color: 'var(--color-up)'}}>{maxProfit}</div>
                    </div>
                    <div style={{flex: 1}}>
                        <div style={{fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px'}}>Max Loss</div>
                        <div style={{fontSize: '13px', fontWeight: 'bold', color: 'var(--color-down)'}}>{maxLoss}</div>
                    </div>
                    <div style={{flex: 1}}>
                        <div style={{fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px'}}>Reward / Risk</div>
                        <div style={{fontSize: '13px', fontWeight: 'bold', color: 'white'}}>NA</div>
                    </div>
                    <div style={{flex: 1.5}}>
                        <div style={{fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px'}}>Breakeven</div>
                        <div style={{fontSize: '13px', fontWeight: 'bold', color: 'white'}}>{breakeven}</div>
                    </div>
                </div>
                
                {/* Tabs */}
                <div style={{display: 'flex', gap: '8px', marginBottom: '16px'}}>
                    <div 
                        onClick={() => setActiveTab('Chart')} 
                        style={{flex: 1, textAlign: 'center', padding: '6px 0', background: activeTab === 'Chart' ? 'rgba(255,255,255,0.1)' : 'transparent', color: activeTab === 'Chart' ? 'white' : 'var(--text-secondary)', fontSize: '12px', fontWeight: activeTab === 'Chart' ? 'bold' : 'normal', cursor: 'pointer', borderRadius: '4px', border: activeTab === 'Chart' ? '1px solid var(--border-color)' : '1px solid transparent'}}
                    >
                        PNL Chart
                    </div>
                    <div 
                        onClick={() => setActiveTab('PNL')} 
                        style={{flex: 1, textAlign: 'center', padding: '6px 0', background: activeTab === 'PNL' ? 'rgba(255,255,255,0.1)' : 'transparent', color: activeTab === 'PNL' ? 'white' : 'var(--text-secondary)', fontSize: '12px', fontWeight: activeTab === 'PNL' ? 'bold' : 'normal', cursor: 'pointer', borderRadius: '4px', border: activeTab === 'PNL' ? '1px solid var(--border-color)' : '1px solid transparent'}}
                    >
                        PNL Table
                    </div>
                    <div 
                        onClick={() => setActiveTab('Greeks')} 
                        style={{flex: 1, textAlign: 'center', padding: '6px 0', background: activeTab === 'Greeks' ? 'rgba(255,255,255,0.1)' : 'transparent', color: activeTab === 'Greeks' ? 'white' : 'var(--text-secondary)', fontSize: '12px', fontWeight: activeTab === 'Greeks' ? 'bold' : 'normal', cursor: 'pointer', borderRadius: '4px', border: activeTab === 'Greeks' ? '1px solid var(--border-color)' : '1px solid transparent'}}
                    >
                        Greeks Table
                    </div>
                </div>
                 
                 {activeTab === 'Chart' && (
                 <>
                 <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', fontSize: '12px'}}>
                     <div style={{display: 'flex', alignItems: 'center', gap: '5px'}}>
                         <div style={{width: '12px', height: '2px', background: '#00C087'}}></div>
                         <span>On Expiry Date</span>
                     </div>
                     <div style={{display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--text-secondary)'}}>
                         <span>Index <span className="font-bold text-white">{typeof spotPrice === "number" ? Number(spotPrice || 24231.85).toFixed(2) : "24231.85"}</span></span>
                     </div>
                     <div style={{display: 'flex', alignItems: 'center', gap: '5px'}}>
                         <div style={{width: '12px', height: '2px', background: 'var(--color-accent)'}}></div>
                         <span>On Target Date</span>
                     </div>
                 </div>

                 <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: 'var(--text-secondary)', padding: '0 5px', marginBottom: '4px'}}>
                     <span>Profit / Loss (₹)</span>
                     {spotPrice && (
                         <span style={{background: 'rgba(255,255,255,0.08)', padding: '2px 8px', borderRadius: '4px', color: 'white', fontWeight: 'bold', fontSize: '11px'}}>
                             Current Price {typeof spotPrice === "number" ? Number(spotPrice || 24231.85).toFixed(0) : "24232"}
                         </span>
                     )}
                     <span>Open Interest (₹)</span>
                 </div>

                 <div style={{height: '250px', marginLeft: '-20px'}}>
                     {stratBasket.length > 0 ? (
                     <ResponsiveContainer width="100%" height="100%">
                         <ComposedChart data={payoffData}>
                             <XAxis dataKey="price" type="number" domain={['dataMin', 'dataMax']} stroke="#5a616e" fontSize={10} tickFormatter={(val) => Math.round(val).toLocaleString('en-IN')} />
                             <YAxis yAxisId="left" stroke="#5a616e" fontSize={10} domain={yAxisDomains.left} tickFormatter={(val) => Math.round(val).toLocaleString('en-IN')} width={45} />
                             <YAxis 
                                 yAxisId="right" 
                                 orientation="right" 
                                 stroke="#5a616e" 
                                 fontSize={10} 
                                 domain={yAxisDomains.right} 
                                 tickFormatter={(val) => {
                                     const absVal = Math.abs(val);
                                     if (absVal === 0) return '0';
                                     if (absVal >= 1e7) return `₹${(absVal / 1e7).toFixed(1)}Cr`;
                                     if (absVal >= 1e5) return `₹${(absVal / 1e5).toFixed(1)}L`;
                                     if (absVal >= 1e3) return `₹${(absVal / 1e3).toFixed(0)}K`;
                                     return `₹${absVal.toFixed(0)}`;
                                 }} 
                                 width={45} 
                             />
                             <Tooltip 
                                 content={({ active, payload, label }) => {
                                     if (active && payload && payload.length) {
                                         const price = Number(label);
                                         const pnlTarget = Number(payload.find((p:any) => p.dataKey === 'pnlTarget')?.value || 0);
                                         const pnlExpiry = Number(payload.find((p:any) => p.dataKey === 'pnlExpiry')?.value || 0);
                                         
                                         const sp = typeof spotPrice === 'number' ? spotPrice : 24255.50;
                                         const diffPct = sp > 0 ? ((price - sp) / sp) * 100 : 0;
                                         const diffPctStr = diffPct >= 0 ? `+${diffPct.toFixed(2)}%` : `${diffPct.toFixed(2)}%`;
                                         
                                         return (
                                             <div style={{
                                                 backgroundColor: '#111622', 
                                                 border: '1px solid rgba(255, 255, 255, 0.12)', 
                                                 padding: '8px 12px', 
                                                 borderRadius: '6px', 
                                                 fontSize: '12px', 
                                                 minWidth: '160px', 
                                                 boxShadow: '0 8px 24px rgba(0,0,0,0.6)'
                                             }}>
                                                 <div style={{fontWeight: 'bold', fontSize: '13px', color: 'white', marginBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '4px'}}>
                                                     {price.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})} <span style={{fontSize: '11px', color: diffPct >= 0 ? '#00c087' : '#f84960', fontWeight: 600}}>({diffPctStr})</span>
                                                 </div>
                                                 <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', fontSize: '11.5px'}}>
                                                     <span style={{color: 'var(--text-secondary)'}}>Target:</span>
                                                     <span style={{color: pnlTarget >= 0 ? '#00c087' : '#f84960', fontWeight: 'bold', fontFamily: 'monospace'}}>
                                                         {pnlTarget >= 0 ? `+₹${Math.round(pnlTarget).toLocaleString('en-IN')}` : `-₹${Math.round(Math.abs(pnlTarget)).toLocaleString('en-IN')}`}
                                                     </span>
                                                 </div>
                                                 <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11.5px'}}>
                                                     <span style={{color: 'var(--text-secondary)'}}>Expiry:</span>
                                                     <span style={{color: pnlExpiry >= 0 ? '#00c087' : '#f84960', fontWeight: 'bold', fontFamily: 'monospace'}}>
                                                         {pnlExpiry >= 0 ? `+₹${Math.round(pnlExpiry).toLocaleString('en-IN')}` : `-₹${Math.round(Math.abs(pnlExpiry)).toLocaleString('en-IN')}`}
                                                     </span>
                                                 </div>
                                             </div>
                                         );
                                     }
                                     return null;
                                 }}
                             />
                             
                             <defs>
                                 <linearGradient id="splitStroke" x1="0" y1="0" x2="0" y2="1">
                                     <stop offset={(() => {
                                         const max = Math.max(...payoffData.map(d => d.pnlExpiry));
                                         const min = Math.min(...payoffData.map(d => d.pnlExpiry));
                                         if (max === min) return 0.5;
                                         if (max <= 0) return 0;
                                         if (min >= 0) return 1;
                                         return max / (max - min);
                                     })()} stopColor="#00C087" />
                                     <stop offset={(() => {
                                         const max = Math.max(...payoffData.map(d => d.pnlExpiry));
                                         const min = Math.min(...payoffData.map(d => d.pnlExpiry));
                                         if (max === min) return 0.5;
                                         if (max <= 0) return 0;
                                         if (min >= 0) return 1;
                                         return max / (max - min);
                                     })()} stopColor="#F84960" />
                                 </linearGradient>
                             </defs>

                             <ReferenceLine y={0} yAxisId="left" stroke="#5a616e" />
                             {spotPrice && (
                                 <ReferenceLine 
                                     x={spotPrice} 
                                     yAxisId="left" 
                                     stroke="#00c087" 
                                     strokeDasharray="2 2"
                                     label={{
                                         value: `${spotPrice.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`,
                                         position: 'top',
                                         fill: '#ffffff',
                                         fontSize: 10.5,
                                         fontWeight: 'bold',
                                         offset: 5
                                     }}
                                 />
                             )}
                            {targetPrice && stratBasket.length > 0 && (
                                <>
                                    <ReferenceLine x={targetPrice} yAxisId="left" stroke="var(--color-accent)" strokeWidth={1.5} />
                                    <ReferenceDot yAxisId="left" x={targetPrice} y={projectedPNL} r={4} fill="var(--color-accent)" stroke="white" strokeWidth={1.5} />
                                </>
                            )}
                            
                            <Bar 
                                yAxisId="right" 
                                dataKey="putOI_INR" 
                                fill="#F84960" 
                                isAnimationActive={false} 
                                shape={(props: any) => {
                                    const { x, y, width, height, fill } = props;
                                    if (!height || Math.abs(height) <= 0) return null;
                                    const barW = Math.max(4, (width || 20) * 0.9);
                                    const barX = x + (width ? (width - barW) / 2 : 0);
                                    return <rect x={barX} y={height < 0 ? y + height : y} width={barW} height={Math.abs(height)} fill={fill} rx={2} opacity={0.4} />;
                                }}
                            />
                            <Bar 
                                yAxisId="right" 
                                dataKey="callOI_INR" 
                                fill="#00C087" 
                                isAnimationActive={false} 
                                shape={(props: any) => {
                                    const { x, y, width, height, fill } = props;
                                    if (!height || Math.abs(height) <= 0) return null;
                                    const barW = Math.max(4, (width || 20) * 0.9);
                                    const barX = x + (width ? (width - barW) / 2 : 0);
                                    return <rect x={barX} y={height < 0 ? y + height : y} width={barW} height={Math.abs(height)} fill={fill} rx={2} opacity={0.4} />;
                                }}
                            />
                            
                            <Line yAxisId="left" type="linear" dataKey="pnlExpiry" stroke="url(#splitStroke)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                            
                            <Line 
                                yAxisId="left" type="monotone" dataKey="pnlTarget" stroke="var(--color-accent)" strokeWidth={2} dot={false} isAnimationActive={false} 
                                activeDot={(props:any) => {
                                    const { cx, cy } = props;
                                    if (!cx || !cy) return null;
                                    return (
                                        <svg x={cx - 6} y={cy - 6} width={12} height={12} viewBox="0 0 10 10">
                                            <polygon points="5,0 10,5 5,10 0,5" fill="var(--color-accent)" stroke="white" strokeWidth="1" />
                                        </svg>
                                    );
                                }}
                            />
                        </ComposedChart>
                    </ResponsiveContainer>
                 ) : (
                   <div style={{height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '12px', border: '1px dashed #2a313e', borderRadius: '4px'}}>
                      Chart Area
                   </div>
                 )}
               </div>
               </>
               )}
               
               {activeTab === 'Chart' && stratBasket.length > 0 && spotPrice && targetPrice !== null && (
               <div style={{display: 'flex', flexDirection: 'column', gap: '20px', padding: '0 15px', marginBottom: '20px'}}>
                   <div>
                       <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px'}}>
                           <span className="text-secondary text-sm">{activeAsset} Target Price <span style={{color: 'var(--color-accent)', cursor: 'pointer', fontSize: '11px', marginLeft: '5px'}} onClick={() => setTargetPrice(spotPrice)}>↺ Reset</span></span>
                           <span className="font-bold">{targetPrice.toFixed(0)}</span>
                       </div>
                       <input 
                           type="range" 
                           min={Math.round(spotPrice * 0.965)} 
                           max={Math.round(spotPrice * 1.035)} 
                           step={Math.round(spotPrice * 0.001)} 
                           value={targetPrice} 
                           onChange={(e) => setTargetPrice(Number(e.target.value))}
                           style={{width: '100%', accentColor: 'var(--color-accent)'}}
                       />
                   </div>
                   
                   <div>
                         <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px'}}>
                             <span className="text-secondary text-sm">Target Date <span style={{color: 'var(--color-accent)', cursor: 'pointer', fontSize: '11px', marginLeft: '5px'}} onClick={() => setTargetDate(computedSliderMin)}>↺ Reset</span></span>
                             <div style={{textAlign: 'right'}}>
                                 <div className="font-bold text-sm">{new Date(targetDate).toLocaleString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute:'2-digit'})}</div>
                                 <div className="text-xs text-secondary">{Math.max(0, Math.round((minExpiry - targetDate) / MS_PER_DAY))} days to Expiry</div>
                             </div>
                         </div>
                         <input 
                             type="range" 
                             min={computedSliderMin} 
                             max={minExpiry > computedSliderMin ? minExpiry : computedSliderMin} 
                             step={MS_PER_DAY}
                             value={targetDate}
                             onChange={(e) => setTargetDate(Number(e.target.value))}
                             style={{width: '100%', accentColor: 'var(--color-accent)'}}
                         />
                     </div>
               </div>
               )}
               
               {activeTab === 'PNL' && stratBasket.length > 0 && (
                   <div style={{padding: '0 15px', marginBottom: '20px'}}>
                       <div style={{display: 'flex', fontSize: '11px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', marginBottom: '8px'}}>
                           <div style={{flex: 2, display: 'flex', alignItems: 'center', gap: '5px'}}>
                               <input type="checkbox" defaultChecked style={{accentColor: 'var(--color-accent)'}} /> 
                               Contracts ({stratBasket.length} / {stratBasket.length} Selected)
                           </div>
                           <div style={{flex: 1, textAlign: 'right'}}>Est. Price</div>
                           <div style={{flex: 1, textAlign: 'right'}}>Entry Price</div>
                           <div style={{flex: 1, textAlign: 'right'}}>Target PNL</div>
                       </div>
                       
                       {stratBasket.map((leg, idx) => {
                           const chain = chainByExpiry[leg.expiry] || [];
                           const row = chain.find((r:any) => r.strike === leg.strike);
                           const liveMark = row ? (leg.option_type === 'CALL' ? row.callMark : row.putMark) : 0;
                           const cv = activeAsset === 'BTC' ? 0.001 : (activeAsset === 'ETH' ? 0.01 : 1);
                           let intrinsic = targetPrice ? (leg.option_type === 'CALL' ? Math.max(0, targetPrice - leg.strike) : Math.max(0, leg.strike - targetPrice)) : liveMark;
                           const entryPrice = leg.price || 0; 
                           const legPnl = (leg.side === 'BUY' ? intrinsic - entryPrice : entryPrice - intrinsic) * leg.size * cv;
                           
                           return (
                               <div key={idx} style={{display: 'flex', fontSize: '13px', alignItems: 'center', marginBottom: '10px'}}>
                                   <div style={{flex: 2, display: 'flex', alignItems: 'center', gap: '5px'}}>
                                       <input type="checkbox" defaultChecked style={{accentColor: 'var(--color-accent)'}} />
                                       <div style={{display: 'flex', alignItems: 'center', gap: '5px'}}>
                                           <span style={{background: leg.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', color: 'white', padding: '1px 4px', fontSize: '10px', borderRadius: '2px', fontWeight: 'bold'}}>{leg.side === 'BUY' ? 'B' : 'S'}</span>
                                           <span className="font-bold">{leg.option_type === 'CALL' ? 'C' : 'P'}</span>
                                           <span className="font-bold text-sm" style={{marginLeft: '2px'}}>{leg.strike}</span>
                                           <select 
                                               style={{background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '12px', cursor: 'pointer', outline: 'none'}}
                                               value={leg.expiry}
                                               onChange={(e) => {
                                                   const newBasket = [...stratBasket];
                                                   newBasket[idx].expiry = e.target.value;
                                                   setStratBasket(newBasket);
                                               }}
                                           >
                                               {Object.keys(chainByExpiry).map(exp => (
                                                   <option key={exp} value={exp} style={{background: 'var(--bg-surface)'}}>
                                                       {new Date(exp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '')}
                                                   </option>
                                               ))}
                                           </select>
                                       </div>
                                   </div>
                                   <div style={{flex: 1, textAlign: 'right'}}>₹{intrinsic.toFixed(2)}</div>
                                   <div style={{flex: 1, textAlign: 'right'}}>₹{entryPrice.toFixed(2)}</div>
                                   <div style={{flex: 1, textAlign: 'right', fontWeight: 'bold', color: legPnl >= 0 ? 'var(--color-up)' : 'var(--color-down)'}}>{legPnl >= 0 ? `+₹${legPnl.toFixed(2)}` : `-₹${Math.abs(legPnl).toFixed(2)}`}</div>
                               </div>
                           );
                       })}
                       
                       <div style={{display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '15px', marginTop: '10px'}}>
                           <span className="text-sm text-secondary">Total Projected PNL</span>
                           <span className="text-sm font-bold" style={{color: projectedPNL >= 0 ? 'var(--color-up)' : 'var(--color-down)'}}>{projectedPNL >= 0 ? `+₹${projectedPNL.toFixed(2)}` : `-₹${Math.abs(projectedPNL).toFixed(2)}`}</span>
                       </div>
                   </div>
               )}
               
               {activeTab === 'Greeks' && stratBasket.length > 0 && (
                   <div style={{padding: '0 15px', marginBottom: '20px'}}>
                       <div style={{display: 'flex', fontSize: '11px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', marginBottom: '8px'}}>
                           <div style={{flex: 2, display: 'flex', alignItems: 'center', gap: '5px'}}>
                               <input type="checkbox" defaultChecked style={{accentColor: 'var(--color-accent)'}} /> 
                               Contracts ({stratBasket.length} / {stratBasket.length} Selected)
                           </div>
                           <div style={{flex: 1, textAlign: 'right'}}>Delta</div>
                           <div style={{flex: 1, textAlign: 'right'}}>Gamma</div>
                           <div style={{flex: 1, textAlign: 'right'}}>Theta</div>
                           <div style={{flex: 1, textAlign: 'right'}}>Vega</div>
                       </div>
                       
                       {(() => {
                           let totalDelta = 0, totalGamma = 0, totalTheta = 0, totalVega = 0;
                           
                           return (
                               <>
                               {stratBasket.map((leg, idx) => {
                                   const chain = chainByExpiry[leg.expiry] || [];
                                   const row = chain.find((r:any) => r.strike === leg.strike);
                                   const delta = row ? (leg.option_type === 'CALL' ? row.callDelta : row.putDelta) : 0;
                                   const gamma = row ? (leg.option_type === 'CALL' ? row.callGamma : row.putGamma) : 0;
                                   const theta = row ? (leg.option_type === 'CALL' ? row.callTheta : row.putTheta) : 0;
                                   const vega = row ? (leg.option_type === 'CALL' ? row.callVega : row.putVega) : 0;
                                   
                                   const mult = leg.side === 'BUY' ? leg.size : -leg.size;
                                   totalDelta += delta * mult; totalGamma += gamma * mult; totalTheta += theta * mult; totalVega += vega * mult;
                                   const cv = activeAsset === 'BTC' ? 0.001 : (activeAsset === 'ETH' ? 0.01 : 1);
                                   
                                   return (
                                       <div key={idx} style={{display: 'flex', fontSize: '13px', alignItems: 'center', marginBottom: '10px', fontFamily: 'monospace'}}>
                                           <div style={{flex: 2, display: 'flex', alignItems: 'center', gap: '5px', fontFamily: 'var(--font-family)'}}>
                                               <input type="checkbox" defaultChecked style={{accentColor: 'var(--color-accent)'}} />
                                               <span style={{background: leg.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', color: 'white', padding: '1px 4px', fontSize: '10px', borderRadius: '2px', fontWeight: 'bold'}}>{leg.side === 'BUY' ? 'B' : 'S'}</span>
                                               <span className="font-bold">{leg.option_type === 'CALL' ? 'C' : 'P'}-{leg.strike}</span>
                                               <span className="text-secondary" style={{fontSize: '11px', marginLeft: '5px'}}>{new Date(leg.expiry).toLocaleDateString('en-GB', {day: '2-digit', month: 'short'}).replace(/ /g, '')} | {cv} {activeAsset}</span>
                                           </div>
                                           <div style={{flex: 1, textAlign: 'right'}}>{(delta * mult).toFixed(2)}</div>
                                           <div style={{flex: 1, textAlign: 'right'}}>{(gamma * mult).toFixed(5)}</div>
                                           <div style={{flex: 1, textAlign: 'right'}}>{(theta * mult).toFixed(2)}</div>
                                           <div style={{flex: 1, textAlign: 'right'}}>{(vega * mult).toFixed(2)}</div>
                                       </div>
                                   );
                               })}
                               
                               <div style={{display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '15px', marginTop: '10px', fontSize: '13px', fontFamily: 'monospace'}}>
                                   <span className="font-bold" style={{flex: 2, fontFamily: 'var(--font-family)'}}>Total</span>
                                   <div style={{flex: 1, textAlign: 'right'}}>{totalDelta.toFixed(2)}</div>
                                   <div style={{flex: 1, textAlign: 'right'}}>{totalGamma.toFixed(5)}</div>
                                   <div style={{flex: 1, textAlign: 'right'}}>{totalTheta.toFixed(2)}</div>
                                   <div style={{flex: 1, textAlign: 'right'}}>{totalVega.toFixed(2)}</div>
                               </div>
                               </>
                           );
                       })()}
                   </div>
               )}
               
               <div style={{padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)'}}>   </div>
            </div>
           </div>
           
           <div style={{borderTop: '1px solid var(--border-color)', background: 'var(--bg-base)', marginTop: 'auto'}}>
               {/* Insufficient Margin Banner */}
               {(orderMargin + tradingFees.totalAllFees) > activeAccount.balance ? (
                   <div style={{background: '#2A171D', color: '#F84960', padding: '10px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)'}}>
                       <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                           <span style={{fontSize: '14px'}}>!</span>
                           <span>Insufficient balance. Demo mode will auto-fund this order.</span>
                       </div>
                   </div>
               ) : tradeMessage ? (
                   <div style={{background: 'rgba(0, 192, 135, 0.12)', color: 'var(--color-up)', padding: '10px 16px', fontSize: '12px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
                       <span>{tradeMessage}</span>
                       <span style={{color: 'var(--text-secondary)', cursor: 'pointer'}} onClick={() => setTradeMessage('')}>✕</span>
                   </div>
               ) : null}
               
               <div style={{padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px'}}>
                   <div style={{display: 'flex', gap: '30px', flex: 1}}>
                       <div style={{display: 'flex', flexDirection: 'column', gap: '4px'}}>
                           <div style={{display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)'}}>
                               Order Margin <span style={{fontSize: '10px', cursor: 'pointer'}}>↻</span>
                           </div>
                           <span style={{fontWeight: 'bold', color: 'white', fontSize: '14px'}}>₹{orderMargin.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                       </div>
                       <div style={{display: 'flex', flexDirection: 'column', gap: '4px'}}>
                           <div style={{fontSize: '11px', color: 'var(--text-secondary)'}}>
                               Available Margin
                           </div>
                           <span style={{fontWeight: 'bold', fontSize: '14px', color: activeAccount.balance < (orderMargin + tradingFees.totalAllFees) ? 'var(--color-down)' : 'white'}}>₹{activeAccount.balance.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                       </div>
                   </div>
                   
                   <button 
                       className="btn" 
                       style={{
                           background: stratBasket.length === 0 ? '#384050' : 'var(--color-accent)', 
                           color: stratBasket.length === 0 ? '#838a9b' : 'white', 
                           fontWeight: 'bold', 
                           fontSize: '14px', 
                           padding: '12px 24px', 
                           borderRadius: '4px',
                           cursor: stratBasket.length === 0 ? 'not-allowed' : 'pointer',
                           border: 'none',
                           flex: 1
                       }} 
                       disabled={stratBasket.length === 0}
                       onClick={() => handleTrade(stratBasket, strategy)}
                   >
                       Place Order {stratBasket.length > 0 ? `(${stratBasket.length})` : ''}
                   </button>
               </div>
           </div>
        </aside>
        )}
      
      </main>

      {/* Account Switcher & Sub-Account Creator Modal */}
      {showAccountModal && (
          <div style={{position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(4px)'}}>
              <div style={{background: '#141822', padding: '22px', borderRadius: '10px', width: '500px', border: '1px solid var(--border-color)', position: 'relative', boxShadow: '0 12px 40px rgba(0,0,0,0.6)'}}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px'}}>
                      <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                          <span style={{color: 'var(--color-accent)', fontSize: '16px'}}>💼</span>
                          <h3 style={{fontSize: '15px', fontWeight: 'bold', color: 'white'}}>Manage Sub-Accounts</h3>
                          <span style={{background: 'rgba(255,255,255,0.08)', color: 'var(--text-secondary)', fontSize: '10px', padding: '2px 6px', borderRadius: '10px'}}>
                              {accounts.length} / 10 Accounts
                          </span>
                      </div>
                      <span style={{cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '16px'}} onClick={() => setShowAccountModal(false)}>✕</span>
                  </div>

                  <div style={{fontSize: '11.5px', color: 'var(--text-secondary)', marginBottom: '12px'}}>
                      Switch between your active sub-accounts or create a new account with custom margin:
                  </div>

                  {/* Accounts List */}
                  <div style={{display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '18px', maxHeight: '220px', overflowY: 'auto'}}>
                      {accounts.map(acc => (
                          <div 
                              key={acc.id} 
                              style={{
                                  display: 'flex', 
                                  alignItems: 'center', 
                                  justifyContent: 'space-between', 
                                  padding: '10px 12px', 
                                  borderRadius: '6px', 
                                  border: activeAccountId === acc.id ? '1px solid var(--color-accent)' : '1px solid var(--border-color)',
                                  background: activeAccountId === acc.id ? 'rgba(239, 131, 46, 0.1)' : 'rgba(255,255,255,0.02)',
                                  cursor: 'pointer'
                              }}
                              onClick={() => { setActiveAccountId(acc.id); setShowAccountModal(false); }}
                          >
                              <div style={{display: 'flex', flexDirection: 'column', gap: '2px'}}>
                                  <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                                      <span style={{fontWeight: 600, fontSize: '12px', color: 'white'}}>{acc.name}</span>
                                      <span style={{background: acc.margin_type === 'Cross' ? 'rgba(0,192,135,0.2)' : 'rgba(239,131,46,0.2)', color: acc.margin_type === 'Cross' ? 'var(--color-up)' : 'var(--color-accent)', fontSize: '9px', padding: '1px 5px', borderRadius: '2px', fontWeight: 'bold'}}>
                                          {acc.margin_type}
                                      </span>
                                      {activeAccountId === acc.id && <span style={{color: 'var(--color-accent)', fontSize: '10px', fontWeight: 'bold'}}>✓ Active</span>}
                                  </div>
                                  <span style={{fontSize: '10px', color: 'var(--text-secondary)'}}>ID: #{acc.id} • INR Margin</span>
                              </div>
                              
                              <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                                  <div style={{textAlign: 'right'}}>
                                      <div style={{fontSize: '13px', fontWeight: 'bold', color: 'white'}}>₹{Number(acc.balance).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
                                      <div style={{fontSize: '9.5px', color: 'var(--text-secondary)'}}>Available Margin</div>
                                  </div>
                                  <button 
                                      style={{background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-color)', color: 'var(--color-accent)', padding: '4px 9px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold'}}
                                      onClick={(e) => {
                                          e.stopPropagation();
                                          handleOpenEditAccount(acc);
                                      }}
                                      title="Edit Account Name, Margin Type or Balance"
                                  >
                                      ✎ Edit Account
                                  </button>
                              </div>
                          </div>
                      ))}
                  </div>

                  {/* Create New Account Section */}
                  <div style={{borderTop: '1px solid var(--border-color)', paddingTop: '14px'}}>
                      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px'}}>
                          <div style={{fontWeight: 'bold', fontSize: '12px', color: 'white'}}>+ Create New Sub-Account</div>
                          {accountError && <span style={{color: 'var(--color-down)', fontSize: '10px'}}>{accountError}</span>}
                      </div>
                      
                      <div style={{display: 'flex', flexDirection: 'column', gap: '10px'}}>
                          <div style={{display: 'flex', gap: '8px'}}>
                              <input 
                                  type="text" 
                                  placeholder="Account Name (e.g. Scalping / 10L Fund)" 
                                  value={newAccName} 
                                  onChange={e => setNewAccName(e.target.value)}
                                  style={{flex: 2, background: '#0e121a', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '7px 10px', color: 'white', fontSize: '11.5px', outline: 'none'}}
                              />
                              <select 
                                  value={newAccType} 
                                  onChange={(e: any) => setNewAccType(e.target.value)}
                                  style={{flex: 1, background: '#0e121a', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '7px 8px', color: 'white', fontSize: '11.5px', outline: 'none'}}
                              >
                                  <option value="Cross">Cross Margin</option>
                                  <option value="Isolated">Isolated Margin</option>
                              </select>
                          </div>

                          {/* Quick Margin Presets for New Account */}
                          <div style={{display: 'flex', flexWrap: 'wrap', gap: '5px'}}>
                              {[50000, 100000, 250000, 500000, 1000000, 2500000, 5000000].map(amt => (
                                  <button 
                                      key={amt}
                                      style={{
                                          background: newAccBalance === amt ? 'var(--color-accent)' : 'rgba(255,255,255,0.05)',
                                          color: newAccBalance === amt ? 'white' : 'var(--text-secondary)',
                                          border: '1px solid var(--border-color)',
                                          borderRadius: '3px',
                                          padding: '3px 8px',
                                          fontSize: '10px',
                                          cursor: 'pointer',
                                          fontWeight: newAccBalance === amt ? 'bold' : 'normal'
                                      }}
                                      onClick={() => setNewAccBalance(amt)}
                                  >
                                      {amt >= 100000 ? `₹${(amt / 100000).toFixed(amt % 100000 === 0 ? 0 : 1)}L` : `₹${amt / 1000}k`}
                                  </button>
                              ))}
                          </div>

                          <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
                              <div style={{flex: 2, display: 'flex', alignItems: 'center', background: '#0e121a', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '0 10px'}}>
                                  <span style={{color: 'var(--text-secondary)', fontSize: '11px', marginRight: '4px'}}>₹</span>
                                  <input 
                                      type="number" 
                                      placeholder="Initial Margin Amount" 
                                      value={newAccBalance} 
                                      onChange={e => setNewAccBalance(Number(e.target.value))}
                                      style={{width: '100%', background: 'transparent', border: 'none', padding: '7px 0', color: 'white', fontSize: '12px', fontWeight: 'bold', outline: 'none'}}
                                  />
                              </div>
                              <button 
                                  className="btn" 
                                  style={{
                                      flex: 1, 
                                      background: accounts.length >= 10 ? '#384050' : 'var(--color-accent)', 
                                      color: accounts.length >= 10 ? '#838a9b' : 'white', 
                                      padding: '8px 12px', 
                                      fontSize: '11px', 
                                      fontWeight: 'bold', 
                                      border: 'none', 
                                      borderRadius: '4px', 
                                      cursor: accounts.length >= 10 ? 'not-allowed' : 'pointer'
                                  }}
                                  disabled={accounts.length >= 10}
                                  onClick={handleCreateAccount}
                              >
                                  {accounts.length >= 10 ? 'Max 10 Reached' : 'Create Account'}
                              </button>
                          </div>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {/* Edit Account Modal */}
      {editingAccount && (
          <div style={{position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 10000, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(4px)'}}>
              <div style={{background: '#141822', padding: '22px', borderRadius: '10px', width: '460px', border: '1px solid var(--border-color)', position: 'relative', boxShadow: '0 12px 40px rgba(0,0,0,0.6)'}}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px'}}>
                      <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                          <span style={{color: 'var(--color-accent)', fontSize: '16px'}}>✎</span>
                          <h3 style={{fontSize: '15px', fontWeight: 'bold', color: 'white'}}>Edit Sub-Account #{editingAccount.id}</h3>
                      </div>
                      <span style={{cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '16px'}} onClick={() => setEditingAccount(null)}>✕</span>
                  </div>

                  <div style={{display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '20px'}}>
                      {/* Account Name */}
                      <div>
                          <label style={{fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px'}}>Account Name</label>
                          <input 
                              type="text" 
                              value={editAccName} 
                              onChange={e => setEditAccName(e.target.value)}
                              placeholder="e.g. Nifty Scalp Alpha"
                              style={{width: '100%', background: '#0e121a', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '8px 10px', color: 'white', fontSize: '12px', outline: 'none'}}
                          />
                      </div>

                      {/* Margin Type */}
                      <div>
                          <label style={{fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px'}}>Margin Mode</label>
                          <select 
                              value={editAccMarginType} 
                              onChange={e => setEditAccMarginType(e.target.value)}
                              style={{width: '100%', background: '#0e121a', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '8px 10px', color: 'white', fontSize: '12px', outline: 'none'}}
                          >
                              <option value="Cross">Cross Margin (Shared Balance)</option>
                              <option value="Isolated">Isolated Margin (Independent Capital)</option>
                          </select>
                      </div>

                      {/* Margin Balance */}
                      <div>
                          <label style={{fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px'}}>Available Margin (INR ₹)</label>
                          <div style={{display: 'flex', alignItems: 'center', background: '#0e121a', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '6px 12px', marginBottom: '8px'}}>
                              <span style={{color: 'var(--color-accent)', fontWeight: 'bold', fontSize: '14px', marginRight: '6px'}}>₹</span>
                              <input 
                                  type="number" 
                                  value={editAccBalance} 
                                  onChange={e => setEditAccBalance(Number(e.target.value))}
                                  style={{width: '100%', background: 'transparent', border: 'none', color: 'white', fontSize: '13px', fontWeight: 'bold', outline: 'none'}}
                              />
                          </div>

                          {/* Quick Margin Presets */}
                          <div style={{display: 'flex', flexWrap: 'wrap', gap: '5px'}}>
                              {[50000, 100000, 250000, 500000, 1000000, 2500000, 5000000].map(amt => (
                                  <button 
                                      key={amt}
                                      style={{
                                          background: editAccBalance === amt ? 'var(--color-accent)' : 'rgba(255,255,255,0.05)',
                                          color: editAccBalance === amt ? 'white' : 'var(--text-secondary)',
                                          border: '1px solid var(--border-color)',
                                          borderRadius: '3px',
                                          padding: '3px 8px',
                                          fontSize: '10px',
                                          cursor: 'pointer',
                                          fontWeight: editAccBalance === amt ? 'bold' : 'normal'
                                      }}
                                      onClick={() => setEditAccBalance(amt)}
                                  >
                                      {amt >= 100000 ? `₹${(amt / 100000).toFixed(amt % 100000 === 0 ? 0 : 1)}L` : `₹${amt / 1000}k`}
                                  </button>
                              ))}
                          </div>
                      </div>
                  </div>

                  <div style={{display: 'flex', gap: '10px', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '14px'}}>
                      <button 
                          style={{background: 'rgba(248, 73, 96, 0.1)', color: 'var(--color-down)', border: '1px solid rgba(248, 73, 96, 0.3)', padding: '8px 12px', fontSize: '11px', fontWeight: 600, borderRadius: '4px', cursor: 'pointer'}}
                          onClick={() => handleDeleteAccount(editingAccount.id)}
                          title="Delete this sub-account"
                      >
                          🗑️ Delete Account
                      </button>

                      <div style={{display: 'flex', gap: '8px'}}>
                          <button 
                              style={{background: 'rgba(255,255,255,0.08)', color: 'var(--text-secondary)', border: 'none', padding: '8px 14px', fontSize: '11.5px', borderRadius: '4px', cursor: 'pointer'}}
                              onClick={() => setEditingAccount(null)}
                          >
                              Cancel
                          </button>
                          <button 
                              style={{background: 'var(--color-accent)', color: 'white', border: 'none', padding: '8px 18px', fontSize: '11.5px', fontWeight: 'bold', borderRadius: '4px', cursor: 'pointer'}}
                              onClick={handleUpdateAccount}
                          >
                              Save Changes
                          </button>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {/* Available Margin Customizer Modal */}
      {showMarginCustomizer && (
          <div style={{position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(4px)'}}>
              <div style={{background: '#141822', padding: '22px', borderRadius: '10px', width: '450px', border: '1px solid var(--border-color)', position: 'relative', boxShadow: '0 12px 40px rgba(0,0,0,0.6)'}}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px'}}>
                      <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                          <span style={{color: 'var(--color-accent)', fontSize: '16px'}}>💰</span>
                          <h3 style={{fontSize: '15px', fontWeight: 'bold', color: 'white'}}>Customize Available Margin</h3>
                      </div>
                      <span style={{cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '16px'}} onClick={() => setShowMarginCustomizer(false)}>✕</span>
                  </div>

                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11.5px', color: 'var(--text-secondary)', marginBottom: '14px'}}>
                      <div>Account: <strong style={{color: 'white'}}>{activeAccount?.name}</strong></div>
                      <button 
                          onClick={() => { setShowMarginCustomizer(false); setShowAccountModal(true); }}
                          style={{background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-color)', color: 'var(--color-accent)', padding: '2px 8px', borderRadius: '3px', fontSize: '10.5px', cursor: 'pointer', fontWeight: 'bold'}}
                      >
                          Switch Account ⌄
                      </button>
                  </div>

                  <div style={{marginBottom: '16px'}}>
                      <label style={{fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px'}}>Available Margin Amount (INR ₹)</label>
                      <div style={{display: 'flex', alignItems: 'center', background: '#0e121a', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px 12px'}}>
                          <span style={{color: 'var(--color-accent)', fontWeight: 'bold', fontSize: '14px', marginRight: '6px'}}>₹</span>
                          <input 
                              type="number" 
                              value={customBalanceInput} 
                              onChange={e => setCustomBalanceInput(Number(e.target.value))}
                              style={{width: '100%', background: 'transparent', border: 'none', color: 'white', fontSize: '14px', fontWeight: 'bold', outline: 'none'}}
                          />
                      </div>
                  </div>

                  {/* Quick Preset Chips */}
                  <div style={{display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '20px'}}>
                      {[10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000].map(amt => (
                          <button 
                              key={amt} 
                              style={{
                                  background: customBalanceInput === amt ? 'var(--color-accent)' : 'rgba(255,255,255,0.04)', 
                                  color: customBalanceInput === amt ? 'white' : 'var(--text-secondary)',
                                  border: '1px solid var(--border-color)',
                                  borderRadius: '3px',
                                  padding: '5px 10px',
                                  fontSize: '11px',
                                  fontWeight: customBalanceInput === amt ? 'bold' : 'normal',
                                  cursor: 'pointer'
                              }}
                              onClick={() => setCustomBalanceInput(amt)}
                          >
                              {amt >= 100000 ? `₹${(amt / 100000).toFixed(amt % 100000 === 0 ? 0 : 1)}L` : `₹${amt / 1000}k`}
                          </button>
                      ))}
                      <button 
                          style={{background: 'rgba(255,255,255,0.04)', color: 'var(--color-up)', border: '1px solid var(--border-color)', borderRadius: '3px', padding: '5px 8px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer'}}
                          onClick={() => setCustomBalanceInput(prev => prev + 50000)}
                      >
                          +₹50k
                      </button>
                      <button 
                          style={{background: 'rgba(255,255,255,0.04)', color: 'var(--color-up)', border: '1px solid var(--border-color)', borderRadius: '3px', padding: '5px 8px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer'}}
                          onClick={() => setCustomBalanceInput(prev => prev + 100000)}
                      >
                          +₹1L
                      </button>
                  </div>

                  <div style={{display: 'flex', gap: '10px'}}>
                      <button 
                          className="btn" 
                          style={{flex: 1, background: 'rgba(255,255,255,0.08)', color: 'var(--text-secondary)', border: 'none', padding: '10px', fontSize: '12px', borderRadius: '4px', cursor: 'pointer'}}
                          onClick={() => setShowMarginCustomizer(false)}
                      >
                          Cancel
                      </button>
                      <button 
                          className="btn" 
                          style={{flex: 2, background: 'var(--color-accent)', color: 'white', border: 'none', padding: '10px', fontSize: '12px', fontWeight: 'bold', borderRadius: '4px', cursor: 'pointer'}}
                          onClick={() => handleSaveCustomMargin(customBalanceInput)}
                      >
                          Apply Margin
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* Leverage Modal Overlay */}
      {showLeverageModal && (
          <div style={{position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center'}}>
              <div style={{background: 'var(--bg-surface)', padding: '20px', borderRadius: '8px', width: '380px', border: '1px solid var(--border-color)', position: 'relative'}}>
                  <span style={{position: 'absolute', top: '15px', right: '15px', cursor: 'pointer'}} onClick={() => setShowLeverageModal(false)}>✕</span>
                  <h3 style={{marginBottom: '16px', textAlign: 'center', fontSize: '13px', fontWeight: 'bold'}}>Adjust Leverage</h3>
                  
                  <div style={{marginBottom: '16px'}}>
                      <div className="text-secondary text-xs mb-2">Leverage Multiplier</div>
                      <div style={{display: 'flex', background: '#161a22', borderRadius: '4px', padding: '8px', alignItems: 'center'}}>
                          <span style={{cursor: 'pointer', padding: '0 10px', fontSize: '14px'}} onClick={() => setLeverage(Math.max(1, leverage - 5))}>-</span>
                          <span style={{flex: 1, textAlign: 'center', fontWeight: 'bold', fontSize: '13px'}}>{leverage}x</span>
                          <span style={{cursor: 'pointer', padding: '0 10px', fontSize: '14px'}} onClick={() => setLeverage(Math.min(200, leverage + 5))}>+</span>
                      </div>
                  </div>
                  
                  <div style={{display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', color: 'var(--text-secondary)', marginBottom: '16px'}}>
                      {[1, 2, 5, 10, 25, 50, 100, 200].map(val => (
                          <span key={val} style={{cursor: 'pointer', color: leverage === val ? 'var(--color-accent)' : 'inherit', fontWeight: leverage === val ? 'bold' : 'normal'}} onClick={() => setLeverage(val)}>
                              {val}x
                          </span>
                      ))}
                  </div>
                  
                  <button className="btn btn-primary" style={{width: '100%', padding: '8px', fontSize: '11.5px'}} onClick={() => setShowLeverageModal(false)}>Done</button>
              </div>
          </div>
      )}
      {/* Groww-Standard Indian F&O Brokerage & Pricing Calculator Modal */}
      {showCalculatorModal && (() => {
          const qty = Number(calcQty) || 65;
          const buy = Number(calcBuyPrice) || 0;
          const sell = Number(calcSellPrice) || 0;
          
          const turnover = (buy + sell) * qty;
          const grossPnl = (sell - buy) * qty;
          const brokerage = 40.0; // ₹20 Buy + ₹20 Sell
          const stt = (calcSegment === 'F&O') ? (sell * qty * 0.00125) : (sell * qty * 0.00025); // 0.125% on sell premium
          const exchangeCharges = turnover * 0.0003503; // NSE 0.03503%
          const sebiFees = turnover * 0.000001; // SEBI ₹10/crore
          const gst = (brokerage + exchangeCharges + sebiFees) * 0.18; // 18% GST
          const stampDuty = buy * qty * 0.00003; // 0.003% on buy
          const totalCharges = brokerage + stt + exchangeCharges + sebiFees + gst + stampDuty;
          const netPnl = grossPnl - totalCharges;

          return (
          <div style={{position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 99999, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(4px)'}}>
              <div style={{background: '#0d1117', border: '1px solid #30363d', borderRadius: '12px', width: '850px', maxHeight: '90vh', overflowY: 'auto', padding: '24px', boxShadow: '0 20px 60px rgba(0,0,0,0.8)', color: 'white'}}>
                  {/* Header */}
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid #21262d', paddingBottom: '12px'}}>
                      <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                          <div style={{width: '32px', height: '32px', borderRadius: '6px', background: 'rgba(0, 192, 135, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00C087', fontSize: '18px'}}>🧮</div>
                          <div>
                              <h2 style={{fontSize: '18px', fontWeight: 'bold', margin: 0}}>Brokerage Calculator</h2>
                              <p style={{fontSize: '11px', color: 'var(--text-secondary)', margin: '2px 0 0 0'}}>Indian Equity Derivatives (NSE) & Options Pricing Model</p>
                          </div>
                      </div>
                      <span style={{cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '18px', padding: '4px 8px'}} onClick={() => setShowCalculatorModal(false)}>✕</span>
                  </div>

                  {/* Segment Tabs */}
                  <div style={{display: 'flex', gap: '8px', marginBottom: '24px'}}>
                      {(['Equity - delivery', 'Equity - intraday', 'F&O'] as const).map(tab => (
                          <button 
                              key={tab}
                              onClick={() => setCalcSegment(tab)}
                              style={{
                                  background: calcSegment === tab ? '#163b2f' : '#161b22',
                                  color: calcSegment === tab ? '#00c087' : '#8b949e',
                                  border: calcSegment === tab ? '1px solid #00c087' : '1px solid #30363d',
                                  borderRadius: '20px',
                                  padding: '6px 16px',
                                  fontSize: '12px',
                                  fontWeight: '600',
                                  cursor: 'pointer'
                              }}
                          >
                              {tab}
                          </button>
                      ))}
                  </div>

                  {/* 2-Column Grid */}
                  <div style={{display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: '28px'}}>
                      {/* Left: Input Fields */}
                      <div style={{display: 'flex', flexDirection: 'column', gap: '18px'}}>
                          <div>
                              <label style={{fontSize: '12px', color: '#8b949e', display: 'block', marginBottom: '6px'}}>
                                  Qty Option (Lots / Units) <span style={{color: '#00c087'}}>• NSE</span>
                              </label>
                              <div style={{display: 'flex', gap: '8px'}}>
                                  <input 
                                      type="number" 
                                      value={calcQty} 
                                      onChange={e => setCalcQty(Number(e.target.value))}
                                      style={{flex: 1, background: '#161b22', border: '1px solid #30363d', color: 'white', padding: '10px 12px', borderRadius: '6px', fontSize: '14px', fontWeight: 'bold', outline: 'none'}}
                                  />
                                  <div style={{display: 'flex', gap: '4px'}}>
                                      {[65, 130, 195, 260].map(q => (
                                          <button 
                                              key={q} 
                                              onClick={() => setCalcQty(q)}
                                              style={{background: calcQty === q ? '#00c087' : '#21262d', color: calcQty === q ? 'black' : '#c9d1d9', border: 'none', borderRadius: '4px', padding: '0 8px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer'}}
                                          >
                                              {q / 65}L
                                          </button>
                                      ))}
                                  </div>
                              </div>
                              <span style={{fontSize: '11px', color: '#8b949e', marginTop: '4px', display: 'block'}}>
                                  {calcQty} units = {(calcQty / 65).toFixed(1)} NIFTY Lots
                              </span>
                          </div>

                          <div>
                              <label style={{fontSize: '12px', color: '#8b949e', display: 'block', marginBottom: '6px'}}>Buy price per share (₹)</label>
                              <div style={{display: 'flex', alignItems: 'center', background: '#161b22', border: '1px solid #30363d', borderRadius: '6px', padding: '0 12px'}}>
                                  <span style={{color: '#8b949e', marginRight: '6px'}}>₹</span>
                                  <input 
                                      type="number" 
                                      step="0.05"
                                      value={calcBuyPrice} 
                                      onChange={e => setCalcBuyPrice(Number(e.target.value))}
                                      style={{width: '100%', background: 'transparent', border: 'none', color: 'white', padding: '10px 0', fontSize: '14px', fontWeight: 'bold', outline: 'none'}}
                                  />
                              </div>
                          </div>

                          <div>
                              <label style={{fontSize: '12px', color: '#8b949e', display: 'block', marginBottom: '6px'}}>Sell price per share (₹)</label>
                              <div style={{display: 'flex', alignItems: 'center', background: '#161b22', border: '1px solid #30363d', borderRadius: '6px', padding: '0 12px'}}>
                                  <span style={{color: '#8b949e', marginRight: '6px'}}>₹</span>
                                  <input 
                                      type="number" 
                                      step="0.05"
                                      value={calcSellPrice} 
                                      onChange={e => setCalcSellPrice(Number(e.target.value))}
                                      style={{width: '100%', background: 'transparent', border: 'none', color: 'white', padding: '10px 0', fontSize: '14px', fontWeight: 'bold', outline: 'none'}}
                                  />
                              </div>
                          </div>

                          {/* Quick Price Delta buttons */}
                          <div style={{display: 'flex', gap: '8px'}}>
                              <button onClick={() => setCalcSellPrice(calcBuyPrice + 10)} style={{flex: 1, background: '#21262d', border: '1px solid #30363d', color: '#00c087', padding: '6px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer'}}>+10 Pts</button>
                              <button onClick={() => setCalcSellPrice(calcBuyPrice + 25)} style={{flex: 1, background: '#21262d', border: '1px solid #30363d', color: '#00c087', padding: '6px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer'}}>+25 Pts</button>
                              <button onClick={() => setCalcSellPrice(calcBuyPrice + 50)} style={{flex: 1, background: '#21262d', border: '1px solid #30363d', color: '#00c087', padding: '6px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer'}}>+50 Pts</button>
                              <button onClick={() => setCalcSellPrice(Math.max(0, calcBuyPrice - 20))} style={{flex: 1, background: '#21262d', border: '1px solid #30363d', color: '#f84960', padding: '6px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer'}}>-20 Pts</button>
                          </div>
                      </div>

                      {/* Right: Results Breakdown matching Groww */}
                      <div style={{background: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '18px'}}>
                          <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '13px'}}>
                              <span style={{color: '#8b949e'}}>Turnover</span>
                              <strong style={{fontSize: '14px'}}>₹{turnover.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong>
                          </div>

                          <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '13px'}}>
                              <span style={{color: '#8b949e'}}>Gross P&L</span>
                              <strong style={{fontSize: '14px', color: grossPnl >= 0 ? '#00c087' : '#f84960'}}>
                                  {grossPnl >= 0 ? '+' : ''}₹{grossPnl.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                              </strong>
                          </div>

                          <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '14px', fontSize: '13px', borderBottom: '1px solid #30363d', paddingBottom: '10px'}}>
                              <span style={{color: '#8b949e'}}>Total Charges</span>
                              <strong style={{fontSize: '14px', color: '#f84960'}}>₹{totalCharges.toFixed(2)}</strong>
                          </div>

                          {/* Charges Detailed Itemization */}
                          <div style={{display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '11.5px', marginBottom: '16px', color: '#c9d1d9'}}>
                              <div style={{display: 'flex', justifyContent: 'space-between'}}>
                                  <span>Brokerage (Buy + Sell)</span>
                                  <span>₹{brokerage.toFixed(2)}</span>
                              </div>
                              <div style={{display: 'flex', justifyContent: 'space-between'}}>
                                  <span>Securities Transaction Tax (STT)</span>
                                  <span>₹{stt.toFixed(2)}</span>
                              </div>
                              <div style={{display: 'flex', justifyContent: 'space-between'}}>
                                  <span>Exchange Txn Charges (NSE)</span>
                                  <span>₹{exchangeCharges.toFixed(2)}</span>
                              </div>
                              <div style={{display: 'flex', justifyContent: 'space-between'}}>
                                  <span>SEBI Turnover Fees</span>
                                  <span>₹{sebiFees.toFixed(2)}</span>
                              </div>
                              <div style={{display: 'flex', justifyContent: 'space-between'}}>
                                  <span>GST (18% on Brokerage & Txn)</span>
                                  <span>₹{gst.toFixed(2)}</span>
                              </div>
                              <div style={{display: 'flex', justifyContent: 'space-between'}}>
                                  <span>Stamp Duty</span>
                                  <span>₹{stampDuty.toFixed(2)}</span>
                              </div>
                          </div>

                          {/* Net P&L Highlight Box */}
                          <div style={{background: netPnl >= 0 ? 'rgba(0, 192, 135, 0.1)' : 'rgba(248, 73, 96, 0.1)', border: netPnl >= 0 ? '1px solid #00c087' : '1px solid #f84960', borderRadius: '6px', padding: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                              <div>
                                  <div style={{fontSize: '11px', color: '#8b949e', textTransform: 'uppercase', fontWeight: 'bold'}}>Net P&L</div>
                                  <div style={{fontSize: '9.5px', color: '#8b949e'}}>After all taxes & charges</div>
                              </div>
                              <div style={{fontSize: '18px', fontWeight: 'bold', color: netPnl >= 0 ? '#00c087' : '#f84960'}}>
                                  {netPnl >= 0 ? '+' : ''}₹{netPnl.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                              </div>
                          </div>
                      </div>
                  </div>
              </div>
          </div>
          );
      })()}
    </div>
  );
}

export default NiftyTerminal;


