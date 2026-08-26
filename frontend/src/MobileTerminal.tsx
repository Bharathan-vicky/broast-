import React, { useState, useEffect, useMemo } from 'react';
import { ResponsiveContainer, ComposedChart, XAxis, YAxis, Tooltip, ReferenceLine, Line } from 'recharts';

interface OptionLeg {
  symbol: string;
  underlying: string;
  strike: number;
  expiry: string;
  option_type: 'CALL' | 'PUT';
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  order_type?: 'MARKET' | 'LIMIT';
  limit_price?: number;
}

interface Account {
  id: number;
  name: string;
  margin_type: 'Cross' | 'Isolated';
  balance: number;
  currency: 'INR' | 'USD';
}

const ASSET_CONFIG: Record<string, { currency: 'INR' | 'USD', lotSize: number, symbol: string, name: string, lotUnit: string, exchange: string }> = {
  'NIFTY': { currency: 'INR', lotSize: 65, symbol: '₹', name: 'NIFTY 50 Index', lotUnit: 'units', exchange: 'NSE' },
  'BANKNIFTY': { currency: 'INR', lotSize: 30, symbol: '₹', name: 'BANK NIFTY Index', lotUnit: 'units', exchange: 'NSE' },
  'SENSEX': { currency: 'INR', lotSize: 20, symbol: '₹', name: 'BSE SENSEX Index', lotUnit: 'units', exchange: 'BSE' },
  'CRUDEOIL': { currency: 'INR', lotSize: 100, symbol: '₹', name: 'Crude Oil', lotUnit: 'bbl', exchange: 'MCX' },
  'GOLD': { currency: 'INR', lotSize: 100, symbol: '₹', name: 'Gold', lotUnit: 'grams', exchange: 'MCX' },
  'SILVER': { currency: 'INR', lotSize: 30, symbol: '₹', name: 'Silver', lotUnit: 'kg', exchange: 'MCX' },
  'BTC': { currency: 'USD', lotSize: 0.001, symbol: '$', name: 'Bitcoin', lotUnit: 'BTC', exchange: 'DELTA' },
  'ETH': { currency: 'USD', lotSize: 0.01, symbol: '$', name: 'Ethereum', lotUnit: 'ETH', exchange: 'DELTA' },
  'XAUT': { currency: 'USD', lotSize: 1, symbol: '$', name: 'Tether Gold', lotUnit: 'oz', exchange: 'DELTA' }
};

