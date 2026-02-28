const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

const MAP_HEADER: usize = 12; // 3 × u32
const MAP_SLOT: usize = 18; // u64 + u32 + u16 + u32
const SET_HEADER: usize = 12;
const SET_SLOT: usize = 14; // u64 + u32 + u16

/// FNV-1a hash, forced to odd (never zero).
///
/// The frozen hash tables use `slot_hash == 0` as the empty-slot sentinel
/// for linear-probe termination. `h | 1` guarantees a populated slot can
/// never be mistaken for an empty one.
#[inline]
pub fn fnv_hash(data: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h | 1 // never zero — 0 is the empty-slot sentinel
}

/// FNV-1a hash of a NUL-separated pair, forced to odd (never zero).
/// See [`fnv_hash`] for why `h | 1`.
#[inline]
pub fn fnv_hash_pair(a: &[u8], b: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for &byte in a {
        h ^= byte as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    // NUL separator
    h ^= 0u64;
    h = h.wrapping_mul(FNV_PRIME);
    for &byte in b {
        h ^= byte as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h | 1 // never zero — 0 is the empty-slot sentinel
}

/// FNV-1a hash of a concatenation `a || b` (no separator), forced to odd.
/// See [`fnv_hash`] for why `h | 1`.
#[inline]
pub fn fnv_hash_concat(a: &[u8], b: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for &byte in a {
        h ^= byte as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    for &byte in b {
        h ^= byte as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h | 1 // never zero — 0 is the empty-slot sentinel
}

/// Lemire fast range reduction: maps a u64 hash into [0, n) via
/// fixed-point multiply — one `mul` + shift, no division.
#[inline(always)]
fn fast_reduce(h: u64, n: usize) -> usize {
    ((h as u128).wrapping_mul(n as u128) >> 64) as usize
}

#[inline]
pub fn frozen_map_get_pair(table: &[u8], left: &[u8], right: &[u8]) -> Option<u32> {
    let num_slots = read_u32(table, 0) as usize;
    let string_pool_off = MAP_HEADER + num_slots * MAP_SLOT;
    let h = fnv_hash_pair(left, right);
    let mut idx = fast_reduce(h, num_slots);
    let expected_len = left.len() + 1 + right.len();

    for _ in 0..num_slots {
        let slot_off = MAP_HEADER + idx * MAP_SLOT;
        let slot_hash = read_u64(table, slot_off);
        if slot_hash == 0 {
            return None;
        }
        if slot_hash == h {
            let key_off = read_u32(table, slot_off + 8) as usize;
            let key_len = read_u16(table, slot_off + 12) as usize;
            if key_len == expected_len {
                let stored = &table[string_pool_off + key_off..string_pool_off + key_off + key_len];
                if stored[..left.len()] == *left
                    && stored[left.len()] == 0
                    && stored[left.len() + 1..] == *right
                {
                    return Some(read_u32(table, slot_off + 14));
                }
            }
        }
        idx += 1;
        if idx == num_slots { idx = 0; }
    }
    None
}

/// Look up the concatenation `a || b` in a frozen map without allocating.
/// Equivalent to `frozen_map_get(table, &[a, b].concat())` but avoids the
/// temporary `Vec`.
#[inline]
pub fn frozen_map_get_concat(table: &[u8], a: &[u8], b: &[u8]) -> Option<u32> {
    let num_slots = read_u32(table, 0) as usize;
    let string_pool_off = MAP_HEADER + num_slots * MAP_SLOT;
    let h = fnv_hash_concat(a, b);
    let mut idx = fast_reduce(h, num_slots);
    let expected_len = a.len() + b.len();

    for _ in 0..num_slots {
        let slot_off = MAP_HEADER + idx * MAP_SLOT;
        let slot_hash = read_u64(table, slot_off);
        if slot_hash == 0 {
            return None;
        }
        if slot_hash == h {
            let key_off = read_u32(table, slot_off + 8) as usize;
            let key_len = read_u16(table, slot_off + 12) as usize;
            if key_len == expected_len {
                let stored = &table[string_pool_off + key_off..string_pool_off + key_off + key_len];
                if stored[..a.len()] == *a && stored[a.len()..] == *b {
                    return Some(read_u32(table, slot_off + 14));
                }
            }
        }
        idx += 1;
        if idx == num_slots { idx = 0; }
    }
    None
}

#[inline]
pub fn frozen_set_contains(table: &[u8], key: &[u8]) -> bool {
    let num_slots = read_u32(table, 0) as usize;
    let string_pool_off = SET_HEADER + num_slots * SET_SLOT;
    let h = fnv_hash(key);
    let mut idx = fast_reduce(h, num_slots);

    for _ in 0..num_slots {
        let slot_off = SET_HEADER + idx * SET_SLOT;
        let slot_hash = read_u64(table, slot_off);
        if slot_hash == 0 {
            return false;
        }
        if slot_hash == h {
            let key_off = read_u32(table, slot_off + 8) as usize;
            let key_len = read_u16(table, slot_off + 12) as usize;
            let stored = &table[string_pool_off + key_off..string_pool_off + key_off + key_len];
            if stored == key {
                return true;
            }
        }
        idx += 1;
        if idx == num_slots { idx = 0; }
    }
    false
}

pub fn frozen_map_byte_len(table: &[u8]) -> usize {
    let num_slots = read_u32(table, 0) as usize;
    let string_pool_len = read_u32(table, 8) as usize;
    MAP_HEADER + num_slots * MAP_SLOT + string_pool_len
}

pub fn frozen_set_byte_len(table: &[u8]) -> usize {
    let num_slots = read_u32(table, 0) as usize;
    let string_pool_len = read_u32(table, 8) as usize;
    SET_HEADER + num_slots * SET_SLOT + string_pool_len
}

#[inline(always)]
pub fn read_u32(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
}

#[inline(always)]
pub fn read_u16(data: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([data[off], data[off + 1]])
}

#[inline(always)]
pub fn read_u64(data: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}
