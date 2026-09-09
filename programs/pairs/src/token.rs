//! Minimal SPL Token / Token-2022 support: base-layout decoding and CPI
//! wrappers. Both programs share the same instruction encoding and the same
//! first 82 (mint) / 165 (account) bytes of state, so one implementation
//! serves both; extension-bearing Token-2022 accounts are recognised by the
//! account-type byte that follows the base layout.

use {
    crate::error::PairsError,
    solana_program::{
        account_info::AccountInfo,
        entrypoint::ProgramResult,
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
        program_error::ProgramError,
        pubkey,
        pubkey::Pubkey,
    },
};

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

pub const MINT_LEN: usize = 82;
pub const ACCOUNT_LEN: usize = 165;
const ACCOUNT_TYPE_MINT: u8 = 1;
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;

pub fn is_token_program(key: &Pubkey) -> bool {
    *key == TOKEN_PROGRAM_ID || *key == TOKEN_2022_PROGRAM_ID
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MintState {
    pub mint_authority: Option<Pubkey>,
    pub supply: u64,
    pub decimals: u8,
    pub freeze_authority: Option<Pubkey>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenAccountState {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    /// 1 = initialized, 2 = frozen
    pub state: u8,
}

fn coption_pubkey(src: &[u8], off: usize) -> Result<Option<Pubkey>, ProgramError> {
    let tag = u32::from_le_bytes(src[off..off + 4].try_into().unwrap());
    match tag {
        0 => Ok(None),
        1 => Ok(Some(Pubkey::new_from_array(
            src[off + 4..off + 36].try_into().unwrap(),
        ))),
        _ => Err(ProgramError::InvalidAccountData),
    }
}

/// Decode a mint owned by `token_program`.
pub fn unpack_mint(info: &AccountInfo, token_program: &Pubkey) -> Result<MintState, ProgramError> {
    if info.owner != token_program {
        return Err(PairsError::IncorrectOwner.into());
    }
    let data = info.try_borrow_data()?;
    if data.len() < MINT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    if data.len() > MINT_LEN {
        // Token-2022 mint with extensions: base, padding, account type, TLV.
        if data.len() <= ACCOUNT_LEN || data[ACCOUNT_LEN] != ACCOUNT_TYPE_MINT {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    if data[45] != 1 {
        return Err(ProgramError::UninitializedAccount);
    }
    Ok(MintState {
        mint_authority: coption_pubkey(&data, 0)?,
        supply: u64::from_le_bytes(data[36..44].try_into().unwrap()),
        decimals: data[44],
        freeze_authority: coption_pubkey(&data, 46)?,
    })
}

/// Decode a token account owned by `token_program`.
pub fn unpack_token_account(
    info: &AccountInfo,
    token_program: &Pubkey,
) -> Result<TokenAccountState, ProgramError> {
    if info.owner != token_program {
        return Err(PairsError::IncorrectOwner.into());
    }
    let data = info.try_borrow_data()?;
    if data.len() < ACCOUNT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    if data.len() > ACCOUNT_LEN && data[ACCOUNT_LEN] != ACCOUNT_TYPE_ACCOUNT {
        return Err(ProgramError::InvalidAccountData);
    }
    let state = data[108];
    if state == 0 {
        return Err(ProgramError::UninitializedAccount);
    }
    Ok(TokenAccountState {
        mint: Pubkey::new_from_array(data[0..32].try_into().unwrap()),
        owner: Pubkey::new_from_array(data[32..64].try_into().unwrap()),
        amount: u64::from_le_bytes(data[64..72].try_into().unwrap()),
        state,
    })
}

/// Current balance of a token account (no ownership checks; used for
/// before/after deltas on accounts already validated).
pub fn account_amount(info: &AccountInfo) -> Result<u64, ProgramError> {
    let data = info.try_borrow_data()?;
    if data.len() < ACCOUNT_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

// ---- instruction builders (also used by tests and clients) ----

pub fn ix_transfer_checked(
    token_program: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

pub fn ix_mint_to(
    token_program: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(7);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

pub fn ix_burn(
    token_program: &Pubkey,
    account: &Pubkey,
    mint: &Pubkey,
    authority: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(8);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// `InitializeMint2` (no rent sysvar needed).
pub fn ix_initialize_mint2(
    token_program: &Pubkey,
    mint: &Pubkey,
    mint_authority: &Pubkey,
    freeze_authority: Option<&Pubkey>,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(67);
    data.push(20);
    data.push(decimals);
    data.extend_from_slice(mint_authority.as_ref());
    match freeze_authority {
        Some(k) => {
            data.push(1);
            data.extend_from_slice(k.as_ref());
        }
        None => data.push(0),
    }
    Instruction {
        program_id: *token_program,
        accounts: vec![AccountMeta::new(*mint, false)],
        data,
    }
}

/// `InitializeAccount3` (owner in data, no rent sysvar).
pub fn ix_initialize_account3(
    token_program: &Pubkey,
    account: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(33);
    data.push(18);
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new_readonly(*mint, false),
        ],
        data,
    }
}

/// Associated token account address.
pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// Associated Token Account program `CreateIdempotent`.
pub fn ix_create_associated_token_account_idempotent(
    payer: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    let ata = associated_token_address(owner, mint, token_program);
    Instruction {
        program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(solana_system_interface::program::id(), false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: vec![1],
    }
}

// ---- CPI wrappers ----

/// Transfer signed by a user (or by the PDA when `signer_seeds` is given).
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    signer_seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    let ix = ix_transfer_checked(
        token_program.key,
        source.key,
        mint.key,
        destination.key,
        authority.key,
        amount,
        decimals,
    );
    let infos = [
        source.clone(),
        mint.clone(),
        destination.clone(),
        authority.clone(),
        token_program.clone(),
    ];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &infos, &[seeds]),
        None => invoke(&ix, &infos),
    }
}

pub fn mint_to<'a>(
    token_program: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    let ix = ix_mint_to(
        token_program.key,
        mint.key,
        destination.key,
        authority.key,
        amount,
    );
    invoke_signed(
        &ix,
        &[
            mint.clone(),
            destination.clone(),
            authority.clone(),
            token_program.clone(),
        ],
        &[signer_seeds],
    )
}

/// Burn signed by the token account owner.
pub fn burn<'a>(
    token_program: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    owner: &AccountInfo<'a>,
    amount: u64,
) -> ProgramResult {
    let ix = ix_burn(token_program.key, account.key, mint.key, owner.key, amount);
    invoke(
        &ix,
        &[
            account.clone(),
            mint.clone(),
            owner.clone(),
            token_program.clone(),
        ],
    )
}
