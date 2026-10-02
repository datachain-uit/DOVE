function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientRpcError(err) {
  const msg = String(err?.code || err?.shortMessage || err?.message || err || "");
  return (
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ENETUNREACH") ||
    msg.includes("SERVER_ERROR") ||
    msg.includes("NETWORK_ERROR") ||
    msg.includes("timeout") ||
    msg.includes("failed to detect network")
  );
}

async function withRetry(label, fn, tries = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err) || attempt === tries) throw err;
      const delayMs = 1000 * attempt;
      console.warn(`[retry] ${label} failed (${attempt}/${tries}): ${err.code || err.message}`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = {
  sleep,
  isTransientRpcError,
  withRetry,
};
