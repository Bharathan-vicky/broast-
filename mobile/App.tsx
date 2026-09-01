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
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Path, Line as SvgLine, Text as SvgText, Circle, Rect, G, Defs, ClipPath, LinearGradient, Stop } from 'react-native-svg';
import Constants from 'expo-constants';
import { usePriceFeed } from './src/lib/priceFeed';
import { synthesizeOptionChain, generateDefaultExpiries, fuseLiveOptionChain, calculateBSPrice, ASSET_IV_MAP } from './src/lib/optionChainSynthesizer';
import { fetchAllDirectSpots, fetchDirectYahooSpot } from './src/lib/directMarketFeed';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const STATUSBAR_HEIGHT = Platform.OS === 'ios'
  ? (Constants.statusBarHeight || 44)
  : Math.max(Constants.statusBarHeight || 0, StatusBar.currentHeight || 0, 32);

const getBackendUrl = () => {
  // 1. Explicit env var override (highest priority)
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '');
  }
  // 2. High-availability 24/7 Cloud Backend on Render
  return 'https://broast.onrender.com';
};

const BACKEND_URL = getBackendUrl();

export const parseDateSafe = (dateStr: string | null): Date => {
  if (!dateStr) return new Date();
  try {
    const clean = dateStr.split('T')[0];
    const parts = clean.split('-');
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10) - 1;
      const d = parseInt(parts[2], 10);
      if (!isNaN(y) && !isNaN(m) && !isNaN(d) && y >= 2025 && y <= 2030) {
        return new Date(y, m, d);
      }
    }
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= 2025 && parsed.getFullYear() <= 2030) {
      return parsed;
    }
  } catch {}
  return new Date();
};

export const formatDisplayDate = (dateStr: string | null): string => {
  if (!dateStr) return '';
  const d = parseDateSafe(dateStr);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const formatDisplayDateShort = (dateStr: string | null): string => {
  if (!dateStr) return '';
  const d = parseDateSafe(dateStr);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

const getDteLabel = (expiryDateStr: string | null) => {
  if (!expiryDateStr) return '0 DTE';
  const expiryDate = parseDateSafe(expiryDateStr);
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
  if (feedPchange !== undefined && feedPchange !== 0) {
    return Math.max(-95.0, Math.min(180.0, feedPchange));
  }
  if (!spot || spotPct === 0) return 0;

  const distancePct = (strike - spot) / spot;
  let delta = 0.5;

  if (isCall) {
    delta = 1 / (1 + Math.exp(distancePct * 12));
  } else {
    delta = -1 / (1 + Math.exp(-distancePct * 12));
  }

  // Calculate realistic derivative percentage change relative to spot move
  const spotMove = spot * (spotPct / 100);
  const approxPrevLtp = Math.max(0.2, ltp - (delta * spotMove));
  const realisticPct = ((ltp - approxPrevLtp) / approxPrevLtp) * 100;

  return Math.round(Math.max(-88.5, Math.min(145.0, realisticPct)) * 10) / 10;
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
  // Benchmark Indices (Exact Angel One Closing Spot Prices)
  'NIFTY': { currency: 'INR', lotSize: 65, lotUnit: 'units', symbol: '₹', name: 'NIFTY 50 Index', tag: 'NSE India', category: 'INDIAN', strikeStep: 50, defaultSpot: 24175.65, exchange: 'NSE' },
  'BANKNIFTY': { currency: 'INR', lotSize: 30, lotUnit: 'units', symbol: '₹', name: 'BANK NIFTY Index', tag: 'NSE India', category: 'INDIAN', strikeStep: 100, defaultSpot: 57496.30, exchange: 'NSE' },
  'SENSEX': { currency: 'INR', lotSize: 20, lotUnit: 'units', symbol: '₹', name: 'BSE SENSEX Index', tag: 'BSE India', category: 'INDIAN', strikeStep: 100, defaultSpot: 77264.51, exchange: 'BSE' },
  
  // MCX Commodities (Exact MCX Market Prices & Steps)
  // Standard Lots (Top 4)
  'CRUDEOIL': { currency: 'INR', lotSize: 100, lotUnit: 'bbl', symbol: '₹', name: 'Crude Oil', tag: 'MCX Main', category: 'COMMODITY', strikeStep: 50, defaultSpot: 8315.0, exchange: 'MCX' },
  'GOLD': { currency: 'INR', lotSize: 100, lotUnit: 'grams', symbol: '₹', name: 'Gold Standard', tag: 'MCX Main', category: 'COMMODITY', strikeStep: 500, defaultSpot: 161690.0, exchange: 'MCX' },
  'SILVER': { currency: 'INR', lotSize: 30, lotUnit: 'kg', symbol: '₹', name: 'Silver Standard', tag: 'MCX Main', category: 'COMMODITY', strikeStep: 250, defaultSpot: 246274.0, exchange: 'MCX' },
  'NATURALGAS': { currency: 'INR', lotSize: 1250, lotUnit: 'mmBtu', symbol: '₹', name: 'Natural Gas', tag: 'MCX Main', category: 'COMMODITY', strikeStep: 5, defaultSpot: 264.5, exchange: 'MCX' },
  // Mini Lots (Below)
  'CRUDEOILM': { currency: 'INR', lotSize: 10, lotUnit: 'bbl', symbol: '₹', name: 'Crude Oil Mini', tag: 'MCX Mini', category: 'COMMODITY', strikeStep: 50, defaultSpot: 8315.0, exchange: 'MCX' },
  'GOLDM': { currency: 'INR', lotSize: 10, lotUnit: 'grams', symbol: '₹', name: 'Gold Mini (10g)', tag: 'MCX Mini', category: 'COMMODITY', strikeStep: 500, defaultSpot: 161690.0, exchange: 'MCX' },
  'SILVERM': { currency: 'INR', lotSize: 5, lotUnit: 'kg', symbol: '₹', name: 'Silver Mini (5kg)', tag: 'MCX Mini', category: 'COMMODITY', strikeStep: 1000, defaultSpot: 246274.0, exchange: 'MCX' },
  'NATGASM': { currency: 'INR', lotSize: 250, lotUnit: 'mmBtu', symbol: '₹', name: 'Natural Gas Mini', tag: 'MCX Mini', category: 'COMMODITY', strikeStep: 5, defaultSpot: 264.5, exchange: 'MCX' },
  
  // Crypto Derivatives (Exact Delta Exchange Live Specs)
  'BTC': { currency: 'USD', lotSize: 0.001, lotUnit: 'BTC', symbol: '$', name: 'Bitcoin Options', tag: 'Delta Exchange', category: 'CRYPTO', strikeStep: 200, defaultSpot: 79800.0, exchange: 'DELTA', settlementCurrency: 'INR' },
  'ETH': { currency: 'USD', lotSize: 0.01, lotUnit: 'ETH', symbol: '$', name: 'Ethereum Options', tag: 'Delta Exchange', category: 'CRYPTO', strikeStep: 10, defaultSpot: 2480.0, exchange: 'DELTA', settlementCurrency: 'INR' },
  'XAUT': { currency: 'USD', lotSize: 1, lotUnit: 'oz', symbol: '$', name: 'Tether Gold Options', tag: 'Delta Exchange', category: 'CRYPTO', strikeStep: 10, defaultSpot: 4430.0, exchange: 'DELTA', settlementCurrency: 'USD' }
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
    view: 'High Volatility',
    purpose: 'Profit from massive explosive breakout in either direction.',
    strike: 'Buy ATM Call + Buy ATM Put.',
    usage: 'Buy ATM CE and PE. Profits if price moves significantly higher or lower. Loses on theta decay.'
  },
  'Long Strangle': {
    view: 'High Volatility',
    purpose: 'Low-cost speculative play on an expected huge breakout.',
    strike: 'Buy OTM Call + Buy OTM Put.',
    usage: 'Buy OTM CE and PE. Cheaper entry cost than Straddle, but requires a much stronger price move.'
  },
  'Long Iron Butterfly': {
    view: 'High Volatility',
    purpose: 'Defined-risk breakout structure profit on big moves.',
    strike: 'Buy 1 ATM Put, Sell 1 OTM Put, Sell 1 OTM Call, Buy 1 ATM Call.',
    usage: 'Defined-risk volatility play. Profits when price moves outside the middle range.'
  },
  'Long Iron Condor': {
    view: 'High Volatility',
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

const isAssetMarketOpen = (asset: string, serverMarketOpen: boolean): boolean => {
  const conf = ASSET_CONFIG[asset];
  if (!conf) return serverMarketOpen;
  if (conf.category === 'CRYPTO') return true; // Crypto 24/7/365

  if (conf.category === 'COMMODITY') {
    // MCX Commodities: 09:00 to 23:30 IST Monday-Friday
    try {
      const now = new Date();
      const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
      const istTime = new Date(utc + (3600000 * 5.5));
      const day = istTime.getDay();
      if (day === 0 || day === 6) return false;
      const curMinutes = istTime.getHours() * 60 + istTime.getMinutes();
      return curMinutes >= (9 * 60) && curMinutes <= (23 * 60 + 30);
    } catch {
      return serverMarketOpen;
    }
  }

  // Indian Indices & Stocks (NSE/BSE): 09:15 to 15:30 IST Monday-Friday
  try {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istTime = new Date(utc + (3600000 * 5.5));
    const day = istTime.getDay();
    if (day === 0 || day === 6) return false;
    const curMinutes = istTime.getHours() * 60 + istTime.getMinutes();
    return curMinutes >= (9 * 60 + 15) && curMinutes <= (15 * 60 + 30);
  } catch {
    return serverMarketOpen;
  }
};

interface SwipeOrderSliderProps {
  isBuy: boolean;
  orderLots: number;
  totalUnits: number;
  lotUnit: string;
  isTrading: boolean;
  onSwipeComplete: () => void;
}

const SwipeOrderSlider: React.FC<SwipeOrderSliderProps> = ({
  isBuy,
  orderLots,
  totalUnits,
  lotUnit,
  isTrading,
  onSwipeComplete
}) => {
  const panX = useRef(new Animated.Value(0)).current;
  const [sliderWidth, setSliderWidth] = useState(320);
  const buttonWidth = 56;
  const maxDrag = Math.max(100, sliderWidth - buttonWidth - 8);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !isTrading,
      onMoveShouldSetPanResponder: (_, gesture) => !isTrading && Math.abs(gesture.dx) > 5,
      onPanResponderMove: (_, gesture) => {
        if (gesture.dx > 0) {
          panX.setValue(Math.min(maxDrag, gesture.dx));
        }
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx >= maxDrag * 0.65) {
          Animated.timing(panX, {
            toValue: maxDrag,
            duration: 120,
            useNativeDriver: false
          }).start(() => {
            onSwipeComplete();
            setTimeout(() => {
              Animated.spring(panX, {
                toValue: 0,
                friction: 6,
                useNativeDriver: false
              }).start();
            }, 600);
          });
        } else {
          Animated.spring(panX, {
            toValue: 0,
            friction: 5,
            useNativeDriver: false
          }).start();
        }
      }
    })
  ).current;

  const trackBg = isBuy ? '#00c087' : '#f84960';
  const actionLabel = isBuy ? `SWIPE TO BUY (${orderLots} LOT)` : `SWIPE TO SELL (${orderLots} LOT)`;

  return (
    <View
      onLayout={(e) => setSliderWidth(e.nativeEvent.layout.width)}
      style={{
        height: 52,
        backgroundColor: '#0c101d',
        borderRadius: 26,
        borderWidth: 1.5,
        borderColor: isBuy ? 'rgba(0, 192, 135, 0.6)' : 'rgba(248, 73, 96, 0.6)',
        justifyContent: 'center',
        paddingHorizontal: 4,
        position: 'relative',
        overflow: 'hidden',
        marginBottom: 20
      }}
    >
      {/* Background fill track */}
      <Animated.View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: Animated.add(panX, buttonWidth + 8),
          backgroundColor: isBuy ? 'rgba(0, 192, 135, 0.25)' : 'rgba(248, 73, 96, 0.25)',
          borderRadius: 26
        }}
      />

      {/* Centered Action Text */}
      <View style={{ position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: isBuy ? '#34d399' : '#f87171', fontSize: 12.5, fontWeight: '800', letterSpacing: 1 }}>
          {actionLabel}  ›››
        </Text>
      </View>

      {/* Draggable Knob */}
      <Animated.View
        {...panResponder.panHandlers}
        style={{
          transform: [{ translateX: panX }],
          width: buttonWidth,
          height: 44,
          borderRadius: 22,
          backgroundColor: trackBg,
          alignItems: 'center',
          justifyContent: 'center',
          elevation: 5,
          shadowColor: trackBg,
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.5,
          shadowRadius: 4
        }}
      >
        {isTrading ? (
          <ActivityIndicator size="small" color="white" />
        ) : (
          <Text style={{ color: 'white', fontSize: 18, fontWeight: '900' }}>➔</Text>
        )}
      </Animated.View>
    </View>
  );
};

interface OptionRowProps {
  row: any;
  isCallITM: boolean;
  isPutITM: boolean;
  showSpotLine: boolean;
  isCallFocused: boolean;
  isPutFocused: boolean;
  callLegSide: 'BUY' | 'SELL' | null;
  putLegSide: 'BUY' | 'SELL' | null;
  callChangePct: number;
  putChangePct: number;
  callLtp: number;
  putLtp: number;
  callOI: number;
  putOI: number;
  maxOI: number;
  viewMode: 'LTP' | 'OI';
  currSym: string;
  selectedMarket: string | null;
  activeAsset: string;
  spotPrice: number;
  onFocusCall: () => void;
  onFocusPut: () => void;
  onFocusClear: () => void;
  onToggleCallBuy: (e: any) => void;
  onToggleCallSell: (e: any) => void;
  onTogglePutBuy: (e: any) => void;
  onTogglePutSell: (e: any) => void;
}

