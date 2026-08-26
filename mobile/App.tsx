import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Image,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  Modal,
  StatusBar,
  Dimensions,
  Platform,
  ActivityIndicator,
  BackHandler,
  PanResponder,
  Animated,
  TextInput,
  Alert,
  FlatList
} from 'react-native';
import Svg, { Path, Line as SvgLine, Text as SvgText, Circle, Rect, G, Defs, ClipPath, LinearGradient, Stop } from 'react-native-svg';
import Constants from 'expo-constants';
import { usePriceFeed } from './src/lib/priceFeed';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const getBackendUrl = () => {
  // 1. Explicit env var override (highest priority)
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '');
  }
  // 2. Expo Go dev mode - auto-detect host IP from dev server
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(':')[0];
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return `http://${host}:8000`;
    }
  }
  // 3. Standalone APK/Production build - default to Render cloud backend
  return 'https://broast.onrender.com';
};

const BACKEND_URL = getBackendUrl();

const getDteLabel = (expiryDateStr: string | null) => {
  if (!expiryDateStr) return '0 DTE';
  const expiryDate = new Date(expiryDateStr);
  const now = new Date();

  // Set both dates to midnight for true calendar day difference
  const expZero = new Date(expiryDate.getFullYear(), expiryDate.getMonth(), expiryDate.getDate()).getTime();
  const nowZero = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round((expZero - nowZero) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return '0 DTE (Today)';
  if (diffDays === 1) return '1 DTE (Tomorrow)';
  return `${diffDays} DTE`;
};

const calculateTimeToExpiry = (expiryDateStr: string | null, isCrypto: boolean = false) => {
  if (!expiryDateStr) return isCrypto ? '00h:00m' : '0 DTE (Today)';
  const expiryDate = new Date(expiryDateStr);
  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();

  if (!isCrypto) {
    return getDteLabel(expiryDateStr);
  }

  // Delta Exchange Crypto countdown timer format (e.g. 2d 14h or 14h 32m)
  if (diffMs <= 0) return '00h:00m';
  const diffMins = Math.floor(diffMs / 60000);
  const days = Math.floor(diffMins / (24 * 60));
  const hours = Math.floor((diffMins % (24 * 60)) / 60);
  const mins = diffMins % 60;
  const pad = (num: number) => String(num).padStart(2, '0');

  if (days > 0) {
    return `${days}d ${pad(hours)}h`;
  }
  return `${pad(hours)}h ${pad(mins)}m`;
};

const getRealisticOptionPchange = (
  isCall: boolean,
  strike: number,
  spot: number,
  spotPct: number,
  ltp: number,
  feedPchange: number
) => {
  if (feedPchange !== 0) {
    return feedPchange;
  }
  if (!spot || spotPct === 0) return 0;

  const distancePct = (strike - spot) / spot;
  let delta = 0.5;

  if (isCall) {
    delta = 1 / (1 + Math.exp(distancePct * 15));
  } else {
    delta = -1 / (1 + Math.exp(-distancePct * 15));
  }

  const spotChangeVal = spot * (spotPct / 100);
  const optChangeVal = delta * spotChangeVal;

  if (ltp <= 0.05) {
    return spotPct > 0 ? (isCall ? 99.9 : -99.9) : (isCall ? -99.9 : 99.9);
  }

  const calculatedPct = (optChangeVal / ltp) * 100;
  return Math.max(-99.9, Math.min(999.9, calculatedPct));
};

interface OptionLeg {
  symbol: string;
  underlying: string;
  strike: number;
  expiry: string;
  option_type: 'CALL' | 'PUT';
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  iv?: number;
  token?: string;
  stoploss?: number;
  target?: number;
  stoploss_type?: 'PRICE' | 'PERCENT';
  target_type?: 'PRICE' | 'PERCENT';
  product_type?: 'NRML' | 'MIS';
  order_mode?: 'REGULAR' | 'AMO';
  order_type?: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  trigger_price?: number;
}

interface Account {
  id: number;
  name: string;
  margin_type: 'Cross' | 'Isolated';
  balance: number;
  currency: 'INR' | 'USD';
  market: 'CRYPTO' | 'INDIAN' | 'STOCKS' | 'COMMODITY';
}

const ASSET_CONFIG: Record<string, { currency: 'INR' | 'USD'; lotSize: number; lotUnit: string; symbol: string; name: string; tag: string; category: 'INDIAN' | 'STOCKS' | 'CRYPTO' | 'COMMODITY'; strikeStep: number; defaultSpot: number; exchange: string; settlementCurrency?: string }> = {
  // Benchmark Indices
  'NIFTY': { currency: 'INR', lotSize: 65, lotUnit: 'units', symbol: '₹', name: 'NIFTY 50 Index', tag: 'NSE India', category: 'INDIAN', strikeStep: 50, defaultSpot: 24234.55, exchange: 'NSE' },
  'BANKNIFTY': { currency: 'INR', lotSize: 30, lotUnit: 'units', symbol: '₹', name: 'BANK NIFTY Index', tag: 'NSE India', category: 'INDIAN', strikeStep: 100, defaultSpot: 57655.50, exchange: 'NSE' },
  'SENSEX': { currency: 'INR', lotSize: 20, lotUnit: 'units', symbol: '₹', name: 'BSE SENSEX Index', tag: 'BSE India', category: 'INDIAN', strikeStep: 100, defaultSpot: 77315.44, exchange: 'BSE' },
  
  // NSE Stock Options (F&O Heavyweights)
  'RELIANCE': { currency: 'INR', lotSize: 250, lotUnit: 'shares', symbol: '₹', name: 'Reliance Industries Ltd', tag: 'NSE F&O', category: 'STOCKS', strikeStep: 20, defaultSpot: 1305.00, exchange: 'NSE' },
  'TCS': { currency: 'INR', lotSize: 175, lotUnit: 'shares', symbol: '₹', name: 'Tata Consultancy Services', tag: 'NSE F&O', category: 'STOCKS', strikeStep: 50, defaultSpot: 2295.40, exchange: 'NSE' },
  'INFY': { currency: 'INR', lotSize: 400, lotUnit: 'shares', symbol: '₹', name: 'Infosys Ltd', tag: 'NSE F&O', category: 'STOCKS', strikeStep: 20, defaultSpot: 1137.20, exchange: 'NSE' },
  'HDFCBANK': { currency: 'INR', lotSize: 550, lotUnit: 'shares', symbol: '₹', name: 'HDFC Bank Ltd', tag: 'NSE F&O', category: 'STOCKS', strikeStep: 20, defaultSpot: 1642.50, exchange: 'NSE' },
  'ICICIBANK': { currency: 'INR', lotSize: 700, lotUnit: 'shares', symbol: '₹', name: 'ICICI Bank Ltd', tag: 'NSE F&O', category: 'STOCKS', strikeStep: 20, defaultSpot: 1215.10, exchange: 'NSE' },
  'SBIN': { currency: 'INR', lotSize: 750, lotUnit: 'shares', symbol: '₹', name: 'State Bank of India', tag: 'NSE F&O', category: 'STOCKS', strikeStep: 10, defaultSpot: 815.00, exchange: 'NSE' },
  'TATAMOTORS': { currency: 'INR', lotSize: 575, lotUnit: 'shares', symbol: '₹', name: 'Tata Motors Ltd', tag: 'NSE F&O', category: 'STOCKS', strikeStep: 20, defaultSpot: 985.00, exchange: 'NSE' },
  'BHARTIARTL': { currency: 'INR', lotSize: 475, lotUnit: 'shares', symbol: '₹', name: 'Bharti Airtel Ltd', tag: 'NSE F&O', category: 'STOCKS', strikeStep: 20, defaultSpot: 1450.00, exchange: 'NSE' },
  'ITC': { currency: 'INR', lotSize: 1600, lotUnit: 'shares', symbol: '₹', name: 'ITC Ltd', tag: 'NSE F&O', category: 'STOCKS', strikeStep: 5, defaultSpot: 490.00, exchange: 'NSE' },
  'LT': { currency: 'INR', lotSize: 150, lotUnit: 'shares', symbol: '₹', name: 'Larsen & Toubro Ltd', tag: 'NSE F&O', category: 'STOCKS', strikeStep: 50, defaultSpot: 3600.00, exchange: 'NSE' },

  // MCX Commodities
  'CRUDEOIL': { currency: 'INR', lotSize: 100, lotUnit: 'bbl', symbol: '₹', name: 'Crude Oil', tag: 'MCX', category: 'COMMODITY', strikeStep: 50, defaultSpot: 8315.0, exchange: 'MCX' },
  'GOLD': { currency: 'INR', lotSize: 100, lotUnit: 'grams', symbol: '₹', name: 'Gold', tag: 'MCX', category: 'COMMODITY', strikeStep: 100, defaultSpot: 161690.0, exchange: 'MCX' },
  'SILVER': { currency: 'INR', lotSize: 30, lotUnit: 'kg', symbol: '₹', name: 'Silver', tag: 'MCX', category: 'COMMODITY', strikeStep: 500, defaultSpot: 246274.0, exchange: 'MCX' },
  
  // Crypto Derivatives
  'BTC': { currency: 'USD', lotSize: 0.001, lotUnit: 'BTC', symbol: '$', name: 'Bitcoin Options', tag: 'Delta Exchange', category: 'CRYPTO', strikeStep: 1000, defaultSpot: 60000.0, exchange: 'DELTA', settlementCurrency: 'INR' },
  'ETH': { currency: 'USD', lotSize: 0.01, lotUnit: 'ETH', symbol: '$', name: 'Ethereum Options', tag: 'Delta Exchange', category: 'CRYPTO', strikeStep: 50, defaultSpot: 2500.0, exchange: 'DELTA', settlementCurrency: 'INR' },
  'XAUT': { currency: 'USD', lotSize: 1, lotUnit: 'oz', symbol: '$', name: 'Gold Options', tag: 'Delta Exchange', category: 'CRYPTO', strikeStep: 20, defaultSpot: 2500.0, exchange: 'DELTA', settlementCurrency: 'USD' }
};

interface StrategyTemplate {
  name: string;
  view: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'VOLATILE';
  desc: string;
  risk: 'Defined' | 'Unlimited';
  reward: 'Defined' | 'Unlimited';
}

const READY_STRATEGIES: StrategyTemplate[] = [
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

const STRATEGY_GLOSSARY: Record<string, { view: string; purpose: string; strike: string; usage: string }> = {
  'Buy Call': {
    view: 'Strongly Bullish 📈',
    purpose: 'Unlimited upside with strictly defined risk.',
    strike: 'ATM (balanced choice), ITM (higher premium/safer), or OTM (cheaper/needs stronger move).',
    usage: 'Simply buy a Call option contract. Volatility rise helps the option value.'
  },
  'Bull Call Spread': {
    view: 'Moderately Bullish 📈',
    purpose: 'Reduce option buying costs while capping max risk and return.',
    strike: 'Buy ATM/slightly ITM Call + Sell OTM Call (target price).',
    usage: 'Buy lower strike Call + Sell higher strike Call. Reduces premium decay drag.'
  },
  'Bull Put Spread': {
    view: 'Moderately Bullish 📈',
    purpose: 'Collect upfront credit/income if asset stays above strike.',
    strike: 'Sell ATM Put + Buy OTM Put (protection).',
    usage: 'Sell higher strike Put + Buy lower strike Put. Generates positive theta decay.'
  },
  'Call Ratio Spread': {
    view: 'Slightly Bullish / Neutral 📈',
    purpose: 'Profit from a target price while paying very low or zero net premium.',
    strike: 'Buy 1 ATM Call + Sell 2 OTM Calls.',
    usage: 'Buy 1 CE at lower strike + Sell 2 CE at higher strike. Risk is unlimited if price explodes.'
  },
  'Bullish Condor': {
    view: 'Moderately Bullish 📈',
    purpose: 'Range-bound play with bullish bias and capped maximum loss.',
    strike: 'Buy far OTM Put, Sell slightly ITM Put, Sell slightly OTM Call, Buy far OTM Call.',
    usage: '4-leg structure designed to profit if asset stays near the bullish target range.'
  },
  'Buy Put': {
    view: 'Strongly Bearish 📉',
    purpose: 'Profit from rapid downward movements with limited risk.',
    strike: 'ATM (balanced), ITM (conservative), or OTM (aggressive/speculative).',
    usage: 'Simply buy a Put option contract. Volatility expansion benefits the value.'
  },
  'Bear Put Spread': {
    view: 'Moderately Bearish 📉',
    purpose: 'Cheaper way to play a bearish move by selling a lower strike Put.',
    strike: 'Buy ATM Put + Sell OTM Put.',
    usage: 'Buy higher strike Put + Sell lower strike Put. Less theta decay drag than outright Buy Put.'
  },
  'Bear Call Spread': {
    view: 'Moderately Bearish 📉',
    purpose: 'Collect credit/premium income expecting price to stay below strike.',
    strike: 'Sell ATM Call + Buy OTM Call (protection).',
    usage: 'Sell lower strike Call + Buy higher strike Call. Benefits from theta decay.'
  },
  'Put Ratio Spread': {
    view: 'Slightly Bearish / Neutral 📉',
    purpose: 'Profit from target low while paying very low or zero net premium.',
    strike: 'Buy 1 ATM Put + Sell 2 OTM Puts.',
    usage: 'Buy 1 PE at higher strike + Sell 2 PE at lower strike. Risk is unlimited if price drops to zero.'
  },
  'Bearish Condor': {
    view: 'Moderately Bearish 📉',
    purpose: 'Range-bound play with bearish bias and capped maximum loss.',
    strike: 'Buy far OTM Put, Sell slightly OTM Put, Sell slightly ITM Call, Buy far OTM Call.',
    usage: '4-leg structure designed to profit if asset stays near the bearish target range.'
  },
  'Short Straddle': {
    view: 'Neutral ↔',
    purpose: 'Collect high premium expecting zero market movement.',
    strike: 'Sell ATM Call + Sell ATM Put.',
    usage: 'Sell ATM CE and PE. Maximum risk is unlimited in both directions. Highest theta collection.'
  },
  'Short Strangle': {
    view: 'Neutral / Range-Bound ↔',
    purpose: 'Wide range profit with high probability of success.',
    strike: 'Sell OTM Call + Sell OTM Put.',
    usage: 'Sell OTM CE and PE. Risk is unlimited in both directions but price has room to breathe.'
  },
  'Long Call Butterfly': {
    view: 'Neutral / Pinning ↔',
    purpose: 'Extremely high ROI if asset finishes exactly at ATM strike.',
    strike: 'Buy 1 ITM Call + Sell 2 ATM Calls + Buy 1 OTM Call.',
    usage: 'Highly defined risk target play. Benefits from decay on sold ATM body.'
  },
  'Short Iron Condor': {
    view: 'Neutral / Range-Bound ↔',
    purpose: 'Collect premium safely with defined, limited risk.',
    strike: 'Buy OTM Put + Sell slightly OTM Put + Sell slightly OTM Call + Buy OTM Call.',
    usage: 'Sell ATM body + Buy OTM wings. Safest income strategy with capped maximum loss.'
  },
  'Long Straddle': {
    view: 'Highly Volatile ⚡',
    purpose: 'Profit from massive explosive breakout in either direction.',
    strike: 'Buy ATM Call + Buy ATM Put.',
    usage: 'Buy ATM CE and PE. Profits if price moves significantly higher or lower. Loses on theta decay.'
  },
  'Long Strangle': {
    view: 'Highly Volatile ⚡',
    purpose: 'Low-cost speculative play on an expected huge breakout.',
    strike: 'Buy OTM Call + Buy OTM Put.',
    usage: 'Buy OTM CE and PE. Cheaper entry cost than Straddle, but requires a much stronger price move.'
  },
  'Long Iron Butterfly': {
    view: 'Highly Volatile ⚡',
    purpose: 'Defined-risk breakout structure profit on big moves.',
    strike: 'Buy 1 ATM Put, Sell 1 OTM Put, Sell 1 OTM Call, Buy 1 ATM Call.',
    usage: 'Defined-risk volatility play. Profits when price moves outside the middle range.'
  },
  'Long Iron Condor': {
    view: 'Highly Volatile ⚡',
    purpose: 'Defined-risk play on range breakdown.',
    strike: 'Buy OTM Put + Sell slightly OTM Put + Sell slightly OTM Call + Buy OTM Call.',
    usage: 'Designed to profit if asset breaks out of range with capped maximum loss.'
  },
  'Short Call': {
    view: 'Strongly Bearish 📉',
    purpose: 'Collect premium income expecting price to stay below strike.',
    strike: 'ATM (highest theta collection) or OTM (safer buffer).',
    usage: 'Sell a Call option contract. Maximum profit is capped, risk is unlimited.'
  },
  'Short Put': {
    view: 'Strongly Bullish 📈',
    purpose: 'Collect premium income expecting price to stay above strike.',
    strike: 'ATM (highest theta collection) or OTM (safer buffer).',
    usage: 'Sell a Put option contract. Maximum profit is capped, risk is unlimited.'
  },
  'Custom Strategy': {
    view: 'Varies (depends on leg combination) 🎭',
    purpose: 'Tailored payoff profile for specific market situations.',
    strike: 'Selected manually depending on trader view.',
    usage: 'Multi-leg custom trade. Review the Payoff Chart & Greeks to evaluate risk/reward.'
  }
};

const formatOI = (val: number, selectedMarket: string | null) => {
  if (selectedMarket === 'CRYPTO') {
    if (val >= 1000000) return (val / 1000000).toFixed(2) + 'M';
    if (val >= 1000) return (val / 1000).toFixed(1) + 'k';
    return val.toFixed(0);
  }
  if (val >= 10000000) return (val / 10000000).toFixed(2) + 'Cr';
  if (val >= 100000) return (val / 100000).toFixed(2) + 'L';
  if (val >= 1000) return (val / 1000).toFixed(1) + 'k';
  return val.toString();
};

function cdf(x: number) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2.0);
  const t = 1.0 / (1.0 + p * absX);
  const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * erf);
}

function pdf(x: number) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function blackScholes(
  type: 'CALL' | 'PUT',
  s: number,
  k: number,
  t: number,
  r: number,
  v: number
) {
  if (t <= 0) {
    return type === 'CALL' ? Math.max(0, s - k) : Math.max(0, k - s);
  }
  const d1 = (Math.log(s / k) + (r + (v * v) / 2) * t) / (v * Math.sqrt(t));
  const d2 = d1 - v * Math.sqrt(t);
  if (type === 'CALL') {
    return s * cdf(d1) - k * Math.exp(-r * t) * cdf(d2);
  } else {
    return k * Math.exp(-r * t) * cdf(-d2) - s * cdf(-d1);
  }
}

function calculateDteDays(expiryStr?: string) {
  if (!expiryStr) return 4;
  const expDate = new Date(expiryStr);
  const diffMs = expDate.getTime() - Date.now();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return Math.max(0.01, diffDays);
}

function calculateBlackScholesGreeks(
  spot: number,
  strike: number,
  dteDays: number,
  price: number,
  type: 'CALL' | 'PUT',
  r = 0.065
) {
  const T = Math.max(dteDays / 365.0, 0.001);
  const sigma = 0.145;

  const d1 = (Math.log(spot / strike) + (r + (sigma * sigma) / 2.0) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  let delta = 0;
  if (type === 'CALL') {
    delta = cdf(d1);
  } else {
    delta = cdf(d1) - 1;
  }

  const gamma = pdf(d1) / (spot * sigma * Math.sqrt(T));
  const vega = (spot * Math.sqrt(T) * pdf(d1)) / 100.0;

  let theta = 0;
  if (type === 'CALL') {
    theta = (- (spot * pdf(d1) * sigma) / (2 * Math.sqrt(T)) - r * strike * Math.exp(-r * T) * cdf(d2)) / 365.0;
  } else {
    theta = (- (spot * pdf(d1) * sigma) / (2 * Math.sqrt(T)) + r * strike * Math.exp(-r * T) * cdf(-d2)) / 365.0;
  }

  const intrinsic = type === 'CALL' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const timeValue = Math.max(0, price - intrinsic);

  return {
    delta,
    gamma,
    theta,
    vega,
    iv: sigma * 100,
    intrinsic,
    timeValue
  };
}

const detectStrategy = (legs: OptionLeg[]) => {
  if (!legs || legs.length === 0) return null;
  if (legs.length === 1) {
    const l = legs[0];
    return `${l.side === 'BUY' ? 'Long' : 'Short'} ${l.option_type === 'CALL' ? 'Call' : 'Put'}`;
  }
  if (legs.length === 2) {
    const [l1, l2] = legs;
    if (l1.option_type === 'CALL' && l2.option_type === 'CALL') {
      if (l1.side !== l2.side) return l1.side === 'BUY' ? (l1.strike < l2.strike ? 'Bull Call Spread' : 'Bear Call Spread') : (l1.strike > l2.strike ? 'Bull Call Spread' : 'Bear Call Spread');
    }
    if (l1.option_type === 'PUT' && l2.option_type === 'PUT') {
      if (l1.side !== l2.side) return l1.side === 'BUY' ? (l1.strike > l2.strike ? 'Bear Put Spread' : 'Bull Put Spread') : (l1.strike < l2.strike ? 'Bear Put Spread' : 'Bull Put Spread');
    }
    if (l1.strike === l2.strike && l1.option_type !== l2.option_type) {
      if (l1.side === 'BUY' && l2.side === 'BUY') return 'Long Straddle';
      if (l1.side === 'SELL' && l2.side === 'SELL') return 'Short Straddle';
    }
    if (l1.strike !== l2.strike && l1.option_type !== l2.option_type) {
      if (l1.side === 'BUY' && l2.side === 'BUY') return 'Long Strangle';
      if (l1.side === 'SELL' && l2.side === 'SELL') return 'Short Strangle';
    }
  }
  if (legs.length === 3) {
    return 'Custom Strategy';
  }
  if (legs.length === 4) {
    const buys = legs.filter(l => l.side === 'BUY').length;
    const sells = legs.filter(l => l.side === 'SELL').length;
    if (buys === 2 && sells === 2) {
      const uniqueStrikes = new Set(legs.map(l => l.strike)).size;
      if (uniqueStrikes === 3) return 'Iron Butterfly';
      return 'Iron Condor';
    }
  }
  return 'Custom Strategy';
};


const PriceFlasher = ({ price, children }: { price: number, children: React.ReactNode }) => {
  const prevPriceRef = useRef(price);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (price !== prevPriceRef.current) {
      anim.setValue(price > prevPriceRef.current ? 1 : -1);
      Animated.timing(anim, {
        toValue: 0,
        duration: 600,
        useNativeDriver: false
      }).start();
    }
    prevPriceRef.current = price;
  }, [price]);

  const bgColor = anim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ['rgba(248, 73, 96, 0.4)', 'transparent', 'rgba(0, 192, 135, 0.4)']
  });

  return (
    <Animated.View style={{ backgroundColor: bgColor, borderRadius: 4 }}>
      {children}
    </Animated.View>
  );
};