export default function MobileTerminal() {
  const [activeAsset, setActiveAsset] = useState<string>('NIFTY');
  const [activeExpiry, setActiveExpiry] = useState<string>('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [chainByExpiry, setChainByExpiry] = useState<any>({});
  const [spotPrice, setSpotPrice] = useState<number | null>(null);
  const [spotChange, setSpotChange] = useState<number>(0);
  const [spotPercentChange, setSpotPercentChange] = useState<number>(0);
  
  // View mode: LTP vs OI
  const [viewMode, setViewMode] = useState<'LTP' | 'OI'>('LTP');
  
  // Navigation Tabs: 'chain' | 'strategy' | 'positions' | 'accounts'
  const [activeTab, setActiveTab] = useState<'chain' | 'strategy' | 'positions' | 'accounts'>('chain');
  
  // Bottom Sheet Modals
  const [showAssetSheet, setShowAssetSheet] = useState(false);
  const [showExpirySheet, setShowExpirySheet] = useState(false);
  const [selectedStrikeLeg, setSelectedStrikeLeg] = useState<{ strike: number, type: 'CALL' | 'PUT', row: any, side: 'BUY' | 'SELL' } | null>(null);
  
  // Strategy Basket
  const [stratBasket, setStratBasket] = useState<OptionLeg[]>([]);
  const [orderLots, setOrderLots] = useState<number>(1);
  const [tradeMessage, setTradeMessage] = useState<string>('');
  
  // Accounts State (INR for Nifty, USD for Crypto)
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<number>(1);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editAccName, setEditAccName] = useState('');
  const [editAccBalance, setEditAccBalance] = useState<number>(1000000);
  const [editAccMarginType, setEditAccMarginType] = useState<'Cross' | 'Isolated'>('Cross');
  
  // Portfolio & History
  const [portfolio, setPortfolio] = useState<any>(null);
  const [orderHistory, setOrderHistory] = useState<any[]>([]);
  
  const currConfig = ASSET_CONFIG[activeAsset] || ASSET_CONFIG['NIFTY'];
  const currency = currConfig.currency;
  const currSym = currConfig.symbol;
  const lotSize = currConfig.lotSize;

  // Active account for current asset currency
  const activeAccount = useMemo(() => {
    const acc = accounts.find(a => a.id === activeAccountId && a.currency === currency);
    if (acc) return acc;
    const firstMatching = accounts.find(a => a.currency === currency);
    return firstMatching || { id: 1, name: `${activeAsset} Main`, margin_type: 'Cross', balance: currency === 'INR' ? 1000000 : 100000, currency };
  }, [accounts, activeAccountId, currency, activeAsset]);

  // Load Accounts on Currency Change
  const fetchAccounts = () => {
    fetch(`http://127.0.0.1:8000/api/accounts?currency=${currency}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setAccounts(data);
          setActiveAccountId(prev => data.some((a: any) => a.id === prev) ? prev : data[0].id);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchAccounts();
  }, [currency]);

  // Fetch Market Data (1s interval)
  useEffect(() => {
    const chainApi = activeAsset === 'NIFTY' ? '/api/nifty/chain' : '/api/options/chain';
    const spotApi = activeAsset === 'NIFTY' ? '/api/nifty/spot' : '/api/spot';

    const fetchMarketTick = () => {
      fetch(`http://127.0.0.1:8000${chainApi}?asset=${activeAsset}`)
        .then(r => r.json())
        .then(data => {
          if (data.expiries && data.expiries.length > 0) {
            setExpiries(data.expiries);
            setActiveExpiry(prev => (prev && data.expiries.includes(prev)) ? prev : data.expiries[0]);
          }
          if (data.chainByExpiry) setChainByExpiry(data.chainByExpiry);
        })
        .catch(() => {});

      fetch(`http://127.0.0.1:8000${spotApi}?asset=${activeAsset}`)
        .then(r => r.json())
        .then(data => {
          if (data.spot_price !== undefined && data.spot_price !== null) {
            const p = typeof data.spot_price === 'object' ? Number(data.spot_price?.spot_price) : Number(data.spot_price);
            setSpotPrice(p);
            if (data.change !== undefined) setSpotChange(Number(data.change));
            if (data.percent_change !== undefined) setSpotPercentChange(Number(data.percent_change));
          }
        })
        .catch(() => {});
    };

    fetchMarketTick();
    const interval = setInterval(fetchMarketTick, 1000);
    return () => clearInterval(interval);
  }, [activeAsset]);

  // Fetch Portfolio & Positions (1s interval)
  useEffect(() => {
    const fetchUserData = () => {
      const accId = activeAccount?.id || 1;
      fetch(`http://127.0.0.1:8000/api/portfolio?account_id=${accId}`)
        .then(r => r.json())
        .then(data => setPortfolio(data))
        .catch(() => {});

      fetch(`http://127.0.0.1:8000/api/history?account_id=${accId}`)
        .then(r => r.json())
        .then(data => setOrderHistory(data))
        .catch(() => {});
    };

    fetchUserData();
    const interval = setInterval(fetchUserData, 1000);
    return () => clearInterval(interval);
  }, [activeAccount?.id]);

  const currentChain = useMemo(() => {
    return chainByExpiry[activeExpiry] || [];
  }, [chainByExpiry, activeExpiry]);

  // Order Margin Calculation (NSE SPAN / Delta Portfolio Standard)
  const orderMargin = useMemo(() => {
    if (!stratBasket.length) return 0;
    const sp = spotPrice || 24250.0;
    const buyLegs = stratBasket.filter(l => l.side === 'BUY');
    const sellLegs = stratBasket.filter(l => l.side === 'SELL');

    let buyPremium = 0;
    buyLegs.forEach(l => {
      buyPremium += (l.price || 0) * lotSize * (l.size || 1);
    });

    if (sellLegs.length === 0) return buyPremium;

    const sellCalls = sellLegs.filter(l => l.option_type === 'CALL');
    const sellPuts = sellLegs.filter(l => l.option_type === 'PUT');
    const sellCallLots = sellCalls.reduce((s, l) => s + (l.size || 1), 0);
    const sellPutLots = sellPuts.reduce((s, l) => s + (l.size || 1), 0);

    const baseSpanPerLot = 0.082 * sp * lotSize;
    const exposurePerLot = 0.020 * sp * lotSize;
    const nakedMarginPerLot = baseSpanPerLot + exposurePerLot;

    if (sellCallLots > 0 && sellPutLots > 0) {
      const maxLots = Math.max(sellCallLots, sellPutLots);
      const minLots = Math.min(sellCallLots, sellPutLots);
      const dominantMargin = maxLots * nakedMarginPerLot;
      const hedgeBenefitOffset = minLots * (nakedMarginPerLot * 0.725);
      return Math.max(buyPremium + ((dominantMargin + minLots * nakedMarginPerLot) - hedgeBenefitOffset), buyPremium);
    }

    let netSellMargin = 0;
    sellLegs.forEach(sLeg => {
      const sLots = sLeg.size || 1;
      const hedge = buyLegs.find(bLeg =>
        bLeg.option_type === sLeg.option_type &&
        ((sLeg.option_type === 'CALL' && bLeg.strike > sLeg.strike) ||
         (sLeg.option_type === 'PUT' && bLeg.strike < sLeg.strike))
      );

      if (hedge) {
        const spreadWidth = Math.abs(hedge.strike - sLeg.strike);
        const maxRisk = spreadWidth * lotSize * sLots;
        netSellMargin += Math.min(nakedMarginPerLot * sLots, maxRisk + (0.015 * sp * lotSize * sLots));
      } else {
        netSellMargin += (nakedMarginPerLot + (sLeg.price || 0) * lotSize) * sLots;
      }
    });

    return buyPremium + netSellMargin;
  }, [stratBasket, spotPrice, lotSize]);

  // PayOff Data Calculation for Chart
  const payoffData = useMemo(() => {
    if (!stratBasket.length) return [];
    const strikes = stratBasket.map(l => l.strike);
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    const range = Math.max(maxStrike - minStrike, (spotPrice || 24250) * 0.04);
    const step = Math.max(10, Math.round(range / 30));

    const low = Math.floor((minStrike - range * 0.6) / 50) * 50;
    const high = Math.ceil((maxStrike + range * 0.6) / 50) * 50;

    const data = [];
    for (let p = low; p <= high; p += step) {
      let pnlExpiry = 0;
      stratBasket.forEach(leg => {
        const intrinsic = leg.option_type === 'CALL' ? Math.max(0, p - leg.strike) : Math.max(0, leg.strike - p);
        const entryPrice = leg.price || 0;
        pnlExpiry += (leg.side === 'BUY' ? intrinsic - entryPrice : entryPrice - intrinsic) * (leg.size || 1) * lotSize;
      });
      data.push({ price: p, pnlExpiry });
    }
    return data;
  }, [stratBasket, spotPrice, lotSize]);

  const handleAddLeg = (row: any, type: 'CALL' | 'PUT', side: 'BUY' | 'SELL', size: number) => {
    const symbol = type === 'CALL' ? row.callSym : row.putSym;
    const price = type === 'CALL' ? (row.callMark || 0) : (row.putMark || 0);
    const newLeg: OptionLeg = {
      symbol: symbol || `${type[0]}-${activeAsset}-${row.strike}`,
      underlying: activeAsset,
      strike: row.strike,
      expiry: activeExpiry,
      option_type: type,
      side,
      size,
      price
    };
    setStratBasket([newLeg]);
    setSelectedStrikeLeg(null);
    setActiveTab('strategy');
  };

  const handlePlaceOrder = () => {
    if (!stratBasket.length) return;
    fetch('http://127.0.0.1:8000/api/trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        basket_name: `${activeAsset} Mobile Strategy`,
        legs: stratBasket,
        account_id: activeAccount.id
      })
    })
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') {
          setTradeMessage('Order placed successfully! ⚡');
          setStratBasket([]);
          setActiveTab('positions');
          setTimeout(() => setTradeMessage(''), 4000);
        } else {
          setTradeMessage(`Error: ${data.message}`);
        }
      })
      .catch(() => setTradeMessage('Trade execution failed'));
  };

  const handleClosePosition = (basketId: number) => {
    fetch('http://127.0.0.1:8000/api/trade/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basket_id: basketId, account_id: activeAccount.id })
    })
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') {
          setTradeMessage('Position closed successfully! ✓');
          setTimeout(() => setTradeMessage(''), 3000);
        }
      })
      .catch(() => {});
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

  return (
    <div style={{
      width: '100vw',
      minHeight: '100vh',
      maxWidth: '480px',
      margin: '0 auto',
      background: '#0a0d14',
      color: '#ffffff',
      fontFamily: 'Inter, -apple-system, Roboto, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      paddingBottom: '60px'
    }}>
      {/* 1. Header Bar */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        background: '#10141f',
        borderBottom: '1px solid #1a2233'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '18px', cursor: 'pointer' }} onClick={() => window.history.back()}>←</span>
          <h2 style={{ fontSize: '16px', fontWeight: 'bold' }}>Option Chain</h2>
          <span style={{ color: '#707886', fontSize: '14px', cursor: 'pointer' }}>ⓘ</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button 
            onClick={() => {
              fetch('http://127.0.0.1:8000/api/refresh').catch(() => {});
              const chainApi = activeAsset === 'NIFTY' ? '/api/nifty/chain' : '/api/options/chain';
              const spotApi = activeAsset === 'NIFTY' ? '/api/nifty/spot' : '/api/spot';
              fetch(`http://127.0.0.1:8000${chainApi}?asset=${activeAsset}`)
                .then(r => r.json())
                .then(data => {
                  if (data.expiries?.length) {
                    setExpiries(data.expiries);
                    setActiveExpiry(prev => (prev && data.expiries.includes(prev)) ? prev : data.expiries[0]);
                  }
                  if (data.chainByExpiry) setChainByExpiry(data.chainByExpiry);
                })
                .catch(() => {});
              fetch(`http://127.0.0.1:8000${spotApi}?asset=${activeAsset}`)
                .then(r => r.json())
                .then(data => {
                  if (data.spot_price !== undefined && data.spot_price !== null) {
                    const p = typeof data.spot_price === 'object' ? Number(data.spot_price?.spot_price) : Number(data.spot_price);
                    setSpotPrice(p);
                    if (data.change !== undefined) setSpotChange(Number(data.change));
                    if (data.percent_change !== undefined) setSpotPercentChange(Number(data.percent_change));
                  }
                })
                .catch(() => {});
              setTradeMessage('Live Prices Updated! ⚡');
              setTimeout(() => setTradeMessage(''), 2500);
            }}
            style={{ 
              background: 'rgba(16, 185, 129, 0.15)', 
              color: '#10b981', 
              border: '1px solid #10b981', 
              padding: '3px 9px', 
              borderRadius: '6px', 
              fontSize: '11px', 
              fontWeight: 'bold', 
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            🔄 Refresh
          </button>
          <span style={{ background: '#1c2230', padding: '3px 8px', borderRadius: '12px', fontSize: '10px', color: '#00c087', fontWeight: 'bold' }}>
            ⚡ Live
          </span>
          <span style={{ fontSize: '16px', cursor: 'pointer' }} onClick={() => setShowAssetSheet(true)}>⋮</span>
        </div>
      </header>

      {/* 2. Top Banner / Status */}
      <div style={{
        background: 'linear-gradient(90deg, #1b2030, #131826)',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '11px',
        borderBottom: '1px solid #1a2233'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ color: '#f78d38' }}>💼</span>
          <span style={{ fontWeight: 600 }}>{activeAccount.name}</span>
          <span style={{ color: '#707886' }}>({activeAccount.margin_type})</span>
        </div>
        <div style={{ fontWeight: 'bold', color: '#00c087' }}>
          {currSym}{Number(activeAccount.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
        </div>
      </div>

      {/* Trade Success / Error Message Banner */}
      {tradeMessage && (
        <div style={{
          background: tradeMessage.includes('Error') ? '#3d141a' : '#102a20',
          color: tradeMessage.includes('Error') ? '#f84960' : '#00c087',
          padding: '8px 16px',
          fontSize: '12px',
          fontWeight: 600,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span>{tradeMessage}</span>
          <span style={{ cursor: 'pointer' }} onClick={() => setTradeMessage('')}>✕</span>
        </div>
      )}

      {/* 3. Asset & Spot Controller Box (Exactly matching Screenshot 1) */}
      <div style={{ padding: '12px 16px', background: '#0e121a', borderBottom: '1px solid #1a2233' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          {/* Index Selector Dropdown Pill */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '10px', color: '#707886' }}>Index</span>
            <div 
              onClick={() => setShowAssetSheet(true)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                background: '#161c28',
                border: '1px solid #232c3d',
                padding: '6px 12px',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              <span style={{ fontWeight: 'bold', fontSize: '14px', letterSpacing: '0.5px' }}>{activeAsset}</span>
              <span style={{ color: '#707886', fontSize: '10px' }}>⌄</span>
            </div>
          </div>

          {/* Live Spot Price */}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '17px', fontWeight: 'bold', letterSpacing: '0.3px' }}>
              {spotPrice ? spotPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
            </div>
            <div style={{ fontSize: '11px', fontWeight: 600, color: spotChange >= 0 ? '#00c087' : '#f84960' }}>
              {spotChange >= 0 ? `+${spotChange.toFixed(2)}` : spotChange.toFixed(2)} ({spotPercentChange >= 0 ? `+${spotPercentChange.toFixed(2)}` : spotPercentChange.toFixed(2)}%)
            </div>
          </div>
        </div>

        {/* Expiry Selector & LTP/OI Toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div 
            onClick={() => setShowExpirySheet(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: '#161c28',
              border: '1px solid #232c3d',
              padding: '6px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            <span>{activeExpiry ? new Date(activeExpiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Select Expiry'}</span>
            <span style={{ color: '#707886', fontSize: '10px' }}>⌄</span>
          </div>

          {/* LTP vs OI Segment */}
          <div style={{ display: 'flex', background: '#141824', padding: '2px', borderRadius: '6px', border: '1px solid #232c3d' }}>
            <button
              onClick={() => setViewMode('LTP')}
              style={{
                padding: '4px 14px',
                fontSize: '11px',
                fontWeight: 'bold',
                borderRadius: '4px',
                border: 'none',
                background: viewMode === 'LTP' ? '#1e293b' : 'transparent',
                color: viewMode === 'LTP' ? '#38bdf8' : '#707886',
                cursor: 'pointer'
              }}
            >
              LTP
            </button>
            <button
              onClick={() => setViewMode('OI')}
              style={{
                padding: '4px 14px',
                fontSize: '11px',
                fontWeight: 'bold',
                borderRadius: '4px',
                border: 'none',
                background: viewMode === 'OI' ? '#1e293b' : 'transparent',
                color: viewMode === 'OI' ? '#38bdf8' : '#707886',
                cursor: 'pointer'
              }}
            >
              OI
            </button>
          </div>
        </div>
      </div>

      {/* ===================== TAB 1: OPTION CHAIN ===================== */}
      {activeTab === 'chain' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {/* Table Header */}
          <div style={{
            display: 'flex',
            padding: '8px 12px',
            background: '#121622',
            borderBottom: '1px solid #1a2233',
            fontSize: '11.5px',
            fontWeight: 600,
            color: '#8a95a5'
          }}>
            <div style={{ flex: 1, textAlign: 'left' }}>Call {viewMode} (Chng%)</div>
            <div style={{ width: '80px', textAlign: 'center', color: '#e2e8f0' }}>Strike</div>
            <div style={{ flex: 1, textAlign: 'right' }}>Put {viewMode} (Chng%)</div>
          </div>

          {/* Option Chain Rows (Screenshot 1 & 4 layout) */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {currentChain.map((row: any, idx: number) => {
              const isCallITM = spotPrice ? row.strike < spotPrice : false;
              const isPutITM = spotPrice ? row.strike > spotPrice : false;
              const nextRow = currentChain[idx + 1];
              const showSpotLine = spotPrice && nextRow && row.strike <= spotPrice && nextRow.strike > spotPrice;

              const callLtp = row.callMark || 0;
              const putLtp = row.putMark || 0;
              const callPchange = row.callPchange !== undefined ? row.callPchange : 0;
              const putPchange = row.putPchange !== undefined ? row.putPchange : 0;
              const callOi = row.callOI || 0;
              const putOi = row.putOI || 0;

              return (
                <React.Fragment key={row.strike}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    minHeight: '44px',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                    fontSize: '12px'
                  }}>
                    {/* 1. Call LTP / OI Box */}
                    <div 
                      onClick={() => setSelectedStrikeLeg({ strike: row.strike, type: 'CALL', row, side: 'BUY' })}
                      style={{
                        flex: 1,
                        padding: '6px 10px',
                        background: isCallITM ? 'rgba(239, 68, 68, 0.06)' : 'transparent',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        position: 'relative'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span style={{ fontWeight: 'bold', color: '#ffffff' }}>
                          {viewMode === 'LTP' ? callLtp.toFixed(2) : callOi.toLocaleString()}
                        </span>
                        <span style={{ fontSize: '10px', color: callPchange >= 0 ? '#00c087' : '#f84960', fontWeight: 500 }}>
                          {callPchange >= 0 ? `+${callPchange.toFixed(2)}%` : `${callPchange.toFixed(2)}%`}
                        </span>
                      </div>
                      {/* Subtle Volume Bar Indicator */}
                      <div style={{ width: '40%', height: '2px', background: 'rgba(239, 68, 68, 0.3)', marginTop: '2px', borderRadius: '1px' }} />
                    </div>

                    {/* 2. Strike Center Pillar */}
                    <div style={{
                      width: '80px',
                      background: '#111520',
                      padding: '8px 0',
                      textAlign: 'center',
                      fontWeight: 'bold',
                      fontSize: '13px',
                      color: '#ffffff',
                      borderLeft: '1px solid rgba(255,255,255,0.05)',
                      borderRight: '1px solid rgba(255,255,255,0.05)'
                    }}>
                      {row.strike.toLocaleString('en-IN')}
                    </div>

                    {/* 3. Put LTP / OI Box */}
                    <div 
                      onClick={() => setSelectedStrikeLeg({ strike: row.strike, type: 'PUT', row, side: 'BUY' })}
                      style={{
                        flex: 1,
                        padding: '6px 10px',
                        background: isPutITM ? 'rgba(0, 192, 135, 0.06)' : 'transparent',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-end',
                        justifyContent: 'center',
                        position: 'relative'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span style={{ fontWeight: 'bold', color: '#ffffff' }}>
                          {viewMode === 'LTP' ? putLtp.toFixed(2) : putOi.toLocaleString()}
                        </span>
                        <span style={{ fontSize: '10px', color: putPchange >= 0 ? '#00c087' : '#f84960', fontWeight: 500 }}>
                          {putPchange >= 0 ? `+${putPchange.toFixed(2)}%` : `${putPchange.toFixed(2)}%`}
                        </span>
                      </div>
                      {/* Subtle Volume Bar Indicator */}
                      <div style={{ width: '40%', height: '2px', background: 'rgba(0, 192, 135, 0.3)', marginTop: '2px', borderRadius: '1px' }} />
                    </div>
                  </div>

                  {/* Spot Price Live Divider Capsule (Screenshot 1 & 4) */}
                  {showSpotLine && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      position: 'relative',
                      margin: '2px 0'
                    }}>
                      <div style={{ width: '100%', height: '1px', background: '#38bdf8' }} />
                      <div style={{
                        position: 'absolute',
                        background: '#0284c7',
                        color: 'white',
                        padding: '3px 12px',
                        borderRadius: '12px',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        boxShadow: '0 2px 8px rgba(2,132,199,0.5)',
                        zIndex: 2
                      }}>
                        {activeAsset} {spotPrice?.toFixed(2)}
                      </div>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* ===================== TAB 2: STRATEGY & PAYOFF ===================== */}
      {activeTab === 'strategy' && (
        <div style={{ flex: 1, padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 'bold' }}>Strategy Payoff</h3>
            <span style={{ fontSize: '12px', color: '#707886' }}>{stratBasket.length} Legs Selected</span>
          </div>

          {/* Payoff Chart */}
          {stratBasket.length > 0 ? (
            <div style={{ height: '220px', background: '#10141f', borderRadius: '8px', padding: '8px', border: '1px solid #1a2233' }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={payoffData}>
                  <XAxis dataKey="price" stroke="#5a616e" fontSize={9} tickFormatter={(v) => Math.round(v).toLocaleString()} />
                  <YAxis stroke="#5a616e" fontSize={9} tickFormatter={(v) => `${currSym}${Math.round(v).toLocaleString()}`} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (active && payload && payload.length) {
                        const price = Number(label);
                        const pnl = Number(payload[0]?.value || 0);
                        return (
                          <div style={{ background: '#161c28', padding: '6px 10px', borderRadius: '4px', border: '1px solid #232c3d', fontSize: '11px' }}>
                            <div>Price: <strong>{price.toLocaleString()}</strong></div>
                            <div style={{ color: pnl >= 0 ? '#00c087' : '#f84960', fontWeight: 'bold' }}>
                              Expiry PNL: {pnl >= 0 ? `+${currSym}${Math.round(pnl).toLocaleString()}` : `-${currSym}${Math.round(Math.abs(pnl)).toLocaleString()}`}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <ReferenceLine y={0} stroke="#5a616e" strokeDasharray="3 3" />
                  {spotPrice && <ReferenceLine x={spotPrice} stroke="#38bdf8" />}
                  <Line type="monotone" dataKey="pnlExpiry" stroke="#00c087" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div style={{ padding: '30px', textAlign: 'center', color: '#707886', fontSize: '12px', background: '#10141f', borderRadius: '8px' }}>
              Tap any Strike from Option Chain to add Legs to Strategy Builder.
            </div>
          )}

          {/* Strategy Legs */}
          {stratBasket.map((leg, i) => (
            <div key={i} style={{ background: '#10141f', padding: '10px 12px', borderRadius: '6px', border: '1px solid #1a2233', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ background: leg.side === 'BUY' ? 'rgba(0,192,135,0.2)' : 'rgba(248,73,96,0.2)', color: leg.side === 'BUY' ? '#00c087' : '#f84960', padding: '2px 6px', borderRadius: '3px', fontWeight: 'bold', fontSize: '11px' }}>
                  {leg.side}
                </span>
                <span style={{ fontWeight: 'bold' }}>{leg.strike} {leg.option_type}</span>
                <span style={{ fontSize: '11px', color: '#707886' }}>{leg.size} Lot ({leg.size * lotSize} units)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 'bold' }}>{currSym}{leg.price?.toFixed(2)}</span>
                <span style={{ color: '#f84960', cursor: 'pointer', fontSize: '14px' }} onClick={() => setStratBasket(stratBasket.filter((_, idx) => idx !== i))}>🗑️</span>
              </div>
            </div>
          ))}

          {/* Order Margin & Place Order Button */}
          {stratBasket.length > 0 && (
            <div style={{ marginTop: 'auto', background: '#10141f', padding: '12px', borderRadius: '8px', border: '1px solid #1a2233' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '12px' }}>
                <span style={{ color: '#707886' }}>Required Margin:</span>
                <span style={{ fontWeight: 'bold', color: '#ffffff' }}>{currSym}{orderMargin.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              <button
                onClick={handlePlaceOrder}
                style={{
                  width: '100%',
                  background: '#f78d38',
                  color: 'white',
                  border: 'none',
                  padding: '12px',
                  borderRadius: '6px',
                  fontWeight: 'bold',
                  fontSize: '14px',
                  cursor: 'pointer'
                }}
              >
                Place Strategy Order ({stratBasket.length} Legs)
              </button>
            </div>
          )}
        </div>
      )}

      {/* ===================== TAB 3: POSITIONS & ORDERS ===================== */}
      {activeTab === 'positions' && (
        <div style={{ flex: 1, padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 'bold' }}>Live Positions ({portfolio?.baskets?.length || 0})</h3>

          {portfolio?.baskets && portfolio.baskets.length > 0 ? (
            portfolio.baskets.map((b: any) => (
              b.legs?.map((leg: any, i: number) => {
                const chain = chainByExpiry[leg.expiry] || [];
                const row = chain.find((r: any) => r.strike === leg.strike);
                const ltp = row ? (leg.option_type === 'CALL' ? row.callMark : row.putMark) : leg.entry_price;
                const entry = leg.entry_price || 0;
                const diff = leg.side === 'BUY' ? (ltp - entry) : (entry - ltp);
                const pnl = diff * (leg.size || 1) * lotSize;

                return (
                  <div key={i} style={{ background: '#10141f', borderRadius: '8px', padding: '12px', border: '1px solid #1a2233', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ background: leg.side === 'BUY' ? 'rgba(0,192,135,0.2)' : 'rgba(248,73,96,0.2)', color: leg.side === 'BUY' ? '#00c087' : '#f84960', padding: '1px 5px', borderRadius: '3px', fontWeight: 'bold', fontSize: '10px' }}>
                          {leg.side}
                        </span>
                        <span style={{ fontWeight: 'bold', fontSize: '13px' }}>{leg.symbol}</span>
                      </div>
                      <span style={{ fontWeight: 'bold', fontSize: '13px', color: pnl >= 0 ? '#00c087' : '#f84960' }}>
                        {pnl >= 0 ? `+${currSym}${pnl.toFixed(2)}` : `-${currSym}${Math.abs(pnl).toFixed(2)}`}
                      </span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#707886' }}>
                      <span>Size: {leg.size} Lot ({leg.size * lotSize} units)</span>
                      <span>Entry: {currSym}{entry.toFixed(2)} • LTP: {currSym}{ltp.toFixed(2)}</span>
                    </div>

                    <button
                      onClick={() => handleClosePosition(b.id)}
                      style={{
                        background: 'rgba(248,73,96,0.15)',
                        color: '#f84960',
                        border: '1px solid rgba(248,73,96,0.3)',
                        padding: '6px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        cursor: 'pointer',
                        marginTop: '4px'
                      }}
                    >
                      Close Position
                    </button>
                  </div>
                );
              })
            ))
          ) : (
            <div style={{ padding: '30px', textAlign: 'center', color: '#707886', fontSize: '12px', background: '#10141f', borderRadius: '8px' }}>
              No active positions found.
            </div>
          )}

          {/* Order History */}
          <h3 style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '10px' }}>Order History</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {orderHistory.map((trade: any, idx: number) => (
              <div key={idx} style={{ background: '#10141f', padding: '8px 12px', borderRadius: '6px', border: '1px solid #1a2233', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{trade.symbol}</div>
                  <div style={{ color: '#707886', fontSize: '10px' }}>{new Date(trade.timestamp).toLocaleTimeString()}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ color: trade.side === 'BUY' ? '#00c087' : '#f84960', fontWeight: 'bold', marginRight: '6px' }}>{trade.side}</span>
                  <span style={{ fontWeight: 'bold' }}>{currSym}{trade.price?.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===================== TAB 4: ACCOUNTS & CAPITAL ===================== */}
      {activeTab === 'accounts' && (
        <div style={{ flex: 1, padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 'bold' }}>Sub-Accounts ({currency})</h3>
            <span style={{ fontSize: '11px', color: '#707886' }}>{accounts.length} / 10 Accounts</span>
          </div>

          {/* Accounts List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {accounts.map(acc => (
              <div
                key={acc.id}
                onClick={() => setActiveAccountId(acc.id)}
                style={{
                  background: activeAccountId === acc.id ? 'rgba(247, 141, 56, 0.1)' : '#10141f',
                  border: activeAccountId === acc.id ? '1px solid #f78d38' : '1px solid #1a2233',
                  borderRadius: '6px',
                  padding: '10px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  cursor: 'pointer'
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontWeight: 'bold', fontSize: '12px' }}>{acc.name}</span>
                    <span style={{ background: acc.margin_type === 'Cross' ? 'rgba(0,192,135,0.2)' : 'rgba(247,141,56,0.2)', color: acc.margin_type === 'Cross' ? '#00c087' : '#f78d38', fontSize: '9px', padding: '1px 5px', borderRadius: '2px', fontWeight: 'bold' }}>
                      {acc.margin_type}
                    </span>
                    {activeAccountId === acc.id && <span style={{ color: '#f78d38', fontSize: '10px', fontWeight: 'bold' }}>✓</span>}
                  </div>
                  <span style={{ fontSize: '10px', color: '#707886' }}>ID: #{acc.id} • {acc.currency} Margin</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 'bold', fontSize: '13px' }}>
                      {currSym}{Number(acc.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </div>
                    <div style={{ fontSize: '9px', color: '#707886' }}>Available Margin</div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingAccount(acc);
                      setEditAccName(acc.name);
                      setEditAccBalance(acc.balance);
                      setEditAccMarginType(acc.margin_type);
                    }}
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid #232c3d', color: '#f78d38', padding: '4px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer' }}
                  >
                    ✎ Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===================== BOTTOM SHEET: ASSET SELECTOR (Screenshot 2) ===================== */}
      {showAssetSheet && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }} onClick={() => setShowAssetSheet(false)}>
          <div style={{ background: '#121622', borderTopLeftRadius: '16px', borderTopRightRadius: '16px', padding: '16px', maxHeight: '60vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ width: '36px', height: '4px', background: '#3b4455', borderRadius: '2px', margin: '0 auto 16px' }} />
            <h3 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '14px' }}>Select Underlying Asset</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {Object.keys(ASSET_CONFIG).map(assetKey => {
                const conf = ASSET_CONFIG[assetKey];
                const isSelected = activeAsset === assetKey;
                return (
                  <div
                    key={assetKey}
                    onClick={() => {
                      setActiveAsset(assetKey);
                      setShowAssetSheet(false);
                    }}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '12px 14px',
                      borderRadius: '8px',
                      background: isSelected ? 'rgba(247, 141, 56, 0.1)' : 'transparent',
                      cursor: 'pointer'
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 'bold', fontSize: '14px' }}>{assetKey}</div>
                      <div style={{ fontSize: '11px', color: '#707886' }}>{conf.name} • {conf.currency} Margin</div>
                    </div>
                    {isSelected && <span style={{ color: '#0284c7', fontSize: '18px', fontWeight: 'bold' }}>✓</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ===================== BOTTOM SHEET: EXPIRY SELECTOR (Screenshot 3) ===================== */}
      {showExpirySheet && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }} onClick={() => setShowExpirySheet(false)}>
          <div style={{ background: '#121622', borderTopLeftRadius: '16px', borderTopRightRadius: '16px', padding: '16px', maxHeight: '70vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ width: '36px', height: '4px', background: '#3b4455', borderRadius: '2px', margin: '0 auto 16px' }} />
            <h3 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '14px' }}>Select Expiration Date</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {expiries.map(exp => {
                const isSelected = activeExpiry === exp;
                return (
                  <div
                    key={exp}
                    onClick={() => {
                      setActiveExpiry(exp);
                      setShowExpirySheet(false);
                    }}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '12px 14px',
                      borderRadius: '8px',
                      background: isSelected ? 'rgba(2, 132, 199, 0.15)' : 'transparent',
                      cursor: 'pointer'
                    }}
                  >
                    <span style={{ fontWeight: isSelected ? 'bold' : 500, fontSize: '13px' }}>
                      {new Date(exp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </span>
                    {isSelected && <span style={{ color: '#0284c7', fontSize: '16px', fontWeight: 'bold' }}>✓</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ===================== BOTTOM SHEET: QUICK ORDER MODAL ===================== */}
      {selectedStrikeLeg && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }} onClick={() => setSelectedStrikeLeg(null)}>
          <div style={{ background: '#121622', borderTopLeftRadius: '16px', borderTopRightRadius: '16px', padding: '16px', maxHeight: '60vh' }} onClick={e => e.stopPropagation()}>
            <div style={{ width: '36px', height: '4px', background: '#3b4455', borderRadius: '2px', margin: '0 auto 12px' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div>
                <h3 style={{ fontSize: '15px', fontWeight: 'bold' }}>{activeAsset} {selectedStrikeLeg.strike} {selectedStrikeLeg.type}</h3>
                <span style={{ fontSize: '11px', color: '#707886' }}>{activeExpiry ? new Date(activeExpiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : ''}</span>
              </div>
              <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#ffffff' }}>
                {currSym}{(selectedStrikeLeg.type === 'CALL' ? selectedStrikeLeg.row.callMark : selectedStrikeLeg.row.putMark)?.toFixed(2)}
              </div>
            </div>

            {/* Buy / Sell Toggle */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
              <button
                onClick={() => setSelectedStrikeLeg({ ...selectedStrikeLeg, side: 'BUY' })}
                style={{
                  flex: 1,
                  padding: '8px',
                  borderRadius: '6px',
                  border: 'none',
                  background: selectedStrikeLeg.side === 'BUY' ? '#00c087' : '#1e2433',
                  color: 'white',
                  fontWeight: 'bold',
                  cursor: 'pointer'
                }}
              >
                BUY
              </button>
              <button
                onClick={() => setSelectedStrikeLeg({ ...selectedStrikeLeg, side: 'SELL' })}
                style={{
                  flex: 1,
                  padding: '8px',
                  borderRadius: '6px',
                  border: 'none',
                  background: selectedStrikeLeg.side === 'SELL' ? '#f84960' : '#1e2433',
                  color: 'white',
                  fontWeight: 'bold',
                  cursor: 'pointer'
                }}
              >
                SELL
              </button>
            </div>

            {/* Lot Size Selector */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#161c28', padding: '8px 12px', borderRadius: '6px', marginBottom: '14px' }}>
              <span style={{ fontSize: '12px', color: '#707886' }}>Quantity (Lots)</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button onClick={() => setOrderLots(Math.max(1, orderLots - 1))} style={{ background: '#232c3d', color: 'white', border: 'none', width: '28px', height: '28px', borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer' }}>-</button>
                <span style={{ fontWeight: 'bold', fontSize: '14px' }}>{orderLots} Lot ({orderLots * lotSize} units)</span>
                <button onClick={() => setOrderLots(orderLots + 1)} style={{ background: '#232c3d', color: 'white', border: 'none', width: '28px', height: '28px', borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer' }}>+</button>
              </div>
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => handleAddLeg(selectedStrikeLeg.row, selectedStrikeLeg.type, selectedStrikeLeg.side, orderLots)}
                style={{
                  flex: 1,
                  background: selectedStrikeLeg.side === 'BUY' ? '#00c087' : '#f84960',
                  color: 'white',
                  border: 'none',
                  padding: '12px',
                  borderRadius: '6px',
                  fontWeight: 'bold',
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                Add to Strategy Basket
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== BOTTOM SHEET: EDIT ACCOUNT ===================== */}
      {editingAccount && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 10000, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }} onClick={() => setEditingAccount(null)}>
          <div style={{ background: '#121622', borderTopLeftRadius: '16px', borderTopRightRadius: '16px', padding: '16px' }} onClick={e => e.stopPropagation()}>
            <div style={{ width: '36px', height: '4px', background: '#3b4455', borderRadius: '2px', margin: '0 auto 12px' }} />
            <h3 style={{ fontSize: '15px', fontWeight: 'bold', marginBottom: '14px' }}>Edit Sub-Account #{editingAccount.id}</h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
              <div>
                <label style={{ fontSize: '11px', color: '#707886', display: 'block', marginBottom: '4px' }}>Account Name</label>
                <input
                  type="text"
                  value={editAccName}
                  onChange={e => setEditAccName(e.target.value)}
                  style={{ width: '100%', background: '#161c28', border: '1px solid #232c3d', borderRadius: '6px', padding: '8px 10px', color: 'white', fontSize: '12px', outline: 'none' }}
                />
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#707886', display: 'block', marginBottom: '4px' }}>Margin Mode</label>
                <select
                  value={editAccMarginType}
                  onChange={(e: any) => setEditAccMarginType(e.target.value)}
                  style={{ width: '100%', background: '#161c28', border: '1px solid #232c3d', borderRadius: '6px', padding: '8px 10px', color: 'white', fontSize: '12px', outline: 'none' }}
                >
                  <option value="Cross">Cross Margin (Shared Balance)</option>
                  <option value="Isolated">Isolated Margin (Independent Capital)</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: '11px', color: '#707886', display: 'block', marginBottom: '4px' }}>Available Margin ({currency})</label>
                <input
                  type="number"
                  value={editAccBalance}
                  onChange={e => setEditAccBalance(Number(e.target.value))}
                  style={{ width: '100%', background: '#161c28', border: '1px solid #232c3d', borderRadius: '6px', padding: '8px 10px', color: 'white', fontSize: '13px', fontWeight: 'bold', outline: 'none' }}
                />
              </div>
            </div>

            <button
              onClick={handleUpdateAccount}
              style={{ width: '100%', background: '#f78d38', color: 'white', border: 'none', padding: '12px', borderRadius: '6px', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}
            >
              Save Changes
            </button>
          </div>
        </div>
      )}

      {/* 4. Bottom Tab Bar Navigation */}
      <nav style={{
        position: 'fixed',
        bottom: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        width: '100%',
        maxWidth: '480px',
        height: '56px',
        background: '#0d111a',
        borderTop: '1px solid #1a2233',
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'center',
        zIndex: 100
      }}>
        <div onClick={() => setActiveTab('chain')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', color: activeTab === 'chain' ? '#38bdf8' : '#707886' }}>
          <span style={{ fontSize: '16px' }}>📊</span>
          <span style={{ fontSize: '10px', fontWeight: activeTab === 'chain' ? 'bold' : 'normal' }}>Chain</span>
        </div>
        <div onClick={() => setActiveTab('strategy')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', color: activeTab === 'strategy' ? '#38bdf8' : '#707886' }}>
          <span style={{ fontSize: '16px' }}>📈</span>
          <span style={{ fontSize: '10px', fontWeight: activeTab === 'strategy' ? 'bold' : 'normal' }}>Strategy</span>
        </div>
        <div onClick={() => setActiveTab('positions')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', color: activeTab === 'positions' ? '#38bdf8' : '#707886' }}>
          <span style={{ fontSize: '16px' }}>💼</span>
          <span style={{ fontSize: '10px', fontWeight: activeTab === 'positions' ? 'bold' : 'normal' }}>Positions</span>
        </div>
        <div onClick={() => setActiveTab('accounts')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', color: activeTab === 'accounts' ? '#38bdf8' : '#707886' }}>
          <span style={{ fontSize: '16px' }}>👤</span>
          <span style={{ fontSize: '10px', fontWeight: activeTab === 'accounts' ? 'bold' : 'normal' }}>Accounts</span>
        </div>
      </nav>
    </div>
  );
}
