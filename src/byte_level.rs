/// GPT-2 byte-level encoding: maps each byte 0x00..0xFF to a unique Unicode
/// character so that BPE merges operate on displayable strings.
///
/// Printable ASCII + Latin-1 supplement map to themselves; control characters
/// and the few gaps (0x00-0x20, 0x7F-0xA0, 0xAD) map to U+0100..U+0143.
pub fn byte_to_char_table() -> [char; 256] {
    let mut table = ['\0'; 256];
    let mut n: u32 = 0;
    for b in 0u16..256 {
        let ch = match b as u8 {
            // Ranges that map to themselves
            0x21..=0x7E | 0xA1..=0xAC | 0xAE..=0xFF => b as u32,
            // Everything else maps to 0x100 + n
            _ => {
                let c = 0x100 + n;
                n += 1;
                c
            }
        };
        table[b as usize] = char::from_u32(ch).unwrap();
    }
    table
}

/// Encode raw bytes into the GPT-2 unicode representation.
pub fn encode_bytes(input: &[u8], table: &[char; 256]) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input {
        out.push(table[b as usize]);
    }
    out
}
