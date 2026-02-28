const ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";

function zbase32Encode(bytes) {
  let bits = "";
  for (const b of bytes) {
    bits += b.toString(2).padStart(8, "0");
  }
  while (bits.length % 5 !== 0) {
    bits += "0";
  }
  let result = "";
  for (let i = 0; i < bits.length; i += 5) {
    const idx = parseInt(bits.slice(i, i + 5), 2);
    result += ALPHABET[idx];
  }
  return result;
}

function zbase32Decode(str) {
  let bits = "";
  for (const c of str) {
    const idx = ALPHABET.indexOf(c);
    if (idx === -1) return null;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

function base64UrlEncode(bytes) {
  const binStr = String.fromCodePoint(...bytes);
  return btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodePayload(textA, textB, opts) {
  const obj = { a: textA, b: textB };
  if (opts) {
    if (opts.model) obj.m = opts.model;
    if (opts.highlight) obj.h = opts.highlight;
    if (opts.tokens) obj.t = opts.tokens;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return base64UrlEncode(bytes);
}

export function decodePayload(encoded) {
  try {
    const bytes = zbase32Decode(encoded);
    if (!bytes) return null;
    const json = new TextDecoder().decode(bytes);
    const obj = JSON.parse(json);
    if (typeof obj.a === "string" && typeof obj.b === "string") {
      return { a: obj.a, b: obj.b, m: obj.m || null, h: obj.h || null, t: obj.t || null };
    }
    return null;
  } catch {
    return null;
  }
}

function base64Decode(encoded) {
  let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const binStr = atob(b64);
  return Uint8Array.from(binStr, (c) => c.codePointAt(0));
}

export function decodePayloadBase64(encoded) {
  try {
    const bytes = base64Decode(encoded);
    const json = new TextDecoder().decode(bytes);
    const obj = JSON.parse(json);
    if (typeof obj.a === "string" && typeof obj.b === "string") {
      return { a: obj.a, b: obj.b, m: obj.m || null, h: obj.h || null, t: obj.t || null };
    }
    return null;
  } catch {
    return null;
  }
}
