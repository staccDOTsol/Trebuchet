//! Trebuchet Pairs: fully collateralized leveraged long/short pools for any
//! Solana token, with on-chain resting offers as the order book.
//!
//! Lineage: the pair-mint / redeem / decide flow of SPL binary-oracle-pair
//! and the priced two-party trade of SPL binary-option, generalised from a
//! binary outcome to a capped price range (which is what makes a position
//! leveraged) and extended with resting offers, funding and Orca Whirlpool
//! settlement.

pub mod entrypoint;
pub mod error;
pub mod instruction;
pub mod math;
pub mod processor;
pub mod state;
pub mod token;

solana_program::declare_id!("46RKjEgeK2qNkDdBFnBnrSUJtrXmPcFwSa6xNzNfMums");
