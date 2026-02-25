// Word-level diff using Longest Common Subsequence (LCS)

function tokenize(text) {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

function lcs(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

export function computeDiff(textA, textB) {
  if (!textA && !textB) return [];

  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  const dp = lcs(tokensA, tokensB);

  const segments = [];
  let i = tokensA.length;
  let j = tokensB.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && tokensA[i - 1] === tokensB[j - 1]) {
      segments.unshift({ text: tokensA[i - 1], type: "unchanged" });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      segments.unshift({ text: tokensB[j - 1], type: "added" });
      j--;
    } else {
      segments.unshift({ text: tokensA[i - 1], type: "removed" });
      i--;
    }
  }

  // Merge consecutive segments of same type
  const merged = [];
  for (const seg of segments) {
    if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
      merged[merged.length - 1].text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}