export default function App() {

  const [selectedMarket, setSelectedMarket] = useState<'CRYPTO' | 'INDIAN' | 'STOCKS' | 'COMMODITY' | null>(null);
  const [activeAsset, setActiveAsset] = useState<string>('NIFTY');
  const [cryptoLeverage, setCryptoLeverage] = useState<number>(200);
  const [activeExpiry, setActiveExpiry] = useState<string>('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [chainByExpiry, setChainByExpiry] = useState<any>({});

  const chainScrollRef = useRef<FlatList<any>>(null);

  // Live Spot Prices Dictionary
  const [liveMarketPrices, setLiveMarketPrices] = useState<Record<string, { spot: number; change: number; pctChange: number }>>({
    'NIFTY': { spot: 24234.55, change: 2.70, pctChange: 0.01 },
    'BANKNIFTY': { spot: 57655.50, change: 159.60, pctChange: 0.28 },
    'SENSEX': { spot: 77315.44, change: -225.39, pctChange: -0.29 },
    'RELIANCE': { spot: 1305.00, change: -11.00, pctChange: -0.84 },
    'TCS': { spot: 2295.40, change: -6.60, pctChange: -0.29 },
    'INFY': { spot: 1137.20, change: 16.20, pctChange: 1.45 },
    'HDFCBANK': { spot: 1642.50, change: 8.30, pctChange: 0.51 },
    'ICICIBANK': { spot: 1215.10, change: -4.20, pctChange: -0.35 },
    'SBIN': { spot: 815.00, change: 3.40, pctChange: 0.42 },
    'TATAMOTORS': { spot: 985.00, change: -5.20, pctChange: -0.53 },
    'BHARTIARTL': { spot: 1450.00, change: 12.00, pctChange: 0.83 },
    'ITC': { spot: 490.00, change: 1.50, pctChange: 0.31 },
    'LT': { spot: 3600.00, change: -18.00, pctChange: -0.50 },
    'CRUDEOIL': { spot: 8315.0, change: 0.0, pctChange: 0.0 },
    'GOLD': { spot: 161690.0, change: 0.0, pctChange: 0.0 },
    'SILVER': { spot: 246274.0, change: 0.0, pctChange: 0.0 },
    'BTC': { spot: 76406.20, change: 6811.70, pctChange: 9.64 },
    'ETH': { spot: 2375.46, change: 127.96, pctChange: 5.59 },
    'XAUT': { spot: 2521.80, change: 12.40, pctChange: 0.49 }
  });

  const [activeTab, setActiveTab] = useState<'home' | 'chain' | 'strategy' | 'tradelab' | 'accounts'>('home');
  const [tradeLabSubTab, setTradeLabSubTab] = useState<'positions' | 'performance' | 'discover' | 'journal'>('positions');
  const [selectedHeatmapDate, setSelectedHeatmapDate] = useState<string | null>(null);
  const [showAlertBanner, setShowAlertBanner] = useState(true);
  const [marketOpen, setMarketOpen] = useState(true);

  const [isCreatingAccount, setIsCreatingAccount] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountBalance, setNewAccountBalance] = useState('');

  const [editingAccount, setEditingAccount] = useState<any | null>(null);
  const [editAccountName, setEditAccountName] = useState('');
  const [editAccountBalance, setEditAccountBalance] = useState('');

  const [viewMode, setViewMode] = useState<'LTP' | 'OI'>('LTP');
  const [activeRowTarget, setActiveRowTarget] = useState<{ strike: number; side: 'CALL' | 'PUT' } | null>(null);

  const [cursorSpotOffset, setCursorSpotOffset] = useState<number>(0);

  const [showReadyModal, setShowReadyModal] = useState(false);
  const [showPayoffModal, setShowPayoffModal] = useState(false);
  const [showGlossaryModal, setShowGlossaryModal] = useState(false);
  const [selectedMarketView, setSelectedMarketView] = useState<'ALL' | 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'VOLATILE'>('ALL');

  const [showAssetModal, setShowAssetModal] = useState(false);
  const [showExpiryModal, setShowExpiryModal] = useState(false);
  const [tradeMessage, setTradeMessage] = useState<string>('');
  const [isTrading, setIsTrading] = useState(false);

  // Order Placement Modal (Zerodha/Delta style)
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [orderModalLeg, setOrderModalLeg] = useState<OptionLeg | null>(null);
  const [orderMode, setOrderMode] = useState<'REGULAR' | 'AMO'>('REGULAR');
  const [productType, setProductType] = useState<'NRML' | 'MIS'>('NRML');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT' | 'SL' | 'SL-M'>('MARKET');
  const [orderLots, setOrderLots] = useState<number>(1);
  const [orderLimitPrice, setOrderLimitPrice] = useState<string>('');
  const [orderTriggerPrice, setOrderTriggerPrice] = useState<string>('');
  const [hasStoploss, setHasStoploss] = useState(false);
  const [slMode, setSlMode] = useState<'PRICE' | 'PERCENT'>('PERCENT');
  const [slValue, setSlValue] = useState<string>('15');
  const [hasTarget, setHasTarget] = useState(false);
  const [targetMode, setTargetMode] = useState<'PRICE' | 'PERCENT'>('PERCENT');
  const [targetValue, setTargetValue] = useState<string>('30');

  // Modify Position Modal State
  const [showModifyModal, setShowModifyModal] = useState(false);
  const [selectedModifyPosition, setSelectedModifyPosition] = useState<any>(null);
  const [modHasStoploss, setModHasStoploss] = useState(false);
  const [modSlMode, setModSlMode] = useState<'PRICE' | 'PERCENT'>('PERCENT');
  const [modSlValue, setModSlValue] = useState<string>('15');
  const [modHasTarget, setModHasTarget] = useState(false);
  const [modTargetMode, setModTargetMode] = useState<'PRICE' | 'PERCENT'>('PERCENT');
  const [modTargetValue, setModTargetValue] = useState<string>('30');

  const [stratBasket, setStratBasket] = useState<OptionLeg[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountsByMarket, setActiveAccountsByMarket] = useState<{ [market: string]: number }>({
    CRYPTO: 101,
    INDIAN: 1,
    STOCKS: 1,
    COMMODITY: 201
  });
  
  const [portfolio, setPortfolio] = useState<any>(null);
  const [orderHistory, setOrderHistory] = useState<any[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const currConfig = ASSET_CONFIG[activeAsset] || ASSET_CONFIG['NIFTY'];
  const currency = currConfig.currency;

  const updateLegSize = useCallback((idx: number, delta: number) => {
    setStratBasket(prev => {
      if (!prev[idx]) return prev;
      const cur = prev[idx].size || 1;
      const step = selectedMarket === 'CRYPTO' ? 10 : 1;
      const next = Math.max(1, cur + (delta * step));
      if (next === cur) return prev;
      const copy = [...prev];
      copy[idx] = { ...copy[idx], size: next };
      return copy;
    });
  }, [selectedMarket]);

  const activeAccountId = selectedMarket ? (activeAccountsByMarket[selectedMarket] || (selectedMarket === 'CRYPTO' ? 101 : 1)) : 1;

  const setActiveAccountId = (newIdOrFunc: number | ((prev: number) => number)) => {
    if (selectedMarket) {
      setActiveAccountsByMarket(prev => {
        const cur = prev[selectedMarket] || (selectedMarket === 'CRYPTO' ? 101 : 1);
        const resolved = typeof newIdOrFunc === 'function' ? newIdOrFunc(cur) : newIdOrFunc;
        return {
          ...prev,
          [selectedMarket]: resolved
        };
      });
    }
  };

  const currSym = currConfig.symbol;
  const lotSize = currConfig.lotSize;
  const strikeStep = currConfig.strikeStep;

  const currentSpotInfo = liveMarketPrices[activeAsset] || { spot: currConfig.defaultSpot, change: 0, pctChange: 0 };
  const spotPrice = currentSpotInfo.spot;
  const spotChange = currentSpotInfo.change;
  const spotPercentChange = currentSpotInfo.pctChange;

  const triggerManualRefresh = useCallback(() => {
    setIsRefreshing(true);
    fetch(`${BACKEND_URL}/api/refresh`)
      .catch(() => {});

    const accId = activeAccountId;
    fetch(`${BACKEND_URL}/api/sync/live?asset=${activeAsset}&account_id=${accId}&force=true`)
      .then(r => r.json())
      .then(data => {
        if (!data) return;
        if (data.spots) setLiveMarketPrices(data.spots);
        if (data.chain) {
          if (data.chain.expiries && data.chain.expiries.length > 0) {
            setExpiries(data.chain.expiries);
            setActiveExpiry(prev => (prev && data.chain.expiries.includes(prev)) ? prev : data.chain.expiries[0]);
          }
          if (data.chain.chainByExpiry) setChainByExpiry(data.chain.chainByExpiry);
        }
        if (data.portfolio) setPortfolio(data.portfolio);
        setTradeMessage('Live Prices Updated! ⚡');
        setTimeout(() => setTradeMessage(''), 2500);
      })
      .catch(() => {})
      .finally(() => {
        setTimeout(() => setIsRefreshing(false), 500);
      });
  }, [activeAsset, activeAccountId]);

  const handleBackPress = () => {
    if (showReadyModal) {
      setShowReadyModal(false);
      return true;
    }
    if (showAssetModal) {
      setShowAssetModal(false);
      return true;
    }
    if (showExpiryModal) {
      setShowExpiryModal(false);
      return true;
    }
    if (activeRowTarget !== null) {
      setActiveRowTarget(null);
      return true;
    }
    if (activeTab !== 'home') {
      setActiveTab('home');
      return true;
    }
    if (selectedMarket !== null) {
      setSelectedMarket(null);
      return true;
    }
    return false;
  };

  useEffect(() => {
    const backAction = () => handleBackPress();
    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [showReadyModal, showAssetModal, showExpiryModal, activeRowTarget, activeTab]);

  const activeAccount = useMemo(() => {
    const acc = accounts.find(a => a.id === activeAccountId);
    if (acc) return acc;
    const firstMatching = accounts.find(a => a.market === selectedMarket);
    if (firstMatching) return firstMatching;
    return { 
      id: activeAccountId, 
      name: `${activeAsset} Account ${activeAccountId}`, 
      margin_type: 'Cross', 
      balance: selectedMarket === 'CRYPTO' ? 100000 : 2500000, 
      currency, 
      market: selectedMarket 
    };
  }, [accounts, activeAccountId, currency, activeAsset, selectedMarket]);

  const fetchAccounts = useCallback(() => {
    if (!selectedMarket) return;
    fetch(`${BACKEND_URL}/api/accounts?market=${selectedMarket}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setAccounts(data);
          setActiveAccountsByMarket(prev => {
            const cur = prev[selectedMarket];
            if (cur && data.some((a: any) => a.id === cur)) {
              return prev; // Retain current active account!
            }
            return { ...prev, [selectedMarket]: data[0].id };
          });
        }
      })
      .catch(() => {});
  }, [selectedMarket]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Synchronize selectedMarket when activeAsset changes (if a market is chosen)
  useEffect(() => {
    if (selectedMarket === null) return;
    const config = ASSET_CONFIG[activeAsset];
    if (config && config.category && selectedMarket !== config.category) {
      setSelectedMarket(config.category);
    }
  }, [activeAsset]);

  // Real-Time 0-Lag Ultra-Fast WebSocket Stream (spots + option chain, lag-free)
  const priceFeed = usePriceFeed(activeAsset);

  useEffect(() => {
    if (priceFeed.spots && Object.keys(priceFeed.spots).length > 0) {
      setLiveMarketPrices((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const k of Object.keys(priceFeed.spots)) {
          const p = prev[k];
          const n = priceFeed.spots[k];
          if (!p || Math.abs(p.spot - n.spot) > 0.001 || Math.abs(p.change - n.change) > 0.001) {
            next[k] = n;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [priceFeed.spots]);

  useEffect(() => {
    const c = priceFeed.chain;
    if (c.expiries && c.expiries.length > 0) {
      setExpiries((prev) => {
        if (prev.length === c.expiries.length && prev[0] === c.expiries[0]) return prev;
        return c.expiries;
      });
      setActiveExpiry((prev) => (prev && c.expiries.includes(prev)) ? prev : c.expiries[0]);
    }
    if (c.chainByExpiry && Object.keys(c.chainByExpiry).length > 0) {
      setChainByExpiry(c.chainByExpiry);
    }
  }, [priceFeed.chain]);

  useEffect(() => {
    setMarketOpen((prev) => (prev === priceFeed.marketOpen ? prev : priceFeed.marketOpen));
  }, [priceFeed.marketOpen]);

  // Real-Time Atomic Sync Loop (fallback for HTTP and periodic portfolio updates)
  useEffect(() => {
    let isMounted = true;

    const syncLiveMarket = () => {
      const accId = activeAccountId || 1;
      
      // If WS is connected, we only need to sync portfolio and history periodically
      if (priceFeed.connected && !priceFeed.stale) {
        fetch(`${BACKEND_URL}/api/portfolio?account_id=${accId}`)
          .then(r => r.json())
          .then(data => {
            if (isMounted && data) setPortfolio(data);
          })
          .catch(() => {});

        fetch(`${BACKEND_URL}/api/history?account_id=${accId}`)
          .then(r => r.json())
          .then(data => {
            if (isMounted && Array.isArray(data)) setOrderHistory(data);
          })
          .catch(() => {});
        return;
      }

      // Fallback: Full REST Sync when WebSocket is offline/reconnecting
      fetch(`${BACKEND_URL}/api/sync/live?asset=${activeAsset}&account_id=${accId}`)
        .then(r => r.json())
        .then(data => {
          if (!isMounted || !data) return;

          // 1. Atomic Update of spots
          if (data.spots) {
            setLiveMarketPrices((prev) => ({ ...prev, ...data.spots }));
          }

          // 2. Atomic Update of active Option Chain
          if (data.chain) {
            if (data.chain.expiries && data.chain.expiries.length > 0) {
              setExpiries((prev) => {
                if (prev.length === data.chain.expiries.length && prev[0] === data.chain.expiries[0]) return prev;
                return data.chain.expiries;
              });
              setActiveExpiry(prev => (prev && data.chain.expiries.includes(prev)) ? prev : data.chain.expiries[0]);
            }
            if (data.chain.chainByExpiry) {
              setChainByExpiry(data.chain.chainByExpiry);
            }
          }

          // 3. Atomic Update of Portfolio & Balances
          if (data.portfolio) {
            setPortfolio(data.portfolio);
          }
        })
        .catch(() => {});

      // History fetch
      fetch(`${BACKEND_URL}/api/history?account_id=${accId}`)
        .then(r => r.json())
        .then(data => {
          if (isMounted && Array.isArray(data)) setOrderHistory(data);
        })
        .catch(() => {});
    };

    syncLiveMarket();
    const intervalTime = priceFeed.connected && !priceFeed.stale ? 1500 : 600;
    const interval = setInterval(syncLiveMarket, intervalTime);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeAsset, activeAccountId, priceFeed.connected, priceFeed.stale]);

  const currentChain = useMemo(() => {
    if (!activeExpiry && expiries.length > 0) {
      return chainByExpiry[expiries[0]] || [];
    }
    return chainByExpiry[activeExpiry] || [];
  }, [chainByExpiry, activeExpiry, expiries]);

  const maxOI = useMemo(() => Math.max(1, ...currentChain.map((r: any) => Math.max(r.callOI || 0, r.putOI || 0))), [currentChain]);

  const headerAtmStrike = useMemo(() => {
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

  const hasAutoScrolled = useRef<string>('');

  const scrollToAtm = () => {
    if (!currentChain || currentChain.length === 0) return;
    const sp = spotPrice || currConfig.defaultSpot;
    const sorted = [...currentChain].sort((a, b) => a.strike - b.strike);
    let atmIdx = 0;
    let minDiff = Infinity;
    sorted.forEach((r, idx) => {
      const diff = Math.abs(r.strike - sp);
      if (diff < minDiff) {
        minDiff = diff;
        atmIdx = idx;
      }
    });

    const targetY = Math.max(0, (atmIdx * 50) - 180);
    chainScrollRef.current?.scrollToOffset({ offset: targetY, animated: true });
  };

  useEffect(() => {
    const scrollKey = `${activeAsset}-${activeExpiry}`;
    if (activeTab === 'chain' && currentChain.length > 0 && spotPrice > 0 && hasAutoScrolled.current !== scrollKey) {
      const timer = setTimeout(() => {
        scrollToAtm();
        hasAutoScrolled.current = scrollKey;
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [activeTab, activeAsset, activeExpiry, currentChain.length, spotPrice]);

  const handleToggleLeg = (row: any, type: 'CALL' | 'PUT', side: 'BUY' | 'SELL') => {
    const symbol = type === 'CALL' ? row.callSym : row.putSym;
    const price = type === 'CALL' ? (row.callMark || 0) : (row.putMark || 0);

    setStratBasket(prev => {
      const existingIdx = prev.findIndex(l => l.strike === row.strike && l.option_type === type);
      if (existingIdx >= 0) {
        const existing = prev[existingIdx];
        if (existing.side === side) {
          return prev.filter((_, i) => i !== existingIdx);
        } else {
          const updated = [...prev];
          updated[existingIdx] = { ...existing, side, price };
          return updated;
        }
      } else {
        const newLeg: OptionLeg = {
          symbol: symbol || `${type[0]}-${activeAsset}-${row.strike}`,
          underlying: activeAsset,
          strike: row.strike,
          expiry: activeExpiry || (expiries.length > 0 ? expiries[0] : ''),
          option_type: type,
          side,
          size: 1,
          price
        };
        return [...prev, newLeg];
      }
    });
  };

  const applyReadyStrategy = (strat: StrategyTemplate) => {
    if (!currentChain || currentChain.length === 0) return;
    const sp = spotPrice || currConfig.defaultSpot;
    const sorted = [...currentChain].sort((a, b) => a.strike - b.strike);

    let atmIdx = 0;
    let minDiff = Infinity;
    sorted.forEach((r, idx) => {
      const diff = Math.abs(r.strike - sp);
      if (diff < minDiff) {
        minDiff = diff;
        atmIdx = idx;
      }
    });

    const getRow = (offset: number) => {
      const idx = Math.max(0, Math.min(sorted.length - 1, atmIdx + offset));
      return sorted[idx];
    };

    const makeLeg = (row: any, type: 'CALL' | 'PUT', side: 'BUY' | 'SELL', size = 1): OptionLeg => ({
      symbol: type === 'CALL' ? row.callSym : row.putSym,
      underlying: activeAsset,
      strike: row.strike,
      expiry: activeExpiry || (expiries.length > 0 ? expiries[0] : ''),
      option_type: type,
      side,
      size,
      price: type === 'CALL' ? (row.callMark || 0) : (row.putMark || 0)
    });

    let legs: OptionLeg[] = [];

    switch (strat.name) {
      case 'Buy Call':
        legs = [makeLeg(getRow(0), 'CALL', 'BUY')];
        break;
      case 'Bull Call Spread':
        legs = [makeLeg(getRow(0), 'CALL', 'BUY'), makeLeg(getRow(2), 'CALL', 'SELL')];
        break;
      case 'Bull Put Spread':
        legs = [makeLeg(getRow(0), 'PUT', 'SELL'), makeLeg(getRow(-2), 'PUT', 'BUY')];
        break;
      case 'Bullish Condor':
      case 'Bearish Condor':
        legs = [makeLeg(getRow(-3), 'PUT', 'BUY'), makeLeg(getRow(-1), 'PUT', 'SELL'), makeLeg(getRow(1), 'CALL', 'SELL'), makeLeg(getRow(3), 'CALL', 'BUY')];
        break;
      case 'Call Ratio Spread':
        legs = [makeLeg(getRow(0), 'CALL', 'BUY', 1), makeLeg(getRow(2), 'CALL', 'SELL', 2)];
        break;
      case 'Buy Put':
        legs = [makeLeg(getRow(0), 'PUT', 'BUY')];
        break;
      case 'Bear Put Spread':
        legs = [makeLeg(getRow(0), 'PUT', 'BUY'), makeLeg(getRow(-2), 'PUT', 'SELL')];
        break;
      case 'Bear Call Spread':
        legs = [makeLeg(getRow(0), 'CALL', 'SELL'), makeLeg(getRow(2), 'CALL', 'BUY')];
        break;
      case 'Put Ratio Spread':
        legs = [makeLeg(getRow(0), 'PUT', 'BUY', 1), makeLeg(getRow(-2), 'PUT', 'SELL', 2)];
        break;
      case 'Short Straddle':
        legs = [makeLeg(getRow(0), 'CALL', 'SELL'), makeLeg(getRow(0), 'PUT', 'SELL')];
        break;
      case 'Short Strangle':
        legs = [makeLeg(getRow(2), 'CALL', 'SELL'), makeLeg(getRow(-2), 'PUT', 'SELL')];
        break;
      case 'Long Call Butterfly':
        legs = [makeLeg(getRow(-2), 'CALL', 'BUY', 1), makeLeg(getRow(0), 'CALL', 'SELL', 2), makeLeg(getRow(2), 'CALL', 'BUY', 1)];
        break;
      case 'Short Iron Condor':
        legs = [makeLeg(getRow(-3), 'PUT', 'BUY'), makeLeg(getRow(-1), 'PUT', 'SELL'), makeLeg(getRow(1), 'CALL', 'SELL'), makeLeg(getRow(3), 'CALL', 'BUY')];
        break;
      case 'Long Straddle':
        legs = [makeLeg(getRow(0), 'CALL', 'BUY'), makeLeg(getRow(0), 'PUT', 'BUY')];
        break;
      case 'Long Strangle':
        legs = [makeLeg(getRow(2), 'CALL', 'BUY'), makeLeg(getRow(-2), 'PUT', 'BUY')];
        break;
      case 'Long Iron Butterfly':
        legs = [makeLeg(getRow(-2), 'PUT', 'BUY'), makeLeg(getRow(0), 'PUT', 'SELL'), makeLeg(getRow(0), 'CALL', 'SELL'), makeLeg(getRow(2), 'CALL', 'BUY')];
        break;
      case 'Long Iron Condor':
        legs = [makeLeg(getRow(-3), 'PUT', 'BUY'), makeLeg(getRow(-1), 'PUT', 'SELL'), makeLeg(getRow(1), 'CALL', 'SELL'), makeLeg(getRow(3), 'CALL', 'BUY')];
        break;
    }

    setStratBasket(legs);
    setCursorSpotOffset(0);
    setShowReadyModal(false);
    setActiveTab('chain');
    setShowPayoffModal(true);
  };

  const selectAssetAndTrade = (assetKey: string) => {
    setActiveAsset(assetKey);
    const cat = ASSET_CONFIG[assetKey]?.category;
    if (cat && selectedMarket !== cat) {
      setSelectedMarket(cat);
    }
    setStratBasket([]);
    setCursorSpotOffset(0);
    setActiveTab('chain');
  };

  const orderMargin = useMemo(() => {
    if (!stratBasket.length) return 0;
    const sp = spotPrice || currConfig.defaultSpot;

    if (selectedMarket === 'CRYPTO') {
      let margin = 0;
      stratBasket.forEach(leg => {
        const entryPrice = leg.price || 0;
        if (leg.side === 'BUY') {
          margin += entryPrice * (leg.size || 1) * lotSize;
        } else {
          margin += (sp * lotSize * (leg.size || 1)) / cryptoLeverage;
        }
      });
      return margin;
    }

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
  }, [stratBasket, spotPrice, lotSize, activeAsset]);

  const netPremium = useMemo(() => {
    let total = 0;
    stratBasket.forEach(l => {
      const p = (l.price || 0) * (l.size || 1) * lotSize;
      total += l.side === 'BUY' ? -p : p;
    });
    return total;
  }, [stratBasket, lotSize]);

  const greeksData = useMemo(() => {
    const sp = spotPrice || currConfig.defaultSpot;
    let netDelta = 0;
    let netGamma = 0;
    let netTheta = 0;
    let netVega = 0;

    const legsWithGreeks = stratBasket.map(leg => {
      const row = currentChain.find((r: any) => r.strike === leg.strike);
      const livePrice = row ? (leg.option_type === 'CALL' ? (row.callMark || row.callLtp || 0) : (row.putMark || row.putLtp || 0)) : (leg.price || 0);
      const dteDays = calculateDteDays(leg.expiry);
      const greeks = calculateBlackScholesGreeks(sp, leg.strike, dteDays, livePrice, leg.option_type);
      const mult = leg.side === 'BUY' ? 1 : -1;
      const qty = (leg.size || 1) * lotSize;

      const legDelta = greeks.delta * mult * qty;
      const legGamma = greeks.gamma * mult * qty;
      const legTheta = greeks.theta * mult * qty;
      const legVega = greeks.vega * mult * qty;

      netDelta += legDelta;
      netGamma += legGamma;
      netTheta += legTheta;
      netVega += legVega;

      return {
        ...leg,
        greeks,
        legDelta,
        legGamma,
        legTheta,
        legVega
      };
    });

    return {
      legs: legsWithGreeks,
      netDelta,
      netGamma,
      netTheta,
      netVega
    };
  }, [stratBasket, spotPrice, lotSize, activeAsset, selectedMarket, currentChain]);

  const calculatePnlAtSpot = (targetSpot: number) => {
    let pnl = 0;
    stratBasket.forEach(leg => {
      const intrinsic = leg.option_type === 'CALL' ? Math.max(0, targetSpot - leg.strike) : Math.max(0, leg.strike - targetSpot);
      const entryPrice = leg.price || 0;
      pnl += (leg.side === 'BUY' ? intrinsic - entryPrice : entryPrice - intrinsic) * (leg.size || 1) * lotSize;
    });
    return pnl;
  };

  const calculateExpectedPnlAtSpot = (targetSpot: number) => {
    let pnl = 0;
    stratBasket.forEach(leg => {
      const row = currentChain.find((r: any) => r.strike === leg.strike);
      const iv = row ? ((leg.option_type === 'CALL' ? row.callIv : row.putIv) || 35.0) / 100.0 : 0.35;
      const dteDays = calculateDteDays(leg.expiry);
      const T = Math.max(0.001, dteDays / 365.0);
      const theoretical = blackScholes(leg.option_type, targetSpot, leg.strike, T, 0.065, iv);
      const entryPrice = leg.price || 0;
      pnl += (leg.side === 'BUY' ? theoretical - entryPrice : entryPrice - theoretical) * (leg.size || 1) * lotSize;
    });
    return pnl;
  };

  const [pickerModal, setPickerModal] = useState<{
    visible: boolean;
    type: 'strike' | 'expiry';
    legIndex: number;
  } | null>(null);

  const toggleLegSide = (idx: number) => {
    setStratBasket(prev => {
      const nb = [...prev];
      nb[idx].side = nb[idx].side === 'BUY' ? 'SELL' : 'BUY';
      return nb;
    });
  };

  const toggleLegOptionType = (idx: number) => {
    setStratBasket(prev => {
      const nb = [...prev];
      nb[idx].option_type = nb[idx].option_type === 'CALL' ? 'PUT' : 'CALL';
      const row = currentChain.find((r: any) => r.strike === nb[idx].strike);
      if (row) {
        nb[idx].token = nb[idx].option_type === 'CALL' ? String(row.callToken) : String(row.putToken);
        nb[idx].price = nb[idx].option_type === 'CALL' ? (row.callMark || row.callLtp || 0) : (row.putMark || row.putLtp || 0);
      }
      return nb;
    });
  };

  const changeLegStrike = (idx: number, newStrike: number) => {
    setStratBasket(prev => {
      const nb = [...prev];
      const row = currentChain.find((r: any) => r.strike === newStrike);
      if (row) {
        nb[idx].strike = newStrike;
        nb[idx].token = nb[idx].option_type === 'CALL' ? String(row.callToken) : String(row.putToken);
        nb[idx].price = nb[idx].option_type === 'CALL' ? (row.callMark || row.callLtp || 0) : (row.putMark || row.putLtp || 0);
      }
      return nb;
    });
  };

  const changeLegExpiry = (idx: number, newExpiry: string) => {
    setStratBasket(prev => {
      const nb = [...prev];
      nb[idx].expiry = newExpiry;
      const chain = chainByExpiry[newExpiry] || [];
      const row = chain.find((r: any) => r.strike === nb[idx].strike);
      if (row) {
        nb[idx].token = nb[idx].option_type === 'CALL' ? String(row.callToken) : String(row.putToken);
        nb[idx].price = nb[idx].option_type === 'CALL' ? (row.callMark || row.callLtp || 0) : (row.putMark || row.putLtp || 0);
      }
      return nb;
    });
  };

  const handleStepStrike = (idx: number, direction: 'UP' | 'DOWN') => {
    setStratBasket(prev => {
      const nb = [...prev];
      const leg = nb[idx];
      const strikes = currentChain.map((r: any) => r.strike).sort((a: number, b: number) => a - b);
      const currIdx = strikes.indexOf(leg.strike);
      if (currIdx !== -1) {
        const nextIdx = direction === 'UP' ? currIdx + 1 : currIdx - 1;
        if (nextIdx >= 0 && nextIdx < strikes.length) {
          const newStrike = strikes[nextIdx];
          const row = currentChain.find((r: any) => r.strike === newStrike);
          if (row) {
            nb[idx] = {
              ...leg,
              strike: newStrike,
              token: leg.option_type === 'CALL' ? String(row.callToken) : String(row.putToken),
              price: leg.option_type === 'CALL' ? (row.callMark || row.callLtp || 0) : (row.putMark || row.putLtp || 0)
            };
          }
        }
      }
      return nb;
    });
  };

  const payoffStats = useMemo(() => {
    if (!stratBasket.length) return { points: [], maxProfit: '0.00', maxLoss: '0.00', minPnl: 0, maxPnl: 0, minStrike: 0, maxStrike: 0, pnlTable: [], breakevens: [] };
    const strikes = stratBasket.map(l => l.strike);
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    const sp = spotPrice || currConfig.defaultSpot;
    const range = Math.max(maxStrike - minStrike, sp * 0.08);
    const step = Math.max(5, Math.round(range / 50));

    const low = Math.floor((minStrike - range * 1.2) / strikeStep) * strikeStep;
    const high = Math.ceil((maxStrike + range * 1.2) / strikeStep) * strikeStep;

    const points: { price: number; pnl: number; pnlExpected: number }[] = [];
    let minPnl = Infinity;
    let maxPnl = -Infinity;
    const breakevens: number[] = [];

    let prevPnl = null;
    let prevPrice = null;

    for (let p = low; p <= high; p += step) {
      const pnlExpiry = calculatePnlAtSpot(p);
      const pnlExpected = calculateExpectedPnlAtSpot(p);
      points.push({ price: p, pnl: pnlExpiry, pnlExpected });

      if (pnlExpiry < minPnl) minPnl = pnlExpiry;
      if (pnlExpiry > maxPnl) maxPnl = pnlExpiry;

      if (prevPnl !== null && prevPrice !== null) {
        if ((prevPnl < 0 && pnlExpiry >= 0) || (prevPnl >= 0 && pnlExpiry < 0)) {
          const be = prevPrice + (p - prevPrice) * (0 - prevPnl) / (pnlExpiry - prevPnl);
          breakevens.push(Math.round(be * 10) / 10);
        }
      }
      prevPnl = pnlExpiry;
      prevPrice = p;
    }

    const mult = activeAsset === 'BTC' ? 10 
               : activeAsset === 'GOLD' ? 20
               : activeAsset === 'SILVER' ? 30
               : activeAsset === 'SENSEX' ? 2
               : activeAsset === 'BANKNIFTY' ? 2 
               : 1;
    const targetDiffs = [-300 * mult, -200 * mult, -100 * mult, -50 * mult, 0, 50 * mult, 100 * mult, 200 * mult, 300 * mult];
    const pnlTable = targetDiffs.map(diff => {
      const tgt = Math.round(sp + diff);
      const pnl = calculatePnlAtSpot(tgt);
      return { targetPrice: tgt, diff, pnl };
    });

    const isCrypto = selectedMarket === 'CRYPTO';
    const unit = isCrypto ? 'USD' : 'INR';

    return {
      points,
      minPnl,
      maxPnl,
      minStrike: low,
      maxStrike: high,
      pnlTable,
      breakevens,
      maxProfit: maxPnl > 500000 ? 'Unlimited' : `${maxPnl > 0 ? '+' : ''}${maxPnl.toFixed(2)} ${unit}`,
      maxLoss: minPnl < -500000 ? 'Unlimited' : `${minPnl.toFixed(2)} ${unit}`
    };
  }, [stratBasket, spotPrice, lotSize, currSym, strikeStep, activeAsset, selectedMarket, currentChain]);

  const currentTargetSpot = useMemo(() => {
    const sp = spotPrice || currConfig.defaultSpot;
    return sp + cursorSpotOffset;
  }, [spotPrice, cursorSpotOffset, activeAsset]);

  const targetSpotPnl = useMemo(() => {
    return calculatePnlAtSpot(currentTargetSpot);
  }, [currentTargetSpot, stratBasket, lotSize]);

  const targetSpotExpectedPnl = useMemo(() => {
    return calculateExpectedPnlAtSpot(currentTargetSpot);
  }, [currentTargetSpot, stratBasket, lotSize, currentChain]);

  const targetSpotMovePct = useMemo(() => {
    const sp = spotPrice || currConfig.defaultSpot;
    return ((currentTargetSpot - sp) / sp) * 100;
  }, [currentTargetSpot, spotPrice, activeAsset]);

  const rewardRiskVal = useMemo(() => {
    if (payoffStats.maxProfit === 'Unlimited' || payoffStats.maxLoss === 'Unlimited' || payoffStats.maxPnl <= 0 || payoffStats.minPnl >= 0) {
      return 'NA';
    }
    const ratio = payoffStats.maxPnl / Math.abs(payoffStats.minPnl);
    return ratio.toFixed(2);
  }, [payoffStats]);

  const chartW = SCREEN_WIDTH - 48;
  const chartH = 220;
  const padding = 24;

  const minX = payoffStats.points.length > 0 ? payoffStats.points[0].price : 23000;
  const maxX = payoffStats.points.length > 0 ? payoffStats.points[payoffStats.points.length - 1].price : 25500;
  const defaultBound = selectedMarket === 'CRYPTO' ? 2 : 1000;
  const minY = Math.min(-defaultBound, payoffStats.minPnl * 1.15);
  const maxY = Math.max(defaultBound, payoffStats.maxPnl * 1.15);

  const getX = (price: number) => padding + Math.max(0, Math.min(1, (price - minX) / (maxX - minX || 1))) * (chartW - padding * 2);
  const getY = (pnl: number) => chartH - padding - Math.max(0, Math.min(1, (pnl - minY) / (maxY - minY || 1))) * (chartH - padding * 2);

  const chartPanResponder = useMemo(() => {
    let startX = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt, gestureState) => {
        startX = evt.nativeEvent.locationX;
        const ratio = Math.max(0, Math.min(1, (startX - padding) / (chartW - padding * 2)));
        const targetPrice = minX + ratio * (maxX - minX);
        const sp = spotPrice || currConfig.defaultSpot;
        setCursorSpotOffset(Math.round((targetPrice - sp) * 10) / 10);
      },
      onPanResponderMove: (evt, gestureState) => {
        const touchX = startX + gestureState.dx;
        const ratio = Math.max(0, Math.min(1, (touchX - padding) / (chartW - padding * 2)));
        const targetPrice = minX + ratio * (maxX - minX);
        const sp = spotPrice || currConfig.defaultSpot;
        setCursorSpotOffset(Math.round((targetPrice - sp) * 10) / 10);
      }
    });
  }, [payoffStats, spotPrice, chartW, minX, maxX, activeAsset]);

  const renderInteractivePayoffSvg = () => {
    const { points } = payoffStats;
    if (!points || points.length < 2) return null;

    const zeroY = getY(0);
    const liveSpot = spotPrice || currConfig.defaultSpot;
    const liveSpotX = getX(liveSpot);

    const cursorX = getX(currentTargetSpot);
    const cursorY = getY(targetSpotPnl);

    let pathD = `M ${getX(points[0].price)} ${getY(points[0].pnl)}`;
    for (let i = 1; i < points.length; i++) {
      pathD += ` L ${getX(points[i].price)} ${getY(points[i].pnl)}`;
    }

    let expectedPathD = `M ${getX(points[0].price)} ${getY(points[0].pnlExpected)}`;
    for (let i = 1; i < points.length; i++) {
      expectedPathD += ` L ${getX(points[i].price)} ${getY(points[i].pnlExpected)}`;
    }
    
    // Calculate profit (above zeroY) and loss (below zeroY) paths dynamically
    let profitPathD = '';
    let lossPathD = '';

    for (let i = 1; i < points.length; i++) {
      const p1 = points[i - 1];
      const p2 = points[i];
      
      const x1 = getX(p1.price);
      const y1 = getY(p1.pnl);
      const x2 = getX(p2.price);
      const y2 = getY(p2.pnl);
      
      const pnl1 = p1.pnl;
      const pnl2 = p2.pnl;
      
      if (pnl1 >= 0 && pnl2 >= 0) {
        profitPathD += ` M ${x1} ${zeroY} L ${x1} ${y1} L ${x2} ${y2} L ${x2} ${zeroY} Z`;
      } else if (pnl1 < 0 && pnl2 < 0) {
        lossPathD += ` M ${x1} ${zeroY} L ${x1} ${y1} L ${x2} ${y2} L ${x2} ${zeroY} Z`;
      } else {
        const ratio = (0 - pnl1) / (pnl2 - pnl1);
        const xMid = x1 + ratio * (x2 - x1);
        
        if (pnl1 >= 0) {
          profitPathD += ` M ${x1} ${zeroY} L ${x1} ${y1} L ${xMid} ${zeroY} Z`;
          lossPathD += ` M ${xMid} ${zeroY} L ${x2} ${y2} L ${x2} ${zeroY} Z`;
        } else {
          lossPathD += ` M ${x1} ${zeroY} L ${x1} ${y1} L ${xMid} ${zeroY} Z`;
          profitPathD += ` M ${xMid} ${zeroY} L ${x2} ${y2} L ${x2} ${zeroY} Z`;
        }
      }
    }

    const expiryDateObj = activeExpiry ? new Date(activeExpiry) : (expiries.length > 0 ? new Date(expiries[0]) : new Date());
    const formattedExpiryDate = expiryDateObj.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short' });

    const isCrypto = selectedMarket === 'CRYPTO';
    const tooltipWidth = isCrypto ? 190 : 144;
    const tooltipHeight = isCrypto ? 84 : 46;
    const tooltipX = Math.max(padding, Math.min(chartW - padding - tooltipWidth, cursorX - tooltipWidth / 2));
    const tooltipY = Math.max(padding - 10, cursorY - tooltipHeight - 14);

    return (
      <View style={styles.chartWrapper}>
        <View style={styles.payoffHeaderRow}>
          <View>
            <Text style={styles.payoffTitleText}>{activeAsset} Payoff at Expiry</Text>
            <View style={{ flexDirection: 'row', gap: 16, marginTop: 4 }}>
              <View>
                <Text style={styles.payoffStatLabel}>Max profit</Text>
                <Text style={[styles.payoffStatVal, { color: '#00c087' }]}>{payoffStats.maxProfit}</Text>
              </View>
              <View>
                <Text style={styles.payoffStatLabel}>Max loss</Text>
                <Text style={[styles.payoffStatVal, { color: '#f84960' }]}>{payoffStats.maxLoss}</Text>
              </View>
              <View>
                <Text style={styles.payoffStatLabel}>Reward / Risk</Text>
                <Text style={styles.payoffStatVal}>{rewardRiskVal}</Text>
              </View>
              {payoffStats.breakevens.length > 0 && (
                <View>
                  <Text style={styles.payoffStatLabel}>Breakeven</Text>
                  <Text style={styles.payoffStatVal}>{payoffStats.breakevens.join(', ')}</Text>
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Payoff Graph Legend Row */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginVertical: 8, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 3, backgroundColor: '#00c087', borderRadius: 1.5 }} />
            <View style={{ width: 8, height: 3, backgroundColor: '#f84960', borderRadius: 1.5, marginLeft: -4 }} />
            <Text style={{ color: '#8a95a5', fontSize: 10 }}>On Expiry Date</Text>
          </View>
          <View style={{ width: 1, height: 10, backgroundColor: '#334155' }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 1.2, height: 10, backgroundColor: '#ffffff', opacity: 0.7 }} />
            <Text style={{ color: '#8a95a5', fontSize: 10 }}>Index {Math.round(currentTargetSpot)}</Text>
          </View>
          <View style={{ width: 1, height: 10, backgroundColor: '#334155' }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 12, height: 2.5, backgroundColor: '#ff9800', borderRadius: 1.25 }} />
            <Text style={{ color: '#8a95a5', fontSize: 10 }}>On Target Date</Text>
          </View>
        </View>

        <View {...chartPanResponder.panHandlers} style={{ width: chartW, height: chartH }}>
          <Svg width={chartW} height={chartH} pointerEvents="none">
            <Defs>
              <LinearGradient id="payoffGrad" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%" stopColor="#00c087" />
                <Stop offset={`${Math.min(100, Math.max(0, (zeroY / chartH) * 100))}%`} stopColor="#00c087" />
                <Stop offset={`${Math.min(100, Math.max(0, (zeroY / chartH) * 100))}%`} stopColor="#f84960" />
                <Stop offset="100%" stopColor="#f84960" />
              </LinearGradient>
            </Defs>
            <SvgLine x1={padding} y1={zeroY} x2={chartW - padding} y2={zeroY} stroke="#334155" strokeDasharray="4,4" strokeWidth="1" />
            <SvgText x={chartW - padding + 2} y={zeroY + 3} fill="#64748b" fontSize="9">₹0</SvgText>

            {/* Profit Area Shade (Green) */}
            {!!profitPathD && (
              <Path d={profitPathD} fill="rgba(0, 192, 135, 0.18)" stroke="none" />
            )}

            {/* Loss Area Shade (Red) */}
            {!!lossPathD && (
              <Path d={lossPathD} fill="rgba(248, 73, 96, 0.18)" stroke="none" />
            )}

            {/* Selected Strike Vertical Markers & Labels */}
            {stratBasket.map((leg, idx) => {
              const legX = getX(leg.strike);
              const isBuy = leg.side === 'BUY';
              const strikeColor = isBuy ? '#00c087' : '#f84960';
              const labelY = idx % 2 === 0 ? padding + 14 : padding + 28;
              const legLabel = `${leg.strike} ${leg.option_type[0]}E (${leg.side[0]})`;

              return (
                <G key={idx}>
                  <SvgLine x1={legX} y1={padding} x2={legX} y2={chartH - padding} stroke={strikeColor} strokeDasharray="2,2" strokeWidth="1.2" opacity="0.75" />
                  <Rect x={legX - 34} y={labelY - 10} width="68" height="14" rx="3" fill={isBuy ? '#064e3b' : '#7f1d1d'} opacity="0.9" />
                  <SvgText x={legX} y={labelY + 1} fill="#ffffff" fontSize="8.5" fontWeight="bold" textAnchor="middle">
                    {legLabel}
                  </SvgText>
                </G>
              );
            })}

            {/* Live Spot Price Line */}
            <SvgLine x1={liveSpotX} y1={padding} x2={liveSpotX} y2={chartH - padding} stroke="#38bdf8" strokeDasharray="3,3" strokeWidth="1.5" />
            <SvgText x={liveSpotX} y={chartH - 8} fill="#38bdf8" fontSize="9" fontWeight="bold" textAnchor="middle">Spot</SvgText>

            {/* On Expiry Date Path */}
            <Path d={pathD} stroke="url(#payoffGrad)" strokeWidth="2.5" fill="none" />

            {/* On Target Date Path */}
            <Path d={expectedPathD} stroke="#ff9800" strokeWidth="2" fill="none" opacity="0.9" />

            <SvgLine x1={cursorX} y1={padding} x2={cursorX} y2={chartH - padding} stroke="#ffffff" strokeDasharray="2,2" strokeWidth="1.5" />
            <Circle cx={cursorX} cy={cursorY} r="6.5" fill="#ffffff" stroke="#ff9800" strokeWidth="2.5" />

            <G x={tooltipX} y={tooltipY}>
              <Rect width={tooltipWidth} height={tooltipHeight} rx="6" fill="#161c28" stroke="#2a364f" strokeWidth="1" />
              {isCrypto ? (
                <>
                  <SvgText x={12} y={15} fill="#8a95a5" fontSize="8.5" fontWeight="500">When price is at:</SvgText>
                  <SvgText x={12} y={30} fill="#ffffff" fontSize="12" fontWeight="bold">{Math.round(currentTargetSpot)}</SvgText>
                  
                  <SvgText x={12} y={46} fill="#8a95a5" fontSize="8.5" fontWeight="500">Expected PNL on</SvgText>
                  
                  <SvgText x={12} y={61} fill="#ffffff" fontSize="10">{formattedExpiryDate}</SvgText>
                  <SvgText x={tooltipWidth - 18} y={61} fill={targetSpotExpectedPnl >= 0 ? '#00c087' : '#f84960'} fontSize="10.5" fontWeight="bold" textAnchor="end">
                    {targetSpotExpectedPnl >= 0 ? `+${targetSpotExpectedPnl.toFixed(2)}` : `${targetSpotExpectedPnl.toFixed(2)}`} USD
                  </SvgText>

                  <SvgText x={12} y={75} fill="#ffffff" fontSize="10">Expiry</SvgText>
                  <SvgText x={tooltipWidth - 18} y={75} fill={targetSpotPnl >= 0 ? '#00c087' : '#f84960'} fontSize="10.5" fontWeight="bold" textAnchor="end">
                    {targetSpotPnl >= 0 ? `+${targetSpotPnl.toFixed(2)}` : `${targetSpotPnl.toFixed(2)}`} USD
                  </SvgText>
                </>
              ) : (
                <>
                  <SvgText x={tooltipWidth / 2} y={17} fill="#ffffff" fontSize="10.5" fontWeight="bold" textAnchor="middle">
                    Target: {currentTargetSpot.toFixed(2)} ({targetSpotMovePct >= 0 ? `+${targetSpotMovePct.toFixed(2)}%` : `${targetSpotMovePct.toFixed(2)}%`})
                  </SvgText>
                  <SvgText x={tooltipWidth / 2} y={35} fill={targetSpotPnl >= 0 ? '#00c087' : '#f84960'} fontSize="11.5" fontWeight="bold" textAnchor="middle">
                    Expiry PnL: {targetSpotPnl >= 0 ? `+${currSym}${targetSpotPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : `-${currSym}${Math.abs(targetSpotPnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
                  </SvgText>
                </>
              )}
            </G>

            {/* X Axis Labels */}
            <SvgText x={padding} y={chartH - 2} fill="#94a3b8" fontSize="10">{Math.round(minX)}</SvgText>
            <SvgText x={chartW / 2} y={chartH - 2} fill="#94a3b8" fontSize="10" textAnchor="middle">{Math.round((minX + maxX) / 2)}</SvgText>
            <SvgText x={chartW - padding} y={chartH - 2} fill="#94a3b8" fontSize="10" textAnchor="end">{Math.round(maxX)}</SvgText>

            {/* Y Axis Labels */}
            <SvgText x={chartW - 2} y={padding + 10} fill="#00c087" fontSize="10" textAnchor="end" fontWeight="bold">+{Math.round(maxY)}</SvgText>
            <SvgText x={chartW - 2} y={chartH - padding - 2} fill="#f84960" fontSize="10" textAnchor="end" fontWeight="bold">{Math.round(minY)}</SvgText>
            <SvgText x={chartW - 2} y={zeroY - 4} fill="#94a3b8" fontSize="10" textAnchor="end">0</SvgText>
          </Svg>
        </View>

        <Text style={styles.dragNoticeText}>👆 Touch or drag across the graph to inspect {activeAsset} P&L</Text>

        {/* Spot Movement Controls */}
        <View style={styles.spotScrubberBox}>
          <Text style={styles.spotScrubberLabel}>
            Target Spot: <Text style={{ color: '#ffffff', fontWeight: 'bold' }}>{currSym}{currentTargetSpot.toFixed(2)}</Text> ({targetSpotMovePct >= 0 ? `+${targetSpotMovePct.toFixed(2)}%` : `${targetSpotMovePct.toFixed(2)}%`})
          </Text>
          <View style={styles.spotStepperRow}>
            <TouchableOpacity style={styles.spotStepBtn} onPress={() => setCursorSpotOffset(prev => prev - 2 * (currConfig.strikeStep || 100))}>
              <Text style={styles.spotStepBtnText}>-{2 * (currConfig.strikeStep || 100)}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.spotStepBtn} onPress={() => setCursorSpotOffset(prev => prev - (currConfig.strikeStep || 100))}>
              <Text style={styles.spotStepBtnText}>-{currConfig.strikeStep || 100}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.spotResetBtn} onPress={() => setCursorSpotOffset(0)}>
              <Text style={styles.spotResetBtnText}>Live Spot (0)</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.spotStepBtn} onPress={() => setCursorSpotOffset(prev => prev + (currConfig.strikeStep || 100))}>
              <Text style={styles.spotStepBtnText}>+{currConfig.strikeStep || 100}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.spotStepBtn} onPress={() => setCursorSpotOffset(prev => prev + 2 * (currConfig.strikeStep || 100))}>
              <Text style={styles.spotStepBtnText}>+{2 * (currConfig.strikeStep || 100)}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  const renderDeltaPayoffLegsTable = () => {
    return (
      <View style={styles.deltaTableCard}>
        {/* Header Row */}
        <View style={styles.deltaTableHeader}>
          <Text style={[styles.deltaColHeader, { flex: 1.8 }]}>Contracts ({stratBasket.length} Selected)</Text>
          <Text style={[styles.deltaColHeader, { flex: 1, textAlign: 'right' }]}>Est. Price</Text>
          <Text style={[styles.deltaColHeader, { flex: 1, textAlign: 'right' }]}>Entry Price</Text>
          <Text style={[styles.deltaColHeader, { flex: 1.2, textAlign: 'right' }]}>Target PNL</Text>
        </View>

        {/* Rows */}
        {stratBasket.map((leg, idx) => {
          // Calculate Est. Price (theoretical)
          const row = currentChain.find((r: any) => r.strike === leg.strike);
          const iv = row ? ((leg.option_type === 'CALL' ? row.callIv : row.putIv) || 35.0) / 100.0 : 0.35;
          const dteDays = calculateDteDays(leg.expiry);
          const T = Math.max(0.001, dteDays / 365.0);
          const theoretical = blackScholes(leg.option_type, currentTargetSpot, leg.strike, T, 0.065, iv);
          const entryPrice = leg.price || 0;
          
          // Calculate Target PNL for this leg
          const legSize = leg.size || 1;
          const legPnl = (leg.side === 'BUY' ? theoretical - entryPrice : entryPrice - theoretical) * legSize * lotSize;
          
          // Format expiry date
          const expStr = leg.expiry ? new Date(leg.expiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
          
          // Format Position Size (e.g. 0.1 BTC, or 65 INR Contracts)
          const sizeStr = selectedMarket === 'CRYPTO' ? `${(legSize * lotSize).toFixed(3).replace(/\.?0+$/, '')} ${activeAsset}` : `${legSize * lotSize} Contracts`;

          return (
            <View key={idx} style={styles.deltaTableRow}>
              {/* Left Column: Leg Info */}
              <View style={{ flex: 1.8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={[
                    styles.deltaTableRowSide,
                    { color: leg.side === 'BUY' ? '#00c087' : '#f84960' }
                  ]}>
                    {leg.side === 'BUY' ? 'B' : 'S'}
                  </Text>
                  <Text style={styles.deltaTableRowSym}>
                    {leg.option_type === 'CALL' ? 'C' : 'P'}-{leg.strike}
                  </Text>
                </View>
                <Text style={styles.deltaTableRowSubText}>
                  {expStr} • {sizeStr}
                </Text>
              </View>

              {/* Est. Price */}
              <Text style={[styles.deltaTableCellText, { flex: 1, textAlign: 'right' }]}>
                {theoretical.toFixed(selectedMarket === 'CRYPTO' ? 2 : 1)}
              </Text>

              {/* Entry Price */}
              <Text style={[styles.deltaTableCellText, { flex: 1, textAlign: 'right' }]}>
                {entryPrice.toFixed(selectedMarket === 'CRYPTO' ? 2 : 1)}
              </Text>

              {/* Target PNL */}
              <Text style={[
                styles.deltaTableCellText, 
                { flex: 1.2, textAlign: 'right', fontWeight: 'bold', color: legPnl >= 0 ? '#00c087' : '#f84960' }
              ]}>
                {legPnl >= 0 ? `+${legPnl.toFixed(2)}` : legPnl.toFixed(2)}
              </Text>
            </View>
          );
        })}

        {/* Bottom Summary Bar */}
        <View style={styles.deltaTableSummaryRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.deltaSummaryLabel}>Total Projected PNL</Text>
            <Text style={[
              styles.deltaSummaryValue, 
              { color: targetSpotExpectedPnl >= 0 ? '#00c087' : '#f84960' }
            ]}>
              {targetSpotExpectedPnl >= 0 ? `+${targetSpotExpectedPnl.toFixed(2)}` : targetSpotExpectedPnl.toFixed(2)} {selectedMarket === 'CRYPTO' ? 'USD' : 'INR'}
            </Text>
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Text style={styles.deltaSummaryLabel}>Total Current UPNL</Text>
            <Text style={[styles.deltaSummaryValue, { color: '#8a95a5' }]}>
              0.00 {selectedMarket === 'CRYPTO' ? 'USD' : 'INR'}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  const renderJournalEquityCurve = () => {
    const points = cumulativePnlPoints;
    if (points.length < 2) return null;

    const chartW = SCREEN_WIDTH - 48;
    const chartH = 100;
    const padding = 16;

    const pnls = points.map(p => p.pnl);
    const maxP = Math.max(...pnls, 10);
    const minP = Math.min(...pnls, -10);
    const rangeY = maxP - minP || 1;

    const getX = (index: number) => padding + (index / (points.length - 1)) * (chartW - padding * 2);
    const getY = (pnl: number) => chartH - padding - ((pnl - minP) / rangeY) * (chartH - padding * 2);

    let pathD = `M ${getX(points[0].index)} ${getY(points[0].pnl)}`;
    for (let i = 1; i < points.length; i++) {
      pathD += ` L ${getX(points[i].index)} ${getY(points[i].pnl)}`;
    }

    const isProfit = points[points.length - 1].pnl >= 0;
    const curveColor = isProfit ? '#00c087' : '#f84960';

    return (
      <View style={styles.equityCurveContainer}>
        <Text style={styles.equityCurveTitle}>📈 Cumulative Realised P&L Curve</Text>
        <Svg width={chartW} height={chartH}>
          <Path d={pathD} stroke={curveColor} strokeWidth="2.5" fill="none" />
          {minP < 0 && maxP > 0 && (
            <SvgLine x1={padding} y1={getY(0)} x2={chartW - padding} y2={getY(0)} stroke="#334155" strokeDasharray="3,3" strokeWidth="1" />
          )}
          <Circle cx={getX(points[0].index)} cy={getY(points[0].pnl)} r="4" fill="#64748b" />
          <Circle cx={getX(points[points.length - 1].index)} cy={getY(points[points.length - 1].pnl)} r="5" fill={curveColor} />
        </Svg>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%', paddingHorizontal: 12, marginTop: 4 }}>
          <Text style={{ color: '#64748b', fontSize: 10 }}>Start</Text>
          <Text style={{ color: curveColor, fontSize: 11, fontWeight: 'bold' }}>
            Net: {isProfit ? '+' : ''}{currSym}{points[points.length - 1].pnl.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </Text>
        </View>
      </View>
    );
  };

  const renderJournalCalendarHeatmap = () => {
    const dates = heatmapDates;
    const map = dailyPnlMap;

    const weeks = [];
    for (let i = 0; i < 5; i++) {
      weeks.push(dates.slice(i * 7, (i + 1) * 7));
    }

    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    return (
      <View style={styles.heatmapCard}>
        <Text style={styles.heatmapTitle}>📅 P&L Daily Heatmap (Last 5 Weeks)</Text>
        
        <View style={styles.heatmapGrid}>
          <View style={styles.weekdayHeaderRow}>
            {weekdays.map((day, idx) => (
              <Text key={idx} style={styles.weekdayLabel}>{day[0]}</Text>
            ))}
          </View>

          {weeks.map((week, wIdx) => (
            <View key={wIdx} style={styles.heatmapRow}>
              {week.map((date, dIdx) => {
                const yyyy = date.getFullYear();
                const mm = String(date.getMonth() + 1).padStart(2, '0');
                const dd = String(date.getDate()).padStart(2, '0');
                const dateKey = `${yyyy}-${mm}-${dd}`;
                
                const pnl = map[dateKey] || 0;
                const hasTrade = map[dateKey] !== undefined;
                
                 let cellBg = '#0c101b'; // Base empty cells background
                 let cellBorder = '#172033'; // Border to match card styling
                 if (hasTrade) {
                   cellBorder = 'transparent';
                   if (pnl > 0) {
                     if (pnl < 1000) {
                       cellBg = 'rgba(16, 185, 129, 0.22)';
                     } else if (pnl < 5000) {
                       cellBg = 'rgba(16, 185, 129, 0.6)';
                     } else {
                       cellBg = '#00c087';
                     }
                   } else if (pnl < 0) {
                     const absVal = Math.abs(pnl);
                     if (absVal < 1000) {
                       cellBg = 'rgba(239, 68, 68, 0.22)';
                     } else if (absVal < 5000) {
                       cellBg = 'rgba(239, 68, 68, 0.6)';
                     } else {
                       cellBg = '#f84960';
                     }
                   } else {
                     cellBg = '#4b5563'; // Neutral gray
                   }
                 }
                
                const isSelected = selectedHeatmapDate === dateKey;

                return (
                  <TouchableOpacity
                    key={dIdx}
                    style={[
                      styles.heatmapCell, 
                      { backgroundColor: cellBg, borderColor: cellBorder, borderWidth: 1 },
                      isSelected && { borderColor: '#38bdf8', borderWidth: 1.5 }
                    ]}
                    onPress={() => {
                      if (hasTrade) {
                        setSelectedHeatmapDate(isSelected ? null : dateKey);
                      }
                    }}
                  >
                    <Text style={[styles.heatmapCellText, { opacity: hasTrade ? 1 : 0.4 }]}>
                      {date.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </View>

        {selectedHeatmapDate && map[selectedHeatmapDate] !== undefined ? (
          <View style={styles.heatmapTooltip}>
            <Text style={styles.heatmapTooltipDate}>
              Date: {new Date(selectedHeatmapDate).toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short' })}
            </Text>
            <Text style={[styles.heatmapTooltipPnl, { color: map[selectedHeatmapDate] >= 0 ? '#00c087' : '#f84960' }]}>
              Daily P&L: {map[selectedHeatmapDate] >= 0 ? '+' : '-'}{currSym}{Math.abs(map[selectedHeatmapDate]).toFixed(2)}
            </Text>
          </View>
        ) : (
          <View style={styles.heatmapTooltipPlaceholder}>
            <Text style={styles.heatmapTooltipPlaceholderText}>Tap any green/red day cell to view net P&L</Text>
          </View>
        )}
      </View>
    );
  };

  const handleCreateAccount = () => {
    if (!newAccountName || !newAccountBalance) return;
    fetch(`${BACKEND_URL}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newAccountName,
        balance: parseFloat(newAccountBalance),
        margin_type: 'Cross',
        currency: currency,
        market: selectedMarket
      })
    })
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') {
          setIsCreatingAccount(false);
          setNewAccountName('');
          setNewAccountBalance('');
          fetchAccounts();
          setTradeMessage('Sub-Account Created! 💼');
          setTimeout(() => setTradeMessage(''), 3000);
        } else {
          setTradeMessage(data.message || 'Failed to create account');
          setTimeout(() => setTradeMessage(''), 3000);
        }
      })
      .catch(() => {});
  };

  const startEditingAccount = (acc: any) => {
    setEditingAccount(acc);
    setEditAccountName(acc.name);
    setEditAccountBalance(String(acc.balance));
  };

  const handleUpdateAccount = () => {
    if (!editingAccount || !editAccountName || !editAccountBalance) return;
    fetch(`${BACKEND_URL}/api/accounts/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: editingAccount.id,
        name: editAccountName,
        balance: parseFloat(editAccountBalance),
        margin_type: editingAccount.margin_type
      })
    })
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') {
          setEditingAccount(null);
          fetchAccounts();
          setTradeMessage('Account Updated! ✓');
          setTimeout(() => setTradeMessage(''), 3000);
        }
      })
      .catch(() => {});
  };

  const handleDeleteAccount = (accId: number) => {
    Alert.alert(
      "Confirm Delete",
      "Are you sure you want to delete this sub-account? This will permanently wipe all associated active positions and trading history.",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Delete", 
          style: "destructive",
          onPress: () => {
            fetch(`${BACKEND_URL}/api/accounts/delete`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ account_id: accId })
            })
              .then(r => r.json())
              .then(data => {
                if (data.status === 'success') {
                  fetchAccounts();
                  setTradeMessage('Sub-Account Deleted.');
                  setTimeout(() => setTradeMessage(''), 3000);
                } else {
                  setTradeMessage(data.message || 'Failed to delete');
                  setTimeout(() => setTradeMessage(''), 3000);
                }
              })
              .catch(() => {});
          }
        }
      ]
    );
  };

  const openOrderTicket = (leg?: OptionLeg) => {
    const isAssetCrypto = activeAsset === 'BTC' || activeAsset === 'ETH' || activeAsset === 'XAUT';
    const isIndianMarketClosed = !isAssetCrypto && !marketOpen;

    if (leg) {
      setOrderModalLeg(leg);
      setOrderLots(leg.size || 1);
      setOrderLimitPrice(leg.price ? leg.price.toString() : '');
      const defaultTrig = leg.side === 'BUY' ? (leg.price * 0.95).toFixed(1) : (leg.price * 1.05).toFixed(1);
      setOrderTriggerPrice(defaultTrig);
    } else if (stratBasket.length > 0) {
      setOrderModalLeg(stratBasket[0]);
      setOrderLots(stratBasket[0].size || 1);
      setOrderLimitPrice(stratBasket[0].price ? stratBasket[0].price.toString() : '');
      setOrderTriggerPrice('');
    }
    setOrderMode(isIndianMarketClosed ? 'AMO' : 'REGULAR');
    setProductType('NRML');
    setOrderType('MARKET');
    setHasStoploss(false);
    setHasTarget(false);
    setSlMode('PERCENT');
    setSlValue('15');
    setTargetMode('PERCENT');
    setTargetValue('30');
    setShowOrderModal(true);
  };

  const handlePlaceOrder = () => {
    if (!stratBasket.length) return;
    openOrderTicket();
  };

  const handleExecuteOrderModal = () => {
    if (!orderModalLeg && !stratBasket.length) return;
    setIsTrading(true);
    setTradeMessage('Executing Order...');

    const parsedSL = hasStoploss ? parseFloat(slValue) || 0 : 0;
    const parsedTarget = hasTarget ? parseFloat(targetValue) || 0 : 0;
    const limitP = (orderType === 'LIMIT' || orderType === 'SL') ? parseFloat(orderLimitPrice) || (orderModalLeg?.price || 0) : (orderModalLeg?.price || 0);
    const triggerP = (orderType === 'SL' || orderType === 'SL-M') ? parseFloat(orderTriggerPrice) || 0 : 0;

    let legsToExecute: OptionLeg[] = [];
    if (orderModalLeg) {
      legsToExecute = [{
        ...orderModalLeg,
        size: orderLots,
        price: limitP,
        stoploss: parsedSL,
        target: parsedTarget,
        stoploss_type: slMode,
        target_type: targetMode,
        product_type: productType,
        order_mode: orderMode,
        order_type: orderType,
        trigger_price: triggerP
      }];
    } else {
      legsToExecute = stratBasket.map(l => ({
        ...l,
        size: orderLots,
        stoploss: parsedSL,
        target: parsedTarget,
        stoploss_type: slMode,
        target_type: targetMode,
        product_type: productType,
        order_mode: orderMode,
        order_type: orderType,
        trigger_price: triggerP
      }));
    }

    const orderBasketName = `${activeAsset} ${legsToExecute[0]?.option_type || 'OPT'} ${orderMode === 'AMO' ? 'AMO' : ''} ${productType}`;

    fetch(`${BACKEND_URL}/api/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        basket_name: orderBasketName,
        legs: legsToExecute,
        account_id: activeAccountId || 1
      })
    })
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') {
          setTradeMessage(data.message || 'Order Executed Successfully! ⚡');
          setShowOrderModal(false);
          setStratBasket([]);
          setActiveTab('tradelab');
          setTradeLabSubTab('positions');
          triggerManualRefresh();
          setTimeout(() => setTradeMessage(''), 4000);
        } else {
          setTradeMessage(`Error: ${data.message}`);
          setTimeout(() => setTradeMessage(''), 4000);
        }
      })
      .catch(() => setTradeMessage('Trade execution failed'))
      .finally(() => setIsTrading(false));
  };

  const openModifyPositionModal = (pos: any) => {
    setSelectedModifyPosition(pos);
    const sl = pos.stoploss || 0;
    const tgt = pos.target || 0;
    setModHasStoploss(sl > 0);
    setModSlValue(sl > 0 ? sl.toString() : '15');
    setModSlMode(pos.stoplossType || 'PERCENT');
    setModHasTarget(tgt > 0);
    setModTargetValue(tgt > 0 ? tgt.toString() : '30');
    setModTargetMode(pos.targetType || 'PERCENT');
    setShowModifyModal(true);
  };

  const handleSaveModifyPosition = () => {
    if (!selectedModifyPosition) return;
    const sl = modHasStoploss ? parseFloat(modSlValue) || 0 : 0;
    const tgt = modHasTarget ? parseFloat(modTargetValue) || 0 : 0;

    fetch(`${BACKEND_URL}/api/trade/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        position_id: selectedModifyPosition.positionId,
        stoploss: sl,
        target: tgt,
        stoploss_type: modSlMode,
        target_type: modTargetMode
      })
    })
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') {
          setTradeMessage(data.message || 'GTT SL & Target Updated! ✓');
          setShowModifyModal(false);
          triggerManualRefresh();
          setTimeout(() => setTradeMessage(''), 3500);
        } else {
          setTradeMessage(`Error: ${data.message}`);
        }
      })
      .catch(() => setTradeMessage('Failed to update position'));
  };

  const handleCloseSinglePosition = (posId: number, symbol: string) => {
    Alert.alert(
      "Exit Position",
      `Are you sure you want to close ${symbol} at live market price?`,
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Exit Now", 
          style: "destructive",
          onPress: () => {
            setTradeMessage('Closing position...');
            fetch(`${BACKEND_URL}/api/trade/close_position`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ position_id: posId, exit_reason: 'MANUAL EXIT' })
            })
              .then(r => r.json())
              .then(data => {
                if (data.status === 'success') {
                  setTradeMessage(data.message || 'Position Closed! ✓');
                  triggerManualRefresh();
                  setTimeout(() => setTradeMessage(''), 3500);
                } else {
                  setTradeMessage(`Error: ${data.message}`);
                }
              })
              .catch(() => setTradeMessage('Failed to close position'));
          }
        }
      ]
    );
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
    setActiveTab('strategy');
  };

  const handleClosePosition = (basketId: number) => {
    setTradeMessage('Closing position...');
    fetch(`${BACKEND_URL}/api/trade/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basket_id: basketId, account_id: activeAccount?.id || 1 })
    })
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success') {
          setTradeMessage(data.message || 'Position Closed! ✓');
          triggerManualRefresh();
          setTimeout(() => setTradeMessage(''), 3500);
        } else {
          setTradeMessage(`Error: ${data.message || 'Could not close position'}`);
          setTimeout(() => setTradeMessage(''), 4000);
        }
      })
      .catch((err) => {
        setTradeMessage('Error: Failed to connect to trade server');
        setTimeout(() => setTradeMessage(''), 4000);
      });
  };

  const filteredReadyStrategies = useMemo(() => {
    if (selectedMarketView === 'ALL') return READY_STRATEGIES;
    return READY_STRATEGIES.filter(s => s.view === selectedMarketView);
  }, [selectedMarketView]);

  const tradeLabStats = useMemo(() => {
    const rawBalance = Number(activeAccount?.balance) || 1000000;
    let totalInvestedMargin = 0;
    let totalUnrealisedPnl = 0;

    const activePositionsList: any[] = [];

    if (portfolio?.baskets) {
      portfolio.baskets.forEach((b: any) => {
        b.legs?.forEach((leg: any) => {
          const legAsset = leg.underlying || 'NIFTY';
          const legLotSize = ASSET_CONFIG[legAsset]?.lotSize || (
            legAsset === 'NIFTY' ? 65 : 
            (legAsset === 'BANKNIFTY' ? 30 : 
            (legAsset === 'CRUDEOIL' ? 100 : 
            (legAsset === 'GOLD' ? 100 : 
            (legAsset === 'SILVER' ? 30 : 
            (legAsset === 'BTC' ? 0.001 : 
            (legAsset === 'ETH' ? 0.01 : 1.0))))))
          );

          const chain = chainByExpiry[leg.expiry] || [];
          const row = chain.find((r: any) => r.strike === leg.strike);
          
          const ltp = row ? (leg.option_type === 'CALL' ? (row.callMark || row.callLtp || 0) : (row.putMark || row.putLtp || 0)) : (leg.current_price || leg.entry_price || 0);
          const entry = leg.entry_price || 0;
          const qty = (leg.size || 1) * legLotSize;
          
          const diff = leg.side === 'BUY' ? (ltp - entry) : (entry - ltp);
          const legPnl = row ? (diff * qty) : (leg.upnl !== undefined ? leg.upnl : diff * qty);
          const pctChange = row ? (entry > 0 ? ((ltp - entry) / entry) * 100 : 0) : (leg.pnl_pct !== undefined ? leg.pnl_pct : 0);
          
          const isCrypto = legAsset === 'BTC' || legAsset === 'ETH' || legAsset === 'XAUT';
          const invested = entry * qty;

          totalInvestedMargin += invested;
          totalUnrealisedPnl += legPnl;

          activePositionsList.push({
            basketId: b.id,
            positionId: leg.id,
            symbol: leg.symbol || `${legAsset} ${leg.expiry ? new Date(leg.expiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).toUpperCase() : ''} ${leg.strike} ${leg.option_type === 'CALL' ? 'CE' : 'PE'}`,
            underlying: legAsset,
            strike: leg.strike,
            expiry: leg.expiry,
            optionType: leg.option_type,
            qty,
            side: leg.side,
            entry,
            ltp,
            legPnl,
            pctChange,
            stoploss: leg.stoploss || 0,
            target: leg.target || 0,
            stoplossType: leg.stoploss_type || 'PRICE',
            targetType: leg.target_type || 'PRICE',
            productType: leg.product_type || 'NRML',
            orderMode: leg.order_mode || 'REGULAR',
            triggerPrice: leg.trigger_price || 0,
            status: 'Active',
            currency: isCrypto ? 'USD' : 'INR'
          });
        });
      });
    }

    const availableMargin = Math.max(0, rawBalance);
    const totalPortfolio = rawBalance + totalInvestedMargin + totalUnrealisedPnl;

    const closedOrders = orderHistory.filter((h: any) => h.status === 'CLOSED');
    let totalRealisedPnl = 0;
    let winCount = 0;
    let bestTrade = 0;
    let worstTrade = 0;

    closedOrders.forEach((h: any) => {
      const pnl = Number(h.realized_pnl) || 0;
      totalRealisedPnl += pnl;
      if (pnl > 0) winCount++;
      if (pnl > bestTrade) bestTrade = pnl;
      if (pnl < worstTrade) worstTrade = pnl;
    });

    const winRate = closedOrders.length > 0 ? (winCount / closedOrders.length) * 100 : 0;

    return {
      totalPortfolio,
      totalUnrealisedPnl,
      availableMargin,
      totalInvestedMargin,
      activePositionsList,
      closedOrders,
      totalRealisedPnl,
      winRate,
      bestTrade,
      worstTrade
    };
  }, [portfolio, orderHistory, chainByExpiry, activeAccount, lotSize, activeAsset]);

  const dailyPnlMap = useMemo(() => {
    const map: { [dateKey: string]: number } = {};
    orderHistory.forEach((item: any) => {
      if (!item.closed_at) return;
      const dateObj = new Date(item.closed_at);
      const yyyy = dateObj.getFullYear();
      const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
      const dd = String(dateObj.getDate()).padStart(2, '0');
      const dateKey = `${yyyy}-${mm}-${dd}`;
      const pnl = Number(item.realized_pnl) || 0;
      map[dateKey] = (map[dateKey] || 0) + pnl;
    });
    return map;
  }, [orderHistory]);

  const heatmapDates = useMemo(() => {
    const dates = [];
    const start = new Date();
    const day = start.getDay();
    const diffToMonday = day === 0 ? 6 : day - 1;
    
    // Aligns grid: start from Monday of 4 weeks ago to show 5 complete weeks (Monday -> Sunday)
    start.setDate(start.getDate() - diffToMonday - 28);
    start.setHours(0, 0, 0, 0);

    for (let i = 0; i < 35; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      dates.push(d);
    }
    return dates;
  }, []);

  const cumulativePnlPoints = useMemo(() => {
    const sortedTrades = [...orderHistory]
      .filter((item: any) => item.closed_at)
      .sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime());

    let currentSum = 0;
    const points = sortedTrades.map((t, idx) => {
      currentSum += Number(t.realized_pnl) || 0;
      return {
        index: idx + 1,
        pnl: currentSum,
        timestamp: new Date(t.closed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      };
    });

    return [{ index: 0, pnl: 0, timestamp: 'Start' }, ...points];
  }, [orderHistory]);

  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  const handleTouchStart = (e: any) => {
    touchStartX.current = e.nativeEvent.pageX;
    touchStartY.current = e.nativeEvent.pageY;
  };

  const handleTouchEnd = (e: any) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const diffX = e.nativeEvent.pageX - touchStartX.current;
    const diffY = e.nativeEvent.pageY - touchStartY.current;
    touchStartX.current = null;
    touchStartY.current = null;

    // Ignore vertical swipes or small movements
    if (Math.abs(diffY) > Math.abs(diffX)) return;
    const threshold = 85; // Require a decisive swipe gesture
    if (diffX > threshold) {
      // Swipe Right -> navigate to previous tab
      setActiveTab(prev => {
        if (prev === 'tradelab') return 'chain';
        if (prev === 'chain') return 'home';
        return prev;
      });
    } else if (diffX < -threshold) {
      // Swipe Left -> navigate to next tab
      setActiveTab(prev => {
        if (prev === 'home') return 'chain';
        if (prev === 'chain') return 'tradelab';
        return prev;
      });
    }
  };

  return (
    <SafeAreaView 
      style={styles.container}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0a0d14" translucent={false} />


      {selectedMarket === null && (
        <View style={{ flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#0a0d14' }}>
          {/* Logo & Brand Emblem */}
          <View style={{ alignItems: 'center', marginBottom: 36 }}>
            <View style={{
              width: 104,
              height: 104,
              borderRadius: 24,
              backgroundColor: '#101722',
              borderWidth: 1.5,
              borderColor: 'rgba(0, 192, 135, 0.4)',
              justifyContent: 'center',
              alignItems: 'center',
              shadowColor: '#00c087',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.35,
              shadowRadius: 18,
              elevation: 10,
              marginBottom: 16
            }}>
              <Image
                source={require('./assets/logo.png')}
                style={{ width: 88, height: 88, borderRadius: 20 }}
                resizeMode="contain"
              />
            </View>
            <Text style={{ color: 'white', fontSize: 32, fontWeight: '900', letterSpacing: 0.5 }}>Broast App</Text>
            <View style={{ backgroundColor: 'rgba(0, 192, 135, 0.12)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20, marginBottom: 6, borderWidth: 1, borderColor: 'rgba(0, 192, 135, 0.25)' }}>
              <Text style={{ color: '#00c087', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 }}>PRO OPTIONS TRADING SIMULATOR</Text>
            </View>
            <Text style={{ color: '#8a95a5', fontSize: 13, marginTop: 12, textAlign: 'center' }}>Select your trading theater to enter the terminal</Text>
          </View>
          
          <TouchableOpacity 
            style={{ backgroundColor: '#131926', padding: 18, borderRadius: 16, marginBottom: 14, borderWidth: 1, borderColor: '#222f46', flexDirection: 'row', alignItems: 'center' }}
            onPress={() => { setSelectedMarket('INDIAN'); setActiveAsset('NIFTY'); setActiveTab('home'); }}
          >
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(2, 132, 199, 0.15)', justifyContent: 'center', alignItems: 'center', marginRight: 14 }}>
              <Text style={{ fontSize: 22 }}>🇮🇳</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#38bdf8', fontSize: 17, fontWeight: 'bold' }}>Indian Benchmark Indices</Text>
              <Text style={{ color: '#8a95a5', fontSize: 12, marginTop: 2 }}>NIFTY 50, BANK NIFTY, BSE SENSEX</Text>
            </View>
            <Text style={{ color: '#4b5563', fontSize: 20 }}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={{ backgroundColor: '#131926', padding: 18, borderRadius: 16, marginBottom: 14, borderWidth: 1, borderColor: '#222f46', flexDirection: 'row', alignItems: 'center' }}
            onPress={() => { setSelectedMarket('STOCKS'); setActiveAsset('RELIANCE'); setActiveTab('home'); }}
          >
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(168, 85, 247, 0.15)', justifyContent: 'center', alignItems: 'center', marginRight: 14 }}>
              <Text style={{ fontSize: 22 }}>📈</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#c084fc', fontSize: 17, fontWeight: 'bold' }}>NSE Stock Options</Text>
              <Text style={{ color: '#8a95a5', fontSize: 12, marginTop: 2 }}>RELIANCE, TCS, INFY, HDFC & F&O Heavyweights</Text>
            </View>
            <Text style={{ color: '#4b5563', fontSize: 20 }}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={{ backgroundColor: '#131926', padding: 18, borderRadius: 16, marginBottom: 14, borderWidth: 1, borderColor: '#222f46', flexDirection: 'row', alignItems: 'center' }}
            onPress={() => { setSelectedMarket('COMMODITY'); setActiveAsset('CRUDEOIL'); setActiveTab('home'); }}
          >
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(234, 179, 8, 0.15)', justifyContent: 'center', alignItems: 'center', marginRight: 14 }}>
              <Text style={{ fontSize: 22 }}>🛢️</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#facc15', fontSize: 17, fontWeight: 'bold' }}>MCX Commodities</Text>
              <Text style={{ color: '#8a95a5', fontSize: 12, marginTop: 2 }}>CRUDEOIL, GOLD, SILVER Futures & Options</Text>
            </View>
            <Text style={{ color: '#4b5563', fontSize: 20 }}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={{ backgroundColor: '#131926', padding: 18, borderRadius: 16, borderWidth: 1, borderColor: '#222f46', flexDirection: 'row', alignItems: 'center' }}
            onPress={() => { setSelectedMarket('CRYPTO'); setActiveAsset('BTC'); setActiveTab('home'); }}
          >
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(247, 147, 26, 0.15)', justifyContent: 'center', alignItems: 'center', marginRight: 14 }}>
              <Text style={{ fontSize: 22 }}>₿</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#f7931a', fontSize: 17, fontWeight: 'bold' }}>Crypto Options</Text>
              <Text style={{ color: '#8a95a5', fontSize: 12, marginTop: 2 }}>BTC, ETH, XAUT via Delta Exchange (24/7)</Text>
            </View>
            <Text style={{ color: '#4b5563', fontSize: 20 }}>›</Text>
          </TouchableOpacity>
        </View>
      )}

      {selectedMarket !== null && (
        <>
      {/* 1. Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerLeft} onPress={handleBackPress}>
          <Image
            source={require('./assets/logo.png')}
            style={{ width: 38, height: 38, borderRadius: 10 }}
            resizeMode="contain"
          />
          <View>
            <Text style={styles.headerTitle}>Broast App</Text>
            <Text style={styles.headerSubtitle}>
              {activeTab === 'home' ? 'Market Watchlist' : activeTab === 'chain' ? `${activeAsset} Option Chain` : 'Positions'}
            </Text>
          </View>
        </TouchableOpacity>
        <View style={styles.headerRight}>
          <TouchableOpacity 
            style={{ 
              backgroundColor: isRefreshing ? '#065f46' : 'rgba(16, 185, 129, 0.15)', 
              borderColor: isRefreshing ? '#34d399' : '#10b981',
              borderWidth: 1,
              width: 32,
              height: 32,
              borderRadius: 8,
              justifyContent: 'center',
              alignItems: 'center'
            }} 
            onPress={triggerManualRefresh}
            activeOpacity={0.6}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
          >
            <Text style={{ fontSize: 13 }}>🔄</Text>
          </TouchableOpacity>
          {activeTab === 'chain' && (
            <TouchableOpacity style={styles.readyBtnHeader} onPress={() => setShowReadyModal(true)}>
              <Text style={styles.readyBtnHeaderText}>⚡ Ready Strats</Text>
            </TouchableOpacity>
          )}
          {activeTab !== 'home' && (
            <TouchableOpacity style={styles.homeIconBtn} onPress={() => setActiveTab('home')}>
              <Text style={styles.homeIconText}>📑</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => setShowAssetModal(true)}>
            <Text style={styles.menuDots}>⋮</Text>
          </TouchableOpacity>
        </View>
      </View>

      
      {/* 2. Top Nav */}
      <View style={styles.topTabBar}>
        <TouchableOpacity style={[styles.topTabBtn, activeTab === 'home' && styles.topTabBtnActive]} onPress={() => setActiveTab('home')}>
          <Text style={[styles.topTabLabel, activeTab === 'home' && styles.topTabLabelActive]}>📑 Watchlist</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.topTabBtn, activeTab === 'chain' && styles.topTabBtnActive]} onPress={() => setActiveTab('chain')}>
          <Text style={[styles.topTabLabel, activeTab === 'chain' && styles.topTabLabelActive]}>📊 Chain ({activeAsset})</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.topTabBtn, activeTab === 'tradelab' && styles.topTabBtnActive]} onPress={() => setActiveTab('tradelab')}>
          <Text style={[styles.topTabLabel, activeTab === 'tradelab' && styles.topTabLabelActive]}>
            💼 Positions
          </Text>
        </TouchableOpacity>
      </View>


      {/* Market / Feed Status */}
      {!marketOpen && (
        <View style={[styles.alertBanner, { backgroundColor: '#2a1020' }]}>
          <Text style={styles.alertText}>🔴 Market Closed — Live feed resumes during IST trading hours (09:00–23:55)</Text>
        </View>
      )}
      {marketOpen && priceFeed.stale && (
        <View style={[styles.alertBanner, { backgroundColor: 'rgba(56,189,248,0.15)' }]}>
          <Text style={styles.alertText}>🟡 Reconnecting to live feed…</Text>
        </View>
      )}

      {/* Alert */}
      {tradeMessage ? (
        <View style={[styles.alertBanner, tradeMessage.includes('Error') ? styles.alertError : styles.alertSuccess]}>
          <Text style={styles.alertText}>{tradeMessage}</Text>
          <TouchableOpacity onPress={() => setTradeMessage('')}>
            <Text style={styles.alertClose}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ===================== TAB 0: WATCHLIST SCREEN ===================== */}
      
      {activeTab === 'home' && (
        <ScrollView style={styles.tabContentContainer} contentContainerStyle={{ paddingBottom: 60 }}>
          {/* Hero Branding Card */}
          <View style={{
            backgroundColor: '#101522',
            borderRadius: 16,
            padding: 16,
            marginBottom: 20,
            borderWidth: 1,
            borderColor: '#1e293b',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12
          }}>
            <Image
              source={require('./assets/logo.png')}
              style={{ width: 46, height: 46, borderRadius: 12 }}
              resizeMode="contain"
            />
            <View style={{ flex: 1 }}>
              <Text style={{ color: 'white', fontSize: 18, fontWeight: '900', letterSpacing: 0.3 }}>Broast App</Text>
              <Text style={{ color: '#00c087', fontSize: 11, fontWeight: '700', marginTop: 2 }}>
                {selectedMarket === 'CRYPTO' ? 'CRYPTO WATCHLIST' : selectedMarket === 'STOCKS' ? 'NSE F&O STOCK OPTIONS' : selectedMarket === 'COMMODITY' ? 'MCX COMMODITIES' : 'INDIAN BENCHMARK INDICES'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
              <TouchableOpacity
                onPress={triggerManualRefresh}
                style={{ backgroundColor: 'rgba(16, 185, 129, 0.15)', borderWidth: 1, borderColor: '#10b981', width: 34, height: 34, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Text style={{ fontSize: 14 }}>🔄</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setSelectedMarket(null)}
                style={{ backgroundColor: '#1e283d', borderWidth: 1, borderColor: '#334155', width: 34, height: 34, borderRadius: 8, justifyContent: 'center', alignItems: 'center' }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Text style={{ color: '#94a3b8', fontSize: 16, fontWeight: 'bold' }}>⇄</Text>
              </TouchableOpacity>
            </View>
          </View>

          <Text style={{ fontSize: 15, color: '#94a3b8', fontWeight: '800', marginBottom: 12, letterSpacing: 0.5 }}>
            {selectedMarket === 'CRYPTO' ? 'CRYPTO WATCHLIST' : selectedMarket === 'STOCKS' ? 'NSE F&O STOCK OPTIONS' : selectedMarket === 'COMMODITY' ? 'MCX COMMODITIES' : 'INDIAN BENCHMARK INDICES'}
          </Text>
          
          {Object.keys(ASSET_CONFIG).filter(k => ASSET_CONFIG[k].category === selectedMarket).map(assetKey => {
            const conf = ASSET_CONFIG[assetKey];
            const live = liveMarketPrices[assetKey] || { spot: 0, change: 0, pctChange: 0 };
            const isUp = live.change >= 0;
            return (
              <TouchableOpacity 
                key={assetKey}
                style={{ backgroundColor: '#10141f', borderWidth: 1, borderColor: '#1e283d', borderRadius: 12, padding: 16, marginBottom: 12 }}
                onPress={() => {
                  setActiveAsset(assetKey);
                  setActiveTab('chain');
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ color: 'white', fontSize: 18, fontWeight: 'bold' }}>{assetKey}</Text>
                      <View style={{ backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                        <Text style={{ color: '#94a3b8', fontSize: 9.5, fontWeight: 'bold' }}>{conf.exchange}</Text>
                      </View>
                    </View>
                    <Text style={{ color: '#8a95a5', fontSize: 12, marginTop: 4 }}>Lot Size: {conf.lotSize} | Step: {conf.strikeStep}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: isUp ? '#00c087' : '#f84960', fontSize: 16, fontWeight: 'bold' }}>
                      {conf.symbol}{live.spot ? live.spot.toLocaleString('en-IN', { minimumFractionDigits: selectedMarket === 'CRYPTO' ? 1 : 2 }) : conf.defaultSpot.toLocaleString('en-IN')}
                    </Text>
                    <Text style={{ color: isUp ? '#00c087' : '#f84960', fontSize: 12, marginTop: 4, fontWeight: 'bold' }}>
                      {isUp ? '+' : ''}{live.pctChange.toFixed(2)}%
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}


      {/* ===================== TAB 1: OPTION CHAIN ===================== */}
      {activeTab === 'chain' && (
        <View style={{ flex: 1 }}>
          <View style={styles.controllerBox}>
            <View style={styles.controllerTopRow}>
              {/* Dropdowns Container (Side by Side) */}
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <TouchableOpacity 
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: '#131927',
                    borderWidth: 1,
                    borderColor: '#223049',
                    borderRadius: 8,
                    paddingHorizontal: 9,
                    paddingVertical: 5,
                    gap: 5
                  }} 
                  onPress={() => setShowAssetModal(true)}
                  activeOpacity={0.7}
                >
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#38bdf8' }} />
                  <Text style={{ color: '#ffffff', fontSize: 12.5, fontWeight: '800' }}>{activeAsset}</Text>
                  <Text style={{ color: '#64748b', fontSize: 10, fontWeight: 'bold' }}>▾</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: '#131927',
                    borderWidth: 1,
                    borderColor: '#223049',
                    borderRadius: 8,
                    paddingHorizontal: 9,
                    paddingVertical: 5,
                    gap: 5
                  }} 
                  onPress={() => setShowExpiryModal(true)}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '700' }}>
                    {activeExpiry ? new Date(activeExpiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : (expiries.length > 0 ? new Date(expiries[0]).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '27 Aug')}
                  </Text>
                  {selectedMarket !== 'CRYPTO' && (
                    <View style={{ backgroundColor: 'rgba(56, 189, 248, 0.15)', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                      <Text style={{ color: '#38bdf8', fontSize: 10, fontWeight: 'bold' }}>
                        {getDteLabel(activeExpiry || (expiries[0] || ''))}
                      </Text>
                    </View>
                  )}
                  <Text style={{ color: '#64748b', fontSize: 10, fontWeight: 'bold' }}>▾</Text>
                </TouchableOpacity>
              </View>

              {/* Toggles & ATM Button Container */}
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <TouchableOpacity 
                  style={[styles.snapAtmBtnSide, { backgroundColor: isRefreshing ? '#065f46' : '#161c28', borderColor: isRefreshing ? '#10b981' : '#232c3d', paddingHorizontal: 7 }]} 
                  onPress={triggerManualRefresh}
                  activeOpacity={0.6}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                >
                  <Text style={{ fontSize: 12 }}>🔄</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.snapAtmBtnSide} onPress={scrollToAtm}>
                  <Text style={styles.snapAtmBtnTextSide}>🎯 ATM ({headerAtmStrike.toLocaleString('en-IN')})</Text>
                </TouchableOpacity>

                <View style={styles.segmentContainerSide}>
                  <TouchableOpacity
                    style={[styles.segmentBtnSide, viewMode === 'LTP' && styles.segmentBtnActiveSide]}
                    onPress={() => setViewMode('LTP')}
                  >
                    <Text style={[styles.segmentTextSide, viewMode === 'LTP' && styles.segmentTextActiveSide]}>LTP</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.segmentBtnSide, viewMode === 'OI' && styles.segmentBtnActiveSide]}
                    onPress={() => setViewMode('OI')}
                  >
                    <Text style={[styles.segmentTextSide, viewMode === 'OI' && styles.segmentTextActiveSide]}>OI</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {/* Bottom Row: Spot Price Banner */}
            <View style={styles.spotPriceBanner}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                  <Text style={styles.spotBannerLabel}>{activeAsset}:</Text>
                  <Text style={[styles.spotPriceTextSide, { color: spotChange >= 0 ? '#00c087' : '#f84960' }]}>
                    {currSym}{spotPrice ? spotPrice.toLocaleString('en-IN', { minimumFractionDigits: selectedMarket === 'CRYPTO' ? 1 : 2 }) : '24,246.70'}
                  </Text>
                  <Text style={[styles.spotChangeTextSide, { color: spotChange >= 0 ? '#00c087' : '#f84960', marginLeft: 4 }]}>
                    {spotChange >= 0 ? `+${spotChange.toFixed(2)}` : spotChange.toFixed(2)} ({spotPercentChange >= 0 ? `+${spotPercentChange.toFixed(2)}%` : spotPercentChange.toFixed(2)}%)
                  </Text>
                  <TouchableOpacity 
                    onPress={triggerManualRefresh} 
                    style={{ marginLeft: 6, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5, backgroundColor: isRefreshing ? '#065f46' : 'rgba(16, 185, 129, 0.15)', borderWidth: 1, borderColor: isRefreshing ? '#10b981' : 'rgba(16, 185, 129, 0.4)' }}
                    hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                  >
                    <Text style={{ fontSize: 10 }}>🔄</Text>
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 6, flexShrink: 0 }}>
                  <Text style={{ color: '#8a95a5', fontSize: 10, fontWeight: 'bold' }}>
                    {selectedMarket === 'CRYPTO' ? 'Exp: ' : 'DTE: '}
                  </Text>
                  <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: 'bold' }}>
                    {calculateTimeToExpiry(activeExpiry, selectedMarket === 'CRYPTO')}
                  </Text>
                </View>
              </View>
            </View>

            {/* Market Closed & AMO Notice Banner for Indian/MCX/Stock markets */}
            {selectedMarket !== 'CRYPTO' && !marketOpen && (
              <View style={{
                backgroundColor: 'rgba(234, 179, 8, 0.12)',
                borderWidth: 1,
                borderColor: 'rgba(234, 179, 8, 0.35)',
                borderRadius: 8,
                paddingVertical: 5,
                paddingHorizontal: 10,
                marginTop: 6,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ fontSize: 11 }}>🌙</Text>
                  <Text style={{ color: '#eab308', fontSize: 10.5, fontWeight: '800' }}>
                    Market Closed (09:15-15:30 IST) • AMO Orders Active
                  </Text>
                </View>
                <View style={{ backgroundColor: 'rgba(234, 179, 8, 0.2)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                  <Text style={{ color: '#fef08a', fontSize: 9.5, fontWeight: 'bold' }}>AMO Mode ⚡</Text>
                </View>
              </View>
            )}
          </View>

          <FlatList
            ref={chainScrollRef}
            data={currentChain}
            keyExtractor={(item: any) => item.strike.toString()}
            style={styles.scrollArea}
            contentContainerStyle={{ paddingBottom: stratBasket.length > 0 ? 170 : 60 }}
            initialNumToRender={22}
            maxToRenderPerBatch={16}
            windowSize={11}
            removeClippedSubviews={Platform.OS === 'android'}
            getItemLayout={(_data, index) => ({
              length: 52,
              offset: 52 * index,
              index,
            })}
            ListHeaderComponent={
              <View style={styles.tableHeader}>
                <Text style={[styles.tableColTitle, { textAlign: 'left', flex: 1 }]}>
                  {viewMode === 'LTP' ? 'Call LTP' : 'Call OI (Contracts)'}
                </Text>
                <Text style={[styles.tableColTitle, { textAlign: 'center', width: 76 }]}>Strike</Text>
                <Text style={[styles.tableColTitle, { textAlign: 'right', flex: 1 }]}>
                  {viewMode === 'LTP' ? 'Put LTP' : 'Put OI (Contracts)'}
                </Text>
              </View>
            }
            renderItem={({ item: row, index: idx }: { item: any; index: number }) => {
              const sp = spotPrice || currConfig.defaultSpot;
              const isCallITM = row.strike < sp;
              const isPutITM = row.strike > sp;
              const nextRow = currentChain[idx + 1];
              const showSpotLine = nextRow && row.strike <= sp && nextRow.strike > sp;

              const callLtp = row.callMark || 0;
              const putLtp = row.putMark || 0;
              const callOI = row.callOI || 0;
              const putOI = row.putOI || 0;
              const callPch = row.callPchange !== undefined ? row.callPchange : 0;
              const putPch = row.putPchange !== undefined ? row.putPchange : 0;

              const callChangePct = getRealisticOptionPchange(true, row.strike, sp, spotPercentChange, callLtp, callPch);
              const putChangePct = getRealisticOptionPchange(false, row.strike, sp, spotPercentChange, putLtp, putPch);

              const isCallFocused = activeRowTarget?.strike === row.strike && activeRowTarget?.side === 'CALL';
              const isPutFocused = activeRowTarget?.strike === row.strike && activeRowTarget?.side === 'PUT';
              const callLeg = stratBasket.find(l => l.strike === row.strike && l.option_type === 'CALL');
              const putLeg = stratBasket.find(l => l.strike === row.strike && l.option_type === 'PUT');

              return (
                <View key={row.strike}>
                  <View style={styles.tableRow}>
                    {/* CALL SIDE */}
                    <TouchableOpacity
                      activeOpacity={0.82}
                      onPress={() => setActiveRowTarget(isCallFocused ? null : { strike: row.strike, side: 'CALL' })}
                      style={[styles.callCell, isCallITM && styles.itmCall, isCallFocused && { backgroundColor: 'rgba(0, 192, 135, 0.09)' }, { overflow: 'hidden' }]}
                    >
                      {viewMode === 'OI' && callOI > 0 && (
                        <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${(callOI / maxOI) * 100}%`, backgroundColor: 'rgba(0, 192, 135, 0.15)' }} />
                      )}
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <View style={{ flex: 1, paddingRight: 4 }}>
                          <Text style={styles.priceText} numberOfLines={1}>
                            {viewMode === 'LTP' ? `${currSym}${callLtp.toFixed(selectedMarket === 'CRYPTO' ? 1 : 2)}` : formatOI(callOI, activeAsset === 'NIFTY' ? null : 'CRYPTO')}
                          </Text>
                          <Text style={[styles.chngText, { color: callChangePct >= 0 ? '#00c087' : '#f84960' }]}>
                            {callChangePct >= 0 ? `+${callChangePct.toFixed(1)}%` : `${callChangePct.toFixed(1)}%`}
                          </Text>
                        </View>

                        {(isCallFocused || callLeg) ? (
                          <View style={styles.actionBadgesWrapper}>
                            <TouchableOpacity
                              style={[styles.growwBadge, styles.growwBadgeBuy, callLeg?.side === 'BUY' && styles.growwBadgeBuyActive]}
                              onPress={(e) => {
                                e.stopPropagation();
                                handleToggleLeg(row, 'CALL', 'BUY');
                              }}
                              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                            >
                              <Text style={[styles.growwBadgeText, { color: callLeg?.side === 'BUY' ? '#ffffff' : '#00c087' }]}>BUY</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.growwBadge, styles.growwBadgeSell, callLeg?.side === 'SELL' && styles.growwBadgeSellActive]}
                              onPress={(e) => {
                                e.stopPropagation();
                                handleToggleLeg(row, 'CALL', 'SELL');
                              }}
                              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                            >
                              <Text style={[styles.growwBadgeText, { color: callLeg?.side === 'SELL' ? '#ffffff' : '#f84960' }]}>SELL</Text>
                            </TouchableOpacity>
                          </View>
                        ) : (
                          viewMode === 'OI' ? (
                            <View style={[styles.subtleVolumeBarCall, { width: Math.max(10, Math.min(36, (callOI / 10000) * 3)) }]} />
                          ) : (
                            <View style={{ width: 1 }} />
                          )
                        )}
                      </View>
                    </TouchableOpacity>

                    {/* STRIKE PILLAR */}
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => setActiveRowTarget(null)}
                      style={[styles.strikeCell, (isCallFocused || isPutFocused) && styles.strikeCellFocused]}
                    >
                      <Text style={styles.strikeText}>{row.strike.toLocaleString('en-IN')}</Text>
                    </TouchableOpacity>

                    {/* PUT SIDE */}
                    <TouchableOpacity
                      activeOpacity={0.82}
                      onPress={() => setActiveRowTarget(isPutFocused ? null : { strike: row.strike, side: 'PUT' })}
                      style={[styles.putCell, isPutITM && styles.itmPut, isPutFocused && { backgroundColor: 'rgba(248, 73, 96, 0.09)' }, { overflow: 'hidden' }]}
                    >
                      {viewMode === 'OI' && putOI > 0 && (
                        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(putOI / maxOI) * 100}%`, backgroundColor: 'rgba(248, 73, 96, 0.15)' }} />
                      )}
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        {(isPutFocused || putLeg) ? (
                          <View style={styles.actionBadgesWrapper}>
                            <TouchableOpacity
                              style={[styles.growwBadge, styles.growwBadgeBuy, putLeg?.side === 'BUY' && styles.growwBadgeBuyActive]}
                              onPress={(e) => {
                                e.stopPropagation();
                                handleToggleLeg(row, 'PUT', 'BUY');
                              }}
                              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                            >
                              <Text style={[styles.growwBadgeText, { color: putLeg?.side === 'BUY' ? '#ffffff' : '#00c087' }]}>BUY</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.growwBadge, styles.growwBadgeSell, putLeg?.side === 'SELL' && styles.growwBadgeSellActive]}
                              onPress={(e) => {
                                e.stopPropagation();
                                handleToggleLeg(row, 'PUT', 'SELL');
                              }}
                              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                            >
                              <Text style={[styles.growwBadgeText, { color: putLeg?.side === 'SELL' ? '#ffffff' : '#f84960' }]}>SELL</Text>
                            </TouchableOpacity>
                          </View>
                        ) : (
                          viewMode === 'OI' ? (
                            <View style={[styles.subtleVolumeBarPut, { width: Math.max(10, Math.min(36, (putOI / 10000) * 3)) }]} />
                          ) : (
                            <View style={{ width: 1 }} />
                          )
                        )}

                        <View style={{ flex: 1, alignItems: 'flex-end', paddingLeft: 4 }}>
                          <Text style={styles.priceText} numberOfLines={1}>
                            {viewMode === 'LTP' ? `${currSym}${putLtp.toFixed(selectedMarket === 'CRYPTO' ? 1 : 2)}` : formatOI(putOI, activeAsset === 'NIFTY' ? null : 'CRYPTO')}
                          </Text>
                          <Text style={[styles.chngText, { color: putChangePct >= 0 ? '#00c087' : '#f84960' }]}>
                            {putChangePct >= 0 ? `+${putChangePct.toFixed(1)}%` : `${putChangePct.toFixed(1)}%`}
                          </Text>
                        </View>
                      </View>
                    </TouchableOpacity>
                  </View>

                  {showSpotLine && (
                    <View style={styles.spotLineContainer}>
                      <View style={styles.spotLine} />
                      <View style={styles.spotPill}>
                        <Text style={styles.spotPillText}>{activeAsset} {sp.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Text>
                      </View>
                    </View>
                  )}
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={{ padding: 40, alignItems: 'center' }}>
                <ActivityIndicator size="small" color="#38bdf8" />
                <Text style={{ color: '#707886', fontSize: 12, marginTop: 10 }}>Streaming live {activeAsset} option strikes...</Text>
              </View>
            }
          />

          {stratBasket.length > 0 && (
            <View style={styles.prominentStickyBar}>
              {/* Secondary Utility Row (Show Payoff & Clear) */}
              <View style={styles.stickyHeaderRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                  <View style={styles.stratBadgePill}>
                    <Text style={styles.stratBadgeText} numberOfLines={1}>
                      {detectStrategy(stratBasket) || `${stratBasket.length} Legs Selected`}
                    </Text>
                  </View>
                  <TouchableOpacity 
                    onPress={() => setShowPayoffModal(true)} 
                    style={styles.payoffGraphBtn}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.payoffGraphBtnText}>📈 Payoff & Greeks</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity 
                  onPress={() => setStratBasket([])} 
                  style={styles.clearBasketBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.clearBasketBtnText}>Clear 🗑</Text>
                </TouchableOpacity>
              </View>

              {/* Main Side-by-Side Row (Margin Details on Left, Place Order Button on Right) */}
              <View style={styles.stickyMainRow}>
                {/* Left Side: Margin Information (Column) */}
                <View style={styles.stickyMarginCol}>
                  {/* Order Margin Row */}
                  <View style={styles.marginRowItem}>
                    <Text style={styles.marginLabelText}>Order Margin</Text>
                    <Text style={styles.marginValueText}>
                      {currSym}{orderMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </Text>
                  </View>

                  {/* Available Margin Row */}
                  <View style={styles.marginRowItem}>
                    <Text style={styles.availMarginLabelText}>Avail. Margin</Text>
                    <Text style={[
                      styles.availMarginValueText,
                      { color: tradeLabStats.availableMargin <= 0 ? '#ef4444' : '#10b981' }
                    ]}>
                      {currSym}{tradeLabStats.availableMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </Text>
                  </View>
                </View>

                {/* Right Side: Place Order Button */}
                <TouchableOpacity 
                  style={[
                    styles.prominentPlaceOrderBtn,
                    orderMargin > tradeLabStats.availableMargin && styles.prominentPlaceOrderBtnDisabled
                  ]} 
                  onPress={handlePlaceOrder}
                  activeOpacity={0.85}
                >
                  <Text style={styles.prominentPlaceOrderBtnText}>
                    PLACE ORDER ({stratBasket.length})
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      )}

      {/* ===================== TAB 2: STRATEGY PAYOFF & GREEKS ===================== */}
      

      
      {/* ===================== PAYOFF MODAL ===================== */}
      <Modal visible={showPayoffModal} animationType="slide" transparent={true} onRequestClose={() => setShowPayoffModal(false)}>
        <View style={{ flex: 1, backgroundColor: '#0f172a', paddingTop: 40 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 16, borderBottomWidth: 1, borderColor: '#1e293b' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: 'white', fontSize: 18, fontWeight: 'bold' }}>{detectStrategy(stratBasket) || 'Strategy Payoff'}</Text>
              <TouchableOpacity 
                onPress={() => setShowGlossaryModal(true)} 
                style={{ 
                  backgroundColor: '#1e293b', 
                  width: 20, 
                  height: 20, 
                  borderRadius: 10, 
                  justifyContent: 'center', 
                  alignItems: 'center' 
                }}
              >
                <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: 'bold' }}>ⓘ</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => setShowPayoffModal(false)}>
              <Text style={{ color: '#38bdf8', fontSize: 16, fontWeight: 'bold' }}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1, padding: 16 }}>
            {/* Legs Editor */}
            {selectedMarket === 'CRYPTO' && stratBasket.some(l => l.side === 'SELL') && (
              <View style={{ marginBottom: 24, backgroundColor: '#1e293b', padding: 16, borderRadius: 8 }}>
                <Text style={{ color: 'white', fontSize: 14, fontWeight: 'bold', marginBottom: 12 }}>Adjust Leverage</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#0f172a', borderRadius: 6, padding: 4 }}>
                  <TouchableOpacity style={{ padding: 12 }} onPress={() => setCryptoLeverage(prev => Math.max(1, prev - 10))}>
                    <Text style={{ color: '#94a3b8', fontWeight: 'bold', fontSize: 18 }}>-</Text>
                  </TouchableOpacity>
                  <Text style={{ flex: 1, color: '#38bdf8', fontWeight: 'bold', textAlign: 'center', fontSize: 16 }}>{cryptoLeverage}x</Text>
                  <TouchableOpacity style={{ padding: 12 }} onPress={() => setCryptoLeverage(prev => Math.min(200, prev + 10))}>
                    <Text style={{ color: '#94a3b8', fontWeight: 'bold', fontSize: 18 }}>+</Text>
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
                  {[10, 50, 100, 200].map(val => (
                    <TouchableOpacity key={val} onPress={() => setCryptoLeverage(val)}>
                      <Text style={{ color: cryptoLeverage === val ? '#38bdf8' : '#64748b', fontWeight: 'bold' }}>{val}x</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            <View style={{ marginBottom: 24 }}>
              <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>Selected Legs</Text>
              {stratBasket.map((leg, idx) => (
                <View key={idx} style={{ backgroundColor: '#1e293b', padding: 8, paddingHorizontal: 12, borderRadius: 8, marginBottom: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    {/* B/S Side Badge */}
                    <TouchableOpacity 
                      onPress={() => toggleLegSide(idx)} 
                      style={{ 
                        width: 24, 
                        height: 24, 
                        borderRadius: 4, 
                        backgroundColor: leg.side === 'BUY' ? 'rgba(0, 192, 135, 0.2)' : 'rgba(248, 73, 96, 0.2)', 
                        borderColor: leg.side === 'BUY' ? '#00c087' : '#f84960',
                        borderWidth: 1,
                        justifyContent: 'center', 
                        alignItems: 'center',
                        marginRight: 6 
                      }}
                    >
                      <Text style={{ color: leg.side === 'BUY' ? '#00c087' : '#f84960', fontWeight: 'bold', fontSize: 12 }}>
                        {leg.side === 'BUY' ? 'B' : 'S'}
                      </Text>
                    </TouchableOpacity>

                    {/* C/P Option Type */}
                    <TouchableOpacity 
                      onPress={() => toggleLegOptionType(idx)} 
                      style={{ 
                        width: 24, 
                        height: 24, 
                        borderRadius: 4, 
                        backgroundColor: '#0f172a', 
                        justifyContent: 'center', 
                        alignItems: 'center',
                        marginRight: 6 
                      }}
                    >
                      <Text style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: 12 }}>
                        {leg.option_type === 'CALL' ? 'C' : 'P'}
                      </Text>
                    </TouchableOpacity>

                    {/* Strike Dropdown */}
                    <TouchableOpacity 
                      onPress={() => setPickerModal({ visible: true, type: 'strike', legIndex: idx })} 
                      style={{ 
                        minWidth: 54, 
                        height: 24, 
                        borderRadius: 4, 
                        backgroundColor: '#0f172a', 
                        justifyContent: 'center', 
                        alignItems: 'center',
                        paddingHorizontal: 4,
                        marginRight: 6 
                      }}
                    >
                      <Text style={{ color: 'white', fontSize: 11, fontWeight: 'bold' }}>{leg.strike} ▾</Text>
                    </TouchableOpacity>

                    {/* Expiry Dropdown */}
                    <TouchableOpacity 
                      onPress={() => setPickerModal({ visible: true, type: 'expiry', legIndex: idx })} 
                      style={{ 
                        minWidth: 54, 
                        height: 24, 
                        borderRadius: 4, 
                        backgroundColor: '#0f172a', 
                        justifyContent: 'center', 
                        alignItems: 'center',
                        paddingHorizontal: 4,
                        marginRight: 6 
                      }}
                    >
                      <Text style={{ color: 'white', fontSize: 10 }}>
                        {leg.expiry ? new Date(leg.expiry).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).replace(/ /g, '') : ''} ▾
                      </Text>
                    </TouchableOpacity>

                    {/* Qty Stepper */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#0f172a', borderRadius: 6, height: 26, paddingHorizontal: 3, borderWidth: 1, borderColor: '#1e293b' }}>
                      <TouchableOpacity 
                        activeOpacity={0.5}
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                        style={{ paddingHorizontal: 6, paddingVertical: 2 }} 
                        onPress={() => updateLegSize(idx, -1)}
                      >
                        <Text style={{ color: '#94a3b8', fontWeight: 'bold', fontSize: 13 }}>−</Text>
                      </TouchableOpacity>
                      
                      {selectedMarket === 'CRYPTO' ? (
                        <TextInput
                          keyboardType="numeric"
                          style={{ color: 'white', fontWeight: 'bold', width: 28, textAlign: 'center', fontSize: 11, padding: 0 }}
                          value={String(leg.size || 1)}
                          onChangeText={(text) => {
                            const val = Math.max(1, parseInt(text.replace(/[^0-9]/g, '')) || 0);
                            setStratBasket(prev => {
                              if (!prev[idx]) return prev;
                              const nb = [...prev];
                              nb[idx] = { ...nb[idx], size: val };
                              return nb;
                            });
                          }}
                        />
                      ) : (
                        <Text style={{ color: 'white', fontWeight: 'bold', width: 20, textAlign: 'center', fontSize: 11 }}>{leg.size || 1}</Text>
                      )}

                      <TouchableOpacity 
                        activeOpacity={0.5}
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                        style={{ paddingHorizontal: 6, paddingVertical: 2 }}
                        onPress={() => updateLegSize(idx, 1)}
                      >
                        <Text style={{ color: '#94a3b8', fontWeight: 'bold', fontSize: 13 }}>+</Text>
                      </TouchableOpacity>
                    </View>

                    {/* Delete Icon */}
                    <TouchableOpacity 
                      style={{ padding: 4, marginLeft: 4 }}
                      onPress={() => setStratBasket(prev => prev.filter((_, i) => i !== idx))}
                    >
                      <Text style={{ color: '#ef4444', fontWeight: 'bold', fontSize: 14 }}>🗑</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>

            {renderInteractivePayoffSvg()}

            {renderDeltaPayoffLegsTable()}
            
            <View style={{ marginTop: 20 }}>
              <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>Strategy Greeks</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#1e293b', padding: 16, borderRadius: 8 }}>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ color: '#94a3b8', fontSize: 12, marginBottom: 4 }}>Delta</Text>
                  <Text style={{ color: greeksData.netDelta >= 0 ? '#10b981' : '#ef4444', fontWeight: 'bold', fontSize: 16 }}>{greeksData.netDelta.toFixed(3)}</Text>
                </View>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ color: '#94a3b8', fontSize: 12, marginBottom: 4 }}>Theta</Text>
                  <Text style={{ color: greeksData.netTheta >= 0 ? '#10b981' : '#ef4444', fontWeight: 'bold', fontSize: 16 }}>{greeksData.netTheta.toFixed(1)}</Text>
                </View>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ color: '#94a3b8', fontSize: 12, marginBottom: 4 }}>Gamma</Text>
                  <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>{greeksData.netGamma.toFixed(4)}</Text>
                </View>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ color: '#94a3b8', fontSize: 12, marginBottom: 4 }}>Vega</Text>
                  <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>{greeksData.netVega.toFixed(1)}</Text>
                </View>
              </View>
            </View>

            <View style={{ marginTop: 24, marginBottom: 60 }}>
              <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>PnL at Expiry</Text>
              <View style={{ backgroundColor: '#1e293b', borderRadius: 8, overflow: 'hidden' }}>
                <View style={{ flexDirection: 'row', padding: 12, backgroundColor: '#0f172a', borderBottomWidth: 1, borderColor: '#334155' }}>
                  <Text style={{ flex: 1, color: '#94a3b8', fontSize: 12, fontWeight: 'bold' }}>Target Price</Text>
                  <Text style={{ flex: 1, color: '#94a3b8', fontSize: 12, fontWeight: 'bold', textAlign: 'right' }}>% Change</Text>
                  <Text style={{ flex: 1, color: '#94a3b8', fontSize: 12, fontWeight: 'bold', textAlign: 'right' }}>Est. PnL</Text>
                </View>
                {payoffStats.pnlTable && payoffStats.pnlTable.map((row: any, idx: number) => {
                  const sp = spotPrice || currConfig.defaultSpot;
                  const isCurrent = Math.abs(row.targetPrice - sp) < (sp * 0.005);
                  const pctDiff = (row.diff / sp) * 100;
                  return (
                    <View key={idx} style={{ flexDirection: 'row', padding: 12, borderBottomWidth: 1, borderColor: '#334155', backgroundColor: isCurrent ? 'rgba(56, 189, 248, 0.1)' : 'transparent' }}>
                      <Text style={{ flex: 1, color: 'white', fontSize: 14 }}>{row.targetPrice}</Text>
                      <Text style={{ flex: 1, color: row.diff >= 0 ? '#10b981' : '#ef4444', fontSize: 14, textAlign: 'right' }}>
                        {row.diff > 0 ? '+' : ''}{pctDiff.toFixed(2)}%
                      </Text>
                      <Text style={{ flex: 1, color: row.pnl >= 0 ? '#10b981' : '#ef4444', fontSize: 14, fontWeight: 'bold', textAlign: 'right' }}>
                        {row.pnl >= 0 ? '+' : '-'}{currSym}{Math.abs(row.pnl).toFixed(selectedMarket === 'CRYPTO' ? 2 : 0)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>

            {/* Order Margin, Available Margin & Place Order Button below PnL at Expiry */}
            <View style={{ backgroundColor: '#1e293b', padding: 16, borderRadius: 8, marginTop: 16, marginBottom: 24 }}>
              {orderMargin > tradeLabStats.availableMargin && (
                <View style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', padding: 10, borderRadius: 6, marginBottom: 12, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.3)' }}>
                  <Text style={{ color: '#ef4444', marginRight: 6, fontSize: 13 }}>⚠️</Text>
                  <Text style={{ color: '#fca5a5', fontSize: 12, fontWeight: 'bold', flex: 1 }}>Insufficient balance to place this order</Text>
                </View>
              )}
              
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={{ color: '#94a3b8', fontSize: 13, marginRight: 6 }}>Order Margin</Text>
                  <TouchableOpacity onPress={() => {}}>
                    <Text style={{ color: '#ff9800', fontSize: 13 }}>↻</Text>
                  </TouchableOpacity>
                </View>
                <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 14 }}>
                  {currSym}{orderMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </Text>
              </View>

              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <Text style={{ color: '#94a3b8', fontSize: 13 }}>Available Margin</Text>
                <Text style={{ color: tradeLabStats.availableMargin <= 0 ? '#ef4444' : '#10b981', fontWeight: 'bold', fontSize: 14 }}>
                  {currSym}{tradeLabStats.availableMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </Text>
              </View>

              <TouchableOpacity 
                style={{ 
                  backgroundColor: orderMargin > tradeLabStats.availableMargin ? '#5c371d' : '#f78d38', 
                  paddingVertical: 12, 
                  borderRadius: 6, 
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: orderMargin > tradeLabStats.availableMargin ? '#783c13' : 'transparent'
                }} 
                onPress={() => {
                  handlePlaceOrder();
                  setShowPayoffModal(false);
                }}
              >
                <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 14 }}>
                  Place Order ({stratBasket.length})
                </Text>
              </TouchableOpacity>
            </View>

            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>

      {/* ===================== STRATEGY GLOSSARY MODAL ===================== */}
      <Modal visible={showGlossaryModal} transparent={true} animationType="fade" onRequestClose={() => setShowGlossaryModal(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setShowGlossaryModal(false)}>
          <View style={{ backgroundColor: '#0f172a', width: '85%', borderRadius: 12, padding: 18, borderWidth: 1, borderColor: '#1e283d' }}>
            {(() => {
              const detected = detectStrategy(stratBasket) || 'Custom Strategy';
              let key = detected;
              if (detected === 'Long Call') key = 'Buy Call';
              if (detected === 'Long Put') key = 'Buy Put';
              if (detected === 'Iron Butterfly') key = 'Long Iron Butterfly';
              if (detected === 'Iron Condor') key = 'Long Iron Condor';
              
              const info = STRATEGY_GLOSSARY[key] || STRATEGY_GLOSSARY['Custom Strategy'];
              
              return (
                <View>
                  <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: 'bold', marginBottom: 12 }}>{detected} Glossary</Text>
                  
                  <View style={{ gap: 12 }}>
                    <View>
                      <Text style={{ color: '#64748b', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>Market View</Text>
                      <Text style={{ color: '#00c087', fontSize: 13, fontWeight: 'bold', marginTop: 2 }}>{info.view}</Text>
                    </View>
                    
                    <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)' }} />

                    <View>
                      <Text style={{ color: '#64748b', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>Purpose</Text>
                      <Text style={{ color: '#e2e8f0', fontSize: 12, marginTop: 2 }}>{info.purpose}</Text>
                    </View>

                    <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)' }} />
                    
                    <View>
                      <Text style={{ color: '#64748b', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>Strike Selection Rule</Text>
                      <Text style={{ color: '#e2e8f0', fontSize: 12, marginTop: 2 }}>{info.strike}</Text>
                    </View>

                    <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)' }} />
                    
                    <View>
                      <Text style={{ color: '#64748b', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>How it is Used</Text>
                      <Text style={{ color: '#e2e8f0', fontSize: 12, marginTop: 2 }}>{info.usage}</Text>
                    </View>
                  </View>
                  
                  <TouchableOpacity 
                    onPress={() => setShowGlossaryModal(false)}
                    style={{ backgroundColor: '#1e293b', borderRadius: 6, paddingVertical: 10, alignItems: 'center', marginTop: 20 }}
                  >
                    <Text style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: 13 }}>Got It</Text>
                  </TouchableOpacity>
                </View>
              );
            })()}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ===================== MODAL: INLINE STRATEGY PICKER (STRIKE/EXPIRY) ===================== */}
      <Modal visible={!!pickerModal?.visible} transparent animationType="fade" onRequestClose={() => setPickerModal(null)}>
        <TouchableOpacity 
          activeOpacity={1} 
          style={styles.modalOverlay} 
          onPress={() => setPickerModal(null)}
        >
          <View style={[styles.bottomSheet, { maxHeight: '60%' }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeaderRow}>
              <Text style={styles.sheetTitle}>
                Select {pickerModal?.type === 'strike' ? 'Strike Price' : 'Expiry Date'}
              </Text>
              <TouchableOpacity onPress={() => setPickerModal(null)}>
                <Text style={styles.sheetCloseBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ marginTop: 12 }}>
              {(() => {
                if (!pickerModal) return null;
                const { type, legIndex } = pickerModal;
                const leg = stratBasket[legIndex];
                if (!leg) return null;

                if (type === 'strike') {
                  const strikes = currentChain.map((r: any) => r.strike).sort((a: number, b: number) => a - b);
                  return strikes.map((st: number) => (
                    <TouchableOpacity
                      key={st}
                      style={[styles.sheetOptionRow, leg.strike === st && styles.sheetOptionSelected]}
                      onPress={() => {
                        changeLegStrike(legIndex, st);
                        setPickerModal(null);
                      }}
                    >
                      <Text style={[styles.sheetOptionText, leg.strike === st && { color: '#38bdf8', fontWeight: 'bold' }]}>
                        {st}
                      </Text>
                    </TouchableOpacity>
                  ));
                } else {
                  return expiries.map((exp: string) => {
                    const isSelected = activeExpiry === exp;
                    const dteStr = getDteLabel(exp);
                    const is0Dte = dteStr.includes('0 DTE');
                    const is1Dte = dteStr.includes('1 DTE');
                    return (
                      <TouchableOpacity
                        key={exp}
                        style={[
                          styles.sheetOptionRow, 
                          isSelected && styles.sheetOptionSelected,
                          { marginBottom: 8, paddingVertical: 12, paddingHorizontal: 12 }
                        ]}
                        onPress={() => {
                          setActiveExpiry(exp);
                          setShowExpiryModal(false);
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.sheetOptionText, isSelected && { color: '#38bdf8' }]}>
                            {new Date(exp).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
                          </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <View style={{
                            backgroundColor: is0Dte ? 'rgba(234, 179, 8, 0.18)' : is1Dte ? 'rgba(56, 189, 248, 0.18)' : 'rgba(255, 255, 255, 0.08)',
                            borderColor: is0Dte ? '#eab308' : is1Dte ? '#38bdf8' : 'transparent',
                            borderWidth: is0Dte || is1Dte ? 1 : 0,
                            paddingHorizontal: 8,
                            paddingVertical: 3,
                            borderRadius: 6
                          }}>
                            <Text style={{
                              color: is0Dte ? '#eab308' : is1Dte ? '#38bdf8' : '#94a3b8',
                              fontSize: 11,
                              fontWeight: '800'
                            }}>
                              {selectedMarket === 'CRYPTO' ? calculateTimeToExpiry(exp, true) : dteStr}
                            </Text>
                          </View>
                          {isSelected && <Text style={styles.checkIcon}>✓</Text>}
                        </View>
                      </TouchableOpacity>
                    );
                  });
                }
              })()}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ===================== TAB 3: TRADE LAB ===================== */}
      {activeTab === 'tradelab' && (
        <ScrollView style={styles.tabContentContainer} contentContainerStyle={{ paddingBottom: 60 }}>
          <View style={styles.tradeLabSubNav}>
            <TouchableOpacity
              style={[styles.tradeLabNavBtn, tradeLabSubTab === 'positions' && styles.tradeLabNavBtnActive]}
              onPress={() => setTradeLabSubTab('positions')}
            >
              <Text style={[styles.tradeLabNavText, tradeLabSubTab === 'positions' && styles.tradeLabNavTextActive]}>
                Active ({tradeLabStats.activePositionsList.length})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tradeLabNavBtn, (tradeLabSubTab === 'journal' || tradeLabSubTab === 'discover') && styles.tradeLabNavBtnActive]}
              onPress={() => setTradeLabSubTab('journal')}
            >
              <Text style={[styles.tradeLabNavText, (tradeLabSubTab === 'journal' || tradeLabSubTab === 'discover') && styles.tradeLabNavTextActive]}>
                📓 Trade Journal ({orderHistory.length})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tradeLabNavBtn, tradeLabSubTab === 'performance' && styles.tradeLabNavBtnActive]}
              onPress={() => setTradeLabSubTab('performance')}
            >
              <Text style={[styles.tradeLabNavText, tradeLabSubTab === 'performance' && styles.tradeLabNavTextActive]}>
                📊 Analytics
              </Text>
            </TouchableOpacity>
          </View>



          <View style={styles.executivePortfolioCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }}>Executive Summary</Text>
              <TouchableOpacity
                onPress={triggerManualRefresh}
                style={{ backgroundColor: 'rgba(16, 185, 129, 0.15)', borderWidth: 1, borderColor: '#10b981', width: 28, height: 28, borderRadius: 6, justifyContent: 'center', alignItems: 'center' }}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              >
                <Text style={{ fontSize: 12 }}>🔄</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.execTopRow}>
              <View>
                <Text style={styles.execPortfolioValue}>
                  {currSym}{tradeLabStats.totalPortfolio.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </Text>
                <Text style={styles.execSubtitle}>Total Portfolio ⓘ</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[styles.execPnlValue, { color: tradeLabStats.totalUnrealisedPnl >= 0 ? '#00c087' : '#f84960' }]}>
                  {tradeLabStats.totalUnrealisedPnl >= 0 ? `+${currSym}${tradeLabStats.totalUnrealisedPnl.toFixed(2)}` : `-${currSym}${Math.abs(tradeLabStats.totalUnrealisedPnl).toFixed(2)}`}
                </Text>
                <Text style={styles.execSubtitle}>Unrealised P&L</Text>
              </View>
            </View>

            <View style={styles.execDivider} />

            <View style={styles.execBottomRow}>
              <View>
                <Text style={styles.execLabelText}>Available Margin</Text>
                <Text style={styles.execAmountText}>
                  {currSym}{tradeLabStats.availableMargin.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.execLabelText}>Invested Margin</Text>
                <Text style={styles.execAmountText}>
                  {currSym}{tradeLabStats.totalInvestedMargin.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </Text>
              </View>
            </View>
          </View>

          {/* TAB: ACTIVE POSITIONS */}
          {tradeLabSubTab === 'positions' && (
            <View style={{ marginTop: 10 }}>
              {tradeLabStats.activePositionsList.length > 0 ? (
                tradeLabStats.activePositionsList.map((pos, idx) => {
                  const posSym = pos.currency === 'USD' ? '$' : '₹';
                  const isCrypto = pos.currency === 'USD';
                  const isBuy = pos.side === 'BUY';
                  const hasActiveSL = pos.stoploss > 0;
                  const hasActiveTgt = pos.target > 0;

                  return (
                    <View key={idx} style={styles.tradeLabPositionCard}>
                      <View style={styles.tradeLabPosHeader}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
                          <View style={{
                            backgroundColor: isBuy ? 'rgba(0, 192, 135, 0.15)' : 'rgba(248, 73, 96, 0.15)',
                            paddingHorizontal: 6,
                            paddingVertical: 2,
                            borderRadius: 4,
                            borderWidth: 1,
                            borderColor: isBuy ? 'rgba(0, 192, 135, 0.4)' : 'rgba(248, 73, 96, 0.4)'
                          }}>
                            <Text style={{ color: isBuy ? '#00c087' : '#f84960', fontSize: 10, fontWeight: 'bold' }}>
                              {pos.side}
                            </Text>
                          </View>
                          <Text style={styles.tradeLabContractName} numberOfLines={1}>{pos.symbol}</Text>
                          <View style={{ backgroundColor: '#1e293b', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                            <Text style={{ color: '#94a3b8', fontSize: 9.5, fontWeight: 'bold' }}>{pos.productType || 'NRML'}</Text>
                          </View>
                          {pos.orderMode === 'AMO' && (
                            <View style={{ backgroundColor: 'rgba(234, 179, 8, 0.18)', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                              <Text style={{ color: '#eab308', fontSize: 9, fontWeight: 'bold' }}>AMO</Text>
                            </View>
                          )}
                        </View>
                        <View style={{ alignItems: 'flex-end', flexShrink: 0 }}>
                          <Text style={[styles.tradeLabPosPnl, { color: pos.legPnl >= 0 ? '#00c087' : '#f84960' }]}>
                            {pos.legPnl >= 0 ? `+${posSym}${pos.legPnl.toFixed(isCrypto ? 2 : 0)}` : `-${posSym}${Math.abs(pos.legPnl).toFixed(isCrypto ? 2 : 0)}`}
                          </Text>
                          <Text style={[styles.tradeLabPosPct, { color: pos.legPnl >= 0 ? '#00c087' : '#f84960' }]}>
                            ({pos.pctChange >= 0 ? `+${pos.pctChange.toFixed(2)}%` : `${pos.pctChange.toFixed(2)}%`})
                          </Text>
                        </View>
                      </View>

                      <View style={styles.tradeLabPosSubRow}>
                        <Text style={styles.tradeLabQtyStatusText}>
                          {pos.qty} Qty • Avg <Text style={{ color: '#ffffff', fontWeight: 'bold' }}>{posSym}{pos.entry?.toFixed(isCrypto ? 2 : 0)}</Text>
                        </Text>
                        <Text style={styles.tradeLabLtpText}>
                          LTP: <Text style={{ color: '#ffffff', fontWeight: 'bold' }}>{posSym}{pos.ltp?.toFixed(isCrypto ? 2 : 0)}</Text>
                        </Text>
                      </View>

                      {/* GTT SL & Target Status Row */}
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#090d16', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, marginTop: 8 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={{ color: '#64748b', fontSize: 10, fontWeight: 'bold' }}>GTT:</Text>
                          {hasActiveSL ? (
                            <View style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 }}>
                              <Text style={{ color: '#f87171', fontSize: 9.5, fontWeight: '700' }}>
                                SL: {pos.stoplossType === 'PERCENT' ? `${pos.stoploss}%` : `${posSym}${pos.stoploss}`}
                              </Text>
                            </View>
                          ) : (
                            <Text style={{ color: '#475569', fontSize: 9.5, fontStyle: 'italic' }}>No SL</Text>
                          )}
                          {hasActiveTgt ? (
                            <View style={{ backgroundColor: 'rgba(16, 185, 129, 0.15)', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 }}>
                              <Text style={{ color: '#34d399', fontSize: 9.5, fontWeight: '700' }}>
                                TGT: {pos.targetType === 'PERCENT' ? `${pos.target}%` : `${posSym}${pos.target}`}
                              </Text>
                            </View>
                          ) : (
                            <Text style={{ color: '#475569', fontSize: 9.5, fontStyle: 'italic' }}>No Target</Text>
                          )}
                        </View>
                        <TouchableOpacity 
                          onPress={() => openModifyPositionModal(pos)}
                          style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: 'rgba(56, 189, 248, 0.12)' }}
                          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                        >
                          <Text style={{ color: '#38bdf8', fontSize: 10, fontWeight: '700' }}>Set SL/TGT ⚙️</Text>
                        </TouchableOpacity>
                      </View>

                      <View style={[styles.tradeLabPosSubRow, { marginTop: 8, paddingTop: 6, borderTopWidth: 1, borderColor: '#172033' }]}>
                        <TouchableOpacity 
                          style={[styles.tradeLabModifyBtn, { flex: 1, marginRight: 6 }]} 
                          onPress={() => openModifyPositionModal(pos)}
                        >
                          <Text style={styles.tradeLabModifyBtnText}>Modify Order</Text>
                        </TouchableOpacity>
                        <TouchableOpacity 
                          style={[styles.tradeLabCloseBtn, { flex: 1, marginLeft: 6 }]} 
                          onPress={() => handleCloseSinglePosition(pos.positionId, pos.symbol)}
                        >
                          <Text style={styles.tradeLabCloseBtnText}>Exit Position ✕</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })
              ) : (
                <View style={{ padding: 30, alignItems: 'center' }}>
                  <Text style={styles.emptyNotice}>No active positions currently running.</Text>
                  <TouchableOpacity style={styles.openReadyModalBtn} onPress={() => setActiveTab('chain')}>
                    <Text style={styles.openReadyModalBtnText}>📊 Go to Option Chain</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* TAB: TRADE JOURNAL (PERMANENT CLOSED POSITIONS) */}
          {(tradeLabSubTab === 'journal' || tradeLabSubTab === 'discover') && (
            <View style={{ marginTop: 10 }}>
              <View style={styles.perfSummaryGrid}>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Journal Realised P&L</Text>
                  <Text style={[styles.perfMetricVal, { color: tradeLabStats.totalRealisedPnl >= 0 ? '#00c087' : '#f84960' }]}>
                    {tradeLabStats.totalRealisedPnl >= 0 ? `+${currSym}${tradeLabStats.totalRealisedPnl.toFixed(2)}` : `-${currSym}${Math.abs(tradeLabStats.totalRealisedPnl).toFixed(2)}`}
                  </Text>
                </View>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Win Rate</Text>
                  <Text style={[styles.perfMetricVal, { color: '#38bdf8' }]}>
                    {tradeLabStats.winRate.toFixed(1)}%
                  </Text>
                </View>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Closed Trades</Text>
                  <Text style={styles.perfMetricVal}>
                    {orderHistory.length}
                  </Text>
                </View>
              </View>

              {renderJournalEquityCurve()}
              {renderJournalCalendarHeatmap()}

              <Text style={[styles.sectionHeader, { marginTop: 16, fontSize: 13 }]}>
                📓 Logged Closed Positions ({orderHistory.length})
              </Text>

              {orderHistory.length > 0 ? (
                orderHistory.map((item: any, idx: number) => {
                  const pnl = Number(item.realized_pnl) || 0;
                  const roi = Number(item.roi_pct) || 0;
                  const legs = item.legs || [];
                  const closedTime = item.closed_at ? new Date(item.closed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'Recently';
                  const closedDate = item.closed_at ? new Date(item.closed_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';

                  const firstLegAsset = legs[0]?.underlying || 'BTC';
                  const isCrypto = firstLegAsset === 'BTC' || firstLegAsset === 'ETH' || firstLegAsset === 'XAUT';
                  const posSym = isCrypto ? '$' : '₹';
                  return (
                    <View key={idx} style={styles.journalEntryCard}>
                      <View style={styles.journalEntryHeader}>
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text style={styles.journalBasketName}>{item.basket_name || 'Closed Strategy'}</Text>
                            <Text style={{ color: pnl >= 0 ? '#00c087' : '#f84960', fontSize: 10, fontWeight: 'bold' }}>
                              ● {pnl >= 0 ? 'WIN' : 'LOSS'}
                            </Text>
                          </View>
                          <Text style={styles.journalTimestampText}>
                            Settle: {closedDate} {closedTime} • ID: #{item.id}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={[styles.journalPnlText, { color: pnl >= 0 ? '#00c087' : '#f84960' }]}>
                            {pnl >= 0 ? `+${posSym}${pnl.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : `-${posSym}${Math.abs(pnl).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}
                          </Text>
                          <Text style={[styles.journalRoiText, { color: pnl >= 0 ? '#00c087' : '#f84960' }]}>
                            {roi >= 0 ? `+${roi.toFixed(1)}% ROI` : `${roi.toFixed(1)}% ROI`}
                          </Text>
                        </View>
                      </View>

                      {/* Legs Breakdown */}
                      {legs.length > 0 && (
                        <View style={styles.journalLegsContainer}>
                          {legs.map((leg: any, lIdx: number) => {
                            const legPnl = Number(leg.realized_pnl) || 0;
                            const pts = Number(leg.points_captured) || 0;
                            return (
                              <View key={lIdx} style={styles.journalLegRow}>
                                <View style={{ flex: 1.5 }}>
                                  <Text style={styles.journalLegSymbol}>
                                    {leg.symbol || `${leg.strike} ${leg.option_type} (${leg.side})`}
                                  </Text>
                                  <Text style={styles.journalLegPrices}>
                                    {Number(leg.entry_price).toFixed(isCrypto ? 2 : 0)} → {Number(leg.close_price || leg.entry_price).toFixed(isCrypto ? 2 : 0)} ({pts >= 0 ? `+${pts.toFixed(1)}` : pts.toFixed(1)} pts)
                                  </Text>
                                </View>
                                <View style={{ alignItems: 'flex-end', flex: 1 }}>
                                  <Text style={[styles.journalLegPnl, { color: legPnl >= 0 ? '#00c087' : '#f84960' }]}>
                                    {legPnl >= 0 ? `+${posSym}${legPnl.toFixed(isCrypto ? 1 : 0)}` : `-${posSym}${Math.abs(legPnl).toFixed(isCrypto ? 1 : 0)}`}
                                  </Text>
                                  <Text style={styles.journalLegQty}>Qty: {leg.size * (leg.lot_size || lotSize)}</Text>
                                </View>
                              </View>
                            );
                          })}
                        </View>
                      )}
                    </View>
                  );
                })
              ) : (
                <View style={{ padding: 24, alignItems: 'center' }}>
                  <Text style={styles.emptyNotice}>No closed trades logged yet.</Text>
                  <Text style={[styles.emptyNotice, { fontSize: 11, marginTop: 4 }]}>
                    When you close any active position, its full P&L and execution history will automatically appear here.
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* TAB: ANALYTICS */}
          {tradeLabSubTab === 'performance' && (
            <View style={{ marginTop: 10 }}>
              <View style={styles.perfSummaryGrid}>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Realised P&L</Text>
                  <Text style={[styles.perfMetricVal, { color: tradeLabStats.totalRealisedPnl >= 0 ? '#00c087' : '#f84960' }]}>
                    {tradeLabStats.totalRealisedPnl >= 0 ? `+${currSym}${tradeLabStats.totalRealisedPnl.toFixed(2)}` : `-${currSym}${Math.abs(tradeLabStats.totalRealisedPnl).toFixed(2)}`}
                  </Text>
                </View>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Win Rate</Text>
                  <Text style={[styles.perfMetricVal, { color: '#38bdf8' }]}>
                    {tradeLabStats.winRate.toFixed(1)}%
                  </Text>
                </View>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Total Trades</Text>
                  <Text style={styles.perfMetricVal}>
                    {orderHistory.length}
                  </Text>
                </View>
              </View>

              <View style={[styles.perfSummaryGrid, { marginTop: 8 }]}>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Best Trade</Text>
                  <Text style={[styles.perfMetricVal, { color: '#00c087' }]}>
                    +{currSym}{tradeLabStats.bestTrade.toFixed(2)}
                  </Text>
                </View>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Worst Trade</Text>
                  <Text style={[styles.perfMetricVal, { color: '#f84960' }]}>
                    -{currSym}{Math.abs(tradeLabStats.worstTrade).toFixed(2)}
                  </Text>
                </View>
              </View>

              {/* Sub-Accounts Manager */}
              <View style={styles.accountManagerCard}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <Text style={styles.accountManagerTitle}>💼 Sub-Accounts Manager ({accounts.length}/10)</Text>
                  {accounts.length < 10 && !isCreatingAccount && (
                    <TouchableOpacity 
                      style={styles.addAccountHeaderBtn} 
                      onPress={() => setIsCreatingAccount(true)}
                    >
                      <Text style={styles.addAccountHeaderBtnText}>+ Create Account</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {/* Create New Account Inline Panel */}
                {isCreatingAccount && (
                  <View style={styles.createAccountForm}>
                    <Text style={styles.formSectionHeader}>New Sub-Account ({currency})</Text>
                    <TextInput
                      style={styles.accountInput}
                      placeholder="Account Name (e.g. BTC Arbitrage)"
                      placeholderTextColor="#64748b"
                      value={newAccountName}
                      onChangeText={setNewAccountName}
                    />
                    <TextInput
                      style={styles.accountInput}
                      placeholder={`Initial Balance (${currSym})`}
                      placeholderTextColor="#64748b"
                      keyboardType="numeric"
                      value={newAccountBalance}
                      onChangeText={setNewAccountBalance}
                    />
                    <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                      <TouchableOpacity style={styles.formSubmitBtn} onPress={handleCreateAccount}>
                        <Text style={styles.formSubmitBtnText}>Create</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.formCancelBtn} onPress={() => {
                        setIsCreatingAccount(false);
                        setNewAccountName('');
                        setNewAccountBalance('');
                      }}>
                        <Text style={styles.formCancelBtnText}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {/* Account Edit Modal / Panel */}
                {editingAccount && (
                  <View style={styles.createAccountForm}>
                    <Text style={styles.formSectionHeader}>Edit Account: {editingAccount.name}</Text>
                    <TextInput
                      style={styles.accountInput}
                      placeholder="Account Name"
                      placeholderTextColor="#64748b"
                      value={editAccountName}
                      onChangeText={setEditAccountName}
                    />
                    <TextInput
                      style={styles.accountInput}
                      placeholder={`Balance (${currSym})`}
                      placeholderTextColor="#64748b"
                      keyboardType="numeric"
                      value={editAccountBalance}
                      onChangeText={setEditAccountBalance}
                    />
                    <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                      <TouchableOpacity style={styles.formSubmitBtn} onPress={handleUpdateAccount}>
                        <Text style={styles.formSubmitBtnText}>Save</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.formCancelBtn} onPress={() => setEditingAccount(null)}>
                        <Text style={styles.formCancelBtnText}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {/* Accounts List */}
                <View style={{ gap: 8 }}>
                  {accounts.map((acc: any) => {
                    const isActive = acc.id === activeAccountId;
                    return (
                      <View 
                        key={acc.id} 
                        style={[
                          styles.accountListItem,
                          isActive && styles.activeAccountListItem
                        ]}
                      >
                        <TouchableOpacity 
                          style={{ flex: 1 }}
                          onPress={() => {
                            setActiveAccountId(acc.id);
                          }}
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <View style={[styles.accountRadioCircle, isActive && styles.activeAccountRadioCircle]}>
                              {isActive && <View style={styles.activeRadioInner} />}
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.accountListName, isActive && styles.activeAccountListName]} numberOfLines={1}>
                                {acc.name}
                              </Text>
                              <Text style={styles.accountListMarginType}>
                                Margin: {acc.margin_type} • ID: {acc.id}
                              </Text>
                            </View>
                          </View>
                        </TouchableOpacity>

                        <View style={{ alignItems: 'flex-end', gap: 4 }}>
                          <Text style={styles.accountListBalance}>
                            {currSym}{Number(acc.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </Text>
                          <View style={{ flexDirection: 'row', gap: 12 }}>
                            <TouchableOpacity onPress={() => startEditingAccount(acc)}>
                              <Text style={styles.accountActionTextEdit}>Edit</Text>
                            </TouchableOpacity>
                            {accounts.length > 1 && (
                              <TouchableOpacity onPress={() => handleDeleteAccount(acc.id)}>
                                <Text style={styles.accountActionTextDelete}>Delete</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        </View>
                      </View>
                    );
                  })}
                </View>
              </View>
            </View>
          )}

          {tradeLabSubTab === 'discover' && (
            <View style={{ marginTop: 10 }}>
              <Text style={[styles.sectionHeader, { fontSize: 13 }]}>16 Ready-Made Market Strategies</Text>
              {READY_STRATEGIES.slice(0, 8).map((strat, i) => (
                <TouchableOpacity key={i} style={styles.readyStrategyCard} onPress={() => applyReadyStrategy(strat)}>
                  <View style={styles.readyStratTop}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={[
                        styles.readyStratViewTag,
                        strat.view === 'BULLISH' ? styles.tagBullish :
                        strat.view === 'BEARISH' ? styles.tagBearish :
                        strat.view === 'NEUTRAL' ? styles.tagNeutral : styles.tagVolatile
                      ]}>
                        {strat.view}
                      </Text>
                      <Text style={styles.readyStratName}>{strat.name}</Text>
                    </View>
                    <Text style={styles.readyStratTagPill}>Risk: {strat.risk}</Text>
                  </View>
                  <Text style={styles.readyStratDesc}>{strat.desc}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {/* ===================== MODAL: 16 READY-MADE STRATEGIES ===================== */}
      <Modal visible={showReadyModal} transparent animationType="slide" onRequestClose={() => setShowReadyModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowReadyModal(false)} />
          <View style={[styles.bottomSheet, { maxHeight: '85%' }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeaderRow}>
              <View>
                <Text style={styles.sheetTitle}>Ready-Made Strategies ({filteredReadyStrategies.length})</Text>
                <Text style={styles.sheetOptionSubText}>Auto-constructs ATM/OTM legs with live strikes</Text>
              </View>
              <TouchableOpacity onPress={() => setShowReadyModal(false)}>
                <Text style={styles.sheetCloseBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.marketViewsScroll}>
              <TouchableOpacity
                style={[styles.viewFilterPill, selectedMarketView === 'ALL' && styles.viewFilterPillActive]}
                onPress={() => setSelectedMarketView('ALL')}
              >
                <Text style={[styles.viewFilterText, selectedMarketView === 'ALL' && styles.viewFilterTextActive]}>All (16)</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.viewFilterPill, selectedMarketView === 'BULLISH' && styles.viewFilterBullishActive]}
                onPress={() => setSelectedMarketView('BULLISH')}
              >
                <Text style={[styles.viewFilterText, selectedMarketView === 'BULLISH' && { color: '#00c087' }]}>🟢 Bullish (4)</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.viewFilterPill, selectedMarketView === 'BEARISH' && styles.viewFilterBearishActive]}
                onPress={() => setSelectedMarketView('BEARISH')}
              >
                <Text style={[styles.viewFilterText, selectedMarketView === 'BEARISH' && { color: '#f84960' }]}>🔴 Bearish (4)</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.viewFilterPill, selectedMarketView === 'NEUTRAL' && styles.viewFilterNeutralActive]}
                onPress={() => setSelectedMarketView('NEUTRAL')}
              >
                <Text style={[styles.viewFilterText, selectedMarketView === 'NEUTRAL' && { color: '#f59e0b' }]}>🟡 Neutral (4)</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.viewFilterPill, selectedMarketView === 'VOLATILE' && styles.viewFilterVolatileActive]}
                onPress={() => setSelectedMarketView('VOLATILE')}
              >
                <Text style={[styles.viewFilterText, selectedMarketView === 'VOLATILE' && { color: '#a855f7' }]}>🟣 Volatile (4)</Text>
              </TouchableOpacity>
            </ScrollView>

            <ScrollView style={{ maxHeight: 420 }}>
              {filteredReadyStrategies.map((strat, i) => (
                <TouchableOpacity key={i} style={styles.readyStrategyCard} onPress={() => applyReadyStrategy(strat)}>
                  <View style={styles.readyStratTop}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={[
                        styles.readyStratViewTag,
                        strat.view === 'BULLISH' ? styles.tagBullish :
                        strat.view === 'BEARISH' ? styles.tagBearish :
                        strat.view === 'NEUTRAL' ? styles.tagNeutral : styles.tagVolatile
                      ]}>
                        {strat.view}
                      </Text>
                      <Text style={styles.readyStratName}>{strat.name}</Text>
                    </View>
                    <View style={styles.readyStratTags}>
                      <Text style={styles.readyStratTagPill}>Risk: {strat.risk}</Text>
                      <Text style={styles.readyStratTagPill}>Reward: {strat.reward}</Text>
                    </View>
                  </View>
                  <Text style={styles.readyStratDesc}>{strat.desc}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ===================== MODAL: ASSET SELECTOR ===================== */}
      <Modal visible={showAssetModal} transparent animationType="slide" onRequestClose={() => setShowAssetModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowAssetModal(false)} />
          <View style={[styles.bottomSheet, { maxHeight: '82%' }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeaderRow}>
              <Text style={styles.sheetTitle}>Select Underlying Asset</Text>
              <TouchableOpacity onPress={() => setShowAssetModal(false)}>
                <Text style={styles.sheetCloseBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ marginTop: 8 }}>
              {(selectedMarket ? [selectedMarket] : ['INDIAN', 'STOCKS', 'COMMODITY', 'CRYPTO']).map(marketCat => {
                const assetsInCat = Object.keys(ASSET_CONFIG).filter(k => ASSET_CONFIG[k].category === marketCat);
                if (!assetsInCat.length) return null;
                const catTitle = 
                  marketCat === 'INDIAN' ? '🇮🇳 INDIAN BENCHMARK INDICES (NSE & BSE)' : 
                  marketCat === 'STOCKS' ? '📈 NSE STOCK OPTIONS (F&O HEAVYWEIGHTS)' : 
                  marketCat === 'COMMODITY' ? '🛢️ MCX COMMODITIES' : '⚡ CRYPTO DERIVATIVES';
                return (
                  <View key={marketCat} style={{ marginBottom: 16 }}>
                    <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginBottom: 8, paddingHorizontal: 4 }}>
                      {catTitle}
                    </Text>
                    {assetsInCat.map(assetKey => {
                      const conf = ASSET_CONFIG[assetKey];
                      const isSelected = activeAsset === assetKey;
                      const live = liveMarketPrices[assetKey] || { spot: 0, change: 0, pctChange: 0 };
                      const isUp = live.change >= 0;
                      return (
                        <TouchableOpacity
                          key={assetKey}
                          style={[styles.sheetOptionRow, isSelected && styles.sheetOptionSelected, { marginBottom: 8 }]}
                          onPress={() => {
                            selectAssetAndTrade(assetKey);
                            setShowAssetModal(false);
                          }}
                        >
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Text style={[styles.sheetOptionText, isSelected && { color: '#38bdf8' }]}>{assetKey}</Text>
                              <View style={{ backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                                <Text style={{ color: '#94a3b8', fontSize: 9.5, fontWeight: 'bold' }}>{conf.exchange}</Text>
                              </View>
                            </View>
                            <Text style={styles.sheetOptionSubText}>{conf.name} • Lot: {conf.lotSize} {conf.lotUnit}</Text>
                          </View>
                          <View style={{ alignItems: 'flex-end', marginRight: isSelected ? 8 : 0 }}>
                            <Text style={{ color: isUp ? '#00c087' : '#f84960', fontSize: 13, fontWeight: 'bold' }}>
                              {conf.symbol}{live.spot ? live.spot.toLocaleString('en-IN', { minimumFractionDigits: marketCat === 'CRYPTO' ? 1 : 2 }) : conf.defaultSpot.toLocaleString('en-IN')}
                            </Text>
                            <Text style={{ color: isUp ? '#00c087' : '#f84960', fontSize: 10.5, fontWeight: '600' }}>
                              {isUp ? '+' : ''}{live.pctChange.toFixed(2)}%
                            </Text>
                          </View>
                          {isSelected && <Text style={styles.checkIcon}>✓</Text>}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ===================== MODAL: EXPIRY SELECTOR ===================== */}
      <Modal visible={showExpiryModal} transparent animationType="slide" onRequestClose={() => setShowExpiryModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowExpiryModal(false)} />
          <View style={[styles.bottomSheet, { maxHeight: '72%' }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeaderRow}>
              <View>
                <Text style={styles.sheetTitle}>Select Expiration Date</Text>
                <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '700', marginTop: 2 }}>
                  {activeAsset} Weekly & Monthly Expiries
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowExpiryModal(false)}>
                <Text style={styles.sheetCloseBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ marginTop: 8 }}>
              {expiries.map(exp => {
                const isSelected = activeExpiry === exp;
                const dteStr = getDteLabel(exp);
                const is0Dte = dteStr.includes('0 DTE');
                const is1Dte = dteStr.includes('1 DTE');
                return (
                  <TouchableOpacity
                    key={exp}
                    style={[
                      styles.sheetOptionRow, 
                      isSelected && styles.sheetOptionSelected,
                      { marginBottom: 8, paddingVertical: 12, paddingHorizontal: 12 }
                    ]}
                    onPress={() => {
                      setActiveExpiry(exp);
                      setShowExpiryModal(false);
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.sheetOptionText, isSelected && { color: '#38bdf8' }]}>
                        {new Date(exp).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{
                        backgroundColor: is0Dte ? 'rgba(234, 179, 8, 0.18)' : is1Dte ? 'rgba(56, 189, 248, 0.18)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: is0Dte ? '#eab308' : is1Dte ? '#38bdf8' : 'transparent',
                        borderWidth: is0Dte || is1Dte ? 1 : 0,
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        borderRadius: 6
                      }}>
                        <Text style={{
                          color: is0Dte ? '#eab308' : is1Dte ? '#38bdf8' : '#94a3b8',
                          fontSize: 11,
                          fontWeight: '800'
                        }}>
                          {selectedMarket === 'CRYPTO' ? calculateTimeToExpiry(exp, true) : dteStr}
                        </Text>
                      </View>
                      {isSelected && <Text style={styles.checkIcon}>✓</Text>}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
      {/* ===================== MODAL: PROFESSIONAL ORDER PLACEMENT (ZERODHA/DELTA STYLE) ===================== */}
      <Modal visible={showOrderModal} transparent animationType="slide" onRequestClose={() => setShowOrderModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowOrderModal(false)} />
          <View style={[styles.bottomSheet, { maxHeight: '92%', backgroundColor: '#0b0f19', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderColor: '#1e293b' }]}>
            <View style={styles.sheetHandle} />

            {/* Header with Side Badge and Contract Info */}
            {(() => {
              const leg = orderModalLeg || (stratBasket.length > 0 ? stratBasket[0] : null);
              if (!leg) return null;

              const isBuy = leg.side === 'BUY';
              const legAsset = leg.underlying || activeAsset;
              const legLotSize = ASSET_CONFIG[legAsset]?.lotSize || (
                legAsset === 'NIFTY' ? 65 : 
                (legAsset === 'BANKNIFTY' ? 30 : 
                (legAsset === 'CRUDEOIL' ? 100 : 
                (legAsset === 'GOLD' ? 100 : 
                (legAsset === 'SILVER' ? 30 : 
                (legAsset === 'BTC' ? 0.001 : 
                (legAsset === 'ETH' ? 0.01 : 1.0))))))
              );
              const totalUnits = (orderLots || 1) * legLotSize;
              const ltp = leg.price || 0;
              const posSym = legAsset === 'BTC' || legAsset === 'ETH' || legAsset === 'XAUT' ? '$' : '₹';

              // Projected SL & Target calculations
              const slNum = hasStoploss ? parseFloat(slValue) || 0 : 0;
              const tgtNum = hasTarget ? parseFloat(targetValue) || 0 : 0;

              let projectedSlPrice = 0;
              let projectedSlLoss = 0;
              if (hasStoploss && slNum > 0 && ltp > 0) {
                if (slMode === 'PERCENT') {
                  projectedSlPrice = isBuy ? ltp * (1 - slNum / 100) : ltp * (1 + slNum / 100);
                  projectedSlLoss = (ltp * (slNum / 100)) * totalUnits;
                } else {
                  projectedSlPrice = slNum;
                  projectedSlLoss = isBuy ? (ltp - slNum) * totalUnits : (slNum - ltp) * totalUnits;
                }
              }

              let projectedTgtPrice = 0;
              let projectedTgtProfit = 0;
              if (hasTarget && tgtNum > 0 && ltp > 0) {
                if (targetMode === 'PERCENT') {
                  projectedTgtPrice = isBuy ? ltp * (1 + tgtNum / 100) : ltp * (1 - tgtNum / 100);
                  projectedTgtProfit = (ltp * (tgtNum / 100)) * totalUnits;
                } else {
                  projectedTgtPrice = tgtNum;
                  projectedTgtProfit = isBuy ? (tgtNum - ltp) * totalUnits : (ltp - tgtNum) * totalUnits;
                }
              }

              const estimatedMargin = isBuy 
                ? (ltp * totalUnits) 
                : ((spotPrice || 24200) * totalUnits * 0.12 + ltp * totalUnits);

              return (
                <ScrollView style={{ marginTop: 4 }} showsVerticalScrollIndicator={false}>
                  {/* Top Bar */}
                  <View style={{
                    backgroundColor: isBuy ? 'rgba(0, 192, 135, 0.12)' : 'rgba(248, 73, 96, 0.12)',
                    padding: 14,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: isBuy ? 'rgba(0, 192, 135, 0.3)' : 'rgba(248, 73, 96, 0.3)',
                    marginBottom: 12
                  }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <TouchableOpacity 
                          onPress={() => setOrderModalLeg(prev => prev ? { ...prev, side: prev.side === 'BUY' ? 'SELL' : 'BUY' } : null)}
                          style={{
                            backgroundColor: isBuy ? '#00c087' : '#f84960',
                            paddingHorizontal: 8,
                            paddingVertical: 3,
                            borderRadius: 6
                          }}
                        >
                          <Text style={{ color: 'white', fontWeight: '900', fontSize: 12 }}>{leg.side} ⇄</Text>
                        </TouchableOpacity>
                        <Text style={{ color: 'white', fontSize: 14, fontWeight: '800' }}>
                          {leg.symbol || `${legAsset} ${leg.strike} ${leg.option_type === 'CALL' ? 'CE' : 'PE'}`}
                        </Text>
                      </View>
                      <TouchableOpacity onPress={() => setShowOrderModal(false)}>
                        <Text style={{ color: '#94a3b8', fontSize: 16, fontWeight: 'bold' }}>✕</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                      <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                        LTP: <Text style={{ color: '#ffffff', fontWeight: 'bold' }}>{posSym}{ltp.toFixed(2)}</Text> • Lot: {legLotSize}
                      </Text>
                      <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: 'bold' }}>
                        Total: {totalUnits} Qty
                      </Text>
                    </View>
                  </View>

                  {/* Mode Selector: Regular vs AMO */}
                  <View style={{ flexDirection: 'row', backgroundColor: '#090d16', borderRadius: 8, padding: 3, marginBottom: 10 }}>
                    <TouchableOpacity
                      onPress={() => setOrderMode('REGULAR')}
                      style={{ flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6, backgroundColor: orderMode === 'REGULAR' ? '#1e293b' : 'transparent' }}
                    >
                      <Text style={{ color: orderMode === 'REGULAR' ? '#38bdf8' : '#64748b', fontSize: 12, fontWeight: 'bold' }}>⚡ Regular</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setOrderMode('AMO')}
                      style={{ flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6, backgroundColor: orderMode === 'AMO' ? 'rgba(234, 179, 8, 0.2)' : 'transparent' }}
                    >
                      <Text style={{ color: orderMode === 'AMO' ? '#eab308' : '#64748b', fontSize: 12, fontWeight: 'bold' }}>🌙 AMO (After Market)</Text>
                    </TouchableOpacity>
                  </View>

                  {/* AMO Notice Alert */}
                  {orderMode === 'AMO' && (
                    <View style={{
                      backgroundColor: 'rgba(234, 179, 8, 0.12)',
                      borderWidth: 1,
                      borderColor: 'rgba(234, 179, 8, 0.35)',
                      borderRadius: 8,
                      padding: 10,
                      marginBottom: 12,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8
                    }}>
                      <Text style={{ fontSize: 14 }}>🌙</Text>
                      <Text style={{ color: '#fef08a', fontSize: 11, fontWeight: '600', flex: 1 }}>
                        After Market Order (AMO) is queued for execution at next market open (09:15 IST).
                      </Text>
                    </View>
                  )}

                  {/* Product Type: Intraday (MIS) vs Overnight (NRML) */}
                  <View style={{ marginBottom: 12 }}>
                    <Text style={{ color: '#64748b', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.5, marginBottom: 6 }}>PRODUCT TYPE</Text>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <TouchableOpacity
                        onPress={() => setProductType('MIS')}
                        style={{
                          flex: 1,
                          paddingVertical: 9,
                          alignItems: 'center',
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: productType === 'MIS' ? '#38bdf8' : '#1e293b',
                          backgroundColor: productType === 'MIS' ? 'rgba(56, 189, 248, 0.12)' : '#0f172a'
                        }}
                      >
                        <Text style={{ color: productType === 'MIS' ? '#38bdf8' : '#94a3b8', fontSize: 12, fontWeight: 'bold' }}>Intraday (MIS)</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => setProductType('NRML')}
                        style={{
                          flex: 1,
                          paddingVertical: 9,
                          alignItems: 'center',
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: productType === 'NRML' ? '#38bdf8' : '#1e293b',
                          backgroundColor: productType === 'NRML' ? 'rgba(56, 189, 248, 0.12)' : '#0f172a'
                        }}
                      >
                        <Text style={{ color: productType === 'NRML' ? '#38bdf8' : '#94a3b8', fontSize: 12, fontWeight: 'bold' }}>Overnight (NRML)</Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* Order Type: Market | Limit | SL | SL-M */}
                  <View style={{ marginBottom: 14 }}>
                    <Text style={{ color: '#64748b', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.5, marginBottom: 6 }}>ORDER TYPE</Text>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {(['MARKET', 'LIMIT', 'SL', 'SL-M'] as const).map(type => (
                        <TouchableOpacity
                          key={type}
                          onPress={() => setOrderType(type)}
                          style={{
                            flex: 1,
                            paddingVertical: 7,
                            alignItems: 'center',
                            borderRadius: 6,
                            borderWidth: 1,
                            borderColor: orderType === type ? '#00c087' : '#1e293b',
                            backgroundColor: orderType === type ? 'rgba(0, 192, 135, 0.12)' : '#0f172a'
                          }}
                        >
                          <Text style={{ color: orderType === type ? '#00c087' : '#94a3b8', fontSize: 11, fontWeight: 'bold' }}>{type}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>

                  {/* Quantity & Price Grid */}
                  <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
                    {/* Lots Stepper */}
                    <View style={{ flex: 1, backgroundColor: '#0f172a', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#1e293b' }}>
                      <Text style={{ color: '#64748b', fontSize: 10, fontWeight: 'bold', marginBottom: 6 }}>LOTS ({legLotSize}/lot)</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <TouchableOpacity 
                          onPress={() => setOrderLots(prev => Math.max(1, prev - 1))}
                          style={{ backgroundColor: '#1e293b', width: 28, height: 28, borderRadius: 6, justifyContent: 'center', alignItems: 'center' }}
                        >
                          <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold' }}>-</Text>
                        </TouchableOpacity>
                        <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: 'bold' }}>{orderLots}</Text>
                        <TouchableOpacity 
                          onPress={() => setOrderLots(prev => prev + 1)}
                          style={{ backgroundColor: '#1e293b', width: 28, height: 28, borderRadius: 6, justifyContent: 'center', alignItems: 'center' }}
                        >
                          <Text style={{ color: 'white', fontSize: 16, fontWeight: 'bold' }}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>

                    {/* Limit Price */}
                    {(orderType === 'LIMIT' || orderType === 'SL') && (
                      <View style={{ flex: 1, backgroundColor: '#0f172a', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#1e293b' }}>
                        <Text style={{ color: '#64748b', fontSize: 10, fontWeight: 'bold', marginBottom: 4 }}>LIMIT PRICE ({posSym})</Text>
                        <TextInput
                          value={orderLimitPrice}
                          onChangeText={setOrderLimitPrice}
                          keyboardType="decimal-pad"
                          placeholder={ltp.toFixed(2)}
                          placeholderTextColor="#475569"
                          style={{ color: 'white', fontSize: 14, fontWeight: 'bold', paddingVertical: 2 }}
                        />
                      </View>
                    )}

                    {/* Trigger Price */}
                    {(orderType === 'SL' || orderType === 'SL-M') && (
                      <View style={{ flex: 1, backgroundColor: '#0f172a', padding: 10, borderRadius: 8, borderWidth: 1, borderColor: '#1e293b' }}>
                        <Text style={{ color: '#64748b', fontSize: 10, fontWeight: 'bold', marginBottom: 4 }}>TRIGGER ({posSym})</Text>
                        <TextInput
                          value={orderTriggerPrice}
                          onChangeText={setOrderTriggerPrice}
                          keyboardType="decimal-pad"
                          placeholder={(ltp * 0.95).toFixed(2)}
                          placeholderTextColor="#475569"
                          style={{ color: 'white', fontSize: 14, fontWeight: 'bold', paddingVertical: 2 }}
                        />
                      </View>
                    )}
                  </View>

                  {/* ===================== GTT PROTECTION: STOPLOSS & TARGET ===================== */}
                  <View style={{ backgroundColor: '#0c101b', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#172033', marginBottom: 14 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ fontSize: 13 }}>🛡️</Text>
                        <Text style={{ color: '#e2e8f0', fontSize: 12, fontWeight: '800' }}>GTT BRACKET PROTECTION</Text>
                      </View>
                      <Text style={{ color: '#64748b', fontSize: 10, fontStyle: 'italic' }}>Auto Stoploss & Target</Text>
                    </View>

                    {/* Stoploss Option */}
                    <View style={{ backgroundColor: '#0f172a', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: hasStoploss ? 'rgba(239, 68, 68, 0.4)' : '#1e293b', marginBottom: 8 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <TouchableOpacity 
                          onPress={() => setHasStoploss(prev => !prev)}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                        >
                          <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: hasStoploss ? '#ef4444' : '#64748b', backgroundColor: hasStoploss ? '#ef4444' : 'transparent', justifyContent: 'center', alignItems: 'center' }}>
                            {hasStoploss && <Text style={{ color: 'white', fontSize: 11, fontWeight: 'bold' }}>✓</Text>}
                          </View>
                          <Text style={{ color: hasStoploss ? '#f87171' : '#94a3b8', fontSize: 12, fontWeight: 'bold' }}>Stoploss</Text>
                        </TouchableOpacity>

                        {hasStoploss && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            {/* Mode Dropdown / Toggle Button */}
                            <TouchableOpacity 
                              onPress={() => setSlMode(prev => prev === 'PERCENT' ? 'PRICE' : 'PERCENT')}
                              style={{ backgroundColor: '#1e293b', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5, borderWidth: 1, borderColor: '#334155' }}
                            >
                              <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: 'bold' }}>
                                {slMode === 'PERCENT' ? '% Percent ▾' : `${posSym} Price ▾`}
                              </Text>
                            </TouchableOpacity>

                            {/* Input Field */}
                            <TextInput
                              value={slValue}
                              onChangeText={setSlValue}
                              keyboardType="decimal-pad"
                              placeholder={slMode === 'PERCENT' ? '15' : (ltp * 0.85).toFixed(1)}
                              placeholderTextColor="#475569"
                              style={{ backgroundColor: '#1e293b', color: 'white', fontSize: 13, fontWeight: 'bold', width: 65, paddingVertical: 3, paddingHorizontal: 6, borderRadius: 5, textAlign: 'center' }}
                            />
                          </View>
                        )}
                      </View>

                      {hasStoploss && projectedSlPrice > 0 && (
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                          <Text style={{ color: '#94a3b8', fontSize: 10 }}>
                            Trigger: <Text style={{ color: '#f87171', fontWeight: 'bold' }}>{posSym}{projectedSlPrice.toFixed(2)}</Text>
                          </Text>
                          <Text style={{ color: '#f87171', fontSize: 10, fontWeight: 'bold' }}>
                            Max Loss: -{posSym}{projectedSlLoss.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </Text>
                        </View>
                      )}
                    </View>

                    {/* Target Option */}
                    <View style={{ backgroundColor: '#0f172a', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: hasTarget ? 'rgba(16, 185, 129, 0.4)' : '#1e293b' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <TouchableOpacity 
                          onPress={() => setHasTarget(prev => !prev)}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                        >
                          <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: hasTarget ? '#10b981' : '#64748b', backgroundColor: hasTarget ? '#10b981' : 'transparent', justifyContent: 'center', alignItems: 'center' }}>
                            {hasTarget && <Text style={{ color: 'white', fontSize: 11, fontWeight: 'bold' }}>✓</Text>}
                          </View>
                          <Text style={{ color: hasTarget ? '#34d399' : '#94a3b8', fontSize: 12, fontWeight: 'bold' }}>Target</Text>
                        </TouchableOpacity>

                        {hasTarget && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            {/* Mode Dropdown / Toggle Button */}
                            <TouchableOpacity 
                              onPress={() => setTargetMode(prev => prev === 'PERCENT' ? 'PRICE' : 'PERCENT')}
                              style={{ backgroundColor: '#1e293b', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5, borderWidth: 1, borderColor: '#334155' }}
                            >
                              <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: 'bold' }}>
                                {targetMode === 'PERCENT' ? '% Percent ▾' : `${posSym} Price ▾`}
                              </Text>
                            </TouchableOpacity>

                            {/* Input Field */}
                            <TextInput
                              value={targetValue}
                              onChangeText={setTargetValue}
                              keyboardType="decimal-pad"
                              placeholder={targetMode === 'PERCENT' ? '30' : (ltp * 1.3).toFixed(1)}
                              placeholderTextColor="#475569"
                              style={{ backgroundColor: '#1e293b', color: 'white', fontSize: 13, fontWeight: 'bold', width: 65, paddingVertical: 3, paddingHorizontal: 6, borderRadius: 5, textAlign: 'center' }}
                            />
                          </View>
                        )}
                      </View>

                      {hasTarget && projectedTgtPrice > 0 && (
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                          <Text style={{ color: '#94a3b8', fontSize: 10 }}>
                            Target: <Text style={{ color: '#34d399', fontWeight: 'bold' }}>{posSym}{projectedTgtPrice.toFixed(2)}</Text>
                          </Text>
                          <Text style={{ color: '#34d399', fontSize: 10, fontWeight: 'bold' }}>
                            Profit: +{posSym}{projectedTgtProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>

                  {/* Margin & Account Summary */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 4, marginBottom: 14 }}>
                    <View>
                      <Text style={{ color: '#64748b', fontSize: 11 }}>Margin Required</Text>
                      <Text style={{ color: '#ffffff', fontSize: 14, fontWeight: 'bold' }}>
                        {posSym}{estimatedMargin.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: '#64748b', fontSize: 11 }}>Available Virtual Margin</Text>
                      <Text style={{ color: tradeLabStats.availableMargin <= 0 ? '#ef4444' : '#10b981', fontSize: 14, fontWeight: 'bold' }}>
                        {posSym}{tradeLabStats.availableMargin.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </Text>
                    </View>
                  </View>

                  {/* Big Execute Action Button */}
                  <TouchableOpacity
                    onPress={handleExecuteOrderModal}
                    disabled={isTrading}
                    style={{
                      backgroundColor: isBuy ? '#00c087' : '#f84960',
                      paddingVertical: 14,
                      borderRadius: 10,
                      alignItems: 'center',
                      marginBottom: 20
                    }}
                  >
                    {isTrading ? (
                      <ActivityIndicator size="small" color="white" />
                    ) : (
                      <Text style={{ color: 'white', fontSize: 15, fontWeight: '900', letterSpacing: 0.5 }}>
                        {isBuy ? 'BUY' : 'SELL'} • {orderLots} {orderLots === 1 ? 'LOT' : 'LOTS'} ({orderMode === 'AMO' ? 'AMO' : productType})
                      </Text>
                    )}
                  </TouchableOpacity>
                </ScrollView>
              );
            })()}
          </View>
        </View>
      </Modal>

      {/* ===================== MODAL: MODIFY POSITION SL & TARGET ===================== */}
      <Modal visible={showModifyModal} transparent animationType="slide" onRequestClose={() => setShowModifyModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowModifyModal(false)} />
          <View style={[styles.bottomSheet, { maxHeight: '70%', backgroundColor: '#0b0f19', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderColor: '#1e293b' }]}>
            <View style={styles.sheetHandle} />

            {selectedModifyPosition && (() => {
              const pos = selectedModifyPosition;
              const posSym = pos.currency === 'USD' ? '$' : '₹';
              const ltp = pos.ltp || pos.entry || 0;
              const isBuy = pos.side === 'BUY';

              return (
                <View style={{ marginTop: 4 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 10, borderBottomWidth: 1, borderColor: '#1e293b', marginBottom: 12 }}>
                    <View>
                      <Text style={{ color: 'white', fontSize: 15, fontWeight: 'bold' }}>Modify Stoploss & Target</Text>
                      <Text style={{ color: '#94a3b8', fontSize: 11, marginTop: 2 }}>{pos.symbol}</Text>
                    </View>
                    <TouchableOpacity onPress={() => setShowModifyModal(false)}>
                      <Text style={{ color: '#94a3b8', fontSize: 16, fontWeight: 'bold' }}>✕</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#0f172a', padding: 10, borderRadius: 8, marginBottom: 12 }}>
                    <View>
                      <Text style={{ color: '#64748b', fontSize: 10 }}>Entry Avg</Text>
                      <Text style={{ color: 'white', fontSize: 13, fontWeight: 'bold' }}>{posSym}{pos.entry?.toFixed(2)}</Text>
                    </View>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ color: '#64748b', fontSize: 10 }}>Live LTP</Text>
                      <Text style={{ color: 'white', fontSize: 13, fontWeight: 'bold' }}>{posSym}{ltp.toFixed(2)}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: '#64748b', fontSize: 10 }}>Running P&L</Text>
                      <Text style={{ color: pos.legPnl >= 0 ? '#00c087' : '#f84960', fontSize: 13, fontWeight: 'bold' }}>
                        {pos.legPnl >= 0 ? `+${posSym}${pos.legPnl.toFixed(2)}` : `-${posSym}${Math.abs(pos.legPnl).toFixed(2)}`}
                      </Text>
                    </View>
                  </View>

                  {/* Stoploss Setting */}
                  <View style={{ backgroundColor: '#0f172a', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: modHasStoploss ? 'rgba(239, 68, 68, 0.4)' : '#1e293b', marginBottom: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <TouchableOpacity 
                        onPress={() => setModHasStoploss(prev => !prev)}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                      >
                        <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: modHasStoploss ? '#ef4444' : '#64748b', backgroundColor: modHasStoploss ? '#ef4444' : 'transparent', justifyContent: 'center', alignItems: 'center' }}>
                          {modHasStoploss && <Text style={{ color: 'white', fontSize: 11, fontWeight: 'bold' }}>✓</Text>}
                        </View>
                        <Text style={{ color: modHasStoploss ? '#f87171' : '#94a3b8', fontSize: 12, fontWeight: 'bold' }}>Stoploss</Text>
                      </TouchableOpacity>

                      {modHasStoploss && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <TouchableOpacity 
                            onPress={() => setModSlMode(prev => prev === 'PERCENT' ? 'PRICE' : 'PERCENT')}
                            style={{ backgroundColor: '#1e293b', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5, borderWidth: 1, borderColor: '#334155' }}
                          >
                            <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: 'bold' }}>
                              {modSlMode === 'PERCENT' ? '% Percent ▾' : `${posSym} Price ▾`}
                            </Text>
                          </TouchableOpacity>
                          <TextInput
                            value={modSlValue}
                            onChangeText={setModSlValue}
                            keyboardType="decimal-pad"
                            placeholder="15"
                            placeholderTextColor="#475569"
                            style={{ backgroundColor: '#1e293b', color: 'white', fontSize: 13, fontWeight: 'bold', width: 70, paddingVertical: 4, paddingHorizontal: 6, borderRadius: 5, textAlign: 'center' }}
                          />
                        </View>
                      )}
                    </View>
                  </View>

                  {/* Target Setting */}
                  <View style={{ backgroundColor: '#0f172a', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: modHasTarget ? 'rgba(16, 185, 129, 0.4)' : '#1e293b', marginBottom: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <TouchableOpacity 
                        onPress={() => setModHasTarget(prev => !prev)}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                      >
                        <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: modHasTarget ? '#10b981' : '#64748b', backgroundColor: modHasTarget ? '#10b981' : 'transparent', justifyContent: 'center', alignItems: 'center' }}>
                          {modHasTarget && <Text style={{ color: 'white', fontSize: 11, fontWeight: 'bold' }}>✓</Text>}
                        </View>
                        <Text style={{ color: modHasTarget ? '#34d399' : '#94a3b8', fontSize: 12, fontWeight: 'bold' }}>Target</Text>
                      </TouchableOpacity>

                      {modHasTarget && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <TouchableOpacity 
                            onPress={() => setModTargetMode(prev => prev === 'PERCENT' ? 'PRICE' : 'PERCENT')}
                            style={{ backgroundColor: '#1e293b', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5, borderWidth: 1, borderColor: '#334155' }}
                          >
                            <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: 'bold' }}>
                              {modTargetMode === 'PERCENT' ? '% Percent ▾' : `${posSym} Price ▾`}
                            </Text>
                          </TouchableOpacity>
                          <TextInput
                            value={modTargetValue}
                            onChangeText={setModTargetValue}
                            keyboardType="decimal-pad"
                            placeholder="30"
                            placeholderTextColor="#475569"
                            style={{ backgroundColor: '#1e293b', color: 'white', fontSize: 13, fontWeight: 'bold', width: 70, paddingVertical: 4, paddingHorizontal: 6, borderRadius: 5, textAlign: 'center' }}
                          />
                        </View>
                      )}
                    </View>
                  </View>

                  <TouchableOpacity
                    onPress={handleSaveModifyPosition}
                    style={{ backgroundColor: '#0284c7', paddingVertical: 13, borderRadius: 10, alignItems: 'center', marginBottom: 12 }}
                  >
                    <Text style={{ color: 'white', fontSize: 14, fontWeight: 'bold' }}>Save & Update GTT Protection</Text>
                  </TouchableOpacity>
                </View>
              );
            })()}
          </View>
        </View>
      </Modal>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  equityCurveContainer: {
    backgroundColor: '#10141f',
    borderWidth: 1,
    borderColor: '#1a2233',
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
    alignItems: 'center'
  },
  equityCurveTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#8a95a5',
    alignSelf: 'flex-start',
    marginBottom: 8
  },
  heatmapCard: {
    backgroundColor: '#0c101b',
    borderWidth: 1,
    borderColor: '#172033',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10
  },
  heatmapTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#8a95a5',
    marginBottom: 12
  },
  heatmapGrid: {
    alignItems: 'center',
    marginBottom: 10
  },
  weekdayHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 4,
    marginBottom: 6
  },
  weekdayLabel: {
    color: '#64748b',
    fontSize: 10,
    width: 32,
    textAlign: 'center',
    fontWeight: 'bold'
  },
  heatmapRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 4
  },
  heatmapCell: {
    width: 32,
    height: 32,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center'
  },
  heatmapCellText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: 'bold'
  },
  heatmapTooltip: {
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1f2937',
    borderRadius: 6,
    padding: 8,
    alignItems: 'center',
    marginTop: 8
  },
  heatmapTooltipDate: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '500'
  },
  heatmapTooltipPnl: {
    fontSize: 13,
    fontWeight: 'bold',
    marginTop: 2
  },
  heatmapTooltipPlaceholder: {
    alignItems: 'center',
    marginTop: 6
  },
  heatmapTooltipPlaceholderText: {
    color: '#64748b',
    fontSize: 10,
    fontStyle: 'italic'
  },
  accountManagerCard: {
    backgroundColor: '#10141f',
    borderWidth: 1,
    borderColor: '#1a2233',
    borderRadius: 8,
    padding: 14,
    marginBottom: 12
  },
  accountManagerTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#8a95a5'
  },
  addAccountHeaderBtn: {
    backgroundColor: '#0284c7',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 4
  },
  addAccountHeaderBtnText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: 'bold'
  },
  createAccountForm: {
    backgroundColor: '#1e293b',
    borderRadius: 6,
    padding: 12,
    marginBottom: 12
  },
  formSectionHeader: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 8
  },
  accountInput: {
    backgroundColor: '#0a0d14',
    borderRadius: 4,
    color: '#ffffff',
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155'
  },
  formSubmitBtn: {
    backgroundColor: '#00c087',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    flex: 1,
    alignItems: 'center'
  },
  formSubmitBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold'
  },
  formCancelBtn: {
    backgroundColor: '#475569',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    flex: 1,
    alignItems: 'center'
  },
  formCancelBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold'
  },
  accountListItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#0a0d14',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 6,
    padding: 10
  },
  activeAccountListItem: {
    borderColor: '#38bdf8',
    backgroundColor: 'rgba(56, 189, 248, 0.05)'
  },
  accountRadioCircle: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#475569',
    justifyContent: 'center',
    alignItems: 'center'
  },
  activeAccountRadioCircle: {
    borderColor: '#38bdf8'
  },
  activeRadioInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#38bdf8'
  },
  accountListName: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: 'bold'
  },
  activeAccountListName: {
    color: '#ffffff'
  },
  accountListMarginType: {
    color: '#64748b',
    fontSize: 9
  },
  accountListBalance: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold'
  },
  accountActionTextEdit: {
    color: '#38bdf8',
    fontSize: 10,
    fontWeight: 'bold'
  },
  accountActionTextDelete: {
    color: '#f84960',
    fontSize: 10,
    fontWeight: 'bold'
  },
  deltaTableCard: {
    backgroundColor: '#10141f',
    borderWidth: 1,
    borderColor: '#1a2233',
    borderRadius: 8,
    padding: 12,
    marginTop: 16,
    marginBottom: 16
  },
  deltaTableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderColor: '#2a364f',
    paddingBottom: 8,
    marginBottom: 8
  },
  deltaColHeader: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: 'bold'
  },
  deltaTableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: '#1a2233'
  },
  deltaTableRowSide: {
    fontSize: 11,
    fontWeight: 'bold',
    width: 14
  },
  deltaTableRowSym: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold'
  },
  deltaTableRowSubText: {
    color: '#64748b',
    fontSize: 9,
    marginTop: 2
  },
  deltaTableCellText: {
    color: '#ffffff',
    fontSize: 11
  },
  deltaTableSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 10,
    marginTop: 6
  },
  deltaSummaryLabel: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: 'bold',
    marginBottom: 2
  },
  deltaSummaryValue: {
    fontSize: 13,
    fontWeight: 'bold'
  },
  assetDropdownBtnSide: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#334155',
    minWidth: 64
  },
  assetDropdownTextSide: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold'
  },
  dropdownArrowSide: {
    color: '#94a3b8',
    fontSize: 10,
    marginLeft: 4
  },
  expiryBtnSide: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#334155',
    minWidth: 70
  },
  expiryBtnTextSide: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold'
  },
  snapAtmBtnSide: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  snapAtmBtnTextSide: {
    color: '#ffffff',
    fontSize: 10.5,
    fontWeight: 'bold'
  },
  segmentContainerSide: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    padding: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155'
  },
  segmentBtnSide: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4
  },
  segmentBtnActiveSide: {
    backgroundColor: '#334155'
  },
  segmentTextSide: {
    color: '#64748b',
    fontSize: 10.5,
    fontWeight: 'bold'
  },
  segmentTextActiveSide: {
    color: '#ffffff'
  },
  spotPriceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(56, 189, 248, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.15)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 8
  },
  spotBannerLabel: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: 'bold',
    marginRight: 6
  },
  spotPriceTextSide: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
    marginRight: 6
  },
  spotChangeTextSide: {
    fontSize: 10.5,
    fontWeight: '500'
  },
  container: {
    flex: 1,
    backgroundColor: '#0a0d14',
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 0
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#10141f',
    borderBottomWidth: 1,
    borderBottomColor: '#1a2233'
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  headerSubtitle: {
    fontSize: 11,
    color: '#8a95a5'
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  homeIconBtn: {
    backgroundColor: '#1c2436',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6
  },
  homeIconText: {
    fontSize: 13
  },
  readyBtnHeader: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6
  },
  readyBtnHeaderText: {
    fontSize: 10.5,
    fontWeight: 'bold',
    color: '#38bdf8'
  },
  menuDots: {
    fontSize: 18,
    color: '#ffffff',
    paddingHorizontal: 4
  },
  topTabBar: {
    flexDirection: 'row',
    backgroundColor: '#0d111a',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#1a2233',
    justifyContent: 'space-between'
  },
  topTabBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6
  },
  topTabBtnActive: {
    backgroundColor: '#1e293b'
  },
  topTabLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#707886'
  },
  topTabLabelActive: {
    color: '#38bdf8',
    fontWeight: 'bold'
  },
  alertBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8
  },
  alertSuccess: {
    backgroundColor: '#102a20'
  },
  alertError: {
    backgroundColor: '#3d141a'
  },
  alertText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff'
  },
  alertClose: {
    color: '#ffffff',
    fontSize: 14
  },
  homeWelcomeCard: {
    backgroundColor: '#121826',
    borderWidth: 1,
    borderColor: '#1e283d',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16
  },
  homeWelcomeTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  homeWelcomeSub: {
    fontSize: 11,
    color: '#8a95a5',
    marginTop: 2
  },
  livePulseBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 192, 135, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(0, 192, 135, 0.4)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    gap: 5
  },
  greenPulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#00c087'
  },
  livePulseText: {
    fontSize: 9.5,
    fontWeight: 'bold',
    color: '#00c087'
  },
  homeCapitalRow: {
    flexDirection: 'row',
    backgroundColor: '#0d121c',
    borderRadius: 8,
    padding: 10,
    marginTop: 14,
    justifyContent: 'space-between'
  },
  homeCapItem: {
    flex: 1,
    alignItems: 'center'
  },
  homeCapDivider: {
    width: 1,
    backgroundColor: '#1e283d'
  },
  homeCapLabel: {
    fontSize: 10,
    color: '#707886'
  },
  homeCapVal: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ffffff',
    marginTop: 2
  },
  homeSectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8
  },
  homeSectionTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  homeSectionSub: {
    fontSize: 10,
    color: '#707886'
  },
  marketCard: {
    backgroundColor: '#10141f',
    borderWidth: 1,
    borderColor: '#1a2233',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10
  },
  marketCardNifty: {
    borderColor: '#1e3a5f',
    backgroundColor: '#0e1626'
  },
  marketCardBankNifty: {
    borderColor: '#3b2063',
    backgroundColor: '#130d24'
  },
  marketCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10
  },
  niftyLogoBadge: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#0284c7',
    alignItems: 'center',
    justifyContent: 'center'
  },
  niftyBadgeText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 14
  },
  bankNiftyLogoBadge: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#7c3aed',
    alignItems: 'center',
    justifyContent: 'center'
  },
  bankNiftyBadgeText: {
    fontSize: 16
  },
  cryptoBadge: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center'
  },
  cryptoBadgeText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 16
  },
  marketCardName: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  marketCardSubText: {
    fontSize: 10,
    color: '#8a95a5',
    marginTop: 1
  },
  marketPriceText: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  marketChangeText: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 1
  },
  marketCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
    paddingTop: 8
  },
  marketTagPill: {
    fontSize: 9.5,
    color: '#8a95a5',
    backgroundColor: '#151b29',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4
  },
  marketActionArrow: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#38bdf8'
  },
  controllerBox: {
    padding: 12,
    backgroundColor: '#0e121a',
    borderBottomWidth: 1,
    borderBottomColor: '#1a2233'
  },
  controllerTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10
  },
  labelText: {
    fontSize: 10,
    color: '#707886',
    marginBottom: 2
  },
  assetDropdownBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#161c28',
    borderWidth: 1,
    borderColor: '#232c3d',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6
  },
  assetDropdownText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  dropdownArrow: {
    fontSize: 10,
    color: '#707886'
  },
  spotPriceText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  spotChangeText: {
    fontSize: 11,
    fontWeight: '600'
  },
  controllerBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  expiryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#161c28',
    borderWidth: 1,
    borderColor: '#232c3d',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6
  },
  expiryBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff'
  },
  snapAtmBtn: {
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6
  },
  snapAtmBtnText: {
    color: '#38bdf8',
    fontSize: 10.5,
    fontWeight: 'bold'
  },
  segmentContainer: {
    flexDirection: 'row',
    backgroundColor: '#141824',
    padding: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#232c3d'
  },
  segmentBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 4
  },
  segmentBtnActive: {
    backgroundColor: '#1e293b'
  },
  segmentText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#707886'
  },
  segmentTextActive: {
    color: '#38bdf8'
  },
  scrollArea: {
    flex: 1
  },
  tableHeader: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#121622',
    borderBottomWidth: 1,
    borderBottomColor: '#1a2233'
  },
  tableColTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8a95a5'
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.04)',
    paddingHorizontal: 4
  },
  tableRowFocused: {
    backgroundColor: 'rgba(56, 189, 248, 0.04)'
  },
  callCell: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
    justifyContent: 'center'
  },
  itmCall: {
    backgroundColor: 'rgba(239, 68, 68, 0.06)'
  },
  putCell: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
    justifyContent: 'center'
  },
  itmPut: {
    backgroundColor: 'rgba(0, 192, 135, 0.06)'
  },
  priceText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  chngText: {
    fontSize: 10,
    fontWeight: '500'
  },
  actionBadgesWrapper: {
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center'
  },
  growwBadge: {
    minWidth: 42,
    height: 25,
    paddingHorizontal: 6,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center'
  },
  growwBadgeBuy: {
    backgroundColor: 'rgba(0, 192, 135, 0.12)',
    borderColor: 'rgba(0, 192, 135, 0.35)'
  },
  growwBadgeBuyActive: {
    backgroundColor: '#00c087',
    borderColor: '#00c087'
  },
  growwBadgeSell: {
    backgroundColor: 'rgba(248, 73, 96, 0.12)',
    borderColor: 'rgba(248, 73, 96, 0.35)'
  },
  growwBadgeSellActive: {
    backgroundColor: '#f84960',
    borderColor: '#f84960'
  },
  growwBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3
  },
  subtleVolumeBarCall: {
    height: 3,
    backgroundColor: 'rgba(239, 68, 68, 0.45)',
    borderRadius: 2
  },
  subtleVolumeBarPut: {
    height: 3,
    backgroundColor: 'rgba(0, 192, 135, 0.45)',
    borderRadius: 2
  },
  strikeCell: {
    width: 76,
    backgroundColor: '#111520',
    paddingVertical: 8,
    alignItems: 'center',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)'
  },
  strikeCellFocused: {
    backgroundColor: '#1c2230',
    borderColor: '#38bdf8'
  },
  strikeText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  spotLineContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 2,
    position: 'relative'
  },
  spotLine: {
    width: '100%',
    height: 1,
    backgroundColor: '#38bdf8'
  },
  spotPill: {
    position: 'absolute',
    backgroundColor: '#0284c7',
    paddingHorizontal: 12,
    paddingVertical: 3,
    borderRadius: 12
  },
  spotPillText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold'
  },
  prominentStickyBar: {
    position: 'absolute',
    bottom: Platform.OS === 'android' ? 20 : 12,
    left: 10,
    right: 10,
    backgroundColor: '#0f172a',
    borderWidth: 1.5,
    borderColor: '#334155',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.5,
    shadowRadius: 14,
    elevation: 25,
    zIndex: 999
  },
  stickyHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    paddingBottom: 10,
    marginBottom: 10
  },
  stratBadgePill: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.25)'
  },
  stratBadgeText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700'
  },
  payoffGraphBtn: {
    backgroundColor: 'rgba(56, 189, 248, 0.16)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)'
  },
  payoffGraphBtnText: {
    color: '#38bdf8',
    fontSize: 11.5,
    fontWeight: '800'
  },
  clearBasketBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4
  },
  clearBasketBtnText: {
    color: '#f84960',
    fontSize: 12,
    fontWeight: '700'
  },
  stickyMainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  stickyMarginCol: {
    flex: 1.15,
    marginRight: 12
  },
  marginRowItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 4
  },
  marginLabelText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600'
  },
  marginValueText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900'
  },
  availMarginLabelText: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '500'
  },
  availMarginValueText: {
    fontSize: 13,
    fontWeight: '800'
  },
  prominentPlaceOrderBtn: {
    flex: 1,
    backgroundColor: '#f97316',
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#f97316',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4
  },
  prominentPlaceOrderBtnDisabled: {
    backgroundColor: '#5c371d',
    borderColor: '#783c13',
    borderWidth: 1,
    shadowOpacity: 0
  },
  prominentPlaceOrderBtnText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 13,
    letterSpacing: 0.4
  },
  prominentBarTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8
  },
  prominentBarTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#38bdf8'
  },
  prominentBarSub: {
    fontSize: 11,
    color: '#8a95a5',
    marginTop: 2
  },
  prominentBarActions: {
    flexDirection: 'row',
    gap: 8
  },
  prominentPayoffBtn: {
    flex: 1.3,
    backgroundColor: '#162033',
    borderWidth: 1,
    borderColor: '#38bdf8',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center'
  },
  prominentPayoffBtnText: {
    color: '#38bdf8',
    fontWeight: 'bold',
    fontSize: 12
  },
  prominentOrderBtn: {
    flex: 1,
    backgroundColor: '#f78d38',
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center'
  },
  prominentOrderBtnText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 12
  },
  tabContentContainer: {
    flex: 1,
    padding: 14
  },
  sectionHeader: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 8
  },
  payoffHeaderRow: {
    width: '100%',
    marginBottom: 10
  },
  payoffTitleText: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  payoffStatLabel: {
    fontSize: 10,
    color: '#707886'
  },
  payoffStatVal: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#ffffff',
    marginTop: 1
  },
  chartWrapper: {
    backgroundColor: '#10141f',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1a2233',
    padding: 12,
    alignItems: 'center',
    marginBottom: 12
  },
  dragNoticeText: {
    fontSize: 10.5,
    color: '#38bdf8',
    fontWeight: '600',
    marginTop: 6
  },
  spotScrubberBox: {
    width: '100%',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#1e2638'
  },
  spotScrubberLabel: {
    fontSize: 11,
    color: '#8a95a5',
    textAlign: 'center',
    marginBottom: 8
  },
  spotStepperRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 4
  },
  spotStepBtn: {
    flex: 1,
    backgroundColor: '#161c28',
    borderWidth: 1,
    borderColor: '#232c3d',
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: 'center'
  },
  spotStepBtnText: {
    color: '#38bdf8',
    fontSize: 10.5,
    fontWeight: 'bold'
  },
  spotResetBtn: {
    flex: 1.4,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#38bdf8',
    paddingVertical: 6,
    borderRadius: 6,
    alignItems: 'center'
  },
  spotResetBtnText: {
    color: '#ffffff',
    fontSize: 10.5,
    fontWeight: 'bold'
  },
  tradeLabSubNav: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#1a2233',
    marginBottom: 12
  },
  tradeLabNavBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tradeLabNavBtnActive: {
    borderBottomColor: '#38bdf8'
  },
  tradeLabNavText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#707886'
  },
  tradeLabNavTextActive: {
    color: '#38bdf8',
    fontWeight: 'bold'
  },
  tradeLabAlertCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.25)',
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
    gap: 8
  },
  alertIconSpan: {
    fontSize: 14
  },
  tradeLabAlertText: {
    fontSize: 11,
    color: '#cbd5e1',
    lineHeight: 15
  },
  alertLinkText: {
    color: '#f59e0b',
    textDecorationLine: 'underline',
    fontWeight: 'bold'
  },
  alertDismissBtn: {
    color: '#707886',
    fontSize: 14,
    padding: 4
  },
  executivePortfolioCard: {
    backgroundColor: '#121624',
    borderWidth: 1,
    borderColor: '#1e2638',
    borderRadius: 12,
    padding: 16,
    marginBottom: 14
  },
  execTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start'
  },
  execPortfolioValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  execSubtitle: {
    fontSize: 11,
    color: '#707886',
    marginTop: 3
  },
  execPnlValue: {
    fontSize: 16,
    fontWeight: 'bold'
  },
  execDivider: {
    height: 1,
    backgroundColor: '#1e2638',
    marginVertical: 12
  },
  execBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between'
  },
  execLabelText: {
    fontSize: 11,
    color: '#707886'
  },
  execAmountText: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ffffff',
    marginTop: 2
  },
  tradeLabPositionCard: {
    backgroundColor: '#10141f',
    borderWidth: 1,
    borderColor: '#1a2233',
    borderRadius: 8,
    padding: 14,
    marginBottom: 10
  },
  tradeLabPosHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start'
  },
  tradeLabContractName: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ffffff',
    flex: 1
  },
  tradeLabPosPnl: {
    fontSize: 13,
    fontWeight: 'bold'
  },
  tradeLabPosPct: {
    fontSize: 10,
    fontWeight: '600',
    marginTop: 1
  },
  tradeLabPosSubRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6
  },
  tradeLabQtyStatusText: {
    fontSize: 11,
    color: '#8a95a5'
  },
  tradeLabLtpText: {
    fontSize: 11,
    color: '#8a95a5'
  },
  tradeLabAvgPriceText: {
    fontSize: 11,
    color: '#8a95a5'
  },
  tradeLabCloseBtn: {
    backgroundColor: 'rgba(248,73,96,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(248,73,96,0.4)',
    paddingHorizontal: 12,
    paddingVertical: 3,
    borderRadius: 4
  },
  tradeLabCloseBtnText: {
    color: '#f84960',
    fontSize: 10.5,
    fontWeight: 'bold'
  },
  tradeLabModifyBtn: {
    backgroundColor: 'rgba(56,189,248,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(56,189,248,0.4)',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 4
  },
  tradeLabModifyBtnText: {
    color: '#38bdf8',
    fontSize: 10.5,
    fontWeight: 'bold'
  },
  perfSummaryGrid: {
    flexDirection: 'row',
    gap: 8
  },
  perfMetricBox: {
    flex: 1,
    backgroundColor: '#10141f',
    borderWidth: 1,
    borderColor: '#1a2233',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center'
  },
  perfMetricLabel: {
    fontSize: 10,
    color: '#707886'
  },
  perfMetricVal: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ffffff',
    marginTop: 3
  },
  tradeHistoryCard: {
    backgroundColor: '#10141f',
    borderWidth: 1,
    borderColor: '#1a2233',
    padding: 12,
    borderRadius: 6,
    marginBottom: 8
  },
  tradeHistoryTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  tradeHistorySym: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  tradeHistoryPnl: {
    fontSize: 12,
    fontWeight: 'bold'
  },
  tradeHistorySub: {
    fontSize: 10,
    color: '#707886',
    marginTop: 4
  },
  readyBtnStrategy: {
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    borderWidth: 1,
    borderColor: '#38bdf8',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6
  },
  readyBtnStrategyText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#38bdf8'
  },
  openReadyModalBtn: {
    backgroundColor: '#0284c7',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    marginTop: 16,
    alignItems: 'center'
  },
  openReadyModalBtnText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12
  },
  metricCard: {
    flex: 1,
    backgroundColor: '#10141f',
    borderWidth: 1,
    borderColor: '#1a2233',
    padding: 8,
    borderRadius: 6,
    alignItems: 'center'
  },
  metricLabel: {
    fontSize: 9.5,
    color: '#707886'
  },
  metricVal: {
    fontSize: 11.5,
    fontWeight: 'bold',
    color: '#ffffff',
    marginTop: 2
  },
  pnlTableCard: {
    backgroundColor: '#10141f',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1a2233',
    overflow: 'hidden',
    marginBottom: 12
  },
  pnlTableHeader: {
    flexDirection: 'row',
    backgroundColor: '#161c28',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#232c3d'
  },
  pnlTableCol: {
    flex: 1,
    fontSize: 11,
    fontWeight: 'bold',
    color: '#8a95a5'
  },
  pnlTableRow: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.03)'
  },
  pnlTableRowCurrent: {
    backgroundColor: 'rgba(56, 189, 248, 0.08)'
  },
  pnlTableVal: {
    flex: 1,
    fontSize: 11,
    color: '#e2e8f0'
  },
  legCard: {
    backgroundColor: '#10141f',
    padding: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#1a2233',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8
  },
  legCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  sideBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3
  },
  sideBuy: {
    backgroundColor: 'rgba(0,192,135,0.2)'
  },
  sideSell: {
    backgroundColor: 'rgba(248,73,96,0.2)'
  },
  sideBadgeText: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#00c087'
  },
  legStrikeText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  legSizeText: {
    fontSize: 10,
    color: '#707886'
  },
  legCardRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  legPriceText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  deleteIcon: {
    fontSize: 14
  },
  placeOrderBtn: {
    backgroundColor: '#f78d38',
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: 'center',
    marginTop: 10
  },
  placeOrderBtnText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13
  },
  emptyNotice: {
    textAlign: 'center',
    color: '#707886',
    fontSize: 12,
    marginTop: 20
  },
  returnChainBtn: {
    marginTop: 14,
    backgroundColor: '#161c28',
    borderWidth: 1,
    borderColor: '#232c3d',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 6
  },
  returnChainBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: 'bold'
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end'
  },
  modalBackdrop: {
    flex: 1
  },
  bottomSheet: {
    backgroundColor: '#121622',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 30
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: '#3b4455',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 10
  },
  sheetHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12
  },
  sheetTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  sheetCloseBtn: {
    fontSize: 16,
    color: '#707886',
    padding: 4
  },
  marketViewsScroll: {
    flexDirection: 'row',
    marginBottom: 14,
    maxHeight: 38
  },
  viewFilterPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#181f2f',
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#26334a'
  },
  viewFilterPillActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8'
  },
  viewFilterBullishActive: {
    backgroundColor: 'rgba(0, 192, 135, 0.2)',
    borderColor: '#00c087'
  },
  viewFilterBearishActive: {
    backgroundColor: 'rgba(248, 73, 96, 0.2)',
    borderColor: '#f84960'
  },
  viewFilterNeutralActive: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    borderColor: '#f59e0b'
  },
  viewFilterVolatileActive: {
    backgroundColor: 'rgba(168, 85, 247, 0.2)',
    borderColor: '#a855f7'
  },
  viewFilterText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#8a95a5'
  },
  viewFilterTextActive: {
    color: '#ffffff'
  },
  readyStrategyCard: {
    backgroundColor: '#10141f',
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8
  },
  readyStratTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4
  },
  readyStratName: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  readyStratViewTag: {
    fontSize: 9,
    fontWeight: 'bold',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3
  },
  tagBullish: {
    backgroundColor: 'rgba(0, 192, 135, 0.2)',
    color: '#00c087'
  },
  tagBearish: {
    backgroundColor: 'rgba(248, 73, 96, 0.2)',
    color: '#f84960'
  },
  tagNeutral: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    color: '#f59e0b'
  },
  tagVolatile: {
    backgroundColor: 'rgba(168, 85, 247, 0.2)',
    color: '#a855f7'
  },
  readyStratTags: {
    flexDirection: 'row',
    gap: 4
  },
  readyStratTagPill: {
    fontSize: 9.5,
    color: '#707886',
    backgroundColor: '#141a26',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4
  },
  readyStratDesc: {
    fontSize: 10.5,
    color: '#8a95a5',
    lineHeight: 14,
    marginTop: 2
  },
  sheetOptionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 6
  },
  sheetOptionSelected: {
    backgroundColor: 'rgba(56, 189, 248, 0.1)'
  },
  sheetOptionText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff'
  },
  sheetOptionSubText: {
    fontSize: 10,
    color: '#707886'
  },
  checkIcon: {
    fontSize: 14,
    color: '#38bdf8',
    fontWeight: 'bold'
  },
  journalEntryCard: {
    backgroundColor: '#0c101b',
    borderWidth: 1,
    borderColor: '#172033',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10
  },
  journalEntryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start'
  },
  journalBasketName: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#ffffff'
  },
  journalTimestampText: {
    fontSize: 9.5,
    color: '#64748b',
    marginTop: 2
  },
  journalPnlText: {
    fontSize: 14,
    fontWeight: 'bold'
  },
  journalRoiText: {
    fontSize: 10,
    fontWeight: '600',
    marginTop: 1
  },
  journalLegsContainer: {
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
    borderStyle: 'dashed'
  },
  journalLegRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3
  },
  journalLegSymbol: {
    fontSize: 10.5,
    fontWeight: 'bold',
    color: '#e2e8f0'
  },
  journalLegPrices: {
    fontSize: 9,
    color: '#707886',
    marginTop: 1
  },
  journalLegPnl: {
    fontSize: 11,
    fontWeight: 'bold'
  },
  journalLegQty: {
    fontSize: 9,
    color: '#5e6878'
  }
});










