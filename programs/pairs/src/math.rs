//! Pure arithmetic: price splits, payouts, funding and whirlpool prices.
//! Everything here is checked; overflow surfaces as `PairsError::Overflow`.

use {
    crate::{error::PairsError, state::PRICE_SCALE},
    solana_program::program_error::ProgramError,
};

#[allow(clippy::manual_div_ceil)]
mod u256 {
    use uint::construct_uint;
    construct_uint! {
        pub struct U256(4);
    }
}
pub use u256::U256;

/// Sanity limit on `price_decimals` for whirlpool-derived prices.
pub const MAX_PRICE_DECIMALS: u8 = 18;

/// The long side's contribution for `size` contracts at `long_price_ppm`:
/// `ceil(size * p / SCALE)`. The short side pays `size - long_share`.
pub fn long_share(size: u64, long_price_ppm: u64) -> Result<u64, ProgramError> {
    let num = (size as u128)
        .checked_mul(long_price_ppm as u128)
        .ok_or(PairsError::Overflow)?;
    let q = num.div_ceil(PRICE_SCALE as u128);
    u64::try_from(q).map_err(|_| PairsError::Overflow.into())
}

/// `floor(amount * ppm / SCALE)`.
pub fn payout(amount: u64, ppm: u64) -> Result<u64, ProgramError> {
    let num = (amount as u128)
        .checked_mul(ppm as u128)
        .ok_or(PairsError::Overflow)?;
    u64::try_from(num / PRICE_SCALE as u128).map_err(|_| PairsError::Overflow.into())
}

/// `ceil(amount * ppm / SCALE)` — used for fees.
pub fn fee(amount: u64, ppm: u64) -> Result<u64, ProgramError> {
    long_share(amount, ppm)
}

/// The long payout fraction implied by `price` on `[floor, cap]`, in
/// PRICE_SCALE, clamped to `[0, SCALE]`.
pub fn intrinsic_ppm(price: u64, floor: u64, cap: u64) -> u64 {
    if price <= floor {
        return 0;
    }
    if price >= cap {
        return PRICE_SCALE;
    }
    let num = (price - floor) as u128 * PRICE_SCALE as u128;
    (num / (cap - floor) as u128) as u64
}

/// Portion of a maker's escrow consumed when `fill` of `remaining` contracts
/// are taken: `floor(escrowed * fill / remaining)`. The final fill consumes
/// exactly what is left.
pub fn maker_share(escrowed: u64, remaining: u64, fill: u64) -> Result<u64, ProgramError> {
    if fill == remaining {
        return Ok(escrowed);
    }
    let num = (escrowed as u128)
        .checked_mul(fill as u128)
        .ok_or(PairsError::Overflow)?;
    Ok((num / remaining as u128) as u64)
}

/// Long payout at settlement: `clamp(intrinsic - funding_offset, 0, SCALE)`.
pub fn settlement_payout_ppm(intrinsic: u64, funding_offset_ppm: i64) -> u64 {
    let v = intrinsic as i128 - funding_offset_ppm as i128;
    v.clamp(0, PRICE_SCALE as i128) as u64
}

/// Funding accrued over `elapsed_slots` given a mark/index premium.
///
/// `premium_ppm = mark - intrinsic(index)`. The accrual is
/// `premium * rate / SCALE * elapsed / period`, capped in absolute value at
/// `max_per_period * elapsed / period`. Positive means longs pay shorts.
pub fn funding_accrual(
    premium_ppm: i128,
    funding_rate_ppm: u64,
    funding_period_slots: u64,
    max_per_period_ppm: u64,
    elapsed_slots: u64,
) -> Result<i128, ProgramError> {
    if funding_rate_ppm == 0 || funding_period_slots == 0 || elapsed_slots == 0 {
        return Ok(0);
    }
    let raw = premium_ppm
        .checked_mul(funding_rate_ppm as i128)
        .and_then(|v| v.checked_mul(elapsed_slots as i128))
        .ok_or(PairsError::Overflow)?
        / (PRICE_SCALE as i128 * funding_period_slots as i128);
    let cap = (max_per_period_ppm as i128)
        .checked_mul(elapsed_slots as i128)
        .ok_or(PairsError::Overflow)?
        / funding_period_slots as i128;
    Ok(raw.clamp(-cap, cap))
}

/// Add an accrual to the running offset, keeping it in `[-SCALE, SCALE]`
/// (anything beyond is already a 0 or 100% payout).
pub fn apply_funding(offset_ppm: i64, accrual: i128) -> i64 {
    (offset_ppm as i128 + accrual).clamp(-(PRICE_SCALE as i128), PRICE_SCALE as i128) as i64
}

/// Price of token A in token B from an Orca `sqrt_price` (Q64.64), scaled
/// by `10^price_decimals` and expressed in raw base units:
/// `sqrt_price^2 * 10^d / 2^128`, or its inverse when `invert`.
pub fn whirlpool_price(
    sqrt_price: u128,
    price_decimals: u8,
    invert: bool,
) -> Result<u64, ProgramError> {
    if sqrt_price == 0 {
        return Err(PairsError::InvalidWhirlpool.into());
    }
    if price_decimals > MAX_PRICE_DECIMALS {
        return Err(PairsError::InvalidPriceDecimals.into());
    }
    let sq = U256::from(sqrt_price) * U256::from(sqrt_price);
    let scale = U256::from(10u64.pow(price_decimals as u32));
    let one = U256::from(1u8) << 128;
    let p = if invert {
        (one * scale) / sq
    } else {
        (sq * scale) >> 128
    };
    if p > U256::from(u64::MAX) {
        return Err(PairsError::Overflow.into());
    }
    Ok(p.as_u64())
}