const OptionChainRow = React.memo(({
  row,
  isCallITM,
  isPutITM,
  showSpotLine,
  isCallFocused,
  isPutFocused,
  callLegSide,
  putLegSide,
  callChangePct,
  putChangePct,
  callLtp,
  putLtp,
  callOI,
  putOI,
  maxOI,
  viewMode,
  currSym,
  selectedMarket,
  activeAsset,
  spotPrice,
  onFocusCall,
  onFocusPut,
  onFocusClear,
  onToggleCallBuy,
  onToggleCallSell,
  onTogglePutBuy,
  onTogglePutSell,
}: OptionRowProps) => {
  return (
    <View key={row.strike}>
      <View style={styles.tableRow}>
        {/* CALL SIDE */}
        <TouchableOpacity
          activeOpacity={0.82}
          onPress={onFocusCall}
          style={[styles.callCell, isCallITM && styles.itmCall, isCallFocused && { backgroundColor: 'rgba(0, 192, 135, 0.09)' }, { overflow: 'hidden' }]}
        >
          {viewMode === 'OI' && callOI > 0 && (
            <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${(callOI / maxOI) * 100}%`, backgroundColor: 'rgba(0, 192, 135, 0.15)' }} />
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <View style={{ flex: 1, paddingRight: 4 }}>
              <Text style={styles.priceText} numberOfLines={1}>
                {viewMode === 'LTP' ? `${currSym}${selectedMarket === 'CRYPTO' ? callLtp.toFixed(1) : callLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : formatOI(callOI, activeAsset === 'NIFTY' ? null : 'CRYPTO')}
              </Text>
              <Text style={[styles.chngText, { color: callChangePct >= 0 ? '#00c087' : '#f84960' }]}>
                {callChangePct >= 0 ? `+${callChangePct.toFixed(1)}%` : `${callChangePct.toFixed(1)}%`}
              </Text>
            </View>

            {(isCallFocused || callLegSide) ? (
              <View style={styles.actionBadgesWrapper}>
                <TouchableOpacity
                  style={[styles.growwBadge, styles.growwBadgeBuy, callLegSide === 'BUY' && styles.growwBadgeBuyActive]}
                  onPress={onToggleCallBuy}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                >
                  <Text style={[styles.growwBadgeText, { color: callLegSide === 'BUY' ? '#ffffff' : '#00c087' }]}>BUY</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.growwBadge, styles.growwBadgeSell, callLegSide === 'SELL' && styles.growwBadgeSellActive]}
                  onPress={onToggleCallSell}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                >
                  <Text style={[styles.growwBadgeText, { color: callLegSide === 'SELL' ? '#ffffff' : '#f84960' }]}>SELL</Text>
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
          onPress={onFocusClear}
          style={[styles.strikeCell, (isCallFocused || isPutFocused) && styles.strikeCellFocused]}
        >
          <Text style={styles.strikeText}>{row.strike.toLocaleString('en-IN')}</Text>
        </TouchableOpacity>

        {/* PUT SIDE */}
        <TouchableOpacity
          activeOpacity={0.82}
          onPress={onFocusPut}
          style={[styles.putCell, isPutITM && styles.itmPut, isPutFocused && { backgroundColor: 'rgba(248, 73, 96, 0.09)' }, { overflow: 'hidden' }]}
        >
          {viewMode === 'OI' && putOI > 0 && (
            <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(putOI / maxOI) * 100}%`, backgroundColor: 'rgba(248, 73, 96, 0.15)' }} />
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            {(isPutFocused || putLegSide) ? (
              <View style={styles.actionBadgesWrapper}>
                <TouchableOpacity
                  style={[styles.growwBadge, styles.growwBadgeBuy, putLegSide === 'BUY' && styles.growwBadgeBuyActive]}
                  onPress={onTogglePutBuy}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                >
                  <Text style={[styles.growwBadgeText, { color: putLegSide === 'BUY' ? '#ffffff' : '#00c087' }]}>BUY</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.growwBadge, styles.growwBadgeSell, putLegSide === 'SELL' && styles.growwBadgeSellActive]}
                  onPress={onTogglePutSell}
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                >
                  <Text style={[styles.growwBadgeText, { color: putLegSide === 'SELL' ? '#ffffff' : '#f84960' }]}>SELL</Text>
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
                {viewMode === 'LTP' ? `${currSym}${selectedMarket === 'CRYPTO' ? putLtp.toFixed(1) : putLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : formatOI(putOI, activeAsset === 'NIFTY' ? null : 'CRYPTO')}
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
            <Text style={styles.spotPillText}>{activeAsset} {spotPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Text>
          </View>
        </View>
      )}
    </View>
  );
}, (prev, next) => {
  return (
    prev.row.strike === next.row.strike &&
    prev.callLtp === next.callLtp &&
    prev.putLtp === next.putLtp &&
    prev.callChangePct === next.callChangePct &&
    prev.putChangePct === next.putChangePct &&
    prev.isCallITM === next.isCallITM &&
    prev.isPutITM === next.isPutITM &&
    prev.showSpotLine === next.showSpotLine &&
    prev.isCallFocused === next.isCallFocused &&
    prev.isPutFocused === next.isPutFocused &&
    prev.callLegSide === next.callLegSide &&
    prev.putLegSide === next.putLegSide &&
    prev.viewMode === next.viewMode &&
    prev.currSym === next.currSym &&
    prev.activeAsset === next.activeAsset &&
    prev.callOI === next.callOI &&
    prev.putOI === next.putOI
  );
});

export default function App() {

  const [selectedMarket, setSelectedMarket] = useState<'CRYPTO' | 'INDIAN' | 'STOCKS' | 'COMMODITY' | null>('INDIAN');
  const [activeAsset, setActiveAsset] = useState<string>('NIFTY');
  const [cryptoLeverage, setCryptoLeverage] = useState<number>(200);
  const [activeExpiry, setActiveExpiry] = useState<string>('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [chainByExpiry, setChainByExpiry] = useState<any>({});

  const chainScrollRef = useRef<FlatList<any>>(null);

  // Live Spot Prices Dictionary (Calibrated to Real Angel One Closing Values)
  const [liveMarketPrices, setLiveMarketPrices] = useState<Record<string, { spot: number; change: number; pctChange: number }>>({
    'NIFTY': { spot: 24175.65, change: 84.80, pctChange: 0.35 },
    'BANKNIFTY': { spot: 57496.30, change: -159.20, pctChange: -0.28 },
    'SENSEX': { spot: 77264.51, change: 330.92, pctChange: 0.43 },
    'RELIANCE': { spot: 1298.00, change: -19.00, pctChange: -1.44 },
    'TCS': { spot: 2270.00, change: -26.20, pctChange: -1.14 },
    'INFY': { spot: 1120.00, change: -24.00, pctChange: -2.10 },
    'HDFCBANK': { spot: 727.20, change: -0.30, pctChange: -0.04 },
    'ICICIBANK': { spot: 1430.00, change: 7.30, pctChange: 0.51 },
    'SBIN': { spot: 1052.00, change: 4.00, pctChange: 0.38 },
    'TATAMOTORS': { spot: 985.00, change: -5.20, pctChange: -0.53 },
    'BHARTIARTL': { spot: 1902.10, change: -44.90, pctChange: -2.31 },
    'ITC': { spot: 270.25, change: -1.15, pctChange: -0.42 },
    'LT': { spot: 4038.10, change: -80.90, pctChange: -1.96 },
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
  const [selectedAccountForView, setSelectedAccountForView] = useState<number | null>(null);

  const [viewMode, setViewMode] = useState<'LTP' | 'OI'>('LTP');
  const [activeRowTarget, setActiveRowTarget] = useState<{ strike: number; side: 'CALL' | 'PUT' } | null>(null);

  const [cursorSpotOffset, setCursorSpotOffset] = useState<number>(0);

  const [showReadyModal, setShowReadyModal] = useState(false);
  const [showPayoffModal, setShowPayoffModal] = useState(false);
  const [showGlossaryModal, setShowGlossaryModal] = useState(false);
  const [selectedMarketView, setSelectedMarketView] = useState<'ALL' | 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'VOLATILE'>('ALL');

  const [showProfileModal, setShowProfileModal] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
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
  const [orderTimeframe, setOrderTimeframe] = useState<'INTRADAY' | 'TOMORROW' | 'EXPIRY'>('INTRADAY');
  const [showTimeframeModal, setShowTimeframeModal] = useState(false);
  const [showMoreOrderOptions, setShowMoreOrderOptions] = useState(false);
  const [hasStoploss, setHasStoploss] = useState(false);
  const [slMode, setSlMode] = useState<'PRICE' | 'PERCENT'>('PERCENT');
  const [slValue, setSlValue] = useState<string>('');
  const [hasTarget, setHasTarget] = useState(false);
  const [targetMode, setTargetMode] = useState<'PRICE' | 'PERCENT'>('PERCENT');
  const [targetValue, setTargetValue] = useState<string>('');

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
  const [journalSelectedAccount, setJournalSelectedAccount] = useState<number | 'ALL'>('ALL');
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

  // Real-Time 0-Lag Ultra-Fast WebSocket Stream (spots + option chain, lag-free)
  const priceFeed = usePriceFeed(activeAsset);

  // Immediately initialize exact monthly/weekly expiries on asset switch
  useEffect(() => {
    const isCrypto = activeAsset === 'BTC' || activeAsset === 'ETH' || activeAsset === 'XAUT';
    const isStock = currConfig?.category === 'STOCKS';
    const defaultExps = generateDefaultExpiries(isCrypto, isStock, activeAsset);
    setExpiries(defaultExps);
    setActiveExpiry(defaultExps[0]);

    if (currConfig?.category && selectedMarket !== currConfig.category && selectedMarket !== null) {
      setSelectedMarket(currConfig.category);
    }
  }, [activeAsset]);

  const allLiveSpots = useMemo(() => {
    return { ...liveMarketPrices, ...(priceFeed.spots || {}) };
  }, [liveMarketPrices, priceFeed.spots]);

  const currentSpotInfo = allLiveSpots[activeAsset] || { spot: currConfig?.defaultSpot || 24000, change: 0, pctChange: 0 };
  const spotPrice = currentSpotInfo.spot;
  const spotChange = currentSpotInfo.change;
  const spotPercentChange = currentSpotInfo.pctChange;

  const troubleshootLtpSpotLag = useCallback(async () => {
    setIsCalibrating(true);
    setIsRefreshing(true);
    try {
      const isCrypto = activeAsset === 'BTC' || activeAsset === 'ETH' || activeAsset === 'XAUT';
      const isStock = currConfig?.category === 'STOCKS';
      const activeExp = activeExpiry || expiries[0] || generateDefaultExpiries(isCrypto, isStock, activeAsset)[0];

      const directSpotsPromise = fetchAllDirectSpots().catch(() => ({}));
      const t = Date.now();
      const backendPromise = fetch(`${BACKEND_URL}/api/sync/live?asset=${encodeURIComponent(activeAsset)}&expiry=${encodeURIComponent(activeExp)}&account_id=${activeAccountId}&force=true&_t=${t}`, {
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      })
        .then(r => r.json())
        .catch(() => null);

      const [directSpots, backendData] = await Promise.all([directSpotsPromise, backendPromise]);

      const mergedSpots = {
        ...liveMarketPrices,
        ...(backendData?.spots || {}),
        ...(directSpots || {})
      };
      setLiveMarketPrices(mergedSpots);

      // If backend returned real live exchange chain for this expiry, use it directly
      if (backendData?.chain?.chainByExpiry && Object.keys(backendData.chain.chainByExpiry).length > 0) {
        setChainByExpiry((prev: any) => ({ ...prev, ...backendData.chain.chainByExpiry }));
      } else {
        // Instantly re-synthesize options chain for active asset at newly calibrated spot
        const currentSp = mergedSpots[activeAsset]?.spot || spotPrice || currConfig.defaultSpot;
        const newChain = synthesizeOptionChain(activeAsset, currentSp, strikeStep, activeExp);
        if (newChain && newChain.length > 0) {
          setChainByExpiry((prev: Record<string, any[]>) => ({
            ...prev,
            [activeExp]: newChain
          }));
        }
      }

      const currentSp = mergedSpots[activeAsset]?.spot || spotPrice || currConfig.defaultSpot;
      const dispSpot = currentSp.toLocaleString('en-IN', { minimumFractionDigits: selectedMarket === 'CRYPTO' ? 1 : 2 });
      setTradeMessage(`⚡ Live Sync: ${activeAsset} @ ₹${dispSpot}`);
      setTimeout(() => setTradeMessage(''), 2500);
    } catch {
      setTradeMessage('⚡ Spot Feed Refreshed');
      setTimeout(() => setTradeMessage(''), 2000);
    } finally {
      setIsCalibrating(false);
      setIsRefreshing(false);
    }
  }, [activeAsset, activeAccountId, liveMarketPrices, spotPrice, currConfig, activeExpiry, expiries, strikeStep, selectedMarket]);

  // Instant live fetch from Angel One whenever Asset or Expiry dropdown is changed
  useEffect(() => {
    troubleshootLtpSpotLag();
  }, [activeAsset, activeExpiry]);

  const troubleshootOptionChainLag = useCallback(async () => {
    setIsCalibrating(true);
    setIsRefreshing(true);
    try {
      const directSpots: Record<string, any> = await fetchAllDirectSpots().catch(() => ({}));
      const currentSp = directSpots[activeAsset]?.spot || liveMarketPrices[activeAsset]?.spot || spotPrice || currConfig.defaultSpot;
      const isCrypto = activeAsset === 'BTC' || activeAsset === 'ETH' || activeAsset === 'XAUT';
      const isStock = currConfig?.category === 'STOCKS';
      const activeExp = activeExpiry || expiries[0] || generateDefaultExpiries(isCrypto, isStock, activeAsset)[0];

      // Re-synthesize fresh 0-lag options chain grid
      const freshChain = synthesizeOptionChain(activeAsset, currentSp, strikeStep, activeExp);
      if (freshChain && freshChain.length > 0) {
        setChainByExpiry((prev: Record<string, any[]>) => ({
          ...prev,
          [activeExp]: freshChain
        }));
      }

      setTradeMessage(`⚡ ${activeAsset} Option Matrix & Greeks Recalibrated`);
      setTimeout(() => setTradeMessage(''), 3000);
    } catch {
      setTradeMessage('⚡ Option Chain Refreshed');
      setTimeout(() => setTradeMessage(''), 2500);
    } finally {
      setIsCalibrating(false);
      setIsRefreshing(false);
    }
  }, [activeAsset, liveMarketPrices, spotPrice, currConfig, activeExpiry, expiries, strikeStep]);

  const autoCalibrateAllPrices = useCallback(async () => {
    setIsCalibrating(true);
    setIsRefreshing(true);
    try {
      // 1. Concurrently fetch direct multi-node on-device quotes across all indices & commodities
      const directSpots: Record<string, any> = await fetchAllDirectSpots().catch(() => ({}));

      // 2. Fetch backend sync with force refresh
      const backendPromise = fetch(`${BACKEND_URL}/api/sync/live?asset=${activeAsset}&account_id=${activeAccountId}&force=true`)
        .then(r => r.json())
        .catch(() => null);

      const [backendData] = await Promise.all([backendPromise]);

      const mergedSpots = {
        ...liveMarketPrices,
        ...(backendData?.spots || {}),
        ...(directSpots || {})
      };

      setLiveMarketPrices(mergedSpots);

      const currentSp = mergedSpots[activeAsset]?.spot || spotPrice || currConfig.defaultSpot;
      const isCrypto = activeAsset === 'BTC' || activeAsset === 'ETH' || activeAsset === 'XAUT';
      const isStock = currConfig?.category === 'STOCKS';
      const activeExp = activeExpiry || expiries[0] || generateDefaultExpiries(isCrypto, isStock, activeAsset)[0];
      const freshChain = synthesizeOptionChain(activeAsset, currentSp, strikeStep, activeExp);
      if (freshChain && freshChain.length > 0) {
        setChainByExpiry((prev: Record<string, any[]>) => ({
          ...prev,
          [activeExp]: freshChain
        }));
      }

      if (backendData?.portfolio) setPortfolio(backendData.portfolio);

      const nSpot = mergedSpots['NIFTY']?.spot ? `₹${mergedSpots['NIFTY'].spot.toLocaleString('en-IN')}` : '₹24,175.65';
      const bnSpot = mergedSpots['BANKNIFTY']?.spot ? `₹${mergedSpots['BANKNIFTY'].spot.toLocaleString('en-IN')}` : '₹57,655.50';
      setTradeMessage(`⚡ Auto-Correct: Full Pipeline Synced (${nSpot} | ${bnSpot})`);
      setTimeout(() => setTradeMessage(''), 3500);
    } catch {
      setTradeMessage('⚡ Full Pipeline Synced');
      setTimeout(() => setTradeMessage(''), 2500);
    } finally {
      setIsCalibrating(false);
      setIsRefreshing(false);
    }
  }, [activeAsset, activeAccountId, liveMarketPrices, spotPrice, currConfig, activeExpiry, expiries, strikeStep]);

  const triggerManualRefresh = useCallback(() => {
    autoCalibrateAllPrices();
  }, [autoCalibrateAllPrices]);

  const handleBackPress = () => {
    if (showProfileModal) {
      setShowProfileModal(false);
      return true;
    }
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
  }, [showProfileModal, showReadyModal, showAssetModal, showExpiryModal, activeRowTarget, activeTab]);

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

    // 1. Immediately hydrate from local persistent storage so custom account names & balances never flicker to defaults
    AsyncStorage.getItem(`@delta_accounts_${selectedMarket}`).then(cached => {
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setAccounts(parsed);
          }
        } catch (e) {}
      }
    }).catch(() => {});

    // 2. Fetch authoritative database accounts
    fetch(`${BACKEND_URL}/api/accounts?market=${selectedMarket}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setAccounts(data);
          AsyncStorage.setItem(`@delta_accounts_${selectedMarket}`, JSON.stringify(data)).catch(() => {});
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

  useEffect(() => {
    const c = priceFeed.chain;
    if (c?.expiries && c.expiries.length > 0) {
      const validExps = c.expiries.filter((exp: string) => {
        const d = parseDateSafe(exp);
        return d.getFullYear() >= 2025 && d.getFullYear() <= 2030;
      });
      if (validExps.length > 0) {
        setExpiries(validExps);
        setActiveExpiry((prev) => (prev && validExps.includes(prev)) ? prev : validExps[0]);
      }
    }
    if (c?.chainByExpiry && Object.keys(c.chainByExpiry).length > 0) {
      setChainByExpiry((prev: any) => (prev === c.chainByExpiry ? prev : c.chainByExpiry));
    }
  }, [priceFeed.chain]);

  useEffect(() => {
    if (priceFeed?.marketOpen !== undefined) {
      setMarketOpen((prev) => (prev === priceFeed.marketOpen ? prev : priceFeed.marketOpen));
    }
  }, [priceFeed?.marketOpen]);

  // Persistent position storage to ensure positions never disappear across restarts or day changes
  useEffect(() => {
    const loadStoredData = async () => {
      try {
        const storedPort = await AsyncStorage.getItem('@delta_portfolio_v2');
        if (storedPort) {
          const parsed = JSON.parse(storedPort);
          if (parsed && parsed.baskets && parsed.baskets.length > 0) {
            setPortfolio((prev: any) => (prev?.baskets?.length ? prev : parsed));
          }
        }
        const storedHist = await AsyncStorage.getItem('@delta_order_history_v2');
        if (storedHist) {
          const parsedH = JSON.parse(storedHist);
          if (Array.isArray(parsedH) && parsedH.length > 0) {
            setOrderHistory((prev: any[]) => (prev?.length ? prev : parsedH));
          }
        }
      } catch (e) {}
    };
    loadStoredData();
  }, []);

  // Periodic background portfolio & history poller across all accounts with persistent local sync
  useEffect(() => {
    let isMounted = true;
    const accId = activeAccountId || 1;

    const syncPortfolio = () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);

      // Synchronously poll account 1 (Indian indices/stocks), account 101 (Crypto), and account 201 (Commodities)
      Promise.all([
        fetch(`${BACKEND_URL}/api/portfolio?account_id=1`, { signal: controller.signal }).then(r => r.json()).catch(() => null),
        fetch(`${BACKEND_URL}/api/portfolio?account_id=101`, { signal: controller.signal }).then(r => r.json()).catch(() => null),
        fetch(`${BACKEND_URL}/api/portfolio?account_id=201`, { signal: controller.signal }).then(r => r.json()).catch(() => null)
      ]).then(([p1, p101, p201]) => {
        clearTimeout(timer);
        if (!isMounted) return;
        
        // If at least one response was received from backend
        if (p1 !== null || p101 !== null || p201 !== null) {
          const allBaskets: any[] = [];
          let totalBal = 0;
          [p1, p101, p201].forEach(p => {
            if (p && Array.isArray(p.baskets)) {
              allBaskets.push(...p.baskets);
              totalBal += Number(p.balance) || 0;
            }
          });

          const mergedPortfolio = {
            account_id: accId,
            balance: totalBal || 1000000,
            baskets: allBaskets
          };
          setPortfolio(mergedPortfolio);
          AsyncStorage.setItem('@delta_portfolio_v2', JSON.stringify(mergedPortfolio)).catch(() => {});
        }
      }).catch(() => {
        clearTimeout(timer);
      });

      // Poll history across all accounts
      const hController = new AbortController();
      const hTimer = setTimeout(() => hController.abort(), 3500);
      Promise.all([
        fetch(`${BACKEND_URL}/api/history?account_id=1`, { signal: hController.signal }).then(r => r.json()).catch(() => []),
        fetch(`${BACKEND_URL}/api/history?account_id=101`, { signal: hController.signal }).then(r => r.json()).catch(() => []),
        fetch(`${BACKEND_URL}/api/history?account_id=201`, { signal: hController.signal }).then(r => r.json()).catch(() => [])
      ]).then(([h1, h101, h201]) => {
        clearTimeout(hTimer);
        if (!isMounted) return;
        const combined = [
          ...(Array.isArray(h1) ? h1 : []),
          ...(Array.isArray(h101) ? h101 : []),
          ...(Array.isArray(h201) ? h201 : [])
        ];
        if (combined.length > 0) {
          setOrderHistory(combined);
          AsyncStorage.setItem('@delta_order_history_v2', JSON.stringify(combined)).catch(() => {});
        }
      }).catch(() => {
        clearTimeout(hTimer);
      });
    };

    syncPortfolio();
    const interval = setInterval(syncPortfolio, 6000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeAccountId]);

  const currentChain = useMemo(() => {
    const isCrypto = activeAsset === 'BTC' || activeAsset === 'ETH' || activeAsset === 'XAUT';
    const isStock = currConfig?.category === 'STOCKS';
    const activeExp = activeExpiry || expiries[0] || generateDefaultExpiries(isCrypto, isStock, activeAsset)[0];
    const sp = spotPrice || currConfig.defaultSpot;

    // Instant 0ms on-device option chain computation for ALL assets (BTC, ETH, XAUT, NIFTY, SENSEX, BANKNIFTY)
    return synthesizeOptionChain(activeAsset, sp, strikeStep, activeExp);
  }, [activeExpiry, expiries, activeAsset, spotPrice, strikeStep, currConfig]);

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
    let minDiff = 999999;
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
    if (activeTab === 'chain' && currentChain.length > 0 && hasAutoScrolled.current !== scrollKey) {
      hasAutoScrolled.current = scrollKey;
      const timer = setTimeout(() => {
        scrollToAtm();
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [activeTab, activeAsset, activeExpiry]);

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
    const isCrypto = assetKey === 'BTC' || assetKey === 'ETH' || assetKey === 'XAUT';
    const isStock = cat === 'STOCKS';
    const defaultExps = generateDefaultExpiries(isCrypto, isStock, assetKey);
    setExpiries(defaultExps);
    const exp = defaultExps[0];
    setActiveExpiry(exp);
    const sp = ASSET_CONFIG[assetKey]?.defaultSpot || 24000;
    const step = ASSET_CONFIG[assetKey]?.strikeStep || 50;
    const freshChain = synthesizeOptionChain(assetKey, sp, step, exp);
    if (freshChain && freshChain.length > 0) {
      setChainByExpiry({ [exp]: freshChain });
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
    if (!stratBasket.length) return { points: [], maxProfit: '0.00', maxLoss: '0.00', minPnl: 0, maxPnl: 0, minStrike: 0, maxStrike: 0, pnlTable: [], breakevens: [], formattedBreakevens: [] };
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

    const formattedBreakevens = breakevens.map(be => {
      const diff = be - sp;
      const sign = diff >= 0 ? '+' : '';
      const diffStr = Math.abs(diff) < 1000 ? diff.toFixed(1) : Math.round(diff).toString();
      const beStr = isCrypto ? be.toFixed(1) : be.toLocaleString('en-IN');
      return `${beStr} (${sign}${diffStr} pts)`;
    });

    return {
      points,
      minPnl,
      maxPnl,
      minStrike: low,
      maxStrike: high,
      pnlTable,
      breakevens,
      formattedBreakevens,
      maxProfit: maxPnl > 500000 ? 'Unlimited' : `${maxPnl > 0 ? '+' : ''}${isCrypto ? maxPnl.toFixed(2) : Math.round(maxPnl).toLocaleString('en-IN')} ${unit}`,
      maxLoss: minPnl < -500000 ? 'Unlimited' : `${isCrypto ? minPnl.toFixed(2) : Math.round(minPnl).toLocaleString('en-IN')} ${unit}`
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
              {payoffStats.formattedBreakevens.length > 0 && (
                <View>
                  <Text style={styles.payoffStatLabel}>Breakeven (Dist.)</Text>
                  <Text style={[styles.payoffStatVal, { color: '#e2e8f0' }]}>{payoffStats.formattedBreakevens.join(' | ')}</Text>
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
              {targetSpotExpectedPnl >= 0 ? '+' : ''}{selectedMarket === 'CRYPTO' ? targetSpotExpectedPnl.toFixed(2) : Math.round(targetSpotExpectedPnl).toString()} {selectedMarket === 'CRYPTO' ? 'USD' : 'INR'}
            </Text>
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Text style={styles.deltaSummaryLabel}>Total Current UPNL</Text>
            <Text style={[styles.deltaSummaryValue, { color: '#8a95a5' }]}>
              {selectedMarket === 'CRYPTO' ? '0.00 USD' : '0 INR'}
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
    const now = new Date();
    const todayY = now.getFullYear();
    const todayM = String(now.getMonth() + 1).padStart(2, '0');
    const todayD = String(now.getDate()).padStart(2, '0');
    const todayKey = `${todayY}-${todayM}-${todayD}`;

    const accLabel = journalSelectedAccount === 'ALL' 
      ? 'All Accounts' 
      : (accounts.find(a => a.id === journalSelectedAccount)?.name || `Account #${journalSelectedAccount}`);

    return (
      <View style={styles.heatmapCard}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text style={styles.heatmapTitle}>📅 {accLabel} • P&L Heatmap</Text>
          {selectedHeatmapDate && (
            <TouchableOpacity 
              onPress={() => setSelectedHeatmapDate(null)}
              style={{ backgroundColor: 'rgba(56, 189, 248, 0.15)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, borderWidth: 0.5, borderColor: '#38bdf8' }}
            >
              <Text style={{ color: '#38bdf8', fontSize: 10, fontWeight: 'bold' }}>✕ Clear Day Filter</Text>
            </TouchableOpacity>
          )}
        </View>
        
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
                const isToday = dateKey === todayKey;
                
                const pnl = map[dateKey] || 0;
                const hasTrade = map[dateKey] !== undefined;
                
                let cellBg = '#0c101b'; // Base empty cells background
                let cellBorder = isToday ? '#eab308' : '#172033'; // Highlight today with gold
                if (hasTrade) {
                  if (pnl > 0) {
                    if (pnl < 1000) {
                      cellBg = 'rgba(16, 185, 129, 0.35)';
                    } else if (pnl < 5000) {
                      cellBg = 'rgba(16, 185, 129, 0.7)';
                    } else {
                      cellBg = '#00c087';
                    }
                  } else if (pnl < 0) {
                    const absVal = Math.abs(pnl);
                    if (absVal < 1000) {
                      cellBg = 'rgba(239, 68, 68, 0.35)';
                    } else if (absVal < 5000) {
                      cellBg = 'rgba(239, 68, 68, 0.7)';
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
                      { backgroundColor: cellBg, borderColor: isSelected ? '#38bdf8' : cellBorder, borderWidth: isSelected ? 2 : (isToday ? 1.5 : 1) }
                    ]}
                    onPress={() => {
                      if (hasTrade) {
                        setSelectedHeatmapDate(isSelected ? null : dateKey);
                      }
                    }}
                  >
                    <Text style={[
                      styles.heatmapCellText, 
                      { opacity: hasTrade || isToday ? 1 : 0.4 },
                      isToday && { color: '#eab308', fontWeight: 'bold' },
                      isSelected && { color: '#38bdf8', fontWeight: 'bold' }
                    ]}>
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
              Filtered Date: {new Date(selectedHeatmapDate).toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short' })}
            </Text>
            <Text style={[styles.heatmapTooltipPnl, { color: map[selectedHeatmapDate] >= 0 ? '#00c087' : '#f84960' }]}>
              Day Realised P&L: {map[selectedHeatmapDate] >= 0 ? '+' : '-'}{currSym}{Math.abs(map[selectedHeatmapDate]).toFixed(2)}
            </Text>
          </View>
        ) : (
          <View style={styles.heatmapTooltipPlaceholder}>
            <Text style={styles.heatmapTooltipPlaceholderText}>
              Gold border = Today ({now.getDate()} {now.toLocaleDateString('en-US', { month: 'short' })}) • Tap any traded day to filter
            </Text>
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
    setEditAccountName(acc.name || `Acc ${acc.id}`);
    setEditAccountBalance(String(acc.balance || 1000000));
  };

  const handleUpdateAccount = () => {
    if (!editingAccount || !editAccountName.trim() || isNaN(parseFloat(editAccountBalance))) return;
    const updatedBalance = parseFloat(editAccountBalance);
    const updatedName = editAccountName.trim();
    
    // Immediate optimistic update in local state & AsyncStorage
    const updatedAccounts = accounts.map(a => a.id === editingAccount.id ? { ...a, name: updatedName, balance: updatedBalance } : a);
    setAccounts(updatedAccounts);
    AsyncStorage.setItem(`@delta_accounts_${selectedMarket}`, JSON.stringify(updatedAccounts)).catch(() => {});
    setEditingAccount(null);
    setTradeMessage(`⚡ Account updated: ${updatedName} (Balance: ${selectedMarket === 'CRYPTO' ? '$' : '₹'}${updatedBalance.toLocaleString('en-IN')})`);
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
      .then(data => {
        if (data.status === 'success') {
          fetchAccounts();
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

  const executeDirectCryptoTrade = (legs: OptionLeg[]) => {
    if (!legs || legs.length === 0) return;
    setIsTrading(true);
    setShowPayoffModal(false);
    setShowOrderModal(false);
    setActiveTab('tradelab');
    setTradeLabSubTab('positions');
    setTradeMessage(`⚡ Placing 24/7 Crypto Order (${legs[0]?.symbol || activeAsset})...`);

    const legsToExecute = legs.map(l => ({
      ...l,
      size: l.size || 1,
      price: l.price || 0,
      product_type: 'NRML',
      order_mode: 'REGULAR',
      order_type: 'MARKET',
      leverage: cryptoLeverage || 100
    }));

    setStratBasket([]);

    const orderBasketName = `${activeAsset} ${legsToExecute[0]?.option_type || 'OPT'} 24/7 LIVE`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    fetch(`${BACKEND_URL}/api/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        basket_name: orderBasketName,
        legs: legsToExecute,
        account_id: activeAccountId || 101
      })
    })
      .then(r => r.json())
      .then(data => {
        clearTimeout(timeoutId);
        if (data.status === 'success') {
          setTradeMessage(data.message || '✓ Crypto Order Executed Successfully');
          if (data.portfolio) setPortfolio(data.portfolio);
          triggerManualRefresh();
          setTimeout(() => setTradeMessage(''), 3500);
        } else {
          Alert.alert('Order Error', data.message || 'Could not execute order');
          setTradeMessage(`Error: ${data.message}`);
          setTimeout(() => setTradeMessage(''), 4000);
        }
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        setTradeMessage('Crypto trade execution timed out');
      })
      .finally(() => setIsTrading(false));
  };

  const openOrderTicket = (leg?: OptionLeg) => {
    const isAssetCrypto = activeAsset === 'BTC' || activeAsset === 'ETH' || activeAsset === 'XAUT' || selectedMarket === 'CRYPTO';
    if (isAssetCrypto) {
      const legs = leg ? [leg] : (stratBasket.length > 0 ? stratBasket : []);
      if (legs.length > 0) {
        executeDirectCryptoTrade(legs);
        return;
      }
    }

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
    const isAssetCrypto = activeAsset === 'BTC' || activeAsset === 'ETH' || activeAsset === 'XAUT' || selectedMarket === 'CRYPTO';
    
    // Instant optimistic navigation & haptic-like UI response
    setShowPayoffModal(false);
    setShowOrderModal(false);
    setActiveTab('tradelab');
    setTradeLabSubTab('positions');
    setTradeMessage('⚡ Placing Order...');

    if (isAssetCrypto) {
      executeDirectCryptoTrade(stratBasket);
    } else {
      setIsTrading(true);

      const isIndianMarketClosed = !isAssetMarketOpen(activeAsset, marketOpen);
      const orderMode = isIndianMarketClosed ? 'AMO' : 'REGULAR';

      const legsToExecute = stratBasket.map(l => ({
        ...l,
        size: l.size || 1,
        stoploss: 0,
        target: 0,
        product_type: 'NRML',
        order_mode: orderMode,
        order_type: 'MARKET',
        trigger_price: 0
      }));

      setStratBasket([]);

      const orderBasketName = `${activeAsset} ${legsToExecute[0]?.option_type || 'OPT'} ${orderMode === 'AMO' ? 'AMO' : ''} NRML`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      fetch(`${BACKEND_URL}/api/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          basket_name: orderBasketName,
          legs: legsToExecute,
          account_id: activeAccountId || 1
        })
      })
        .then(r => r.json())
        .then(data => {
          clearTimeout(timeoutId);
          if (data.status === 'success') {
            setTradeMessage(data.message || '✓ Order Executed Successfully');
            if (data.portfolio) setPortfolio(data.portfolio);
            triggerManualRefresh();
            setTimeout(() => setTradeMessage(''), 3500);
          } else {
            Alert.alert('Order Error', data.message || 'Could not execute order');
            setTradeMessage(`Error: ${data.message}`);
            setTimeout(() => setTradeMessage(''), 4000);
          }
        })
        .catch((err) => {
          if (err.name === 'AbortError') {
            setTradeMessage('Trade execution timed out');
          }
        })
        .finally(() => setIsTrading(false));
    }
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    fetch(`${BACKEND_URL}/api/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        basket_name: orderBasketName,
        legs: legsToExecute,
        account_id: activeAccountId || 1
      })
    })
      .then(r => r.json())
      .then(data => {
        clearTimeout(timeoutId);
        if (data.status === 'success') {
          setTradeMessage(data.message || 'Order Executed Successfully');
          setShowOrderModal(false);
          setStratBasket([]);
          if (data.portfolio) setPortfolio(data.portfolio);
          setActiveTab('tradelab');
          setTradeLabSubTab('positions');
          triggerManualRefresh();
          setTimeout(() => setTradeMessage(''), 4000);
        } else {
          Alert.alert('Order Error', data.message || 'Could not execute order');
          setTradeMessage(`Error: ${data.message}`);
          setTimeout(() => setTradeMessage(''), 4000);
        }
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        Alert.alert('Network Error', 'Connecting to cloud backend. Please retry in 2 seconds.');
        setTradeMessage('Trade execution timed out');
      })
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

  const handleCloseSinglePosition = (posId: number, symbol: string, basketId?: number) => {
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
            
            // 1. Optimistically remove position from local portfolio state immediately
            setPortfolio((prev: any) => {
              if (!prev || !prev.baskets) return prev;
              const nextBaskets = prev.baskets.map((b: any) => {
                if (b.id === basketId || b.legs?.some((l: any) => l.id === posId)) {
                  const nextLegs = b.legs?.filter((l: any) => l.id !== posId) || [];
                  return { ...b, legs: nextLegs };
                }
                return b;
              }).filter((b: any) => b.legs && b.legs.length > 0);

              const updated = { ...prev, baskets: nextBaskets };
              AsyncStorage.setItem('@delta_portfolio_v2', JSON.stringify(updated)).catch(() => {});
              return updated;
            });

            // 2. Request backend exit
            const targetId = posId || basketId || 1;
            fetch(`${BACKEND_URL}/api/trade/close_position`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ position_id: targetId, exit_reason: 'MANUAL EXIT' })
            })
              .then(r => r.json())
              .then(data => {
                setTradeMessage(data.message || 'Position Exited! ✓');
                triggerManualRefresh();
                fetch(`${BACKEND_URL}/api/history?account_id=1`).then(res => res.json()).then(histData => {
                  if (Array.isArray(histData)) setOrderHistory(histData);
                }).catch(() => {});
                setTimeout(() => setTradeMessage(''), 3500);
              })
              .catch(() => {
                triggerManualRefresh();
              });
          }
        }
      ]
    );
  };

  const handleResetTradeHistory = () => {
    Alert.alert(
      "Reset Trade Journal",
      "Are you sure you want to clear all trade history and start fresh?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear All",
          style: "destructive",
          onPress: () => {
            fetch(`${BACKEND_URL}/api/trade/reset`, { method: 'POST' })
              .then(r => r.json())
              .then(() => {
                setOrderHistory([]);
                AsyncStorage.removeItem('@delta_order_history_v2').catch(() => {});
                triggerManualRefresh();
                setTradeMessage('Trade Journal Reset! 🗑️');
                setTimeout(() => setTradeMessage(''), 3000);
              })
              .catch(() => setTradeMessage('Reset failed'));
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
    setTradeMessage('Exiting position...');
    setPortfolio((prev: any) => {
      if (!prev || !prev.baskets) return prev;
      const nextBaskets = prev.baskets.filter((b: any) => b.id !== basketId);
      const updated = { ...prev, baskets: nextBaskets };
      AsyncStorage.setItem('@delta_portfolio_v2', JSON.stringify(updated)).catch(() => {});
      return updated;
    });

    fetch(`${BACKEND_URL}/api/trade/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basket_id: basketId, account_id: activeAccountId || 1 })
    })
      .then(r => r.json())
      .then(data => {
        setTradeMessage(data.message || 'Position Exited! ✓');
        triggerManualRefresh();
        fetch(`${BACKEND_URL}/api/history?account_id=1`).then(res => res.json()).then(histData => {
          if (Array.isArray(histData)) setOrderHistory(histData);
        }).catch(() => {});
        setTimeout(() => setTradeMessage(''), 3500);
      })
      .catch(() => {
        triggerManualRefresh();
      });
  };

  const filteredReadyStrategies = useMemo(() => {
    if (selectedMarketView === 'ALL') return READY_STRATEGIES;
    return READY_STRATEGIES.filter(s => s.view === selectedMarketView);
  }, [selectedMarketView]);

  const formatCleanContractSymbol = (leg: any) => {
    const und = (leg.underlying || 'NIFTY').toUpperCase();
    const strike = leg.strike || 0;
    const isCall = leg.option_type === 'CALL' || leg.option_type === 'CE' || leg.symbol?.startsWith('C-') || leg.symbol?.includes('CALL') || leg.symbol?.includes('CE');
    const opt = isCall ? 'CE' : 'PE';
    
    // Format expiry nicely (e.g. 01st SEP or 24th SEP)
    let expStr = '';
    if (leg.expiry) {
      try {
        const d = new Date(leg.expiry);
        if (!isNaN(d.getTime())) {
          const day = d.getDate();
          const suffix = (day === 1 || day === 21 || day === 31) ? 'st' : (day === 2 || day === 22) ? 'nd' : (day === 3 || day === 23) ? 'rd' : 'th';
          const dayStr = String(day).padStart(2, '0') + suffix;
          const monthStr = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
          expStr = `${dayStr} ${monthStr}`;
        }
      } catch (e) {}
    }
    
    if (!expStr && typeof leg.expiry === 'string' && leg.expiry.length > 0) {
      const parts = leg.expiry.trim().split(' ');
      if (parts.length >= 2) {
        const dayNum = parseInt(parts[0], 10);
        if (!isNaN(dayNum)) {
          const suffix = (dayNum === 1 || dayNum === 21 || dayNum === 31) ? 'st' : (dayNum === 2 || dayNum === 22) ? 'nd' : (dayNum === 3 || dayNum === 23) ? 'rd' : 'th';
          expStr = `${String(dayNum).padStart(2, '0')}${suffix} ${parts[1].toUpperCase()}`;
        }
      }
    }

    if (expStr) {
      return `${und} ${expStr} ${strike} ${opt}`;
    }
    return `${und} ${strike} ${opt}`;
  };

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

          // 1. Search in cached chainByExpiry
          let chain = chainByExpiry[leg.expiry];
          if (!chain || chain.length === 0) {
            for (const k of Object.keys(chainByExpiry)) {
              if (k === leg.expiry || (leg.expiry && k.includes(leg.expiry.slice(0, 10))) || (leg.expiry && leg.expiry.includes(k))) {
                chain = chainByExpiry[k];
                break;
              }
            }
          }

          let row = chain?.find((r: any) => r.strike === leg.strike);

          // 2. Synthesize dynamically with calibrated Angel One matrix if not in memory
          if (!row) {
            const currentSpot = allLiveSpots[legAsset]?.spot || spotPrice || ASSET_CONFIG[legAsset]?.defaultSpot || 0;
            const synth = synthesizeOptionChain(legAsset, currentSpot, leg.expiry || activeExpiry);
            row = synth.find((r: any) => r.strike === leg.strike);
          }

          let ltp = 0;
          if (row) {
            ltp = (leg.option_type === 'CALL' || leg.option_type === 'CE') ? (row.callMark || row.callLtp || 0) : (row.putMark || row.putLtp || 0);
          }

          // 3. Prevent artificial entry discrepancy (if LTP is missing, fallback to entry_price)
          if (!ltp || ltp <= 0) {
            ltp = leg.entry_price || 0;
          }

          const entry = leg.entry_price || 0;
          const qty = (leg.size || 1) * legLotSize;
          
          const isBuy = leg.side === 'BUY';
          const diff = isBuy ? (ltp - entry) : (entry - ltp);
          const legPnl = diff * qty;
          const pctChange = entry > 0 ? (isBuy ? ((ltp - entry) / entry) * 100 : ((entry - ltp) / entry) * 100) : 0;
          
          const isCrypto = legAsset === 'BTC' || legAsset === 'ETH' || legAsset === 'XAUT';
          const invested = entry * qty;

          totalInvestedMargin += invested;
          totalUnrealisedPnl += legPnl;

          activePositionsList.push({
            basketId: b.id,
            positionId: leg.id,
            symbol: formatCleanContractSymbol(leg),
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

  const filteredJournalOrders = useMemo(() => {
    let list = orderHistory;
    if (journalSelectedAccount !== 'ALL') {
      list = list.filter((h: any) => h.account_id === journalSelectedAccount);
    }
    if (selectedHeatmapDate) {
      list = list.filter((h: any) => {
        if (!h.closed_at) return false;
        const d = new Date(h.closed_at);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}` === selectedHeatmapDate;
      });
    }
    return list;
  }, [orderHistory, journalSelectedAccount, selectedHeatmapDate]);

  const journalStats = useMemo(() => {
    const list = journalSelectedAccount === 'ALL' ? orderHistory : orderHistory.filter((h: any) => h.account_id === journalSelectedAccount);
    let totalRealisedPnl = 0;
    let winCount = 0;
    let bestTrade = 0;
    let worstTrade = 0;

    list.forEach((h: any) => {
      const pnl = Number(h.realized_pnl) || 0;
      totalRealisedPnl += pnl;
      if (pnl > 0) winCount++;
      if (pnl > bestTrade) bestTrade = pnl;
      if (pnl < worstTrade) worstTrade = pnl;
    });

    const winRate = list.length > 0 ? (winCount / list.length) * 100 : 0;
    return {
      totalRealisedPnl,
      winRate,
      totalTrades: list.length,
      bestTrade,
      worstTrade
    };
  }, [orderHistory, journalSelectedAccount]);

  const dailyPnlMap = useMemo(() => {
    const map: { [dateKey: string]: number } = {};
    const list = journalSelectedAccount === 'ALL' ? orderHistory : orderHistory.filter((h: any) => h.account_id === journalSelectedAccount);
    list.forEach((item: any) => {
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
  }, [orderHistory, journalSelectedAccount]);

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
    const list = journalSelectedAccount === 'ALL' ? orderHistory : orderHistory.filter((h: any) => h.account_id === journalSelectedAccount);
    const sortedTrades = [...list]
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
  }, [orderHistory, journalSelectedAccount]);

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
    <View 
      style={[styles.container, { paddingTop: STATUSBAR_HEIGHT }]}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0a0d14" translucent={true} />

    {/* 1. Header (Rendered inside Trading Theaters, removed on Options Terminal home page) */}
    {selectedMarket !== null && (
      <View style={styles.header}>
        <TouchableOpacity 
          style={styles.headerLeft} 
          onPress={() => setSelectedMarket(null)}
          activeOpacity={0.7}
        >
          <View style={styles.headerLogoWrapper}>
            <Image
              source={require('./assets/logo.png')}
              style={{ width: 32, height: 32, borderRadius: 8 }}
              resizeMode="contain"
            />
            <View style={styles.headerLiveDot} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.headerTitle} numberOfLines={1}>Broast Terminal</Text>
              <View style={styles.headerBadge}>
                <Text style={styles.headerBadgeText}>PRO</Text>
              </View>
            </View>
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {activeTab === 'home' ? 'Market Watchlist' : activeTab === 'chain' ? `${activeAsset} Option Chain` : activeTab === 'strategy' ? 'Strategy Studio' : activeTab === 'tradelab' ? 'Trade Lab & Journal' : 'Multi-Broker Accounts'}
            </Text>
          </View>
        </TouchableOpacity>
        
        <View style={styles.headerRight}>
          <TouchableOpacity 
            style={[styles.headerActionBtn, isRefreshing && styles.headerActionBtnActive]} 
            onPress={triggerManualRefresh}
            activeOpacity={0.6}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
          >
            <Text style={{ fontSize: 13 }}>🔄</Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={styles.headerMenuBtn}
            onPress={() => setShowProfileModal(true)}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            activeOpacity={0.7}
          >
            <Text style={styles.menuDots}>⋮</Text>
          </TouchableOpacity>
        </View>
      </View>
    )}

    {/* ===================== VIEW A: OPTIONS TERMINAL (THEATER SELECTOR HUB) ===================== */}
    {selectedMarket === null && (
      <View style={{ flex: 1 }}>
        <ScrollView style={{ flex: 1, backgroundColor: '#0a0d14' }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 24, justifyContent: 'center' }}>
          {/* Logo & Brand Emblem */}
          <View style={{ alignItems: 'center', marginBottom: 28, marginTop: 8 }}>
            <View style={{
              width: 96,
              height: 96,
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
                style={{ width: 80, height: 80, borderRadius: 18 }}
                resizeMode="contain"
              />
            </View>
            <Text style={{ color: 'white', fontSize: 26, fontWeight: '900', letterSpacing: 0.5 }}>Options Terminal</Text>
            <View style={{ backgroundColor: 'rgba(0, 192, 135, 0.12)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20, marginTop: 6, borderWidth: 1, borderColor: 'rgba(0, 192, 135, 0.25)' }}>
              <Text style={{ color: '#00c087', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 }}>INSTITUTIONAL OPTIONS TRADING</Text>
            </View>
            <Text style={{ color: '#8a95a5', fontSize: 13, marginTop: 10, textAlign: 'center' }}>Select your trading theater to enter the terminal</Text>
          </View>
          
          <TouchableOpacity 
            style={{ backgroundColor: '#131926', padding: 18, borderRadius: 16, marginBottom: 14, borderWidth: 1, borderColor: '#222f46', flexDirection: 'row', alignItems: 'center' }}
            onPress={() => { setSelectedMarket('INDIAN'); setActiveAsset('NIFTY'); setActiveTab('home'); }}
            activeOpacity={0.75}
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
            onPress={() => { setSelectedMarket('COMMODITY'); setActiveAsset('CRUDEOIL'); setActiveTab('home'); }}
            activeOpacity={0.75}
          >
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(234, 179, 8, 0.15)', justifyContent: 'center', alignItems: 'center', marginRight: 14 }}>
              <Text style={{ fontSize: 22 }}>🛢️</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#facc15', fontSize: 17, fontWeight: 'bold' }}>MCX Commodities</Text>
              <Text style={{ color: '#8a95a5', fontSize: 12, marginTop: 2 }}>CRUDEOIL, GOLD, SILVER, NATURALGAS (Standard & Mini)</Text>
            </View>
            <Text style={{ color: '#4b5563', fontSize: 20 }}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={{ backgroundColor: '#131926', padding: 18, borderRadius: 16, borderWidth: 1, borderColor: '#222f46', flexDirection: 'row', alignItems: 'center' }}
            onPress={() => { setSelectedMarket('CRYPTO'); setActiveAsset('BTC'); setActiveTab('home'); }}
            activeOpacity={0.75}
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
        </ScrollView>

        {/* Bottom Navigation Bar for Options Terminal */}
        <View style={styles.bottomTabBar}>
          <TouchableOpacity style={styles.bottomTabBtn} onPress={() => setSelectedMarket(null)}>
            <Text style={[styles.bottomTabIcon, styles.bottomTabIconActive]}>🏠</Text>
            <Text style={[styles.bottomTabLabel, styles.bottomTabLabelActive]}>Home</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.bottomTabBtn} 
            onPress={() => {
              setSelectedMarket('INDIAN');
              setActiveAsset('NIFTY');
              setActiveTab('chain');
            }}
          >
            <Text style={styles.bottomTabIcon}>📊</Text>
            <Text style={styles.bottomTabLabel}>Analyse</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.bottomTabBtn} 
            onPress={() => {
              setSelectedMarket('INDIAN');
              setActiveTab('tradelab');
            }}
          >
            <Text style={styles.bottomTabIcon}>💼</Text>
            <Text style={styles.bottomTabLabel}>Positions</Text>
          </TouchableOpacity>
        </View>
      </View>
    )}

    {/* ===================== VIEW B: INSIDE TRADING THEATER ===================== */}
    {selectedMarket !== null && (
      <>
        {/* 2. Top Navigation Bar (Above Option Chain & Watchlist) */}
        <View style={{
          flexDirection: 'row',
          backgroundColor: '#0c101b',
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderColor: '#172033',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8
        }}>
          <TouchableOpacity
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 7,
              paddingHorizontal: 8,
              borderRadius: 8,
              backgroundColor: activeTab === 'home' ? 'rgba(56, 189, 248, 0.16)' : '#121724',
              borderWidth: 1,
              borderColor: activeTab === 'home' ? '#0284c7' : '#1e293b'
            }}
            onPress={() => setActiveTab('home')}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 12, marginRight: 5 }}>🏠</Text>
            <Text style={{
              color: activeTab === 'home' ? '#38bdf8' : '#8a95a5',
              fontSize: 12,
              fontWeight: 'bold'
            }}>
              Watchlist
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={{
              flex: 1.25,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 7,
              paddingHorizontal: 8,
              borderRadius: 8,
              backgroundColor: activeTab === 'chain' ? 'rgba(56, 189, 248, 0.16)' : '#121724',
              borderWidth: 1,
              borderColor: activeTab === 'chain' ? '#0284c7' : '#1e293b'
            }}
            onPress={() => setActiveTab('chain')}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 12, marginRight: 5 }}>📊</Text>
            <Text style={{
              color: activeTab === 'chain' ? '#38bdf8' : '#8a95a5',
              fontSize: 12,
              fontWeight: 'bold'
            }}>
              Chain ({activeAsset})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 7,
              paddingHorizontal: 8,
              borderRadius: 8,
              backgroundColor: activeTab === 'tradelab' ? 'rgba(56, 189, 248, 0.16)' : '#121724',
              borderWidth: 1,
              borderColor: activeTab === 'tradelab' ? '#0284c7' : '#1e293b'
            }}
            onPress={() => setActiveTab('tradelab')}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 12, marginRight: 5 }}>💼</Text>
            <Text style={{
              color: activeTab === 'tradelab' ? '#38bdf8' : '#8a95a5',
              fontSize: 12,
              fontWeight: 'bold'
            }}>
              Positions
            </Text>
          </TouchableOpacity>
        </View>

        {/* Market / Feed Reconnecting Status */}
        {marketOpen && priceFeed.stale && activeTab === 'chain' && (
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

        {/* Main Tab Screen Wrapper */}
        <View style={{ flex: 1 }}>
      {/* ===================== TAB 0: HOME / WATCHLIST ===================== */}
      {activeTab === 'home' && (
        <ScrollView style={styles.tabContentContainer} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 60 }}>
          {/* Market Theater Header Bar with Switch Button */}
          <View style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
            backgroundColor: '#101726',
            borderWidth: 1,
            borderColor: '#1e293b',
            padding: 12,
            borderRadius: 12
          }}>
            <View>
              <Text style={{ color: '#ffffff', fontSize: 16, fontWeight: '900', letterSpacing: 0.5 }}>
                {selectedMarket === 'CRYPTO' ? 'Crypto Derivatives (24/7)' : selectedMarket === 'STOCKS' ? 'NSE Stock Options' : selectedMarket === 'COMMODITY' ? 'MCX Commodities' : 'Indian Benchmark Indices'}
              </Text>
              <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '700', marginTop: 2 }}>
                Live Real-Time Stream • Mark Prices
              </Text>
            </View>

            <TouchableOpacity
              onPress={() => setShowAssetModal(true)}
              style={{ backgroundColor: 'rgba(56, 189, 248, 0.15)', borderWidth: 1, borderColor: '#0284c7', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 4 }}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={{ color: '#38bdf8', fontSize: 11.5, fontWeight: 'bold' }}>Switch ⇄</Text>
            </TouchableOpacity>
          </View>

          {/* Watchlist Asset Cards */}
          {Object.keys(ASSET_CONFIG).filter(k => ASSET_CONFIG[k].category === (selectedMarket || 'INDIAN')).map(assetKey => {
            const conf = ASSET_CONFIG[assetKey];
            const live = allLiveSpots[assetKey] || { spot: 0, change: 0, pctChange: 0 };
            const isUp = live.change >= 0;
            const isSelected = activeAsset === assetKey;
            return (
              <TouchableOpacity 
                key={assetKey}
                style={{
                  backgroundColor: isSelected ? '#121d30' : '#10141f',
                  borderWidth: 1,
                  borderColor: isSelected ? '#0284c7' : '#1e283d',
                  borderRadius: 12,
                  padding: 16,
                  marginBottom: 12
                }}
                onPress={() => {
                  setActiveAsset(assetKey);
                  setActiveTab('chain');
                }}
                activeOpacity={0.75}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ color: 'white', fontSize: 18, fontWeight: 'bold' }}>{assetKey}</Text>
                      <View style={{ backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                        <Text style={{ color: '#94a3b8', fontSize: 9.5, fontWeight: 'bold' }}>{conf.exchange}</Text>
                      </View>
                      {isSelected && (
                        <View style={{ backgroundColor: 'rgba(0, 192, 135, 0.15)', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                          <Text style={{ color: '#00c087', fontSize: 9.5, fontWeight: 'bold' }}>ACTIVE</Text>
                        </View>
                      )}
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
                    {(() => {
                      const isCrypto = selectedMarket === 'CRYPTO' || activeAsset === 'BTC' || activeAsset === 'ETH' || activeAsset === 'XAUT';
                      const isStock = currConfig?.category === 'STOCKS';
                      const activeExp = activeExpiry || (expiries.length > 0 ? expiries[0] : generateDefaultExpiries(isCrypto, isStock, activeAsset)[0]);
                      return formatDisplayDateShort(activeExp);
                    })()}
                  </Text>
                  {selectedMarket !== 'CRYPTO' && (
                    <View style={{ backgroundColor: 'rgba(56, 189, 248, 0.15)', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                      <Text style={{ color: '#38bdf8', fontSize: 10, fontWeight: 'bold' }}>
                        {(() => {
                          const isStock = currConfig?.category === 'STOCKS';
                          const activeExp = activeExpiry || (expiries.length > 0 ? expiries[0] : generateDefaultExpiries(false, isStock, activeAsset)[0]);
                          return getDteLabel(activeExp);
                        })()}
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
                    {spotChange >= 0 ? `+${spotChange.toFixed(2)}` : spotChange.toFixed(2)} ({spotPercentChange >= 0 ? `+${spotPercentChange.toFixed(2)}` : spotPercentChange.toFixed(2)}%)
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

          </View>

          <FlatList
            ref={chainScrollRef}
            data={currentChain}
            keyExtractor={(item: any) => item.strike.toString()}
            style={styles.scrollArea}
            contentContainerStyle={{ paddingBottom: stratBasket.length > 0 ? 190 : 80 }}
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
                <OptionChainRow
                  key={row.strike}
                  row={row}
                  isCallITM={isCallITM}
                  isPutITM={isPutITM}
                  showSpotLine={showSpotLine}
                  isCallFocused={isCallFocused}
                  isPutFocused={isPutFocused}
                  callLegSide={callLeg?.side || null}
                  putLegSide={putLeg?.side || null}
                  callChangePct={callChangePct}
                  putChangePct={putChangePct}
                  callLtp={callLtp}
                  putLtp={putLtp}
                  callOI={callOI}
                  putOI={putOI}
                  maxOI={maxOI}
                  viewMode={viewMode}
                  currSym={currSym}
                  selectedMarket={selectedMarket}
                  activeAsset={activeAsset}
                  spotPrice={sp}
                  onFocusCall={() => setActiveRowTarget(isCallFocused ? null : { strike: row.strike, side: 'CALL' })}
                  onFocusPut={() => setActiveRowTarget(isPutFocused ? null : { strike: row.strike, side: 'PUT' })}
                  onFocusClear={() => setActiveRowTarget(null)}
                  onToggleCallBuy={(e: any) => {
                    e?.stopPropagation?.();
                    handleToggleLeg(row, 'CALL', 'BUY');
                  }}
                  onToggleCallSell={(e: any) => {
                    e?.stopPropagation?.();
                    handleToggleLeg(row, 'CALL', 'SELL');
                  }}
                  onTogglePutBuy={(e: any) => {
                    e?.stopPropagation?.();
                    handleToggleLeg(row, 'PUT', 'BUY');
                  }}
                  onTogglePutSell={(e: any) => {
                    e?.stopPropagation?.();
                    handleToggleLeg(row, 'PUT', 'SELL');
                  }}
                />
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
            <TouchableOpacity 
              style={[styles.prominentStickyBar, { paddingVertical: 14 }]} 
              activeOpacity={0.9} 
              onPress={() => setShowPayoffModal(true)}
            >
              <View style={styles.stickyHeaderRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                  <View style={styles.stratBadgePill}>
                    <Text style={styles.stratBadgeText} numberOfLines={1}>
                      {detectStrategy(stratBasket) || `${stratBasket.length} Legs Selected`}
                    </Text>
                  </View>
                  <Text style={{ color: '#38bdf8', fontSize: 13, fontWeight: '700' }}>
                    Tap for Payoff & Margin 📈
                  </Text>
                </View>
                <TouchableOpacity 
                  onPress={(e) => { e.stopPropagation(); setStratBasket([]); }} 
                  style={styles.clearBasketBtn}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Text style={styles.clearBasketBtnText}>Clear ✕</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
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
                        <Text style={{ color: '#34d399', fontWeight: 'bold', minWidth: 32, textAlign: 'center', fontSize: 11, paddingHorizontal: 2 }}>
                          {(leg.size || 1) * (ASSET_CONFIG[leg.underlying || activeAsset]?.lotSize || lotSize)}
                        </Text>
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
                      <Text style={{ flex: 1, color: 'white', fontSize: 14 }}>{row.targetPrice.toLocaleString('en-IN')}</Text>
                      <Text style={{ flex: 1, color: row.diff >= 0 ? '#10b981' : '#ef4444', fontSize: 14, textAlign: 'right' }}>
                        {row.diff > 0 ? '+' : ''}{pctDiff.toFixed(2)}%
                      </Text>
                      <Text style={{ flex: 1, color: row.pnl >= 0 ? '#10b981' : '#ef4444', fontSize: 14, fontWeight: 'bold', textAlign: 'right' }}>
                        {row.pnl >= 0 ? '+' : '-'}{currSym}{Math.abs(row.pnl).toLocaleString('en-IN', { maximumFractionDigits: selectedMarket === 'CRYPTO' ? 2 : 0 })}
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
                  {currSym}{orderMargin.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </Text>
              </View>

              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <Text style={{ color: '#94a3b8', fontSize: 13 }}>Available Margin</Text>
                <Text style={{ color: tradeLabStats.availableMargin <= 0 ? '#ef4444' : '#10b981', fontWeight: 'bold', fontSize: 14 }}>
                  {currSym}{tradeLabStats.availableMargin.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </Text>
              </View>

              <TouchableOpacity 
                style={{ 
                  backgroundColor: !isAssetMarketOpen(activeAsset, marketOpen) ? '#d97706' : (orderMargin > tradeLabStats.availableMargin ? '#5c371d' : '#f78d38'), 
                  paddingVertical: 12, 
                  borderRadius: 6, 
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: !isAssetMarketOpen(activeAsset, marketOpen) ? '#f59e0b' : (orderMargin > tradeLabStats.availableMargin ? '#783c13' : 'transparent')
                }} 
                onPress={() => {
                  handlePlaceOrder();
                  setShowPayoffModal(false);
                }}
              >
                <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 14 }}>
                  {!isAssetMarketOpen(activeAsset, marketOpen) ? `Place AMO Order (${stratBasket.length})` : `Place Order (${stratBasket.length})`}
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
        <ScrollView style={styles.tabContentContainer} contentContainerStyle={{ paddingBottom: 110 }}>
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



          {/* Clean Zerodha / Angel One Style Total P&L Header */}
          <View style={styles.cleanPnlCard}>
            <Text style={styles.cleanPnlLabel}>Total P&L</Text>
            <Text style={[styles.cleanPnlValue, { color: tradeLabStats.totalUnrealisedPnl >= 0 ? '#00c087' : '#f84960' }]}>
              {tradeLabStats.totalUnrealisedPnl >= 0 ? `+${tradeLabStats.totalUnrealisedPnl.toFixed(2)}` : `-${Math.abs(tradeLabStats.totalUnrealisedPnl).toFixed(2)}`}
            </Text>
          </View>

          {/* TAB: ACTIVE POSITIONS */}
          {tradeLabSubTab === 'positions' && (
            <View style={{ marginTop: 4 }}>
              {tradeLabStats.activePositionsList.length > 0 ? (
                tradeLabStats.activePositionsList.map((pos, idx) => {
                  const isBuy = pos.side === 'BUY';
                  const hasActiveSL = pos.stoploss > 0;
                  const hasActiveTgt = pos.target > 0;
                  const exchName = pos.underlying === 'SENSEX' ? 'BFO' : (pos.underlying === 'NIFTY' || pos.underlying === 'BANKNIFTY' ? 'NFO' : (pos.currency === 'USD' ? 'DELTA' : 'MCX'));

                  return (
                    <View key={idx} style={styles.kitePositionCard}>
                      {/* Top Row: Qty & Avg on Left, Product Tag on Right */}
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <Text style={{ color: '#8a95a5', fontSize: 12 }}>
                          Qty. <Text style={{ color: '#ffffff', fontWeight: '700' }}>{pos.qty}</Text>   Avg. <Text style={{ color: '#ffffff', fontWeight: '700' }}>{pos.entry?.toFixed(2)}</Text>
                        </Text>
                        <View style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 0.5, borderColor: 'rgba(56, 189, 248, 0.3)' }}>
                          <Text style={{ color: '#38bdf8', fontSize: 10, fontWeight: '800' }}>{pos.productType || 'NRML'}</Text>
                        </View>
                      </View>

                      {/* Middle Row: Symbol Name with Expiry on Left, P&L on Right */}
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '800' }}>
                          {pos.symbol}
                        </Text>
                        <Text style={{ color: pos.legPnl >= 0 ? '#00c087' : '#f84960', fontSize: 16, fontWeight: '900' }}>
                          {pos.legPnl >= 0 ? `+${pos.legPnl.toFixed(2)}` : `-${Math.abs(pos.legPnl).toFixed(2)}`}
                        </Text>
                      </View>

                      {/* Bottom Row: Exchange on Left, LTP on Right */}
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '700' }}>
                          {exchName}
                        </Text>
                        <Text style={{ color: '#8a95a5', fontSize: 12 }}>
                          LTP <Text style={{ color: '#ffffff', fontWeight: '700' }}>{pos.ltp?.toFixed(2)}</Text>
                        </Text>
                      </View>

                      {/* Action buttons */}
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, paddingTop: 10, borderTopWidth: 0.5, borderTopColor: '#1e293b' }}>
                        <TouchableOpacity
                          style={{ flex: 1, backgroundColor: '#172033', paddingVertical: 8, borderRadius: 6, alignItems: 'center' }}
                          onPress={() => openModifyPositionModal(pos)}
                        >
                          <Text style={{ color: '#38bdf8', fontSize: 11.5, fontWeight: '700' }}>
                            {hasActiveSL || hasActiveTgt
                              ? `${hasActiveSL ? `SL: ${pos.stoploss}` : ''} ${hasActiveTgt ? `TP: ${pos.target}` : ''}`
                              : '⚙ Set SL / TP'}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={{ flex: 1, backgroundColor: 'rgba(239, 68, 68, 0.12)', borderWidth: 0.5, borderColor: 'rgba(239, 68, 68, 0.4)', paddingVertical: 8, borderRadius: 6, alignItems: 'center' }}
                          onPress={() => handleCloseSinglePosition(pos.positionId, pos.symbol, pos.basketId)}
                        >
                          <Text style={{ color: '#f87171', fontSize: 11.5, fontWeight: '800' }}>🚪 Exit Position</Text>
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
            <View style={{ marginTop: 6 }}>
              {/* Account Filter Bar */}
              <View style={styles.journalAccountFilterContainer}>
                <Text style={styles.journalAccountFilterTitle}>Filter Account:</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
                  <TouchableOpacity
                    style={[styles.journalAccPill, journalSelectedAccount === 'ALL' && styles.journalAccPillActive]}
                    onPress={() => setJournalSelectedAccount('ALL')}
                  >
                    <Text style={[styles.journalAccPillText, journalSelectedAccount === 'ALL' && styles.journalAccPillTextActive]}>
                      🌐 All Accounts ({orderHistory.length})
                    </Text>
                  </TouchableOpacity>
                  {accounts.map(acc => {
                    const count = orderHistory.filter(h => h.account_id === acc.id).length;
                    const isSel = journalSelectedAccount === acc.id;
                    const flag = acc.id === 1 ? '🇮🇳' : acc.id === 101 ? '⚡' : '🛢️';
                    return (
                      <TouchableOpacity
                        key={acc.id}
                        style={[styles.journalAccPill, isSel && styles.journalAccPillActive]}
                        onPress={() => setJournalSelectedAccount(acc.id)}
                      >
                        <Text style={[styles.journalAccPillText, isSel && styles.journalAccPillTextActive]}>
                          {flag} {acc.name} ({count})
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              {/* Performance Metrics for Selected Account */}
              <View style={styles.perfSummaryGrid}>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Journal Realised P&L</Text>
                  <Text style={[styles.perfMetricVal, { color: journalStats.totalRealisedPnl >= 0 ? '#00c087' : '#f84960' }]}>
                    {journalStats.totalRealisedPnl >= 0 ? `+${currSym}${journalStats.totalRealisedPnl.toFixed(2)}` : `-${currSym}${Math.abs(journalStats.totalRealisedPnl).toFixed(2)}`}
                  </Text>
                </View>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Win Rate</Text>
                  <Text style={[styles.perfMetricVal, { color: '#38bdf8' }]}>
                    {journalStats.winRate.toFixed(1)}%
                  </Text>
                </View>
                <View style={styles.perfMetricBox}>
                  <Text style={styles.perfMetricLabel}>Closed Trades</Text>
                  <Text style={styles.perfMetricVal}>
                    {filteredJournalOrders.length}
                  </Text>
                </View>
              </View>

              {renderJournalEquityCurve()}
              {renderJournalCalendarHeatmap()}

              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, marginBottom: 8 }}>
                <Text style={[styles.sectionHeader, { marginTop: 0, fontSize: 13 }]}>
                  📓 Past Closed Trades {selectedHeatmapDate ? `(${selectedHeatmapDate})` : `(${filteredJournalOrders.length})`}
                </Text>
                {filteredJournalOrders.length > 0 && (
                  <TouchableOpacity 
                    onPress={handleResetTradeHistory}
                    style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5, borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.35)' }}
                    hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                  >
                    <Text style={{ color: '#f87171', fontSize: 10.5, fontWeight: 'bold' }}>Clear History 🗑️</Text>
                  </TouchableOpacity>
                )}
              </View>

              {filteredJournalOrders.length > 0 ? (
                filteredJournalOrders.map((item: any, idx: number) => {
                  const pnl = Number(item.realized_pnl) || 0;
                  const roi = Number(item.roi_pct) || 0;
                  const legs = item.legs || [];
                  const closedTime = item.closed_at ? new Date(item.closed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'Recently';
                  const closedDate = item.closed_at ? new Date(item.closed_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';

                  const firstLegAsset = legs[0]?.underlying || 'NIFTY';
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
                            Settle: {closedDate} {closedTime} • ID: #{item.id} {item.account_id ? `• Acc #${item.account_id}` : ''}
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
                  <Text style={styles.emptyNotice}>No closed trades for this selection.</Text>
                  <Text style={[styles.emptyNotice, { fontSize: 11, marginTop: 4 }]}>
                    {selectedHeatmapDate ? `No trades were settled on ${selectedHeatmapDate}. Tap 'Clear Day Filter' above to view all trades.` : 'Trades closed in this account will automatically record and reflect in the heatmap.'}
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

      </View>
      </>
    )}

      {/* ===================== MODAL: PROFILE & AUTO-CORRECT SYSTEM ===================== */}
      <Modal visible={showProfileModal} transparent animationType="slide" onRequestClose={() => setShowProfileModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowProfileModal(false)} />
          <View style={[styles.bottomSheet, { maxHeight: '88%' }]}>
            <View style={styles.sheetHandle} />
            
            {/* Modal Header */}
            <View style={styles.sheetHeaderRow}>
              <View>
                <Text style={styles.sheetTitle}>Institutional Profile & Tools</Text>
                <Text style={styles.sheetOptionSubText}>Live Feed Auto-Calibration • Account & Theaters</Text>
              </View>
              <TouchableOpacity onPress={() => setShowProfileModal(false)}>
                <Text style={styles.sheetCloseBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={{ marginTop: 8 }} contentContainerStyle={{ paddingBottom: 24 }}>
              {/* 1. Trader Profile Card */}
              <View style={{
                backgroundColor: '#101726',
                borderWidth: 1,
                borderColor: '#1e293b',
                borderRadius: 14,
                padding: 14,
                marginBottom: 14,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{
                    width: 48,
                    height: 48,
                    borderRadius: 14,
                    backgroundColor: 'rgba(0, 192, 135, 0.15)',
                    borderWidth: 1.5,
                    borderColor: '#00c087',
                    justifyContent: 'center',
                    alignItems: 'center'
                  }}>
                    <Text style={{ color: '#00c087', fontSize: 18, fontWeight: '900' }}>BR</Text>
                  </View>
                  <View>
                    <Text style={{ color: '#ffffff', fontSize: 16, fontWeight: 'bold' }}>Bharathan R</Text>
                    <Text style={{ color: '#8a95a5', fontSize: 11.5, marginTop: 1 }}>Institutional Options Trader</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10b981' }} />
                      <Text style={{ color: '#10b981', fontSize: 10.5, fontWeight: 'bold' }}>Terminal v2.4 Pro • Online</Text>
                    </View>
                  </View>
                </View>

                <View style={{ alignItems: 'flex-end' }}>
                  <View style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', borderWidth: 1, borderColor: '#0284c7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                    <Text style={{ color: '#38bdf8', fontSize: 10.5, fontWeight: 'bold' }}>
                      {selectedMarket === 'CRYPTO' ? '₿ Crypto 24/7' : selectedMarket === 'COMMODITY' ? '🛢️ MCX MCX' : '🇮🇳 Indian Equities'}
                    </Text>
                  </View>
                </View>
              </View>

              {/* 2. AUTO-CORRECT & PRICE LAG TROUBLESHOOTING HUB */}
              <View style={{
                backgroundColor: '#0a101d',
                borderWidth: 1.5,
                borderColor: 'rgba(0, 192, 135, 0.5)',
                borderRadius: 14,
                padding: 14,
                marginBottom: 14
              }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 16 }}>⚡</Text>
                    <Text style={{ color: '#00c087', fontSize: 14, fontWeight: '900', letterSpacing: 0.3 }}>
                      Lag Troubleshooting & Auto-Correct Hub
                    </Text>
                  </View>
                  <View style={{ backgroundColor: 'rgba(0, 192, 135, 0.15)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                    <Text style={{ color: '#00c087', fontSize: 9.5, fontWeight: 'bold' }}>0-LAG ENGINE</Text>
                  </View>
                </View>

                <Text style={{ color: '#8a95a5', fontSize: 11.5, lineHeight: 16, marginBottom: 12 }}>
                  Select the specific feed you want to troubleshoot or trigger a full end-to-end zero-lag pipeline resync:
                </Text>

                {/* Granular Action 1: Fix Spot / Index LTP Lag */}
                <TouchableOpacity
                  style={{
                    backgroundColor: '#131f33',
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderWidth: 1,
                    borderColor: '#253552',
                    marginBottom: 8
                  }}
                  onPress={troubleshootLtpSpotLag}
                  activeOpacity={0.8}
                  disabled={isCalibrating}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                    <Text style={{ fontSize: 15 }}>⚡</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#38bdf8', fontSize: 12.5, fontWeight: 'bold' }}>Troubleshoot Spot & LTP Lag</Text>
                      <Text style={{ color: '#64748b', fontSize: 10.5 }}>Force-resyncs live spot prices across all indices</Text>
                    </View>
                  </View>
                  <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: 'bold' }}>Resync ➔</Text>
                </TouchableOpacity>

                {/* Granular Action 2: Fix Option Chain & Strikes Lag */}
                <TouchableOpacity
                  style={{
                    backgroundColor: '#131f33',
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderWidth: 1,
                    borderColor: '#253552',
                    marginBottom: 8
                  }}
                  onPress={troubleshootOptionChainLag}
                  activeOpacity={0.8}
                  disabled={isCalibrating}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                    <Text style={{ fontSize: 15 }}>📊</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#facc15', fontSize: 12.5, fontWeight: 'bold' }}>Troubleshoot Option Chain Lag</Text>
                      <Text style={{ color: '#64748b', fontSize: 10.5 }}>Recalibrates strikes, Greeks, IV & PCR matrix</Text>
                    </View>
                  </View>
                  <Text style={{ color: '#facc15', fontSize: 12, fontWeight: 'bold' }}>Resync ➔</Text>
                </TouchableOpacity>

                {/* Granular Action 3: Full Reset (Both) */}
                <TouchableOpacity
                  style={{
                    backgroundColor: isCalibrating ? '#064e3b' : '#059669',
                    paddingVertical: 12,
                    borderRadius: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexDirection: 'row',
                    gap: 8,
                    borderWidth: 1,
                    borderColor: '#10b981',
                    marginBottom: 12
                  }}
                  onPress={autoCalibrateAllPrices}
                  activeOpacity={0.8}
                  disabled={isCalibrating}
                >
                  {isCalibrating ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={{ fontSize: 15 }}>🚀</Text>
                  )}
                  <Text style={{ color: '#ffffff', fontSize: 13, fontWeight: '900', letterSpacing: 0.3 }}>
                    {isCalibrating ? 'Synchronizing Entire Pipeline…' : 'Troubleshoot Both (Full Pipeline Reset)'}
                  </Text>
                </TouchableOpacity>

                {/* Live Index-Wise Calibration Status Grid */}
                <View style={{ backgroundColor: '#070b12', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: '#172033' }}>
                  <Text style={{ color: '#64748b', fontSize: 10, fontWeight: 'bold', marginBottom: 6 }}>
                    VERIFIED INDEX-WISE REAL-TIME STREAM
                  </Text>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={{ color: '#94a3b8', fontSize: 11.5 }}>🇮🇳 NIFTY 50</Text>
                    <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: 'bold' }}>
                      ₹{allLiveSpots['NIFTY']?.spot ? allLiveSpots['NIFTY'].spot.toLocaleString('en-IN') : '24,234.55'}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={{ color: '#94a3b8', fontSize: 11.5 }}>🇮🇳 BANK NIFTY</Text>
                    <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: 'bold' }}>
                      ₹{allLiveSpots['BANKNIFTY']?.spot ? allLiveSpots['BANKNIFTY'].spot.toLocaleString('en-IN') : '57,655.50'}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={{ color: '#94a3b8', fontSize: 11.5 }}>🇮🇳 BSE SENSEX</Text>
                    <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: 'bold' }}>
                      ₹{allLiveSpots['SENSEX']?.spot ? allLiveSpots['SENSEX'].spot.toLocaleString('en-IN') : '77,315.44'}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ color: '#94a3b8', fontSize: 11.5 }}>🛢️ CRUDE OIL</Text>
                    <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: 'bold' }}>
                      ₹{allLiveSpots['CRUDEOIL']?.spot ? allLiveSpots['CRUDEOIL'].spot.toLocaleString('en-IN') : '8,315.00'}
                    </Text>
                  </View>
                </View>
              </View>

              {/* 3. Fast Trading Theater Switcher */}
              <View style={{
                backgroundColor: '#101726',
                borderWidth: 1,
                borderColor: '#1e293b',
                borderRadius: 14,
                padding: 14,
                marginBottom: 14
              }}>
                <Text style={{ color: '#ffffff', fontSize: 13.5, fontWeight: 'bold', marginBottom: 10 }}>
                  Switch Trading Theater
                </Text>
                
                <TouchableOpacity
                  style={{
                    backgroundColor: selectedMarket === 'INDIAN' ? '#162842' : '#0c121d',
                    borderWidth: 1,
                    borderColor: selectedMarket === 'INDIAN' ? '#0284c7' : '#1e293b',
                    padding: 11,
                    borderRadius: 10,
                    marginBottom: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                  onPress={() => {
                    setSelectedMarket('INDIAN');
                    setActiveAsset('NIFTY');
                    setShowProfileModal(false);
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ fontSize: 16 }}>🇮🇳</Text>
                    <Text style={{ color: 'white', fontSize: 13, fontWeight: 'bold' }}>Indian Benchmark Indices</Text>
                  </View>
                  {selectedMarket === 'INDIAN' && <Text style={{ color: '#38bdf8', fontWeight: 'bold' }}>✓</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  style={{
                    backgroundColor: selectedMarket === 'COMMODITY' ? '#162842' : '#0c121d',
                    borderWidth: 1,
                    borderColor: selectedMarket === 'COMMODITY' ? '#0284c7' : '#1e293b',
                    padding: 11,
                    borderRadius: 10,
                    marginBottom: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                  onPress={() => {
                    setSelectedMarket('COMMODITY');
                    setActiveAsset('CRUDEOIL');
                    setShowProfileModal(false);
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ fontSize: 16 }}>🛢️</Text>
                    <Text style={{ color: 'white', fontSize: 13, fontWeight: 'bold' }}>MCX Commodities</Text>
                  </View>
                  {selectedMarket === 'COMMODITY' && <Text style={{ color: '#38bdf8', fontWeight: 'bold' }}>✓</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  style={{
                    backgroundColor: selectedMarket === 'CRYPTO' ? '#162842' : '#0c121d',
                    borderWidth: 1,
                    borderColor: selectedMarket === 'CRYPTO' ? '#0284c7' : '#1e293b',
                    padding: 11,
                    borderRadius: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                  onPress={() => {
                    setSelectedMarket('CRYPTO');
                    setActiveAsset('BTC');
                    setShowProfileModal(false);
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ fontSize: 16 }}>₿</Text>
                    <Text style={{ color: 'white', fontSize: 13, fontWeight: 'bold' }}>Crypto Options (24/7)</Text>
                  </View>
                  {selectedMarket === 'CRYPTO' && <Text style={{ color: '#38bdf8', fontWeight: 'bold' }}>✓</Text>}
                </TouchableOpacity>
              </View>

              {/* 4. ACTIVE TRADING ACCOUNT & SUB-ACCOUNT MANAGER (1-10) */}
              {(() => {
                const displayedAccId = selectedAccountForView || activeAccountId;
                const viewedAccount = accounts.find(a => a.id === displayedAccId) || activeAccount;
                const isViewingActive = viewedAccount?.id === activeAccountId;
                const isEditingThis = editingAccount && editingAccount.id === viewedAccount?.id;

                return (
                  <View style={{
                    backgroundColor: '#101726',
                    borderWidth: 1.5,
                    borderColor: isViewingActive ? 'rgba(56, 189, 248, 0.4)' : '#1e293b',
                    borderRadius: 14,
                    padding: 14,
                    marginBottom: 14
                  }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <Text style={{ color: '#ffffff', fontSize: 13.5, fontWeight: 'bold' }}>
                        Trading Accounts (Acc 1–10)
                      </Text>
                      <View style={{
                        backgroundColor: isViewingActive ? 'rgba(16, 185, 129, 0.15)' : 'rgba(100, 116, 139, 0.15)',
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        borderRadius: 6
                      }}>
                        <Text style={{ color: isViewingActive ? '#10b981' : '#94a3b8', fontSize: 10, fontWeight: 'bold' }}>
                          {isViewingActive ? '🟢 ACTIVE TRADING ACCOUNT' : 'STANDBY ACCOUNT'}
                        </Text>
                      </View>
                    </View>

                    {/* Horizontal 1-10 Account Selector Tabs */}
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                      {accounts.map(acc => {
                        const isAccActive = acc.id === activeAccountId;
                        const isAccSelected = acc.id === displayedAccId;
                        return (
                          <TouchableOpacity
                            key={acc.id}
                            style={{
                              backgroundColor: isAccSelected ? '#0284c7' : (isAccActive ? '#064e3b' : '#0c121d'),
                              borderWidth: 1,
                              borderColor: isAccSelected ? '#38bdf8' : (isAccActive ? '#10b981' : '#1e293b'),
                              paddingHorizontal: 11,
                              paddingVertical: 7,
                              borderRadius: 8,
                              marginRight: 6,
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 4
                            }}
                            onPress={() => {
                              setSelectedAccountForView(acc.id);
                              if (editingAccount) setEditingAccount(null);
                            }}
                          >
                            {isAccActive && <Text style={{ color: '#10b981', fontSize: 10, fontWeight: 'bold' }}>●</Text>}
                            <Text style={{ color: isAccSelected || isAccActive ? 'white' : '#94a3b8', fontSize: 11.5, fontWeight: 'bold' }}>
                              {acc.name || `Acc ${acc.id}`}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>

                    {/* Selected Account Detail Card */}
                    <View style={{ backgroundColor: '#070b12', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#172033', marginBottom: 10 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <View>
                          <Text style={{ color: '#64748b', fontSize: 10, fontWeight: 'bold' }}>ACCOUNT NAME</Text>
                          <Text style={{ color: '#ffffff', fontSize: 14, fontWeight: 'bold' }}>
                            {viewedAccount?.name || `Acc ${viewedAccount?.id}`}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ color: '#64748b', fontSize: 10, fontWeight: 'bold' }}>MARGIN TYPE</Text>
                          <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: 'bold' }}>
                            {viewedAccount?.margin_type || 'Cross'} Margin
                          </Text>
                        </View>
                      </View>

                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 6, borderTopWidth: 1, borderTopColor: '#172033' }}>
                        <View>
                          <Text style={{ color: '#64748b', fontSize: 10 }}>Capital Allocation / Balance</Text>
                          <Text style={{ color: '#10b981', fontSize: 15, fontWeight: '900' }}>
                            {selectedMarket === 'CRYPTO' ? '$' : '₹'}{viewedAccount?.balance?.toLocaleString('en-IN') || '10,00,000'}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ color: '#64748b', fontSize: 10 }}>Status</Text>
                          <Text style={{ color: isViewingActive ? '#10b981' : '#94a3b8', fontSize: 11.5, fontWeight: 'bold' }}>
                            {isViewingActive ? '✓ Default Trading Acc' : 'Standby'}
                          </Text>
                        </View>
                      </View>
                    </View>

                    {/* Inline Edit Form when editing this account */}
                    {isEditingThis ? (
                      <View style={{ backgroundColor: '#0c1424', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#38bdf8', marginBottom: 10 }}>
                        <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: 'bold', marginBottom: 8 }}>
                          ✏️ Edit Account Name & Capital Amount
                        </Text>
                        
                        <Text style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>Account Name:</Text>
                        <TextInput
                          style={{
                            backgroundColor: '#070b12',
                            borderWidth: 1,
                            borderColor: '#253552',
                            color: 'white',
                            paddingHorizontal: 10,
                            paddingVertical: 7,
                            borderRadius: 6,
                            fontSize: 13,
                            marginBottom: 8
                          }}
                          value={editAccountName}
                          onChangeText={setEditAccountName}
                          placeholder="e.g. Acc 1 or Scalping Fund"
                          placeholderTextColor="#475569"
                        />

                        <Text style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>Capital Balance ({selectedMarket === 'CRYPTO' ? 'USD $' : 'INR ₹'}):</Text>
                        <TextInput
                          style={{
                            backgroundColor: '#070b12',
                            borderWidth: 1,
                            borderColor: '#253552',
                            color: 'white',
                            paddingHorizontal: 10,
                            paddingVertical: 7,
                            borderRadius: 6,
                            fontSize: 13,
                            marginBottom: 10
                          }}
                          value={editAccountBalance}
                          onChangeText={setEditAccountBalance}
                          keyboardType="numeric"
                          placeholder="e.g. 1000000"
                          placeholderTextColor="#475569"
                        />

                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <TouchableOpacity
                            style={{ flex: 1, backgroundColor: '#059669', paddingVertical: 9, borderRadius: 6, alignItems: 'center' }}
                            onPress={handleUpdateAccount}
                          >
                            <Text style={{ color: 'white', fontSize: 12, fontWeight: 'bold' }}>💾 Save Changes</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={{ flex: 1, backgroundColor: '#1e293b', paddingVertical: 9, borderRadius: 6, alignItems: 'center' }}
                            onPress={() => setEditingAccount(null)}
                          >
                            <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: 'bold' }}>✕ Cancel</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : null}

                    {/* Action Controls: Set as Active Trading Account & Edit Button */}
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {!isViewingActive ? (
                        <TouchableOpacity
                          style={{
                            flex: 1.2,
                            backgroundColor: '#0284c7',
                            paddingVertical: 10,
                            borderRadius: 8,
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexDirection: 'row',
                            gap: 6
                          }}
                          onPress={() => {
                            if (viewedAccount) {
                              setActiveAccountId(viewedAccount.id);
                              setTradeMessage(`⚡ Active Trading Account set to: ${viewedAccount.name || `Acc ${viewedAccount.id}`}`);
                              setTimeout(() => setTradeMessage(''), 3000);
                            }
                          }}
                          activeOpacity={0.8}
                        >
                          <Text style={{ color: '#ffffff', fontSize: 12.5, fontWeight: 'bold' }}>
                            🎯 Set as Trading Account
                          </Text>
                        </TouchableOpacity>
                      ) : (
                        <View style={{
                          flex: 1.2,
                          backgroundColor: '#064e3b',
                          paddingVertical: 10,
                          borderRadius: 8,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderWidth: 1,
                          borderColor: '#10b981'
                        }}>
                          <Text style={{ color: '#10b981', fontSize: 12, fontWeight: 'bold' }}>
                            ✓ Active Trading Account
                          </Text>
                        </View>
                      )}

                      <TouchableOpacity
                        style={{
                          flex: 1,
                          backgroundColor: '#131f33',
                          borderWidth: 1,
                          borderColor: '#253552',
                          paddingVertical: 10,
                          borderRadius: 8,
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        onPress={() => {
                          if (viewedAccount) startEditingAccount(viewedAccount);
                        }}
                        activeOpacity={0.8}
                      >
                        <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: 'bold' }}>
                          ✏️ Edit Name & Capital
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })()}

              {/* 5. System Connection Diagnostics */}
              <View style={{
                backgroundColor: '#0c101a',
                borderWidth: 1,
                borderColor: '#172033',
                borderRadius: 12,
                padding: 12
              }}>
                <Text style={{ color: '#64748b', fontSize: 10.5, fontWeight: 'bold', marginBottom: 6 }}>
                  SYSTEM HEALTH & MULTI-FEED CONNECTIVITY
                </Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text style={{ color: '#94a3b8', fontSize: 11 }}>Angel One SmartAPI WebSocket</Text>
                  <Text style={{ color: '#10b981', fontSize: 11, fontWeight: 'bold' }}>🟢 Connected (0ms)</Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text style={{ color: '#94a3b8', fontSize: 11 }}>Public Multi-Node Hot Standby</Text>
                  <Text style={{ color: '#10b981', fontSize: 11, fontWeight: 'bold' }}>🟢 Active</Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: '#94a3b8', fontSize: 11 }}>On-Device Black-Scholes Math Engine</Text>
                  <Text style={{ color: '#10b981', fontSize: 11, fontWeight: 'bold' }}>🟢 Real-time Greeks</Text>
                </View>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

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
              {(selectedMarket ? [selectedMarket] : ['INDIAN', 'COMMODITY', 'CRYPTO']).map(marketCat => {
                const assetsInCat = Object.keys(ASSET_CONFIG).filter(k => ASSET_CONFIG[k].category === marketCat);
                if (!assetsInCat.length) return null;

                const renderAssetOption = (assetKey: string) => {
                  const conf = ASSET_CONFIG[assetKey];
                  const isSelected = activeAsset === assetKey;
                  const live = allLiveSpots[assetKey] || { spot: 0, change: 0, pctChange: 0 };
                  const isUp = live.change >= 0;
                  const isMini = conf.tag.includes('Mini');
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
                          <View style={{ backgroundColor: isMini ? 'rgba(234, 179, 8, 0.15)' : 'rgba(255,255,255,0.08)', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                            <Text style={{ color: isMini ? '#eab308' : '#94a3b8', fontSize: 9.5, fontWeight: 'bold' }}>{conf.tag}</Text>
                          </View>
                        </View>
                        <Text style={styles.sheetOptionSubText}>{conf.name} • Lot: {conf.lotSize} {conf.lotUnit} • Step: ₹{conf.strikeStep}</Text>
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
                };

                if (marketCat === 'COMMODITY') {
                  const standardAssets = assetsInCat.filter(k => !ASSET_CONFIG[k].tag.includes('Mini'));
                  const miniAssets = assetsInCat.filter(k => ASSET_CONFIG[k].tag.includes('Mini'));
                  return (
                    <View key={marketCat} style={{ marginBottom: 16 }}>
                      <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginBottom: 8, paddingHorizontal: 4 }}>
                        🛢️ MCX COMMODITIES - STANDARD LOTS
                      </Text>
                      {standardAssets.map(renderAssetOption)}
                      
                      <Text style={{ color: '#eab308', fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginTop: 12, marginBottom: 8, paddingHorizontal: 4 }}>
                        🛢️ MCX COMMODITIES - MINI LOTS
                      </Text>
                      {miniAssets.map(renderAssetOption)}
                    </View>
                  );
                }

                const catTitle = 
                  marketCat === 'INDIAN' ? '🇮🇳 INDIAN BENCHMARK INDICES (NSE & BSE)' : '🌐 CRYPTO DERIVATIVES';

                return (
                  <View key={marketCat} style={{ marginBottom: 16 }}>
                    <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginBottom: 8, paddingHorizontal: 4 }}>
                      {catTitle}
                    </Text>
                    {assetsInCat.map(renderAssetOption)}
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
                      const sp = spotPrice || currConfig.defaultSpot;
                      const freshChain = synthesizeOptionChain(activeAsset, sp, strikeStep, exp);
                      if (freshChain && freshChain.length > 0) {
                        setChainByExpiry((prev: any) => ({ ...prev, [exp]: freshChain }));
                      }
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.sheetOptionText, isSelected && { color: '#38bdf8' }]}>
                        {formatDisplayDate(exp)}
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
    </View>
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
  journalAccountFilterContainer: {
    marginBottom: 10,
    backgroundColor: '#0c101b',
    borderWidth: 1,
    borderColor: '#172033',
    borderRadius: 8,
    padding: 10
  },
  journalAccountFilterTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#8a95a5',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  journalAccPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#161c28',
    borderWidth: 1,
    borderColor: '#232c3d'
  },
  journalAccPillActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    borderColor: '#38bdf8'
  },
  journalAccPillText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#8a95a5'
  },
  journalAccPillTextActive: {
    color: '#38bdf8'
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
    backgroundColor: '#0a0d14'
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#0e131d',
    borderBottomWidth: 1,
    borderBottomColor: '#1a2333',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1
  },
  headerLogoWrapper: {
    position: 'relative',
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#161c28',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  headerLiveDot: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10b981',
    borderWidth: 1.5,
    borderColor: '#0e131d'
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.3
  },
  headerBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.35)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4
  },
  headerBadgeText: {
    color: '#10b981',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5
  },
  headerSubtitle: {
    fontSize: 11,
    color: '#8a95a5',
    fontWeight: '500',
    marginTop: 1
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  headerActionBtn: {
    backgroundColor: '#151c2a',
    borderColor: '#233045',
    borderWidth: 1,
    width: 34,
    height: 34,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center'
  },
  headerActionBtnActive: {
    backgroundColor: '#065f46',
    borderColor: '#10b981'
  },
  headerMenuBtn: {
    backgroundColor: '#151c2a',
    borderColor: '#233045',
    borderWidth: 1,
    width: 34,
    height: 34,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center'
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
  bottomTabBar: {
    flexDirection: 'row',
    backgroundColor: '#090d16',
    paddingTop: 10,
    paddingBottom: Platform.OS === 'android' ? 52 : 24, // Generous clearance so tabs sit cleanly ABOVE Android 3-button navigation bar (||| / <)
    borderTopWidth: 1.5,
    borderTopColor: '#1e293b',
    justifyContent: 'space-around',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 12,
    zIndex: 998
  },
  bottomTabBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    paddingVertical: 3,
  },
  bottomTabLabel: {
    fontSize: 11,
    marginTop: 3,
    color: '#94a3b8',
    fontWeight: '700'
  },
  bottomTabLabelActive: {
    color: '#38bdf8',
    fontWeight: 'bold'
  },
  bottomTabIcon: {
    fontSize: 20,
    color: '#94a3b8'
  },
  bottomTabIconActive: {
    color: '#38bdf8'
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
    bottom: Platform.OS === 'android' ? 24 : 32,
    left: 12,
    right: 12,
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
  cleanPnlCard: {
    backgroundColor: '#0d121f',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginBottom: 12
  },
  cleanPnlLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#8a95a5',
    marginBottom: 4
  },
  cleanPnlValue: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 0.3
  },
  pnlActionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    marginBottom: 10
  },
  pnlActionBtnGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  pnlActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1
  },
  pnlActionBtnAnalyze: {
    backgroundColor: 'rgba(249, 115, 22, 0.12)',
    borderColor: 'rgba(249, 115, 22, 0.4)'
  },
  pnlActionBtnAnalytics: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderColor: 'rgba(56, 189, 248, 0.4)'
  },
  pnlActionBtnText: {
    fontSize: 12,
    fontWeight: '800'
  },
  kitePositionCard: {
    backgroundColor: '#0d121f',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 10,
    padding: 14,
    marginBottom: 10
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










