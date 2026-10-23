// Account with the model's tokenizer; character counts vary too much for code and logs.
export function createContextBudget(contextLength, initialTokens, maxReadTokens = Infinity) {
  const reserveTokens = Math.min(8192, Math.floor(contextLength / 4));
  const templateAllowance = 2048;
  let readTokens = 0, generatedTokens = 0;
  const remaining = () => Math.max(0, Math.min(maxReadTokens - readTokens, contextLength - reserveTokens - templateAllowance - initialTokens - readTokens - generatedTokens));
  return {
    reserveTokens,
    remaining,
    recordPrediction(stats) { generatedTokens += stats.predictedTokensCount ?? 2200; },
    admit(tokens) {
      const cost = tokens + 64; // Tool-result framing and separators.
      if (cost > remaining()) return false;
      readTokens += cost;
      return true;
    },
    get readTokens() { return readTokens; },
  };
}

export function readLimits(contextLength) {
  return {
    maxLines: Math.min(2000, Math.max(300, Math.floor(contextLength / 32))),
    maxCharacters: Math.min(131072, Math.max(18000, contextLength)),
  };
}
