// Claude tokenizer based on rohangpta/ctoc
// Uses greedy longest-match over a trie of 38,360 verified Claude tokens
// Achieves ~96% accuracy on code, ~99% on English prose (always over-counts)

class TrieNode {
  constructor() {
    this.children = new Map();
    this.isTerminal = false;
  }
}

class ClaudeTokenizer {
  constructor(vocab) {
    this.root = new TrieNode();
    const encoder = new TextEncoder();
    for (const token of vocab) {
      let node = this.root;
      for (const byte of encoder.encode(token)) {
        if (!node.children.has(byte)) {
          node.children.set(byte, new TrieNode());
        }
        node = node.children.get(byte);
      }
      node.isTerminal = true;
    }
  }

  // Greedy longest-match: returns byte length of best token at pos
  _matchLen(bytes, pos) {
    let node = this.root;
    let best = 0;
    for (let i = pos; i < bytes.length; i++) {
      node = node.children.get(bytes[i]);
      if (!node) break;
      if (node.isTerminal) best = i - pos + 1;
    }
    return best || 1;
  }

  countTokens(text) {
    if (!text || text.length === 0) return 0;
    const bytes = new TextEncoder().encode(text);
    let count = 0;
    let pos = 0;
    while (pos < bytes.length) {
      pos += this._matchLen(bytes, pos);
      count++;
    }
    return count;
  }

  encode(text) {
    if (!text || text.length === 0) return [];
    const bytes = new TextEncoder().encode(text);
    const tokens = [];

    // Map each byte index to the character index it belongs to,
    // so we can slice the original text instead of decoding bytes
    // (avoids U+FFFD replacement chars for split multi-byte sequences).
    const byteToChar = new Uint32Array(bytes.length + 1);
    const encoder = new TextEncoder();
    let charIdx = 0;
    let byteIdx = 0;
    while (charIdx < text.length) {
      const charByteLen = encoder.encode(text[charIdx]).length;
      for (let b = 0; b < charByteLen; b++) {
        byteToChar[byteIdx + b] = charIdx;
      }
      byteIdx += charByteLen;
      charIdx++;
    }
    byteToChar[byteIdx] = text.length; // sentinel

    let pos = 0;
    while (pos < bytes.length) {
      const len = this._matchLen(bytes, pos);
      const startChar = byteToChar[pos];
      const endChar = byteToChar[pos + len];
      if (endChar > startChar) {
        tokens.push(text.slice(startChar, endChar));
      }
      pos += len;
    }
    return tokens;
  }
}

let instance = null;
let loadPromise = null;

export async function loadClaudeTokenizer(vocabUrl) {
  if (!loadPromise) {
    loadPromise = fetch(vocabUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch vocab: ${res.status}`);
        return res.json();
      })
      .then((vocab) => {
        instance = new ClaudeTokenizer(vocab);
        return instance;
      })
      .catch((err) => {
        loadPromise = null; // allow retry on failure
        throw err;
      });
  }
  return loadPromise;
}

export function getClaudeTokenizer() {
  return instance;
}

export { ClaudeTokenizer };
