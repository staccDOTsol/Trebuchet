//! Account state. Layouts are fixed and little-endian so that off-chain
//! clients (see `pairsClient.js`) can decode them without an IDL.

use {
    crate::error::PairsError,
    solana_program::{program_error::ProgramError, pubkey::Pubkey},
};

/// Prices are fractions of one collateral unit, in parts per million.
/// A long price of 250_000 means the long side pays 25% of notional and the
/// short side pays 75%.
pub const PRICE_SCALE: u64 = 1_000_000;

/// Layout version for `Market` and `Offer`.
pub const VERSION: u8 = 1;

/// Seed prefix for the market authority PDA: `["authority", market]`.
pub const AUTHORITY_SEED: &[u8] = b"authority";
/// Seed prefix for offer PDAs: `["offer", market, maker, nonce_le]`.
pub const OFFER_SEED: &[u8] = b"offer";

/// How a market discovers its settlement price.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SettleKind {
    /// `settler` is a pubkey that must sign `Settle { price }`.
    Authority = 0,
    /// `settler` is an Orca Whirlpool; `Settle` is permissionless and reads
    /// the pool's spot `sqrt_price`.
    Whirlpool = 1,
}

impl SettleKind {
    pub fn from_u8(v: u8) -> Result<Self, ProgramError> {
        match v {
            0 => Ok(SettleKind::Authority),
            1 => Ok(SettleKind::Whirlpool),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

/// Market lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MarketStatus {
    /// Pairs can be minted, traded and redeemed.
    Open = 0,
    /// A settlement price was recorded; positions claim collateral.
    Settled = 1,
    /// No settlement arrived before `settle_end_slot`; both sides claim half.
    Void = 2,
}

impl MarketStatus {
    pub fn from_u8(v: u8) -> Result<Self, ProgramError> {
        match v {
            0 => Ok(MarketStatus::Open),
            1 => Ok(MarketStatus::Settled),
            2 => Ok(MarketStatus::Void),
            _ => Err(PairsError::Uninitialized.into()),
        }
    }
}

/// Which side of a pair an offer's maker wants to hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Side {
    Long = 0,
    Short = 1,
}

impl Side {
    pub fn from_u8(v: u8) -> Result<Self, ProgramError> {
        match v {
            0 => Ok(Side::Long),
            1 => Ok(Side::Short),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

/// One leveraged long/short pool ("market").
///
/// Every LONG + SHORT pair in existence is backed by exactly one base unit of
/// collateral in `vault`. At settlement with price `P`, one LONG pays out
/// `clamp((P - floor) / (cap - floor), 0, 1)` of a collateral unit and one
/// SHORT pays out the rest. A narrow `[floor, cap]` range around spot is what
/// makes the position leveraged: the payout swings from 0 to 100% of notional
/// across that range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Market {
    pub version: u8,
    /// Bump of the `["authority", market]` PDA.
    pub bump: u8,
    pub settle_kind: SettleKind,
    /// Whirlpool mode only: quote price as token A per token B instead of
    /// B per A.
    pub invert: bool,
    /// Whirlpool mode: `price = spot * 10^price_decimals` (raw units).
    /// Authority mode: informational.
    pub price_decimals: u8,
    pub status: MarketStatus,
    pub creator: Pubkey,
    pub collateral_mint: Pubkey,
    /// SPL Token or Token-2022 program that owns `collateral_mint`.
    pub collateral_token_program: Pubkey,
    /// Collateral token account owned by the authority PDA.
    pub vault: Pubkey,
    /// LONG position mint (classic SPL Token, authority = PDA).
    pub long_mint: Pubkey,
    /// SHORT position mint (classic SPL Token, authority = PDA).
    pub short_mint: Pubkey,
    /// Settler pubkey (Authority mode) or Whirlpool address (Whirlpool mode).
    pub settler: Pubkey,
    /// The mint whose price this market is about. Informational in Authority
    /// mode, validated against the whirlpool's mints in Whirlpool mode.
    pub underlying: Pubkey,
    pub floor_price: u64,
    pub cap_price: u64,
    /// Minting, trading and filling stop at this slot (inclusive of the last
    /// slot before it). Settlement may happen from this slot on.
    pub trade_end_slot: u64,
    /// Last slot at which a settlement price is accepted. After it, anyone
    /// may `Void` the market.
    pub settle_end_slot: u64,
    /// Recorded settlement price (0 until settled).
    pub settlement_price: u64,
    /// LONG payout per unit, in PRICE_SCALE (0 until settled or void).
    pub long_payout_ppm: u64,
    /// Slot at which the market was settled or voided.
    pub settled_slot: u64,
    /// Fraction of the (mark - index) premium charged per funding period, in
    /// PRICE_SCALE. 0 disables funding. Values above PRICE_SCALE are allowed
    /// ("ridiculously high" funding).
    pub funding_rate_ppm: u64,
    /// Length of one funding period in slots.
    pub funding_period_slots: u64,
    /// Cap on the absolute funding accrued per period, in PRICE_SCALE of a
    /// collateral unit.
    pub max_funding_per_period_ppm: u64,
    /// Cumulative funding, in PRICE_SCALE. Positive means longs have paid
    /// shorts: the long payout at settlement is `intrinsic - offset`.
    pub funding_offset_ppm: i64,
    /// Slot of the last `Crank` (or market creation).
    pub last_crank_slot: u64,
    /// Sum of `long_price_ppm * size` over trades since the last crank.
    pub vwap_num: u128,
    /// Sum of `size` over trades since the last crank.
    pub vwap_den: u64,
    /// Index price observed by the last crank (informational).
    pub last_index_price: u64,
    /// Fee on traded notional, in PRICE_SCALE, paid to the creator's
    /// collateral account by takers (both sides in a direct `Trade`).
    pub taker_fee_ppm: u64,
    /// Optional Orca Whirlpool of LONG vs collateral used as the funding mark
    /// price. All-zero means "use the VWAP of on-chain trades since the last
    /// crank" instead.
    pub mark_whirlpool: Pubkey,
    /// Whether LONG is token B (true) or token A (false) in `mark_whirlpool`.
    pub mark_invert: bool,
}

impl Market {
    pub const LEN: usize = 464;

    pub fn pack_into(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0] = self.version;
        dst[1] = self.bump;
        dst[2] = self.settle_kind as u8;
        dst[3] = self.invert as u8;
        dst[4] = self.price_decimals;
        dst[5] = self.status as u8;
        dst[6..8].fill(0);
        dst[8..40].copy_from_slice(self.creator.as_ref());
        dst[40..72].copy_from_slice(self.collateral_mint.as_ref());
        dst[72..104].copy_from_slice(self.collateral_token_program.as_ref());
        dst[104..136].copy_from_slice(self.vault.as_ref());
        dst[136..168].copy_from_slice(self.long_mint.as_ref());
        dst[168..200].copy_from_slice(self.short_mint.as_ref());
        dst[200..232].copy_from_slice(self.settler.as_ref());
        dst[232..264].copy_from_slice(self.underlying.as_ref());
        dst[264..272].copy_from_slice(&self.floor_price.to_le_bytes());
        dst[272..280].copy_from_slice(&self.cap_price.to_le_bytes());
        dst[280..288].copy_from_slice(&self.trade_end_slot.to_le_bytes());
        dst[288..296].copy_from_slice(&self.settle_end_slot.to_le_bytes());
        dst[296..304].copy_from_slice(&self.settlement_price.to_le_bytes());
        dst[304..312].copy_from_slice(&self.long_payout_ppm.to_le_bytes());
        dst[312..320].copy_from_slice(&self.settled_slot.to_le_bytes());
        dst[320..328].copy_from_slice(&self.funding_rate_ppm.to_le_bytes());
        dst[328..336].copy_from_slice(&self.funding_period_slots.to_le_bytes());
        dst[336..344].copy_from_slice(&self.max_funding_per_period_ppm.to_le_bytes());
        dst[344..352].copy_from_slice(&self.funding_offset_ppm.to_le_bytes());
        dst[352..360].copy_from_slice(&self.last_crank_slot.to_le_bytes());
        dst[360..376].copy_from_slice(&self.vwap_num.to_le_bytes());
        dst[376..384].copy_from_slice(&self.vwap_den.to_le_bytes());
        dst[384..392].copy_from_slice(&self.last_index_price.to_le_bytes());
        dst[392..400].copy_from_slice(&self.taker_fee_ppm.to_le_bytes());
        dst[400..432].copy_from_slice(self.mark_whirlpool.as_ref());
        dst[432] = self.mark_invert as u8;
        dst[433..Self::LEN].fill(0);
        Ok(())
    }

    /// Decode an initialized market. Fails on the zero (uninitialized) version.
    pub fn unpack(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        if src[0] != VERSION {
            return Err(PairsError::Uninitialized.into());
        }
        Ok(Market {
            version: src[0],
            bump: src[1],
            settle_kind: SettleKind::from_u8(src[2]).map_err(|_| PairsError::Uninitialized)?,
            invert: src[3] != 0,
            price_decimals: src[4],
            status: MarketStatus::from_u8(src[5])?,
            creator: pk(src, 8),
            collateral_mint: pk(src, 40),
            collateral_token_program: pk(src, 72),
            vault: pk(src, 104),
            long_mint: pk(src, 136),
            short_mint: pk(src, 168),
            settler: pk(src, 200),
            underlying: pk(src, 232),
            floor_price: u64_at(src, 264),
            cap_price: u64_at(src, 272),
            trade_end_slot: u64_at(src, 280),
            settle_end_slot: u64_at(src, 288),
            settlement_price: u64_at(src, 296),
            long_payout_ppm: u64_at(src, 304),
            settled_slot: u64_at(src, 312),
            funding_rate_ppm: u64_at(src, 320),
            funding_period_slots: u64_at(src, 328),
            max_funding_per_period_ppm: u64_at(src, 336),
            funding_offset_ppm: i64::from_le_bytes(src[344..352].try_into().unwrap()),
            last_crank_slot: u64_at(src, 352),
            vwap_num: u128::from_le_bytes(src[360..376].try_into().unwrap()),
            vwap_den: u64_at(src, 376),
            last_index_price: u64_at(src, 384),
            taker_fee_ppm: u64_at(src, 392),
            mark_whirlpool: pk(src, 400),
            mark_invert: src[432] != 0,
        })
    }

    pub fn is_initialized(src: &[u8]) -> bool {
        !src.is_empty() && src[0] != 0
    }

    pub fn has_mark_whirlpool(&self) -> bool {
        self.mark_whirlpool != Pubkey::default()
    }
}

/// A resting order: the maker has escrowed their side of `remaining`
/// contracts in the market vault at `long_price_ppm`; any taker can fill part
/// or all of it by providing the other side.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub version: u8,
    /// Bump of the `["offer", market, maker, nonce_le]` PDA.
    pub bump: u8,
    pub side: Side,
    pub market: Pubkey,
    pub maker: Pubkey,
    pub nonce: u64,
    /// Long side's share of one unit, in PRICE_SCALE. The maker pays this if
    /// `side == Long`, otherwise `PRICE_SCALE - long_price_ppm`.
    pub long_price_ppm: u64,
    /// Contracts (collateral base units of notional) still open.
    pub remaining: u64,
    /// Collateral base units currently escrowed for `remaining`.
    pub escrowed: u64,
    /// Slot after which the offer can no longer be filled (0 = never).
    pub expiry_slot: u64,
}

impl Offer {
    pub const LEN: usize = 112;

