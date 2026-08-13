// Single source of truth for the tokencount web app base URL used by
// `--share`. Override at runtime with TOKEN_COUNT_URL (see --help);
// DEFAULT_BASE_URL is only the fallback when that env var is unset.
export const DEFAULT_BASE_URL = "https://tokencount.eordano.com/";

export function resolveBaseUrl(env = process.env) {
  return env.TOKEN_COUNT_URL || DEFAULT_BASE_URL;
}
