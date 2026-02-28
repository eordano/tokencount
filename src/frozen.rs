const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

const MAP_HEADER: usize = 12; // 3 × u32
const MAP_SLOT: usize = 18; // u64 + u32 + u16 + u32
const SET_HEADER: usize = 12;
const SET_SLOT: usize = 14; // u64 + u32 + u16

#[inline]
pub fn fnv_hash(data: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h | 1
}

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
    h | 1
}

#[inline]
pub fn frozen_map_get(table: &[u8], key: &[u8]) -> Option<u32> {
    let num_slots = read_u32(table, 0) as usize;
    let string_pool_off = MAP_HEADER + num_slots * MAP_SLOT;
    let mask = num_slots - 1; // num_slots is power of 2
    let h = fnv_hash(key);
    let mut idx = (h as usize) & mask;

    loop {
        let slot_off = MAP_HEADER + idx * MAP_SLOT;
        let slot_hash = read_u64(table, slot_off);
        if slot_hash == 0 {
            return None;
        }
        if slot_hash == h {
            let key_off = read_u32(table, slot_off + 8) as usize;
            let key_len = read_u16(table, slot_off + 12) as usize;
            let stored = &table[string_pool_off + key_off..string_pool_off + key_off + key_len];
            if stored == key {
                return Some(read_u32(table, slot_off + 14));
            }
        }
        idx = (idx + 1) & mask;
    }
}

#[inline]
pub fn frozen_map_get_pair(table: &[u8], left: &[u8], right: &[u8]) -> Option<u32> {
    let num_slots = read_u32(table, 0) as usize;
    let string_pool_off = MAP_HEADER + num_slots * MAP_SLOT;
    let mask = num_slots - 1;
    let h = fnv_hash_pair(left, right);
    let mut idx = (h as usize) & mask;
    let expected_len = left.len() + 1 + right.len();

    loop {
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
        idx = (idx + 1) & mask;
    }
}

#[inline]
pub fn frozen_set_contains(table: &[u8], key: &[u8]) -> bool {
    let num_slots = read_u32(table, 0) as usize;
    let string_pool_off = SET_HEADER + num_slots * SET_SLOT;
    let mask = num_slots - 1;
    let h = fnv_hash(key);
    let mut idx = (h as usize) & mask;

    loop {
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
        idx = (idx + 1) & mask;
    }
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