    pub fn pack_into(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0] = self.version;
        dst[1] = self.bump;
        dst[2] = self.side as u8;
        dst[3..8].fill(0);
        dst[8..40].copy_from_slice(self.market.as_ref());
        dst[40..72].copy_from_slice(self.maker.as_ref());
        dst[72..80].copy_from_slice(&self.nonce.to_le_bytes());
        dst[80..88].copy_from_slice(&self.long_price_ppm.to_le_bytes());
        dst[88..96].copy_from_slice(&self.remaining.to_le_bytes());
        dst[96..104].copy_from_slice(&self.escrowed.to_le_bytes());
        dst[104..112].copy_from_slice(&self.expiry_slot.to_le_bytes());
        Ok(())
    }

    pub fn unpack(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        if src[0] != VERSION {
            return Err(PairsError::Uninitialized.into());
        }
        Ok(Offer {
            version: src[0],
            bump: src[1],
            side: Side::from_u8(src[2]).map_err(|_| PairsError::Uninitialized)?,
            market: pk(src, 8),
            maker: pk(src, 40),
            nonce: u64_at(src, 72),
            long_price_ppm: u64_at(src, 80),
            remaining: u64_at(src, 88),
            escrowed: u64_at(src, 96),
            expiry_slot: u64_at(src, 104),
        })
    }
}

