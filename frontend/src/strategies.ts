export interface OptionLeg {
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

export const CATEGORIZED_STRATEGIES = {
    'Bullish': [
        'Long Call', 'Bull Call Spread', 'Bull Put Spread', 'Bullish Condor', 'Covered Call', 'Cash-Secured Put'
    ],
    'Bearish': [
        'Long Put', 'Bear Put Spread', 'Bear Call Spread', 'Bearish Condor', 'Short Call'
    ],
    'Neutral': [
        'Iron Condor', 'Iron Butterfly', 'Long Butterfly Spread', 'Short Straddle', 'Short Strangle'
    ],
    'Volatility': [
        'Long Straddle', 'Long Strangle', 'Long Call Ratio Spread', 'Backspread'
    ]
};

// Helper to find a strike by offset from ATM (index-based)
const getStrikeRow = (chain: any[], atmIndex: number, offset: number) => {
    const index = atmIndex + offset;
    if (index >= 0 && index < chain.length) {
        return chain[index];
    }
    // Fallback to boundaries if offset is too large
    if (index < 0) return chain[0];
    return chain[chain.length - 1];
};

const createLeg = (row: any, type: 'CALL' | 'PUT', side: 'BUY' | 'SELL', size: number, activeAsset: string, activeExpiry: string): OptionLeg => {
    const symbol = type === 'CALL' ? row.callSym : row.putSym;
    const price = type === 'CALL' ? (side === 'BUY' ? row.callAsk : row.callBid) : (side === 'BUY' ? row.putAsk : row.putBid);
    return {
        symbol,
        underlying: activeAsset,
        strike: row.strike,
        expiry: activeExpiry,
        option_type: type,
        side,
        size,
        price: price || (type === 'CALL' ? row.callMark : row.putMark) || 0
    };
};

export const buildStrategyBasket = (
    strategyName: string, 
    chain: any[], 
    atmStrike: number, 
    activeAsset: string, 
    activeExpiry: string, 
    baseSize: number,
    targetPrice?: number,
    supportPrice?: number,
    resistancePrice?: number,
    expiries?: string[]
): OptionLeg[] => {
    if (!chain || chain.length === 0 || !atmStrike) return [];

    // Sort chain by strike ascending just in case
    const sortedChain = [...chain].sort((a, b) => a.strike - b.strike);
    const atmIndex = sortedChain.findIndex(r => r.strike === atmStrike);
    if (atmIndex === -1) return [];

    const strikeStep = sortedChain.length > 1 ? Math.abs(sortedChain[1].strike - sortedChain[0].strike) : 50;

    // Helper to find closest strike row to a target value
    const getClosestRow = (target: number) => {
        let minDiff = Infinity;
        let bestRow = sortedChain[atmIndex];
        sortedChain.forEach(r => {
            const d = Math.abs(r.strike - target);
            if (d < minDiff) {
                minDiff = d;
                bestRow = r;
            }
        });
        return bestRow;
    };

    const basket: OptionLeg[] = [];

    // Bullish
    if (strategyName === 'Long Call') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Bull Call Spread') {
        const longRow = getStrikeRow(sortedChain, atmIndex, 0);
        const shortRow = targetPrice ? getClosestRow(targetPrice) : getStrikeRow(sortedChain, atmIndex, 2);
        basket.push(createLeg(longRow, 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(shortRow, 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Bull Put Spread') {
        const shortRow = supportPrice ? getClosestRow(supportPrice) : getStrikeRow(sortedChain, atmIndex, 0);
        const longRow = supportPrice ? getClosestRow(supportPrice - strikeStep * 2) : getStrikeRow(sortedChain, atmIndex, -2);
        basket.push(createLeg(shortRow, 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(longRow, 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Bullish Condor' || strategyName === 'Bearish Condor') {
        const shortPutRow = supportPrice ? getClosestRow(supportPrice) : getStrikeRow(sortedChain, atmIndex, -1);
        const longPutRow = supportPrice ? getClosestRow(supportPrice - strikeStep * 2) : getStrikeRow(sortedChain, atmIndex, -3);
        const shortCallRow = resistancePrice ? getClosestRow(resistancePrice) : getStrikeRow(sortedChain, atmIndex, 1);
        const longCallRow = resistancePrice ? getClosestRow(resistancePrice + strikeStep * 2) : getStrikeRow(sortedChain, atmIndex, 3);
        
        basket.push(createLeg(shortPutRow, 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(longPutRow, 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(shortCallRow, 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(longCallRow, 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Covered Call') {
        const shortRow = targetPrice ? getClosestRow(targetPrice) : getStrikeRow(sortedChain, atmIndex, 1);
        basket.push(createLeg(shortRow, 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Cash-Secured Put') {
        const shortRow = supportPrice ? getClosestRow(supportPrice) : getStrikeRow(sortedChain, atmIndex, -1);
        basket.push(createLeg(shortRow, 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
    }

    // Bearish
    else if (strategyName === 'Long Put') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Bear Put Spread') {
        const longRow = getStrikeRow(sortedChain, atmIndex, 0);
        const shortRow = targetPrice ? getClosestRow(targetPrice) : getStrikeRow(sortedChain, atmIndex, -2);
        basket.push(createLeg(longRow, 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(shortRow, 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Bear Call Spread') {
        const shortRow = resistancePrice ? getClosestRow(resistancePrice) : getStrikeRow(sortedChain, atmIndex, 0);
        const longRow = resistancePrice ? getClosestRow(resistancePrice + strikeStep * 2) : getStrikeRow(sortedChain, atmIndex, 2);
        basket.push(createLeg(shortRow, 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(longRow, 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Short Call') {
        const shortRow = resistancePrice ? getClosestRow(resistancePrice) : getStrikeRow(sortedChain, atmIndex, 1);
        basket.push(createLeg(shortRow, 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
    }

    // Neutral
    else if (strategyName === 'Iron Condor') {
        const shortPutRow = supportPrice ? getClosestRow(supportPrice) : getStrikeRow(sortedChain, atmIndex, -1);
        const longPutRow = supportPrice ? getClosestRow(supportPrice - strikeStep * 2) : getStrikeRow(sortedChain, atmIndex, -2);
        const shortCallRow = resistancePrice ? getClosestRow(resistancePrice) : getStrikeRow(sortedChain, atmIndex, 1);
        const longCallRow = resistancePrice ? getClosestRow(resistancePrice + strikeStep * 2) : getStrikeRow(sortedChain, atmIndex, 2);
        
        basket.push(createLeg(shortPutRow, 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(longPutRow, 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(shortCallRow, 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(longCallRow, 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Iron Butterfly') {
        const centerRow = getStrikeRow(sortedChain, atmIndex, 0);
        const longPutRow = getStrikeRow(sortedChain, atmIndex, -4);
        const longCallRow = getStrikeRow(sortedChain, atmIndex, 4);
        
        basket.push(createLeg(centerRow, 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(centerRow, 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(longCallRow, 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(longPutRow, 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Long Butterfly Spread') {
        const centerRow = getStrikeRow(sortedChain, atmIndex, 0);
        const wingLeft = getStrikeRow(sortedChain, atmIndex, -2);
        const wingRight = getStrikeRow(sortedChain, atmIndex, 2);
        
        basket.push(createLeg(wingLeft, 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(centerRow, 'CALL', 'SELL', baseSize * 2, activeAsset, activeExpiry));
        basket.push(createLeg(wingRight, 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Short Straddle') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Short Strangle') {
        const shortPutRow = supportPrice ? getClosestRow(supportPrice) : getStrikeRow(sortedChain, atmIndex, -2);
        const shortCallRow = resistancePrice ? getClosestRow(resistancePrice) : getStrikeRow(sortedChain, atmIndex, 2);
        
        basket.push(createLeg(shortCallRow, 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(shortPutRow, 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
    }

    // Volatility
    else if (strategyName === 'Long Straddle') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Long Strangle') {
        const longPutRow = supportPrice ? getClosestRow(supportPrice) : getStrikeRow(sortedChain, atmIndex, -2);
        const longCallRow = resistancePrice ? getClosestRow(resistancePrice) : getStrikeRow(sortedChain, atmIndex, 2);
        
        basket.push(createLeg(longCallRow, 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(longPutRow, 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Long Call Ratio Spread') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 2), 'CALL', 'SELL', baseSize * 2, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Backspread') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 2), 'CALL', 'BUY', baseSize * 2, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Calendar') {
        const farExpiry = (expiries && expiries.length > 1) ? expiries[1] : activeExpiry;
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'BUY', baseSize, activeAsset, farExpiry));
    }
    else if (strategyName === 'Diagonal') {
        const farExpiry = (expiries && expiries.length > 1) ? expiries[1] : activeExpiry;
        const shortRow = targetPrice ? getClosestRow(targetPrice) : getStrikeRow(sortedChain, atmIndex, 2);
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'BUY', baseSize, activeAsset, farExpiry));
        basket.push(createLeg(shortRow, 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Protective Put') {
        const longRow = supportPrice ? getClosestRow(supportPrice) : getStrikeRow(sortedChain, atmIndex, -2);
        basket.push(createLeg(longRow, 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Synthetic Long') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Synthetic Short') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Short Call') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 1), 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
    }

    // Neutral
    else if (strategyName === 'Iron Condor') {
        // Sell OTM Put, Buy further OTM Put
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, -1), 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, -2), 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
        // Sell OTM Call, Buy further OTM Call
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 1), 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 2), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Iron Butterfly') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 1), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, -1), 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Long Butterfly Spread') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, -1), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'SELL', baseSize * 2, activeAsset, activeExpiry)); // Sell 2
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 1), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Short Straddle') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Short Strangle') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 1), 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, -1), 'PUT', 'SELL', baseSize, activeAsset, activeExpiry));
    }

    // Volatility
    else if (strategyName === 'Long Straddle') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Long Strangle') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 1), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, -1), 'PUT', 'BUY', baseSize, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Long Call Ratio Spread') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'BUY', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 1), 'CALL', 'SELL', baseSize * 2, activeAsset, activeExpiry));
    }
    else if (strategyName === 'Backspread') {
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 0), 'CALL', 'SELL', baseSize, activeAsset, activeExpiry));
        basket.push(createLeg(getStrikeRow(sortedChain, atmIndex, 1), 'CALL', 'BUY', baseSize * 2, activeAsset, activeExpiry));
    }

    return basket;
};


export interface StrategyMetrics {
    maxProfit: number | 'Unlimited';
    maxLoss: number | 'Unlimited';
    breakevens: number[];
    netPremium: number;
}

export const calculatePayoff = (basket: OptionLeg[], underlyingPrice: number): number => {
    let totalPnl = 0;
    for (const leg of basket) {
        let intrinsicValue = 0;
        if (leg.option_type === 'CALL') {
            intrinsicValue = Math.max(0, underlyingPrice - leg.strike);
        } else {
            intrinsicValue = Math.max(0, leg.strike - underlyingPrice);
        }
        
        let legPnl = 0;
        if (leg.side === 'BUY') {
            legPnl = (intrinsicValue - leg.price) * leg.size;
        } else {
            legPnl = (leg.price - intrinsicValue) * leg.size;
        }
        totalPnl += legPnl;
    }
    return totalPnl;
};

export const generatePayoffData = (basket: OptionLeg[], spotPrice: number) => {
    if (basket.length === 0) return [];
    
    // Determine the range based on strikes
    const strikes = basket.map(b => b.strike);
    const minStrike = Math.min(...strikes, spotPrice * 0.9);
    const maxStrike = Math.max(...strikes, spotPrice * 1.1);
    
    const rangeMin = minStrike * 0.95;
    const rangeMax = maxStrike * 1.05;
    const step = (rangeMax - rangeMin) / 100;
    
    const data = [];
    for (let price = rangeMin; price <= rangeMax; price += step) {
        data.push({
            price: Math.round(price),
            pnl: Math.round(calculatePayoff(basket, price) * 100) / 100
        });
    }
    return data;
};

export const calculateStrategyMetrics = (basket: OptionLeg[]): StrategyMetrics => {
    if (basket.length === 0) {
        return { maxProfit: 0, maxLoss: 0, breakevens: [], netPremium: 0 };
    }

    let netPremium = 0;
    basket.forEach(leg => {
        if (leg.side === 'BUY') netPremium -= leg.price * leg.size;
        if (leg.side === 'SELL') netPremium += leg.price * leg.size;
    });

    const strikes = basket.map(b => b.strike);
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    
    const testPoints = [
        minStrike * 0.5,
        ...strikes,
        maxStrike * 1.5
    ];
    
    let maxP = -Infinity;
    let maxL = Infinity;
    
    for (let i = 0; i < testPoints.length; i++) {
        const p = testPoints[i];
        const pnl = calculatePayoff(basket, p);
        if (pnl > maxP) maxP = pnl;
        if (pnl < maxL) maxL = pnl;
    }

    // Determine unlimited
    const pnlWayDown = calculatePayoff(basket, 0);
    const pnlWayUp = calculatePayoff(basket, maxStrike * 2);
    
    let maxProfit: number | 'Unlimited' = maxP;
    let maxLoss: number | 'Unlimited' = maxL;
    
    if (pnlWayDown > maxP + 0.1 || pnlWayUp > maxP + 0.1) maxProfit = 'Unlimited';
    if (pnlWayDown < maxL - 0.1 || pnlWayUp < maxL - 0.1) maxLoss = 'Unlimited';

    // Simple breakeven finder (linear interpolation between data points)
    const data = generatePayoffData(basket, strikes[0]);
    const breakevens: number[] = [];
    for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1];
        const curr = data[i];
        if ((prev.pnl < 0 && curr.pnl > 0) || (prev.pnl > 0 && curr.pnl < 0)) {
            // Linear interpolation
            const ratio = Math.abs(prev.pnl) / (Math.abs(prev.pnl) + Math.abs(curr.pnl));
            const be = prev.price + ratio * (curr.price - prev.price);
            breakevens.push(Math.round(be * 100) / 100);
        } else if (prev.pnl === 0 && !breakevens.includes(prev.price)) {
            breakevens.push(prev.price);
        }
    }

    return {
        maxProfit: maxProfit === 'Unlimited' ? 'Unlimited' : Math.round(maxProfit as number * 100) / 100,
        maxLoss: maxLoss === 'Unlimited' ? 'Unlimited' : Math.round(maxLoss as number * 100) / 100,
        breakevens: Array.from(new Set(breakevens)).sort((a,b) => a - b),
        netPremium: Math.round(netPremium * 100) / 100
    };
};
