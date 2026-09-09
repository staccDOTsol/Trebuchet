//! Error types

use {solana_program::program_error::ProgramError, thiserror::Error};

/// Errors that may be returned by the Pairs program.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum PairsError {
    /// 0
    #[error("Account already initialized")]
    AlreadyInUse,
    /// 1
    #[error("Account not initialized or wrong version")]
    Uninitialized,
    /// 2
    #[error("Authority PDA does not match")]
    InvalidAuthority,
    /// 3
    #[error("Account is owned by the wrong program")]
    IncorrectOwner,
    /// 4
    #[error("Token program must be SPL Token or Token-2022")]
    InvalidTokenProgram,
    /// 5
    #[error("Token mint is not valid for this market")]
    InvalidMint,
    /// 6
    #[error("Token account is not valid for this market or user")]
    InvalidTokenAccount,
    /// 7
    #[error("Position mint must have zero supply, PDA mint authority and no freeze authority")]
    InvalidPositionMint,
    /// 8
    #[error("Amount must be greater than zero")]
    ZeroAmount,
    /// 9
    #[error("Price must be strictly between 0 and PRICE_SCALE")]
    InvalidPrice,
    /// 10
    #[error("floor must be below cap")]
    InvalidRange,
    /// 11
    #[error("trade_end_slot must be in the future and before settle_end_slot")]
    InvalidSchedule,
    /// 12
    #[error("Trading window for this market has closed")]
    TradingClosed,
    /// 13
    #[error("Market is not open (already settled or void)")]
    MarketNotOpen,
    /// 14
    #[error("Market has not been settled yet")]
    NotSettled,
    /// 15
    #[error("Settlement is not allowed in the current slot")]
    OutsideSettlementWindow,
    /// 16
    #[error("Wrong settler account for this market")]
    WrongSettler,
    /// 17
    #[error("Missing required signature")]
    MissingSignature,
    /// 18
    #[error("Whirlpool account is invalid for this market")]
    InvalidWhirlpool,
    /// 19
    #[error("Arithmetic overflow")]
    Overflow,
    /// 20
    #[error("Vault received a different amount than requested (transfer fees are not supported)")]
    TransferAmountMismatch,
    /// 21
    #[error("Offer belongs to a different market")]
    OfferMarketMismatch,
    /// 22
    #[error("Offer has expired")]
    OfferExpired,
    /// 23
    #[error("Offer is not yet expired and the signer is not its maker")]
    OfferNotCancellable,
    /// 24
    #[error("Offer PDA does not match")]
    InvalidOfferAddress,
    /// 25
    #[error("Maker and taker must be different accounts")]
    SelfTrade,
    /// 26
    #[error("Long and short sides must be different accounts")]
    SameCounterparty,
    /// 27
    #[error("Price decimals too large")]
    InvalidPriceDecimals,
}

impl From<PairsError> for ProgramError {
    fn from(e: PairsError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
