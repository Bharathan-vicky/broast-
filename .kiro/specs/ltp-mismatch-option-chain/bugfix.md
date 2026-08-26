# Bugfix Requirements Document

## Introduction

This bugfix addresses an LTP (Last Traded Price) mismatch issue in the Indian market option chain prices for NIFTY, BANKNIFTY, and SENSEX indices. The backend is returning Black-Scholes calculated prices instead of real Angel One LTP data when the Angel One API connection is available. The bug occurs when the Angel One API returns "Token missing" (AG8003) errors, preventing the LIVE_PRICES cache from being populated.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN Angel One API returns "Token missing" (AG8003) error THEN the LIVE_PRICES cache is not populated

1.2 WHEN LIVE_PRICES cache is not populated THEN the system falls back to Black-Scholes calculated prices instead of displaying live market prices

1.3 WHEN Black-Scholes fallback is used THEN the frontend displays `row.callMark` and `row.putMark` values that appear to be live but are actually calculated values

### Expected Behavior (Correct)

2.1 WHEN Angel One API returns "Token missing" (AG8003) error THEN the system shall log the error and indicate that live prices are unavailable

2.2 WHEN LIVE_PRICES cache is not populated THEN the system SHALL use Black-Scholes calculation but clearly indicate to users that prices are fallback values

2.3 WHEN Angel One API is available and connected THEN the system SHALL display real Angel One LTP values for option chain prices

### Unchanged Behavior (Regression Prevention)

3.1 WHEN Angel One API is providing valid data THEN the system SHALL CONTINUE TO display real Angel One LTP values

3.2 WHEN option chain data is requested for NIFTY, BANKNIFTY, or SENSEX THEN the system SHALL CONTINUE TO return complete option chain data with both call and put options

3.3 WHEN backend polls Angel One quote endpoint every 1.5 seconds THEN the system SHALL CONTINUE TO update price data without failure

## Bug Condition Derivation

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type OptionChainRequest
  OUTPUT: boolean
  
  // Returns true when Angel One API returns "Token missing" error
  // preventing LIVE_PRICES cache population
  RETURN (AngelOneApiError = "AG8003") OR (LIVE_PRICES_cache_empty = TRUE)
END FUNCTION
```

### Property Specification

```pascal
// Property: Fix Checking - Live Price Display
FOR ALL X WHERE isBugCondition(X) DO
  result ← getOptionChain'(X)
  ASSERT (result.ltp_source = "live") OR (result.ltp_source = "fallback_with_indicator")
  ASSERT (result.error_message = null) OR (result.ltp_source = "fallback_with_indicator")
END FOR
```

```pascal
// Property: Fix Checking - Error Handling
FOR ALL X WHERE AngelOneApiError = "AG8003" DO
  result ← getOptionChain'(X)
  ASSERT (result.ltp_source = "fallback_with_indicator")
  ASSERT (result.error_log IS NOT NULL)
END FOR
```

### Preservation Goal

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT getOptionChain(X) = getOptionChain'(X)
END FOR
```