/// Price of the LONG token in collateral units, in PRICE_SCALE, from a
/// LONG/collateral whirlpool. Both mints share decimals, so no adjustment.
pub fn whirlpool_mark_ppm(sqrt_price: u128, long_is_b: bool) -> Result<u64, ProgramError> {
    let p = whirlpool_price(sqrt_price, 6, long_is_b)?;
    Ok(p.min(PRICE_SCALE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_sum_to_size() {
        for (size, p) in [
            (1u64, 1u64),
            (1, 999_999),
            (7, 333_333),
            (1_000_000, 250_000),
            (u64::MAX, 500_000),
        ] {
            let l = long_share(size, p).unwrap();
            let s = size - l;
            assert!(l <= size);
            assert_eq!(l + s, size);
        }
        assert_eq!(long_share(1_000_000, 250_000).unwrap(), 250_000);
        assert_eq!(long_share(3, 500_000).unwrap(), 2);
    }

    #[test]
    fn payouts_never_exceed_collateral() {
        for a in [0u64, 1, 3, 999_999, 1_000_001, u64::MAX / 2] {
            for f in [0u64, 1, 333_333, 500_000, 999_999, PRICE_SCALE] {
                let l = payout(a, f).unwrap();
                let s = payout(a, PRICE_SCALE - f).unwrap();
                assert!(l + s <= a, "{a} {f}");
                assert!(a - (l + s) <= 1);
            }
        }
    }

    #[test]
    fn intrinsic_clamps() {
        assert_eq!(intrinsic_ppm(50, 100, 200), 0);
        assert_eq!(intrinsic_ppm(100, 100, 200), 0);
        assert_eq!(intrinsic_ppm(150, 100, 200), 500_000);
        assert_eq!(intrinsic_ppm(200, 100, 200), PRICE_SCALE);
        assert_eq!(intrinsic_ppm(u64::MAX, 100, 200), PRICE_SCALE);
        assert_eq!(intrinsic_ppm(u64::MAX - 1, 0, u64::MAX), 999_999);
    }

    #[test]
    fn maker_share_consumes_exactly_escrow() {
        let mut escrow = 750u64;
        let mut remaining = 1_000u64;
        let mut total = 0u64;
        for fill in [1u64, 333, 100, 566] {
            let m = maker_share(escrow, remaining, fill).unwrap();
            assert!(m <= fill);
            total += m;
            escrow -= m;
            remaining -= fill;
        }
        assert_eq!(remaining, 0);
        assert_eq!(escrow, 0);
        assert_eq!(total, 750);
    }

    #[test]
    fn funding_math() {
        // Mark 10 points over fair, 100% of premium per period, one full period.
        assert_eq!(
            funding_accrual(100_000, PRICE_SCALE, 1000, PRICE_SCALE, 1000).unwrap(),
            100_000
        );
        // Half a period accrues half.
        assert_eq!(
            funding_accrual(100_000, PRICE_SCALE, 1000, PRICE_SCALE, 500).unwrap(),
            50_000
        );
        // Ridiculous rate: 300% of premium per period.
        assert_eq!(
            funding_accrual(100_000, 3 * PRICE_SCALE, 1000, PRICE_SCALE, 1000).unwrap(),
            300_000
        );
        // Cap binds.
        assert_eq!(
            funding_accrual(100_000, 3 * PRICE_SCALE, 1000, 20_000, 1000).unwrap(),
            20_000
        );
        assert_eq!(
            funding_accrual(-100_000, 3 * PRICE_SCALE, 1000, 20_000, 1000).unwrap(),
            -20_000
        );
        // Disabled.
        assert_eq!(funding_accrual(100_000, 0, 1000, 20_000, 1000).unwrap(), 0);
        assert_eq!(apply_funding(990_000, 50_000), PRICE_SCALE as i64);
        assert_eq!(apply_funding(-990_000, -50_000), -(PRICE_SCALE as i64));
        assert_eq!(settlement_payout_ppm(600_000, 100_000), 500_000);
        assert_eq!(settlement_payout_ppm(600_000, -500_000), PRICE_SCALE);
        assert_eq!(settlement_payout_ppm(50_000, 100_000), 0);
    }

    #[test]
    fn whirlpool_prices() {
        // sqrt_price = 2^64 -> price 1.0
        let one = 1u128 << 64;
        assert_eq!(whirlpool_price(one, 6, false).unwrap(), 1_000_000);
        assert_eq!(whirlpool_price(one, 6, true).unwrap(), 1_000_000);
        // sqrt_price = 2^65 -> price 4.0 (inverse 0.25)
        assert_eq!(whirlpool_price(one << 1, 6, false).unwrap(), 4_000_000);
        assert_eq!(whirlpool_price(one << 1, 6, true).unwrap(), 250_000);
        // sqrt(0.01) * 2^64 -> 0.01
        let sqrt_001 = (0.1f64 * (1u128 << 64) as f64) as u128;
        let p = whirlpool_price(sqrt_001, 9, false).unwrap();
        assert!((p as i64 - 10_000_000).abs() <= 1, "{p}");
        assert!(whirlpool_price(0, 6, false).is_err());
        assert!(whirlpool_price(one, 19, false).is_err());
        assert_eq!(whirlpool_mark_ppm(one << 1, false).unwrap(), PRICE_SCALE);
        assert_eq!(whirlpool_mark_ppm(one << 1, true).unwrap(), 250_000);
    }
}
