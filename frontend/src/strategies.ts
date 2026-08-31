export interface OptionLeg {
    symbol: string;
    underlying: string;
    strike: number;
    expiry: string;
    option_type: 'CALL' | 'PUT';
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    entry_price?: number;
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

export interface StrategyTemplate {
  name: string;
  view: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'VOLATILE';
  desc: string;
  risk: 'Defined' | 'Unlimited';
  reward: 'Defined' | 'Unlimited';
}

export const READY_STRATEGIES: StrategyTemplate[] = [
  { name: 'Buy Call', view: 'BULLISH', desc: 'Buy ATM Call. Strong upward move expected with defined risk.', risk: 'Defined', reward: 'Unlimited' },
  { name: 'Bull Call Spread', view: 'BULLISH', desc: 'Buy ATM CE + Sell OTM CE. Moderate upward move with reduced cost.', risk: 'Defined', reward: 'Defined' },
  { name: 'Bull Put Spread', view: 'BULLISH', desc: 'Sell ATM PE + Buy OTM PE. Moderately bullish credit spread.', risk: 'Defined', reward: 'Defined' },
  { name: 'Call Ratio Spread', view: 'BULLISH', desc: 'Buy 1 ATM CE + Sell 2 OTM CE. Range-bound bullish move.', risk: 'Unlimited', reward: 'Defined' },
  { name: 'Bullish Condor', view: 'BULLISH', desc: '4-leg spread: buy OTM wings and sell ATM body, shifted bullishly.', risk: 'Defined', reward: 'Defined' },

  { name: 'Buy Put', view: 'BEARISH', desc: 'Buy ATM Put. Strong downward move expected.', risk: 'Defined', reward: 'Unlimited' },
  { name: 'Bear Put Spread', view: 'BEARISH', desc: 'Buy ATM PE + Sell OTM PE. Moderate downward move with lower cost.', risk: 'Defined', reward: 'Defined' },
  { name: 'Bear Call Spread', view: 'BEARISH', desc: 'Sell ATM CE + Buy OTM CE. Moderately bearish credit spread.', risk: 'Defined', reward: 'Defined' },
  { name: 'Put Ratio Spread', view: 'BEARISH', desc: 'Buy 1 ATM PE + Sell 2 OTM PE. Range-bound bearish move.', risk: 'Unlimited', reward: 'Defined' },
  { name: 'Bearish Condor', view: 'BEARISH', desc: '4-leg spread: buy OTM wings and sell ATM body, shifted bearishly.', risk: 'Defined', reward: 'Defined' },

  { name: 'Short Straddle', view: 'NEUTRAL', desc: 'Sell ATM CE + Sell ATM PE. Range-bound market with no big move.', risk: 'Unlimited', reward: 'Defined' },
  { name: 'Short Strangle', view: 'NEUTRAL', desc: 'Sell OTM CE + Sell OTM PE. Wide range-bound market.', risk: 'Unlimited', reward: 'Defined' },
  { name: 'Long Call Butterfly', view: 'NEUTRAL', desc: 'Buy 1 ITM CE + Sell 2 ATM CE + Buy 1 OTM CE. Defined risk range play.', risk: 'Defined', reward: 'Defined' },
  { name: 'Short Iron Condor', view: 'NEUTRAL', desc: '4-leg credit spread. Profit if index stays inside range.', risk: 'Defined', reward: 'Defined' },

  { name: 'Long Straddle', view: 'VOLATILE', desc: 'Buy ATM CE + Buy ATM PE. Big move in either direction.', risk: 'Defined', reward: 'Unlimited' },
  { name: 'Long Strangle', view: 'VOLATILE', desc: 'Buy OTM CE + Buy OTM PE. Low-cost explosive breakout move.', risk: 'Defined', reward: 'Unlimited' },
  { name: 'Long Iron Butterfly', view: 'VOLATILE', desc: 'Defined-risk 4-leg breakout structure away from ATM.', risk: 'Defined', reward: 'Defined' },
  { name: 'Long Iron Condor', view: 'VOLATILE', desc: 'Defined-risk 4-leg range breakout strategy.', risk: 'Defined', reward: 'Defined' }
];

export const STRATEGY_GLOSSARY: Record<string, { view: string; purpose: string; strike: string; usage: string }> = {
  'Buy Call': { view: 'Strongly Bullish 📈', purpose: 'Unlimited upside with strictly defined risk.', strike: 'ATM (balanced choice), ITM (higher premium/safer), or OTM (cheaper/needs stronger move).', usage: 'Simply buy a Call option contract. Volatility rise helps the option value.' },
  'Bull Call Spread': { view: 'Moderately Bullish 📈', purpose: 'Reduce option buying costs while capping max risk and return.', strike: 'Buy ATM/slightly ITM Call + Sell OTM Call (target price).', usage: 'Buy lower strike Call + Sell higher strike Call. Reduces premium decay drag.' },
  'Bull Put Spread': { view: 'Moderately Bullish 📈', purpose: 'Collect upfront credit/income if asset stays above strike.', strike: 'Sell ATM Put + Buy OTM Put (protection).', usage: 'Sell higher strike Put + Buy lower strike Put. Generates positive theta decay.' },
  'Call Ratio Spread': { view: 'Slightly Bullish / Neutral 📈', purpose: 'Profit from a target price while paying very low or zero net premium.', strike: 'Buy 1 ATM Call + Sell 2 OTM Calls.', usage: 'Buy 1 CE at lower strike + Sell 2 CE at higher strike. Risk is unlimited if price explodes.' },
  'Bullish Condor': { view: 'Moderately Bullish 📈', purpose: 'Range-bound play with bullish bias and capped maximum loss.', strike: 'Buy far OTM Put, Sell slightly ITM Put, Sell slightly OTM Call, Buy far OTM Call.', usage: '4-leg structure designed to profit if asset stays near the bullish target range.' },
  'Buy Put': { view: 'Strongly Bearish 📉', purpose: 'Profit from rapid downward movements with limited risk.', strike: 'ATM (balanced), ITM (conservative), or OTM (aggressive/speculative).', usage: 'Simply buy a Put option contract. Volatility expansion benefits the value.' },
  'Bear Put Spread': { view: 'Moderately Bearish 📉', purpose: 'Cheaper way to play a bearish move by selling a lower strike Put.', strike: 'Buy ATM Put + Sell OTM Put.', usage: 'Buy higher strike Put + Sell lower strike Put. Less theta decay drag than outright Buy Put.' },
  'Bear Call Spread': { view: 'Moderately Bearish 📉', purpose: 'Collect credit/premium income expecting price to stay below strike.', strike: 'Sell ATM Call + Buy OTM Call (protection).', usage: 'Sell lower strike Call + Buy higher strike Call. Benefits from theta decay.' },
  'Put Ratio Spread': { view: 'Slightly Bearish / Neutral 📉', purpose: 'Profit from target low while paying very low or zero net premium.', strike: 'Buy 1 ATM Put + Sell 2 OTM Puts.', usage: 'Buy 1 PE at higher strike + Sell 2 PE at lower strike. Risk is unlimited if price drops to zero.' },
  'Bearish Condor': { view: 'Moderately Bearish 📉', purpose: 'Range-bound play with bearish bias and capped maximum loss.', strike: 'Buy far OTM Put, Sell slightly OTM Put, Sell slightly ITM Call, Buy far OTM Call.', usage: '4-leg structure designed to profit if asset stays near the bearish target range.' },
  'Short Straddle': { view: 'Neutral ↔', purpose: 'Collect high premium expecting zero market movement.', strike: 'Sell ATM Call + Sell ATM Put.', usage: 'Sell ATM CE and PE. Maximum risk is unlimited in both directions. Highest theta collection.' },
  'Short Strangle': { view: 'Neutral / Range-Bound ↔', purpose: 'Wide range profit with high probability of success.', strike: 'Sell OTM Call + Sell OTM Put.', usage: 'Sell OTM CE and PE. Risk is unlimited in both directions but price has room to breathe.' },
  'Long Call Butterfly': { view: 'Neutral / Pinning ↔', purpose: 'Extremely high ROI if asset finishes exactly at ATM strike.', strike: 'Buy 1 ITM Call + Sell 2 ATM Calls + Buy 1 OTM Call.', usage: 'Highly defined risk target play. Benefits from decay on sold ATM body.' },
  'Short Iron Condor': { view: 'Neutral / Range-Bound ↔', purpose: 'Collect premium safely with defined, limited risk.', strike: 'Buy OTM Put + Sell slightly OTM Put + Sell slightly OTM Call + Buy OTM Call.', usage: 'Sell ATM body + Buy OTM wings. Safest income strategy with capped maximum loss.' },
  'Long Straddle': { view: 'High Volatility', purpose: 'Profit from massive explosive breakout in either direction.', strike: 'Buy ATM Call + Buy ATM Put.', usage: 'Buy ATM CE and PE. Profits if price moves significantly higher or lower. Loses on theta decay.' },
  'Long Strangle': { view: 'High Volatility', purpose: 'Low-cost speculative play on an expected huge breakout.', strike: 'Buy OTM Call + Buy OTM Put.', usage: 'Buy OTM CE and PE. Cheaper entry cost than Straddle, but requires a much stronger price move.' },
  'Long Iron Butterfly': { view: 'High Volatility', purpose: 'Defined-risk breakout structure profit on big moves.', strike: 'Buy 1 ATM Put, Sell 1 OTM Put, Sell 1 OTM Call, Buy 1 ATM Call.', usage: 'Defined-risk volatility play. Profits when price moves outside the middle range.' },
  'Long Iron Condor': { view: 'High Volatility', purpose: 'Defined-risk play on range breakdown.', strike: 'Buy OTM Put + Sell slightly OTM Put + Sell slightly OTM Call + Buy OTM Call.', usage: 'Designed to profit if asset breaks out of range with capped maximum loss.' },
  'Short Call': { view: 'Strongly Bearish 📉', purpose: 'Collect premium income expecting price to stay below strike.', strike: 'ATM (highest theta collection) or OTM (safer buffer).', usage: 'Sell a Call option contract. Maximum profit is capped, risk is unlimited.' },
  'Short Put': { view: 'Strongly Bullish 📈', purpose: 'Collect premium income expecting price to stay above strike.', strike: 'ATM (highest theta collection) or OTM (safer buffer).', usage: 'Sell a Put option contract. Maximum profit is capped, risk is unlimited.' },
  'Custom Strategy': { view: 'Varies (depends on leg combination) 🎭', purpose: 'Tailored payoff profile for specific market situations.', strike: 'Selected manually depending on trader view.', usage: 'Multi-leg custom trade. Review the Payoff Chart & Greeks to evaluate risk/reward.' }
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
