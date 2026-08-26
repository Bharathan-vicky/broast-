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

function CryptoTerminal() {
  const navigate = useNavigate();
  const [activeAsset, setActiveAsset] = useState('BTC');
  const [activeExpiry, setActiveExpiry] = useState<string>('');
  
  const [expiries, setExpiries] = useState<string[]>([]);
  const [chainByExpiry, setChainByExpiry] = useState<any>({});
  const [portfolio, setPortfolio] = useState<any>(null);
  const [tradeMessage, setTradeMessage] = useState('');
  const [spotPrice, setSpotPrice] = useState<number | null>(null);
  const [timeToExpiry, setTimeToExpiry] = useState<string>('');
  const [showLeverageModal, setShowLeverageModal] = useState(false);
  const [leverage, setLeverage] = useState(200);
  const [targetPrice, setTargetPrice] = useState<number | null>(null);
  const [targetDate, setTargetDate] = useState<number>(Date.now());
  const [activeTab, setActiveTab] = useState<'Chart'|'PNL'|'Greeks'>('Chart');
  const [isTrading, setIsTrading] = useState(false);

  // Multi-Account & Custom Available Margin State (CRYPTO USD - Max 10 Accounts)
  const [accounts, setAccounts] = useState<Account[]>([
    { id: 101, name: 'Crypto Main Account (Cross)', margin_type: 'Cross', balance: 100000.0, currency: 'USD' },
    { id: 102, name: 'BTC Scalping 10k (Cross)', margin_type: 'Cross', balance: 10000.0, currency: 'USD' },
    { id: 103, name: 'BTC Swing Trader 25k (Cross)', margin_type: 'Cross', balance: 25000.0, currency: 'USD' },
    { id: 104, name: 'BTC Option Buying 5k (Cross)', margin_type: 'Cross', balance: 5000.0, currency: 'USD' },
    { id: 105, name: 'ETH Strategy Sub-Account 50k (Isolated)', margin_type: 'Isolated', balance: 50000.0, currency: 'USD' },
    { id: 106, name: 'ETH Weekly Option 15k (Cross)', margin_type: 'Cross', balance: 15000.0, currency: 'USD' },
    { id: 107, name: 'Crypto Delta Neutral 75k (Isolated)', margin_type: 'Isolated', balance: 75000.0, currency: 'USD' },
    { id: 108, name: 'Crypto High Leverage 20k (Cross)', margin_type: 'Cross', balance: 20000.0, currency: 'USD' },
    { id: 109, name: 'Crypto Macro Fund 250k (Cross)', margin_type: 'Cross', balance: 250000.0, currency: 'USD' },
    { id: 110, name: 'Crypto Whale Portfolio 500k (Cross)', margin_type: 'Cross', balance: 500000.0, currency: 'USD' }
  ]);
  const [activeAccountId, setActiveAccountId] = useState<number>(101);
  const [showAccountModal, setShowAccountModal] = useState<boolean>(false);
  const [showMarginCustomizer, setShowMarginCustomizer] = useState<boolean>(false);
  const [newAccName, setNewAccName] = useState('');
  const [newAccBalance, setNewAccBalance] = useState<number>(25000);
  const [newAccType, setNewAccType] = useState<'Cross' | 'Isolated'>('Cross');
  const [customBalanceInput, setCustomBalanceInput] = useState<number>(100000);
  const [accountError, setAccountError] = useState('');

  const activeAccount = accounts.find(a => a.id === activeAccountId) || accounts[0];

  useEffect(() => {
    fetch('http://127.0.0.1:8000/api/accounts?currency=USD')
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
      setAccountError("Limit reached: You can create a maximum of 10 Crypto USD sub-accounts.");
      return;
    }
    setAccountError('');
    fetch('http://127.0.0.1:8000/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newAccName,
        balance: Number(newAccBalance) || 25000,
        margin_type: newAccType,
        currency: 'USD'
      })
    })
    .then(r => r.json())
    .then(data => {
      if (data.status === 'success' && data.account) {
        const newAccount: Account = {
          id: data.account.id,
          name: data.account.name,
          margin_type: data.account.margin_type as 'Cross' | 'Isolated',
          balance: data.account.balance,
          currency: data.account.currency
        };
        setAccounts(prev => [...prev, newAccount]);
        setActiveAccountId(newAccount.id);
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
  const [editAccBalance, setEditAccBalance] = useState<number>(100000);

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
          margin_type: editAccMarginType
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
  
  // Strategy Target Price Sync
  useEffect(() => {
    if (spotPrice && strategyTargetPrice === 0) setStrategyTargetPrice(spotPrice);
  }, [spotPrice]);
  
  // Hover state for Buy/Sell buttons
  const [hoveredCell, setHoveredCell] = useState<{strike: number, side: 'CALL'|'PUT'} | null>(null);

  // Strategy Builder State
  const [showBuilder, setShowBuilder] = useState(true);
  const [stratBasket, setStratBasket] = useState<OptionLeg[]>([]);
  const [strategy, setStrategy] = useState('Custom');
  const [stratSize, setStratSize] = useState(100);
  const [outlook, setOutlook] = useState<'Bullish' | 'Bearish' | 'Neutral' | 'Volatility'>('Bullish');
  const [strategyTargetPrice, setStrategyTargetPrice] = useState<number>(0);
  const [supportPrice, setSupportPrice] = useState<number>(0);
  const [resistancePrice, setResistancePrice] = useState<number>(0);

  useEffect(() => {
    setStrategyTargetPrice(0);
    setSupportPrice(0);
    setResistancePrice(0);
  }, [activeAsset]);

  useEffect(() => {
    if (spotPrice && currentChain.length > 0) {
      const sorted = [...currentChain].sort((a, b) => a.strike - b.strike);
      const strikeStep = sorted.length > 1 ? Math.abs(sorted[1].strike - sorted[0].strike) : 50;
      
      const putsBelow = sorted.filter(r => r.strike < spotPrice);
      const putsSorted = [...putsBelow].sort((a, b) => (b.putOI || 0) - (a.putOI || 0));
      const defaultSupport = putsSorted.length > 0 ? putsSorted[0].strike : Math.round((spotPrice * 0.98) / strikeStep) * strikeStep;
      
      const callsAbove = sorted.filter(r => r.strike > spotPrice);
      const callsSorted = [...callsAbove].sort((a, b) => (b.callOI || 0) - (a.callOI || 0));
      const defaultResistance = callsSorted.length > 0 ? callsSorted[0].strike : Math.round((spotPrice * 1.02) / strikeStep) * strikeStep;

      setSupportPrice(prev => prev === 0 ? defaultSupport : prev);
      setResistancePrice(prev => prev === 0 ? defaultResistance : prev);

      const defaultTarget = outlook === 'Bullish' 
        ? Math.round((spotPrice * 1.02) / strikeStep) * strikeStep
        : outlook === 'Bearish' 
          ? Math.round((spotPrice * 0.98) / strikeStep) * strikeStep
          : Math.round(spotPrice / strikeStep) * strikeStep;

      setStrategyTargetPrice(prev => prev === 0 ? defaultTarget : prev);
    }
  }, [spotPrice, currentChain, outlook]);
  const [portfolioTab, setPortfolioTab] = useState('Positions');
  const [orderHistory, setOrderHistory] = useState<any[]>([]);

  // Table Column Visibility State
  const [showColSettings, setShowColSettings] = useState(false);
  const [cols, setCols] = useState({
      oi: false,
      bidAsk: true,
      qty: true,
      mark: true,
      delta: false,
      volume: false
  });

  const todayStart = useMemo(() => new Date(new Date().setHours(0,0,0,0)).getTime(), []);
  const minExpiry = stratBasket.length > 0 ? Math.min(...stratBasket.map(l => new Date(l.expiry).getTime())) : todayStart + 86400000;
  
  const MS_PER_DAY = 86400000;
  const daysDiff = Math.max(0, Math.floor((minExpiry - todayStart) / MS_PER_DAY));
  const computedSliderMin = minExpiry - (daysDiff * MS_PER_DAY);
  
  useEffect(() => {
     if (targetDate > minExpiry) setTargetDate(minExpiry);
     if (targetDate < computedSliderMin) setTargetDate(computedSliderMin);
  }, [minExpiry, computedSliderMin]);

  // Multi-asset cache for instant 0ms switching
  const [assetCache, setAssetCache] = useState<Record<string, { expiries: string[], chainByExpiry: any, spotPrice?: number }>>({});

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

  // Prefetch all assets on mount
  useEffect(() => {
      const assets = ['BTC', 'ETH', 'XAUT'];
      assets.forEach(asset => {
          Promise.all([
              fetch(`http://127.0.0.1:8000/api/options/chain?asset=${asset}`).then(r => r.json()),
              fetch(`http://127.0.0.1:8000/api/spot?asset=${asset}`).then(r => r.json()).catch(() => ({ spot_price: null }))
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
    fetch(`http://127.0.0.1:8000/api/options/chain?asset=${activeAsset}`)
      .then(res => res.json())
      .then(data => {
        if (data.expiries && data.expiries.length > 0) {
          setExpiries(data.expiries);
          setActiveExpiry(prev => (prev && data.expiries.includes(prev)) ? prev : data.expiries[0]);
        }
        if (data.chainByExpiry) setChainByExpiry(data.chainByExpiry);
      })
      .catch(err => console.error("API error:", err));
      
    fetch(`http://127.0.0.1:8000/api/spot?asset=${activeAsset}`)
      .then(res => res.json())
      .then(data => { if (data.spot_price) setSpotPrice(data.spot_price); })
      .catch(() => {});
  }, [activeAsset]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetch(`http://127.0.0.1:8000/api/options/chain?asset=${activeAsset}`)
        .then(res => res.json())
        .then(data => { 
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
        
      fetch(`http://127.0.0.1:8000/api/portfolio`)
        .then(res => res.json())
        .then(data => setPortfolio(data))
        .catch(() => {});
        
      fetch(`http://127.0.0.1:8000/api/history?account_id=${activeAccountId || 1}`)
        .then(res => res.json())
        .then(setOrderHistory)
        .catch(() => {});
        
      fetch(`http://127.0.0.1:8000/api/spot?asset=${activeAsset}`)
        .then(res => res.json())
        .then(data => {
          if (data.spot_price) {
            setSpotPrice(data.spot_price);
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
    }, 300);
    return () => clearInterval(interval);
  }, [activeAsset]);

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

  const currentChain = (effectiveExpiry && chainByExpiry[effectiveExpiry]) || [];
  
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
         stratBasket.forEach(leg => {
            const cv = activeAsset === 'BTC' ? 0.001 : (activeAsset === 'ETH' ? 0.01 : 1);
            const entryPrice = (leg.order_type === 'LIMIT' && leg.limit_price !== undefined) ? leg.limit_price : (leg.price || 0); 
            
            // Expiry PNL (Intrinsic)
            let intrinsic = leg.option_type === 'CALL' ? Math.max(0, price - leg.strike) : Math.max(0, leg.strike - price);
            pnlExpiry += (leg.side === 'BUY' ? intrinsic - entryPrice : entryPrice - intrinsic) * leg.size * cv;
            
            // Target Date PNL (Black-Scholes)
            const legExpiryTime = new Date(leg.expiry).getTime();
            const T = Math.max(0, legExpiryTime - targetDate) / (1000 * 60 * 60 * 24 * 365);
            
            const chain = chainByExpiry[leg.expiry] || [];
            const row = chain.find((r:any) => r.strike === leg.strike);
            let iv = 0.5; // Default IV
            if (row) iv = leg.option_type === 'CALL' ? (row.callIV || 0.5) : (row.putIV || 0.5);
            if (iv > 1) iv = iv / 100;
            
            let theoretical = blackScholes(leg.option_type, price, leg.strike, T, 0, iv);
            pnlTarget += (leg.side === 'BUY' ? theoretical - entryPrice : entryPrice - theoretical) * leg.size * cv;
         });
         
         let callOI_USD = 0;
         let putOI_USD = 0;
         const isStrike = currentChain.find((c:any) => c.strike === price);
         if (isStrike) {
             callOI_USD = (isStrike.callOI || 0) * spotPrice;
             putOI_USD = - (isStrike.putOI || 0) * spotPrice; // Negative to render downwards
         }
         return { price, pnlTarget, pnlExpiry, callOI_USD, putOI_USD };
     });
     return data;
  }, [stratBasket, spotPrice, currentChain, targetDate]);

  const { maxProfit, maxLoss, breakeven } = useMemo(() => {
      if (!payoffData.length) return { maxProfit: '-', maxLoss: '-', breakeven: '-' };
      
      const pnlsExpiry = payoffData.map(d => d.pnlExpiry);
      const mpE = Math.max(...pnlsExpiry);
      const mlE = Math.min(...pnlsExpiry);
      
      let mpStr = mpE > 0 ? `$${mpE.toFixed(2)}` : '0.00 USD';
      let mlStr = mlE < 0 ? `-$${Math.abs(mlE).toFixed(2)}` : '0.00 USD';
      
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
      
      const maxCallOi = Math.max(...payoffData.map(d => d.callOI_USD || 0)) || 10000000;
      const maxPutOi = Math.max(...payoffData.map(d => Math.abs(d.putOI_USD || 0))) || 10000000;
      
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
      let margin = 0;
      stratBasket.forEach(leg => {
          const cv = activeAsset === 'BTC' ? 0.001 : (activeAsset === 'ETH' ? 0.01 : 1);
          const entryPrice = (leg.order_type === 'LIMIT' && leg.limit_price !== undefined) ? leg.limit_price : (leg.price || 0);
          if (leg.side === 'BUY') margin += entryPrice * leg.size * cv;
            else margin += (spotPrice || 0) * leg.size * cv / 100;
      });
      return margin;
  }, [stratBasket, activeAsset]);

  // Delta Exchange Fee Structure:
  // Trading Fee: 0.03% of notional value (per leg, entry side)
  // GST: 18% on trading fee
  // Settlement Fee: 0.03% of notional (at expiry)
  const tradingFees = useMemo(() => {
      const TRADING_FEE_RATE = 0.0003; // 0.03%
      const GST_RATE = 0.18;           // 18% on fee
      const SETTLEMENT_FEE_RATE = 0.0003; // 0.03%
      const lotSize = activeAsset === 'BTC' ? 0.001 : (activeAsset === 'ETH' ? 0.01 : 0.001);

      let totalNotional = 0;
      stratBasket.forEach(leg => {
          const legNotional = leg.size * lotSize * (spotPrice || 0);
          totalNotional += legNotional;
      });

      const tradingFee = totalNotional * TRADING_FEE_RATE;
      const gst = tradingFee * GST_RATE;
      const totalFeesIncGST = tradingFee + gst;
      const settlementFee = totalNotional * SETTLEMENT_FEE_RATE;

      return {
          notionalValue: totalNotional,
          tradingFee,
          gst,
          totalFeesIncGST,
          settlementFee,
          totalAllFees: totalFeesIncGST + settlementFee
      };
  }, [stratBasket, activeAsset, spotPrice]);

  const handleTrade = async (legs: any[], basketName: string) => {
    setIsTrading(true);
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
        // Parallel fetch for zero-lag refresh
        Promise.all([
          fetch('http://127.0.0.1:8000/api/accounts').then(r=>r.json()).then(setAccounts),
          fetch(`http://127.0.0.1:8000/api/portfolio?account_id=${activeAccountId}`).then(r=>r.json()).then(setPortfolio),
          fetch(`http://127.0.0.1:8000/api/spot?asset=${activeAsset}`).then(r=>r.json()).then(data => {
            if (data.spot_price) {
              setSpotPrice(data.spot_price);
              setAssetCache(prev => ({
                  ...prev,
                  [activeAsset]: {
                      ...(prev[activeAsset] || { expiries: [], chainByExpiry: {} }),
                      spotPrice: data.spot_price
                  }
              }));
            }
          })
        ]);
      }
    } catch (err) {
      setTradeMessage('Failed to connect to API');
    } finally {
      setIsTrading(false);
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

  const modifyPosition = (basket: any) => {
      // Pre-fill the strategy basket with this position's legs for modification
      const legsToEdit = basket.legs.map((leg: any) => ({
          symbol: leg.symbol,
          underlying: leg.underlying || activeAsset,
          strike: leg.strike,
          expiry: leg.expiry,
          option_type: leg.option_type,
          side: leg.side,
          size: leg.size,
          price: leg.entry_price || 0,
          order_type: leg.order_type || 'MARKET'
      }));
      setStratBasket(legsToEdit);
      setActiveExpiry(basket.legs[0]?.expiry || expiries[0]);
      setShowBuilder(true);
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
             <nav style={{display: 'flex', gap: '24px', fontSize: '12px', fontWeight: 500}}>
                <span onClick={() => navigate('/')} style={{color: 'white', cursor: 'pointer', borderBottom: '2px solid var(--color-accent)', paddingBottom: '12px', marginBottom: '-12px'}}>Crypto Options</span>
                <span onClick={() => navigate('/nifty')} style={{color: 'var(--text-secondary)', cursor: 'pointer'}}>Nifty Options</span>
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
                 title="Manage and create USD sub-accounts"
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
                 <span style={{color: 'var(--text-secondary)'}}>$</span>
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
             
             {/* Asset Switcher */}
             <div style={{display: 'flex', background: '#0B0D11', borderRadius: '4px', padding: '2px'}}>
               {['BTC', 'ETH', 'XAUT'].map(asset => (
                 <div 
                   key={asset}
                   onClick={() => switchAsset(asset)}
                   style={{
                     padding: '4px 16px', 
                     cursor: 'pointer',
                     borderRadius: '3px',
                     fontSize: '11px',
                     fontWeight: 600,
                     border: activeAsset === asset ? '1px solid var(--color-accent)' : '1px solid transparent',
                     color: activeAsset === asset ? 'var(--color-accent)' : 'var(--text-secondary)',
                     background: activeAsset === asset ? 'rgba(239, 131, 46, 0.05)' : 'transparent',
                     display: 'flex',
                     alignItems: 'center',
                     gap: '4px'
                   }}
                 >
                   <span>{asset}</span>
                   {asset === 'XAUT' && <span style={{background: 'var(--color-accent)', color: 'white', fontSize: '8px', padding: '1px 3px', borderRadius: '2px', fontWeight: 'bold', lineHeight: 1}}>NEW</span>}
                 </div>
               ))}
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
                        {spotPrice ? `$${spotPrice.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1})}` : "Live"}
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

          <div className="table-container" style={{overflowY: 'auto', flex: 1}}>
            <table>
              <thead style={{position: 'sticky', top: 0, background: 'var(--bg-base)', zIndex: 10}}>
                <tr>
                  {cols.volume && <th className="col-left">Volume<br/><span style={{color: '#5d6778', fontSize: '9px'}}>{activeAsset}</span></th>}
                  {cols.delta && <th className="col-left">Delta</th>}
                  {cols.mark && <th className="col-left" style={{paddingLeft: '18px'}}>Mark<br/><span style={{color: '#5d6778', fontSize: '9px'}}>(Price / IV)</span></th>}
                  {cols.bidAsk && <th className="col-left">Ask<br/><span style={{color: '#5d6778', fontSize: '9px'}}>(Price / IV)</span></th>}
                  {cols.qty && cols.bidAsk && <th>Ask Qty<br/><span style={{color: '#5d6778', fontSize: '9px'}}>{activeAsset}</span></th>}
                  {cols.oi && <th>OI<br/><span style={{color: '#5d6778', fontSize: '9px'}}>USD</span></th>}
                  <th className="col-strike" style={{width: '85px'}}>Strike ⬍</th>
                  {cols.oi && <th>OI<br/><span style={{color: '#5d6778', fontSize: '9px'}}>USD</span></th>}
                  {cols.qty && cols.bidAsk && <th>Bid Qty<br/><span style={{color: '#5d6778', fontSize: '9px'}}>{activeAsset}</span></th>}
                  {cols.bidAsk && <th>Bid<br/><span style={{color: '#5d6778', fontSize: '9px'}}>(Price / IV)</span></th>}
                  {cols.mark && <th style={{paddingRight: '18px'}}>Mark<br/><span style={{color: '#5d6778', fontSize: '9px'}}>(Price / IV)</span></th>}
                  {cols.delta && <th>Delta</th>}
                  {cols.volume && <th>Volume<br/><span style={{color: '#5d6778', fontSize: '9px'}}>{activeAsset}</span></th>}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const maxOI = Math.max(1, ...currentChain.map((r: any) => Math.max(r.callOI || 0, r.putOI || 0)));
                  return currentChain.map((row: any) => {
                    const isCallITM = spotPrice ? row.strike < spotPrice : false;
                    const isPutITM = spotPrice ? row.strike > spotPrice : false;
                    const isATM = row.strike === atmStrike;
                    const callLeg = stratBasket.find(l => l.strike === row.strike && l.option_type === 'CALL');
                    const putLeg = stratBasket.find(l => l.strike === row.strike && l.option_type === 'PUT');
                    
                    const callIVStr = row.callIV ? `${(row.callIV * 100).toFixed(1)}%` : '24.1%';
                    const putIVStr = row.putIV ? `${(row.putIV * 100).toFixed(1)}%` : '21.2%';
                    
                    return (
                      <tr key={row.strike} style={{borderTop: isATM ? '1px solid rgba(239, 131, 46, 0.3)' : '', borderBottom: isATM ? '1px solid rgba(239, 131, 46, 0.3)' : '', background: isATM ? 'rgba(239, 131, 46, 0.05)' : ''}}>
                        {cols.volume && <td className={`col-left ${isCallITM ? 'itm-bg' : ''}`} style={{color: 'var(--text-secondary)'}}>{row.callVolume ? row.callVolume.toFixed(2) : '-'}</td>}
                        {cols.delta && <td className={`col-left ${isCallITM ? 'itm-bg' : ''}`} style={{color: 'var(--text-secondary)'}}>{row.callDelta ? row.callDelta.toFixed(2) : '-'}</td>}
                        {cols.mark && (
                          <td className={`col-left ${isCallITM ? 'itm-bg' : ''}`} style={{position: 'relative', borderTop: callLeg ? '1px solid var(--color-accent)' : '', borderBottom: callLeg ? '1px solid var(--color-accent)' : '', borderLeft: callLeg ? '1px solid var(--color-accent)' : ''}}>
                              {callLeg && (
                                  <div 
                                      style={{position: 'absolute', left: 0, top: 0, bottom: 0, width: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: callLeg.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', color: 'white', fontWeight: 'bold', fontSize: '9px', cursor: 'pointer'}}
                                      onClick={(e) => { e.stopPropagation(); setStratBasket(stratBasket.filter(l => !(l.strike === row.strike && l.option_type === 'CALL'))); }}
                                      title="Click to deselect"
                                  >
                                      {callLeg.side === 'BUY' ? 'B' : 'S'}
                                  </div>
                              )}
                              <div style={{paddingLeft: callLeg ? '16px' : '0', display: 'flex', flexDirection: 'column'}}>
                                  <span style={{color: 'white', fontWeight: 500}}>${row.callMark ? row.callMark.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1}) : '-'}</span>
                                  <span style={{color: 'var(--text-secondary)', fontSize: '9px'}}>{callIVStr}</span>
                              </div>
                          </td>
                        )}
                        
                        {cols.bidAsk && (
                          <td 
                              className={`col-left ${isCallITM ? 'itm-bg' : ''}`} 
                              onMouseEnter={() => setHoveredCell({strike: row.strike, side: 'CALL'})}
                              onMouseLeave={() => setHoveredCell(null)}
                              style={{position: 'relative', width: '85px', borderTop: callLeg ? '1px solid var(--color-accent)' : '', borderBottom: callLeg ? '1px solid var(--color-accent)' : ''}}
                          >
                              {hoveredCell?.strike === row.strike && hoveredCell?.side === 'CALL' ? (
                                  <div style={{display: 'flex', gap: '3px', justifyContent: 'flex-start'}}>
                                      <button className="btn" style={{background: 'var(--color-up)', padding: '1px 6px', fontSize: '9.5px', color: 'white', border: 'none', borderRadius: '2px'}} onClick={(e) => { e.stopPropagation(); addLegToBasket('BUY', 'CALL', row, stratSize); }}>Buy</button>
                                      <button className="btn" style={{background: 'var(--color-down)', padding: '1px 6px', fontSize: '9.5px', color: 'white', border: 'none', borderRadius: '2px'}} onClick={(e) => { e.stopPropagation(); addLegToBasket('SELL', 'CALL', row, stratSize); }}>Sell</button>
                                  </div>
                              ) : (
                                  <div style={{display: 'flex', flexDirection: 'column'}}>
                                      <span className="text-down" style={{fontWeight: 500}}>${row.callAsk ? row.callAsk.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1}) : '-'}</span>
                                      <span style={{color: 'var(--text-secondary)', fontSize: '9px'}}>{callIVStr}</span>
                                  </div>
                              )}
                          </td>
                        )}
                        
                        {cols.qty && cols.bidAsk && <td className={isCallITM ? 'itm-bg' : ''} style={{borderTop: callLeg ? '1px solid var(--color-accent)' : '', borderBottom: callLeg ? '1px solid var(--color-accent)' : '', borderRight: callLeg ? '1px solid var(--color-accent)' : '', color: 'var(--text-secondary)'}}>{row.callAskQty ? row.callAskQty.toFixed(3) : '-'}</td>}
                        
                        {cols.oi && (
                          <td className={isCallITM ? 'itm-bg' : ''} style={{color: 'var(--text-secondary)', position: 'relative', textAlign: 'right'}}>
                              {row.callOI > 0 && (
                                  <div style={{ position: 'absolute', right: 0, top: '2px', bottom: '2px', width: `${(row.callOI / maxOI) * 100}%`, background: 'rgba(0, 192, 135, 0.15)', zIndex: 0 }}></div>
                              )}
                              <span style={{position: 'relative', zIndex: 1}}>{row.callOI ? `$${row.callOI >= 1000000 ? (row.callOI/1000000).toFixed(2) + 'M' : (row.callOI >= 1000 ? (row.callOI/1000).toFixed(2) + 'K' : row.callOI.toFixed(0))}` : '-'}</span>
                          </td>
                        )}
                        
                        <td className={`col-strike ${atmStrike === row.strike ? 'atm-strike' : ''}`} style={{background: isATM ? 'rgba(239, 131, 46, 0.15)' : '#141822', color: isATM ? 'var(--color-accent)' : 'white'}}>
                            {isATM ? `📍 ${row.strike}` : row.strike}
                        </td>
                        
                        {cols.oi && (
                          <td className={isPutITM ? 'itm-bg' : ''} style={{color: 'var(--text-secondary)', position: 'relative', textAlign: 'left'}}>
                              {row.putOI > 0 && (
                                  <div style={{ position: 'absolute', left: 0, top: '2px', bottom: '2px', width: `${(row.putOI / maxOI) * 100}%`, background: 'rgba(248, 73, 96, 0.15)', zIndex: 0 }}></div>
                              )}
                              <span style={{position: 'relative', zIndex: 1}}>{row.putOI ? `$${row.putOI >= 1000000 ? (row.putOI/1000000).toFixed(2) + 'M' : (row.putOI >= 1000 ? (row.putOI/1000).toFixed(2) + 'K' : row.putOI.toFixed(0))}` : '-'}</span>
                          </td>
                        )}
                        
                        {cols.qty && cols.bidAsk && <td className={isPutITM ? 'itm-bg' : ''} style={{borderTop: putLeg ? '1px solid var(--color-accent)' : '', borderBottom: putLeg ? '1px solid var(--color-accent)' : '', borderLeft: putLeg ? '1px solid var(--color-accent)' : '', color: 'var(--text-secondary)'}}>{row.putBidQty ? row.putBidQty.toFixed(3) : '-'}</td>}
                        
                        {cols.bidAsk && (
                          <td 
                              className={isPutITM ? 'itm-bg' : ''}
                              onMouseEnter={() => setHoveredCell({strike: row.strike, side: 'PUT'})}
                              onMouseLeave={() => setHoveredCell(null)}
                              style={{position: 'relative', width: '85px', textAlign: 'center', borderTop: putLeg ? '1px solid var(--color-accent)' : '', borderBottom: putLeg ? '1px solid var(--color-accent)' : ''}}
                          >
                              {hoveredCell?.strike === row.strike && hoveredCell?.side === 'PUT' ? (
                                  <div style={{display: 'flex', gap: '3px', justifyContent: 'center'}}>
                                      <button className="btn" style={{background: 'var(--color-up)', padding: '1px 6px', fontSize: '9.5px', color: 'white', border: 'none', borderRadius: '2px'}} onClick={(e) => { e.stopPropagation(); addLegToBasket('BUY', 'PUT', row, stratSize); }}>Buy</button>
                                      <button className="btn" style={{background: 'var(--color-down)', padding: '1px 6px', fontSize: '9.5px', color: 'white', border: 'none', borderRadius: '2px'}} onClick={(e) => { e.stopPropagation(); addLegToBasket('SELL', 'PUT', row, stratSize); }}>Sell</button>
                                  </div>
                              ) : (
                                  <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
                                      <span className="text-up" style={{fontWeight: 500}}>${row.putBid ? row.putBid.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1}) : '-'}</span>
                                      <span style={{color: 'var(--text-secondary)', fontSize: '9px'}}>{putIVStr}</span>
                                  </div>
                              )}
                          </td>
                        )}
                        
                        {cols.mark && (
                          <td className={`${isPutITM ? 'itm-bg' : ''}`} style={{position: 'relative', borderTop: putLeg ? '1px solid var(--color-accent)' : '', borderBottom: putLeg ? '1px solid var(--color-accent)' : '', borderRight: putLeg ? '1px solid var(--color-accent)' : ''}}>
                              <div style={{paddingRight: putLeg ? '16px' : '0', display: 'flex', flexDirection: 'column', alignItems: 'flex-end'}}>
                                  <span style={{color: 'white', fontWeight: 500}}>${row.putMark ? row.putMark.toLocaleString(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1}) : '-'}</span>
                                  <span style={{color: 'var(--text-secondary)', fontSize: '9px'}}>{putIVStr}</span>
                              </div>
                              {putLeg && (
                                  <div 
                                      style={{position: 'absolute', right: 0, top: 0, bottom: 0, width: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: putLeg.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', color: 'white', fontWeight: 'bold', fontSize: '9px', cursor: 'pointer'}}
                                      onClick={(e) => { e.stopPropagation(); setStratBasket(stratBasket.filter(l => !(l.strike === row.strike && l.option_type === 'PUT'))); }}
                                      title="Click to deselect"
                                  >
                                      {putLeg.side === 'BUY' ? 'B' : 'S'}
                                  </div>
                              )}
                          </td>
                        )}
                        {cols.delta && <td className={isPutITM ? 'itm-bg' : ''} style={{color: 'var(--text-secondary)'}}>{row.putDelta ? row.putDelta.toFixed(2) : '-'}</td>}
                        {cols.volume && <td className={isPutITM ? 'itm-bg' : ''} style={{color: 'var(--text-secondary)'}}>{row.putVolume ? row.putVolume.toFixed(2) : '-'}</td>}
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>

          {/* Bottom Tabs Panel */}
          <div style={{height: '220px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)'}}>
              <div style={{padding: '0 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                  <div style={{display: 'flex', gap: '24px'}}>
                      {['Positions', 'Open Orders', 'Stop Orders', 'Risk & Margin Details', 'Fills', 'Order History'].map(tab => (
                          <div key={tab} onClick={() => setPortfolioTab(tab)} style={{padding: '12px 0', fontSize: '13px', fontWeight: tab === portfolioTab ? 'bold' : 'normal', color: tab === portfolioTab ? 'var(--color-accent)' : 'var(--text-secondary)', cursor: 'pointer', borderBottom: tab === portfolioTab ? '2px solid var(--color-accent)' : '2px solid transparent'}}>
                              {tab}
                          </div>
                      ))}
                  </div>
                  <div style={{display: 'flex', gap: '16px', alignItems: 'center'}}>
                      <div style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '12px'}}>
                          <span style={{fontSize: '14px'}}>↻</span> Refresh
                      </div>
                      <div style={{display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', color: 'var(--color-accent)', fontSize: '12px'}}>
                          <span style={{fontSize: '14px'}}>⭳</span> Download
                      </div>
                  </div>
              </div>
              <div style={{flex: 1, display: 'flex', flexDirection: 'column', color: 'white', fontSize: '12px', overflowY: 'auto'}}>
                  {portfolioTab === 'Positions' ? (
                      portfolio && portfolio.baskets && portfolio.baskets.length > 0 ? (
                          <table style={{width: '100%', textAlign: 'left', borderCollapse: 'collapse'}}>
                              <thead style={{color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.02)'}}>
                                  <tr>
                                      <th style={{padding: '8px 16px'}}>Basket Name</th>
                                      <th style={{padding: '8px 16px'}}>Legs</th>
                                      <th style={{padding: '8px 16px'}}>Total PNL</th>
                                      <th style={{padding: '8px 16px'}}>Action</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  {portfolio.baskets.map((b:any) => (
                                      <tr key={b.id} style={{borderBottom: '1px solid var(--border-color)'}}>
                                          <td style={{padding: '8px 16px', fontWeight: '500'}}>{b.name}</td>
                                          <td style={{padding: '8px 16px', fontSize: '11px'}}>
                                              {b.legs.map((leg:any, i:number) => (
                                                  <span key={i} style={{marginRight: '8px', padding: '2px 6px', background: leg.side === 'BUY' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(248, 73, 96, 0.15)', borderRadius: '3px'}}>
                                                      {leg.side} {leg.size} {leg.symbol.split(' ')[0]}
                                                  </span>
                                              ))}
                                          </td>
                                          <td style={{padding: '8px 16px', fontWeight: '500'}}>
                                              <span style={{color: b.upnl > 0 ? 'var(--color-up)' : (b.upnl < 0 ? 'var(--color-down)' : 'white')}}>
                                                  {b.upnl > 0 ? '+' : ''}{b.upnl.toFixed(2)} USD
                                              </span>
                                          </td>
                                          <td style={{padding: '8px 16px'}}>
                                              <div style={{display: 'flex', gap: '6px'}}>
                                                  <button onClick={() => modifyPosition(b)} style={{background: 'rgba(56, 189, 248, 0.15)', border: '1px solid rgba(56, 189, 248, 0.3)', color: '#38bdf8', padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold'}}>Modify</button>
                                                  <button onClick={() => closePosition(b.id)} style={{background: 'rgba(248, 73, 96, 0.15)', border: '1px solid rgba(248, 73, 96, 0.3)', color: '#f84960', padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold'}}>Close</button>
                                              </div>
                                          </td>
                                      </tr>
                                  ))}
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
                                          <td style={{padding: '8px 16px'}}>{trade.symbol}</td>
                                          <td style={{padding: '8px 16px', color: trade.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)'}}>{trade.side}</td>
                                          <td style={{padding: '8px 16px'}}>{trade.size}</td>
                                          <td style={{padding: '8px 16px'}}>${trade.price.toFixed(2)}</td>
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
                               const basket = buildStrategyBasket(e.target.value, currentChain, atmStrike, activeAsset, activeExpiry, stratSize, strategyTargetPrice, supportPrice, resistancePrice, expiries);
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
                       <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                           <span>Multiplier</span>
                           <div style={{display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', borderRadius: '0'}}>
                               <span style={{color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '16px'}} onClick={() => {
                                   const newSize = Math.max(1, stratSize - 1);
                                   setStratSize(newSize);
                                   setStratBasket(stratBasket.map(l => ({...l, size: l.size / stratSize * newSize})));
                               }}>⊖</span>
                               <input type="number" value={stratSize} onChange={(e) => {
                                   const newSize = Number(e.target.value) || 1;
                                   setStratSize(newSize);
                                   setStratBasket(stratBasket.map(l => ({...l, size: l.size / stratSize * newSize})));
                               }} style={{width: '30px', background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid var(--border-color)', borderRadius: '2px', textAlign: 'center', fontSize: '13px', outline: 'none', padding: '2px 0', margin: '0 4px', fontWeight: 'bold'}} />
                               <span style={{color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '16px'}} onClick={() => {
                                   const newSize = stratSize + 1;
                                   setStratSize(newSize);
                                   setStratBasket(stratBasket.map(l => ({...l, size: l.size / stratSize * newSize})));
                               }}>⊕</span>
                           </div>
                       </div>
                       <span style={{cursor: 'pointer', color: '#F84960', fontSize: '14px'}} onClick={() => setStratBasket([])}>🗑️</span>
                   </div>
               </div>
               
               {/* Legs List */}
               {stratBasket.map((leg, i) => {
                    const isLimit = leg.order_type === 'LIMIT';
                    return (
                    <div key={i} style={{display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', marginBottom: '12px'}}>
                        <input 
                             type="checkbox" 
                             checked={true} 
                             onChange={() => setStratBasket(stratBasket.filter((_, idx) => idx !== i))}
                             style={{accentColor: 'var(--color-accent)', width: '16px', height: '16px', cursor: 'pointer'}} 
                         />
                        
                        <div style={{border: leg.side === 'BUY' ? '1px solid var(--color-up)' : '1px solid var(--color-down)', color: leg.side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', padding: '1px 6px', borderRadius: '2px', fontWeight: 'bold', fontSize: '11px', background: 'transparent'}}>
                            {leg.side === 'BUY' ? 'B' : 'S'}
                        </div>
                        
                        <div style={{display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 'bold'}}>
                            <div style={{cursor: 'pointer'}}>{leg.option_type === 'CALL' ? 'C' : 'P'}<span style={{color: 'var(--color-accent)', fontSize: '10px', marginLeft: '2px'}}>⌄</span></div>
                            <div style={{cursor: 'pointer', marginLeft: '4px'}}>{leg.strike}<span style={{color: 'var(--color-accent)', fontSize: '10px', marginLeft: '2px'}}>⌄</span></div>
                            <div style={{cursor: 'pointer', marginLeft: '4px'}}>{new Date(leg.expiry).toLocaleDateString('en-GB', {day: '2-digit', month: '2-digit', year: '2-digit'}).split('/').reverse().join('')}<span style={{color: 'var(--color-accent)', fontSize: '10px', marginLeft: '2px'}}>⌄</span></div>
                        </div>
                        
                        <div style={{flex: 1}}></div>
                        
                        {/* Market Price Box */}
                        <div 
                            style={{
                                display: 'flex', 
                                alignItems: 'center', 
                                gap: '6px', 
                                border: '1px solid var(--border-color)', 
                                borderRadius: '4px', 
                                padding: '4px 8px', 
                                cursor: 'pointer',
                                background: 'transparent',
                                minWidth: '100px'
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
                                padding: '0px 4px', 
                                borderRadius: '2px', 
                                fontSize: '10px', 
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
                                    style={{width: '60px', background: 'transparent', color: 'var(--text-secondary)', border: 'none', fontSize: '12px', outline: 'none'}}
                                />
                            ) : (
                                <span style={{fontSize: '12px', color: 'var(--text-secondary)'}}>Market Price</span>
                            )}
                        </div>
                        
                        {/* Quantity */}
                        <div style={{display: 'flex', alignItems: 'center', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '4px 8px', background: 'transparent'}}>
                            <input 
                                type="number" 
                                value={leg.size || ''} 
                                onChange={(e) => {
                                    const nb = [...stratBasket];
                                    nb[i].size = Math.abs(Number(e.target.value));
                                    setStratBasket(nb);
                                }}
                                style={{width: '40px', background: 'transparent', color: 'white', border: 'none', textAlign: 'right', fontSize: '13px', outline: 'none', fontWeight: 'bold'}}
                            />
                            <span style={{fontSize: '12px', color: 'var(--text-secondary)', marginLeft: '6px'}}>Lot ⌄</span>
                        </div>
                       
                        <div style={{cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '14px', marginLeft: '4px'}} onClick={() => {
                            const newBasket = [...stratBasket];
                            newBasket.splice(i, 1);
                            setStratBasket(newBasket);
                        }}>🗑️</div>
                    </div>
                );})}
               {stratBasket.length === 0 && (
                 <div style={{ padding: '8px 4px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                   <h3 style={{ fontSize: '12.5px', fontWeight: 'bold', color: 'white', marginBottom: '2px', textAlign: 'center', letterSpacing: '0.3px' }}>
                     Choose from Pre-Built Strategies
                   </h3>

                   {/* Outlook & Smart Inputs */}
                   <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                     <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                       <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 'bold' }}>Outlook:</span>
                       <div style={{ display: 'flex', gap: '4px' }}>
                         {(['Bullish', 'Bearish', 'Neutral', 'Volatility'] as const).map(o => (
                           <button
                             key={o}
                             onClick={() => {
                               setOutlook(o);
                               // Trigger recalculation of default target immediately
                               if (spotPrice) {
                                 const step = currentChain.length > 1 ? Math.abs(currentChain[1].strike - currentChain[0].strike) : 50;
                                 const defaultT = o === 'Bullish' 
                                   ? Math.round((spotPrice * 1.02) / step) * step
                                   : o === 'Bearish' 
                                     ? Math.round((spotPrice * 0.98) / step) * step
                                     : Math.round(spotPrice / step) * step;
                                 setTargetPrice(defaultT);
                               }
                             }}
                             style={{
                               background: outlook === o ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                               border: outlook === o ? '1px solid var(--color-accent)' : '1px solid var(--border-color)',
                               borderRadius: '4px',
                               padding: '3px 6px',
                               fontSize: '10px',
                               color: outlook === o ? 'white' : 'var(--text-secondary)',
                               cursor: 'pointer',
                               fontWeight: '600'
                             }}
                           >
                             {o === 'Bullish' ? '📈 Bull' : o === 'Bearish' ? '📉 Bear' : o === 'Neutral' ? '↔️ Neut' : '⚡ Vol'}
                           </button>
                         ))}
                       </div>
                     </div>

                     <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                       <div>
                         <label style={{ fontSize: '10px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Target</label>
                         <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '2px 4px' }}>
                           <input
                             type="number"
                             value={strategyTargetPrice || ''}
                             onChange={e => setStrategyTargetPrice(Number(e.target.value))}
                             style={{ width: '100%', background: 'transparent', border: 'none', color: 'white', fontSize: '11px', textAlign: 'center', outline: 'none' }}
                           />
                         </div>
                       </div>
                       <div>
                         <label style={{ fontSize: '10px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Support</label>
                         <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '2px 4px' }}>
                           <input
                             type="number"
                             value={supportPrice || ''}
                             onChange={e => setSupportPrice(Number(e.target.value))}
                             style={{ width: '100%', background: 'transparent', border: 'none', color: 'white', fontSize: '11px', textAlign: 'center', outline: 'none' }}
                           />
                         </div>
                       </div>
                       <div>
                         <label style={{ fontSize: '10px', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Resistance</label>
                         <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '2px 4px' }}>
                           <input
                             type="number"
                             value={resistancePrice || ''}
                             onChange={e => setResistancePrice(Number(e.target.value))}
                             style={{ width: '100%', background: 'transparent', border: 'none', color: 'white', fontSize: '11px', textAlign: 'center', outline: 'none' }}
                           />
                         </div>
                       </div>
                     </div>

                     {/* Suggester Rule Output */}
                     <div style={{ 
                       background: 'rgba(56, 189, 248, 0.04)', 
                       border: '1px solid rgba(56, 189, 248, 0.15)', 
                       borderRadius: '4px', 
                       padding: '8px', 
                       fontSize: '10.5px', 
                       color: 'var(--color-accent)', 
                       lineHeight: '1.4',
                       textAlign: 'center' 
                     }}>
                       {activeAsset} {spotPrice ? `@ $${spotPrice.toLocaleString()}` : ''} | <strong>{outlook}</strong> | Target: ${targetPrice.toLocaleString()} | Support: ${supportPrice.toLocaleString()} | Resistance: ${resistancePrice.toLocaleString()}
                       <div style={{ marginTop: '4px', color: 'white', fontSize: '10px' }}>
                         💡 Suggested Strategy: 
                         {outlook === 'Bullish' && <span style={{ color: '#00c087', fontWeight: 'bold' }}> Bull Call Spread (Buy ${atmStrike || 'ATM'} CE / Sell ${targetPrice} CE)</span>}
                         {outlook === 'Bearish' && <span style={{ color: '#f84960', fontWeight: 'bold' }}> Bear Put Spread (Buy ${atmStrike || 'ATM'} PE / Sell ${targetPrice} PE)</span>}
                         {outlook === 'Neutral' && <span style={{ color: '#38bdf8', fontWeight: 'bold' }}> Iron Condor (Sell ${supportPrice} PE + Sell ${resistancePrice} CE)</span>}
                         {outlook === 'Volatility' && <span style={{ color: '#38bdf8', fontWeight: 'bold' }}> Long Straddle (Buy ${atmStrike || 'ATM'} CE + Buy ${atmStrike || 'ATM'} PE)</span>}
                       </div>
                       <button
                         onClick={() => {
                           const stratName = outlook === 'Bullish' ? 'Bull Call Spread' : outlook === 'Bearish' ? 'Bear Put Spread' : outlook === 'Neutral' ? 'Iron Condor' : 'Long Straddle';
                           if (atmStrike) {
                             const basket = buildStrategyBasket(stratName, currentChain, atmStrike, activeAsset, activeExpiry, stratSize, targetPrice, supportPrice, resistancePrice, expiries);
                             if (basket.length > 0) {
                               setStratBasket(basket);
                               setStrategy(stratName);
                             }
                           }
                         }}
                         style={{
                           marginTop: '8px',
                           background: 'var(--color-accent)',
                           border: 'none',
                           borderRadius: '4px',
                           padding: '4px 10px',
                           color: 'black',
                           fontWeight: 'bold',
                           fontSize: '10px',
                           cursor: 'pointer',
                           width: '100%'
                         }}
                       >
                         Apply suggested strategy to basket
                       </button>
                     </div>
                   </div>

                   {/* Bullish */}
                   <div>
                     <h4 style={{ fontSize: '11px', color: '#00c087', fontWeight: 'bold', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Bullish Strategies</h4>
                     <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
                       {['Bull Call Spread', 'Bull Put Spread', 'Bullish Condor'].map(stratName => (
                         <button
                           key={stratName}
                           onClick={() => {
                             if (atmStrike) {
                               const basket = buildStrategyBasket(stratName, currentChain, atmStrike, activeAsset, activeExpiry, stratSize, targetPrice, supportPrice, resistancePrice, expiries);
                               if (basket.length > 0) {
                                 setStratBasket(basket);
                                 setStrategy(stratName);
                               }
                             }
                           }}
                           style={{
                             background: 'rgba(0, 192, 135, 0.04)',
                             border: '1px solid rgba(0, 192, 135, 0.15)',
                             borderRadius: '4px',
                             padding: '7px 2px',
                             color: '#00c087',
                             fontSize: '10px',
                             fontWeight: '600',
                             cursor: 'pointer',
                             textAlign: 'center',
                             transition: 'all 0.15s ease-in-out',
                           }}
                           onMouseEnter={e => {
                             e.currentTarget.style.background = 'rgba(0, 192, 135, 0.12)';
                             e.currentTarget.style.borderColor = 'rgba(0, 192, 135, 0.35)';
                           }}
                           onMouseLeave={e => {
                             e.currentTarget.style.background = 'rgba(0, 192, 135, 0.04)';
                             e.currentTarget.style.borderColor = 'rgba(0, 192, 135, 0.15)';
                           }}
                         >
                           {stratName}
                         </button>
                       ))}
                     </div>
                   </div>

                   {/* Bearish */}
                   <div>
                     <h4 style={{ fontSize: '11px', color: '#f84960', fontWeight: 'bold', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Bearish Strategies</h4>
                     <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
                       {['Bear Call Spread', 'Bear Put Spread', 'Bearish Condor'].map(stratName => (
                         <button
                           key={stratName}
                           onClick={() => {
                             if (atmStrike) {
                               const basket = buildStrategyBasket(stratName, currentChain, atmStrike, activeAsset, activeExpiry, stratSize, targetPrice, supportPrice, resistancePrice, expiries);
                               if (basket.length > 0) {
                                 setStratBasket(basket);
                                 setStrategy(stratName);
                               }
                             }
                           }}
                           style={{
                             background: 'rgba(248, 73, 96, 0.04)',
                             border: '1px solid rgba(248, 73, 96, 0.15)',
                             borderRadius: '4px',
                             padding: '7px 2px',
                             color: '#f84960',
                             fontSize: '10px',
                             fontWeight: '600',
                             cursor: 'pointer',
                             textAlign: 'center',
                             transition: 'all 0.15s ease-in-out',
                           }}
                           onMouseEnter={e => {
                             e.currentTarget.style.background = 'rgba(248, 73, 96, 0.12)';
                             e.currentTarget.style.borderColor = 'rgba(248, 73, 96, 0.35)';
                           }}
                           onMouseLeave={e => {
                             e.currentTarget.style.background = 'rgba(248, 73, 96, 0.04)';
                             e.currentTarget.style.borderColor = 'rgba(248, 73, 96, 0.15)';
                           }}
                         >
                           {stratName}
                         </button>
                       ))}
                     </div>
                   </div>

                   {/* Neutral */}
                   <div>
                     <h4 style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 'bold', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Neutral Strategies</h4>
                     <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
                       {['Short Straddle', 'Short Strangle', 'Long Straddle', 'Long Strangle', 'Iron Condor', 'Iron Butterfly'].map(stratName => (
                         <button
                           key={stratName}
                           onClick={() => {
                             if (atmStrike) {
                               const basket = buildStrategyBasket(stratName, currentChain, atmStrike, activeAsset, activeExpiry, stratSize, targetPrice, supportPrice, resistancePrice, expiries);
                               if (basket.length > 0) {
                                 setStratBasket(basket);
                                 setStrategy(stratName);
                               }
                             }
                           }}
                           style={{
                             background: 'rgba(56, 189, 248, 0.04)',
                             border: '1px solid rgba(56, 189, 248, 0.15)',
                             borderRadius: '4px',
                             padding: '7px 2px',
                             color: '#38bdf8',
                             fontSize: '10px',
                             fontWeight: '600',
                             cursor: 'pointer',
                             textAlign: 'center',
                             transition: 'all 0.15s ease-in-out',
                             marginBottom: '2px'
                           }}
                           onMouseEnter={e => {
                             e.currentTarget.style.background = 'rgba(56, 189, 248, 0.12)';
                             e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.35)';
                           }}
                           onMouseLeave={e => {
                             e.currentTarget.style.background = 'rgba(56, 189, 248, 0.04)';
                             e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.15)';
                           }}
                         >
                           {stratName}
                         </button>
                       ))}
                     </div>
                   </div>

                   {/* Divider */}
                   <div style={{ display: 'flex', alignItems: 'center', margin: '8px 0', gap: '8px' }}>
                     <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }}></div>
                     <span style={{ fontSize: '10px', color: 'var(--text-secondary)', textTransform: 'uppercase', fontWeight: 'bold' }}>Or</span>
                     <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }}></div>
                   </div>

                   {/* Option chain instructions */}
                   <div style={{ textAlign: 'center', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                     Add Contracts from Options Chain by clicking BUY or SELL badges
                   </div>
                 </div>
               )}
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
                       <div style={{fontSize: '13px', fontWeight: 'bold', color: 'var(--color-up)'}}>{maxProfit === 'Unlimited' ? 'Unlimited' : `${maxProfit} USD`}</div>
                   </div>
                   <div style={{flex: 1}}>
                       <div style={{fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px'}}>Max Loss</div>
                       <div style={{fontSize: '13px', fontWeight: 'bold', color: 'var(--color-down)'}}>{maxLoss === 'Unlimited' ? 'Unlimited' : `${maxLoss} USD`}</div>
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
                        <span>Index <span className="font-bold text-white">{spotPrice ? spotPrice.toFixed(2) : '-'}</span></span>
                    </div>
                    <div style={{display: 'flex', alignItems: 'center', gap: '5px'}}>
                        <div style={{width: '12px', height: '2px', background: 'var(--color-accent)'}}></div>
                        <span>On Target Date</span>
                    </div>
                </div>

                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: 'var(--text-secondary)', padding: '0 5px', marginBottom: '4px'}}>
                    <span>Profit / Loss (USD)</span>
                    {spotPrice && (
                        <span style={{background: 'rgba(255,255,255,0.08)', padding: '2px 8px', borderRadius: '4px', color: 'white', fontWeight: 'bold', fontSize: '11px'}}>
                            Current Price {spotPrice.toFixed(0)}
                        </span>
                    )}
                    <span>Open Interest ($)</span>
                </div>

                <div style={{height: '250px', marginLeft: '-20px'}}>
                    {stratBasket.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={payoffData}>
                            <XAxis dataKey="price" type="number" domain={['dataMin', 'dataMax']} stroke="#5a616e" fontSize={10} tickFormatter={(val) => Math.round(val).toLocaleString()} />
                            <YAxis yAxisId="left" stroke="#5a616e" fontSize={10} domain={yAxisDomains.left} tickFormatter={(val) => Math.round(val).toString()} width={35} />
                            <YAxis 
                                yAxisId="right" 
                                orientation="right" 
                                stroke="#5a616e" 
                                fontSize={10} 
                                domain={yAxisDomains.right} 
                                tickFormatter={(val) => {
                                    const absVal = Math.abs(val);
                                    if (absVal === 0) return '0';
                                    if (absVal >= 1e6) return `${(absVal / 1e6).toFixed(1)}M`;
                                    if (absVal >= 1e3) return `${(absVal / 1e3).toFixed(0)}K`;
                                    return absVal.toFixed(0);
                                }} 
                                width={45} 
                            />
                            <Tooltip 
                                content={({ active, payload, label }) => {
                                    if (active && payload && payload.length) {
                                        const price = label;
                                        const pnlTarget = Number(payload.find((p:any) => p.dataKey === 'pnlTarget')?.value || 0);
                                        const pnlExpiry = Number(payload.find((p:any) => p.dataKey === 'pnlExpiry')?.value || 0);
                                        const targetDateStr = new Date(targetDate).toLocaleDateString('en-GB', {weekday: 'short', day: '2-digit', month: 'short'});
                                        return (
                                            <div style={{backgroundColor: '#1c2127', border: '1px solid #2a313e', padding: '10px', borderRadius: '4px', fontSize: '12px', minWidth: '150px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)'}}>
                                                <div style={{color: 'var(--text-secondary)', marginBottom: '2px'}}>When price is at:</div>
                                                <div style={{fontWeight: 'bold', fontSize: '14px', marginBottom: '10px'}}>{price}</div>
                                                <div style={{color: 'var(--text-secondary)', marginBottom: '5px'}}>Expected PNL on</div>
                                                <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: '5px'}}>
                                                    <span style={{fontWeight: 'bold'}}>{targetDateStr}</span>
                                                    <span style={{color: pnlTarget >= 0 ? 'var(--color-up)' : 'var(--color-down)'}}>{pnlTarget.toFixed(2)} USD</span>
                                                </div>
                                                <div style={{display: 'flex', justifyContent: 'space-between'}}>
                                                    <span style={{fontWeight: 'bold'}}>Expiry</span>
                                                    <span style={{color: pnlExpiry >= 0 ? 'var(--color-up)' : 'var(--color-down)'}}>{pnlExpiry.toFixed(2)} USD</span>
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
                                <ReferenceLine x={spotPrice} yAxisId="left" stroke="rgba(248, 73, 96, 0.7)" strokeDasharray="2 2" />
                            )}
                            {targetPrice && stratBasket.length > 0 && (
                                <>
                                    <ReferenceLine x={targetPrice} yAxisId="left" stroke="var(--color-accent)" strokeWidth={1.5} />
                                    <ReferenceDot yAxisId="left" x={targetPrice} y={projectedPNL} r={4} fill="var(--color-accent)" stroke="white" strokeWidth={1.5} />
                                </>
                            )}
                            
                            <Bar 
                                yAxisId="right" 
                                dataKey="putOI_USD" 
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
                                dataKey="callOI_USD" 
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
                                             {leg.side === 'SELL' && activeAsset !== 'NIFTY' && (
                                                <span style={{background: '#f97316', color: 'white', padding: '2px 4px', fontSize: '9px', borderRadius: '4px', fontWeight: 'bold', marginLeft: '4px'}} style={{cursor: 'pointer'}} onClick={() => setShowLeverageModal(true)}>{leverage}x</span>
                                             )}
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
                                   <div style={{flex: 1, textAlign: 'right'}}>{intrinsic.toFixed(1)}</div>
                                   <div style={{flex: 1, textAlign: 'right'}}>{entryPrice.toFixed(1)}</div>
                                   <div style={{flex: 1, textAlign: 'right', color: legPnl >= 0 ? 'var(--color-up)' : 'var(--color-down)'}}>{legPnl.toFixed(2)}</div>
                               </div>
                           );
                       })}
                       
                       <div style={{display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '15px', marginTop: '10px'}}>
                           <span className="text-sm text-secondary">Total Projected PNL</span>
                           <span className="text-sm font-bold" style={{color: projectedPNL >= 0 ? 'var(--color-up)' : 'var(--color-down)'}}>{projectedPNL.toFixed(2)} USD</span>
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
                           <span style={{fontWeight: 'bold', color: 'white', fontSize: '14px'}}>${orderMargin.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                       </div>
                       <div style={{display: 'flex', flexDirection: 'column', gap: '4px'}}>
                           <div style={{fontSize: '11px', color: 'var(--text-secondary)'}}>
                               Available Margin
                           </div>
                           <span style={{fontWeight: 'bold', fontSize: '14px', color: activeAccount.balance < (orderMargin + tradingFees.totalAllFees) ? 'var(--color-down)' : 'white'}}>${activeAccount.balance.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                       </div>
                   </div>
                   
                   <button 
                       className="btn" 
                       style={{
                           background: stratBasket.length === 0 ? '#384050' : (isTrading ? '#4b5563' : 'var(--color-accent)'), 
                           color: stratBasket.length === 0 ? '#838a9b' : (isTrading ? '#cdd2d8' : 'white'), 
                           fontWeight: 'bold', 
                           fontSize: '14px', 
                           padding: '12px 24px', 
                           borderRadius: '4px',
                           cursor: stratBasket.length === 0 || isTrading ? 'not-allowed' : 'pointer',
                           border: 'none',
                           flex: 1,
                           transition: 'all 0.2s ease'
                       }} 
                       disabled={stratBasket.length === 0 || isTrading}
                       onClick={() => handleTrade(stratBasket, strategy)}
                   >
                       {isTrading ? (
                           <span style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                               <span style={{width: '14px', height: '14px', border: '2px solid #cdd2d8', borderRightColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite'}}></span>
                               Executing...
                           </span>
                       ) : (
                           `Place Order${stratBasket.length > 0 ? ` (${stratBasket.length})` : ''}`
                       )}
                   </button>
               </div>
           </div>
        </aside>
        )}
      </main>

      {/* Account Switcher & Sub-Account Creator Modal (CRYPTO USD - Max 10) */}
      {showAccountModal && (
          <div style={{position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', backdropFilter: 'blur(3px)'}}>
              <div style={{background: '#141822', padding: '20px', borderRadius: '8px', width: '470px', border: '1px solid var(--border-color)', position: 'relative', boxShadow: '0 8px 32px rgba(0,0,0,0.5)'}}>
                  <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px'}}>
                      <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                          <span style={{color: 'var(--color-accent)', fontSize: '15px'}}>💼</span>
                          <h3 style={{fontSize: '14px', fontWeight: 'bold', color: 'white'}}>Manage Crypto Sub-Accounts (USD)</h3>
                          <span style={{background: accounts.length >= 10 ? '#ff5252' : 'rgba(255,255,255,0.08)', color: 'white', fontSize: '10px', padding: '2px 7px', borderRadius: '10px', fontWeight: 600}}>
                              {accounts.length}/10 Accounts
                          </span>
                      </div>
                      <span style={{cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '14px'}} onClick={() => { setShowAccountModal(false); setAccountError(''); }}>✕</span>
                  </div>

                  {accountError && (
                      <div style={{background: 'rgba(248, 73, 96, 0.15)', border: '1px solid var(--color-down)', color: 'var(--color-down)', padding: '8px 12px', borderRadius: '4px', fontSize: '11.5px', marginBottom: '12px'}}>
                          ⚠️ {accountError}
                      </div>
                  )}

                  <div style={{fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '12px'}}>
                      Select an active account or create up to 10 dedicated USD sub-accounts for Crypto options:
                  </div>

                  {/* Accounts List */}
                  <div style={{display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px', maxHeight: '220px', overflowY: 'auto'}}>
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
                                  background: activeAccountId === acc.id ? 'rgba(239, 131, 46, 0.08)' : 'rgba(255,255,255,0.02)',
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
                                  <span style={{fontSize: '10px', color: 'var(--text-secondary)'}}>ID: #{acc.id} • USD Margin</span>
                              </div>
                              
                              <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                                  <div style={{textAlign: 'right'}}>
                                      <div style={{fontSize: '13px', fontWeight: 'bold', color: 'white'}}>${Number(acc.balance).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
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
                                  placeholder="Account Name (e.g. BTC Momentum / 50k Fund)" 
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
                              {[5000, 10000, 25000, 50000, 100000, 250000, 500000].map(amt => (
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
                                      ${amt / 1000}k
                                  </button>
                              ))}
                          </div>

                          <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
                              <div style={{flex: 2, display: 'flex', alignItems: 'center', background: '#0e121a', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '0 10px'}}>
                                  <span style={{color: 'var(--text-secondary)', fontSize: '11px', marginRight: '4px'}}>$</span>
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
                              placeholder="e.g. Crypto Momentum 50k"
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
                          <label style={{fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px'}}>Available Margin (USD $)</label>
                          <div style={{display: 'flex', alignItems: 'center', background: '#0e121a', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '6px 12px', marginBottom: '8px'}}>
                              <span style={{color: 'var(--color-accent)', fontWeight: 'bold', fontSize: '14px', marginRight: '6px'}}>$</span>
                              <input 
                                  type="number" 
                                  value={editAccBalance} 
                                  onChange={e => setEditAccBalance(Number(e.target.value))}
                                  style={{width: '100%', background: 'transparent', border: 'none', color: 'white', fontSize: '13px', fontWeight: 'bold', outline: 'none'}}
                              />
                          </div>

                          {/* Quick Margin Presets */}
                          <div style={{display: 'flex', flexWrap: 'wrap', gap: '5px'}}>
                              {[5000, 10000, 25000, 50000, 100000, 250000, 500000].map(amt => (
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
                                      ${amt / 1000}k
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
                      <label style={{fontSize: '11px', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px'}}>Available Margin Amount (USD $)</label>
                      <div style={{display: 'flex', alignItems: 'center', background: '#0e121a', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px 12px'}}>
                          <span style={{color: 'var(--color-accent)', fontWeight: 'bold', fontSize: '14px', marginRight: '6px'}}>$</span>
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
                      {[5000, 10000, 25000, 50000, 100000, 250000, 500000].map(amt => (
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
                              ${(amt / 1000).toFixed(0)}k
                          </button>
                      ))}
                      <button 
                          style={{background: 'rgba(255,255,255,0.04)', color: 'var(--color-up)', border: '1px solid var(--border-color)', borderRadius: '3px', padding: '5px 8px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer'}}
                          onClick={() => setCustomBalanceInput(prev => prev + 10000)}
                      >
                          +$10k
                      </button>
                      <button 
                          style={{background: 'rgba(255,255,255,0.04)', color: 'var(--color-up)', border: '1px solid var(--border-color)', borderRadius: '3px', padding: '5px 8px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer'}}
                          onClick={() => setCustomBalanceInput(prev => prev + 50000)}
                      >
                          +$50k
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
    </div>
  );
}

export default CryptoTerminal;