fn pk(src: &[u8], off: usize) -> Pubkey {
    Pubkey::new_from_array(src[off..off + 32].try_into().unwrap())
}

fn u64_at(src: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(src[off..off + 8].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_roundtrip() {
        let m = Market {
            version: VERSION,
            bump: 254,
            settle_kind: SettleKind::Whirlpool,
            invert: true,
            price_decimals: 9,
            status: MarketStatus::Settled,
            creator: Pubkey::new_unique(),
            collateral_mint: Pubkey::new_unique(),
            collateral_token_program: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
            long_mint: Pubkey::new_unique(),
            short_mint: Pubkey::new_unique(),
            settler: Pubkey::new_unique(),
            underlying: Pubkey::new_unique(),
            floor_price: 1,
            cap_price: 2,
            trade_end_slot: 3,
            settle_end_slot: 4,
            settlement_price: 5,
            long_payout_ppm: 6,
            settled_slot: 7,
            funding_rate_ppm: 8,
            funding_period_slots: 9,
            max_funding_per_period_ppm: 10,
            funding_offset_ppm: -11,
            last_crank_slot: 12,
            vwap_num: u128::MAX - 13,
            vwap_den: 14,
            last_index_price: 15,
            taker_fee_ppm: 16,
            mark_whirlpool: Pubkey::new_unique(),
            mark_invert: true,
        };
        let mut buf = vec![0u8; Market::LEN];
        m.pack_into(&mut buf).unwrap();
        assert_eq!(Market::unpack(&buf).unwrap(), m);
        assert!(Market::unpack(&vec![0u8; Market::LEN]).is_err());
    }

    #[test]
    fn offer_roundtrip() {
        let o = Offer {
            version: VERSION,
            bump: 1,
            side: Side::Short,
            market: Pubkey::new_unique(),
            maker: Pubkey::new_unique(),
            nonce: 42,
            long_price_ppm: 250_000,
            remaining: 1_000,
            escrowed: 750,
            expiry_slot: 99,
        };
        let mut buf = vec![0u8; Offer::LEN];
        o.pack_into(&mut buf).unwrap();
        assert_eq!(Offer::unpack(&buf).unwrap(), o);
    }
}
