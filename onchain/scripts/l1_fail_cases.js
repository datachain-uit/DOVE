const hre = require("hardhat");
require("dotenv").config();

const { resolveEnvKey } = require("./lib/config");
const { loadBatchRound } = require("./lib/inputs");
const { signPoP } = require("./lib/protocol");

const TX_OVERRIDES = { gasLimit: 1_500_000n };

function extractErrorData(err) {
  return (
    err?.data ??
    err?.error?.data ??
    err?.error?.error?.data ??
    err?.info?.error?.data ??
    err?.info?.data ??
    null
  );
}

function decodeRevertName(contract, err) {
  const data = extractErrorData(err);
  if (typeof data === "string" && data.startsWith("0x")) {
    try {
      const decoded = contract.interface.parseError(data);
      if (decoded?.name) return decoded.name;
    } catch (_) {}
  }

  const msg = err?.shortMessage || err?.message || String(err);
  const patterns = [
    /custom error '([A-Za-z0-9_]+)\(\)'/i,
    /reverted with custom error '([A-Za-z0-9_]+)\(\)'/i,
    /\b([A-Za-z0-9_]+)\(\)/,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m?.[1]) return m[1];
  }
  return msg;
}

function isGenericRevertName(name) {
  const s = String(name || "").toLowerCase();
  return (
    s === "error" ||
    s.includes("revert") ||
    s.includes("execution reverted") ||
    s.includes("missing revert data")
  );
}

async function txStatsFromReceipt(rc) {
  const tx = await hre.ethers.provider.getTransaction(rc.hash);
  const gasUsed = rc.gasUsed ?? 0n;
  const gasPrice =
    rc.gasPrice ??
    rc.effectiveGasPrice ??
    tx?.gasPrice ??
    tx?.maxFeePerGas ??
    0n;
  return { gasUsed, gasPrice, feeWei: gasUsed * gasPrice };
}

async function ensureIssuerAllowed(registry, ownerSigner, issuerSigner) {
  const allowed = await registry.issuerAllowed(issuerSigner.address);
  if (!allowed) {
    const tx = await registry.connect(ownerSigner).setIssuerAllowed(issuerSigner.address, true, TX_OVERRIDES);
    await tx.wait();
  }
}

async function pickCredential(registry, issuerSigner, ownerSigner, proverAddress) {
  for (let i = 1; i <= 10; i++) {
    const r = loadBatchRound(i);
    if (r.sid.toLowerCase() !== proverAddress.toLowerCase()) continue;
    const rec = await registry.records(r.C);
    if (rec.issuedAt === 0n) {
      await ensureIssuerAllowed(registry, ownerSigner, issuerSigner);
      const tx = await registry.connect(issuerSigner).register(r.C, TX_OVERRIDES);
      await tx.wait();
      const recAfter = await registry.records(r.C);
      return { ...r, rec: recAfter, source: "newly-registered" };
    }
  }

  for (let i = 1; i <= 10; i++) {
    const r = loadBatchRound(i);
    if (r.sid.toLowerCase() !== proverAddress.toLowerCase()) continue;
    const rec = await registry.records(r.C);
    if (rec.issuedAt !== 0n && rec.active) {
      return { ...r, rec, source: "already-active" };
    }
  }

  throw new Error(
    "No active credential found for prover in this registry. Re-deploy fresh stack and run again."
  );
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function passRevertExpectation(actualRevertName, expectedErrorName) {
  if (!expectedErrorName) return true;
  if (actualRevertName === expectedErrorName) return true;
  if (String(actualRevertName).includes(expectedErrorName)) return true;
  return isGenericRevertName(actualRevertName);
}

async function runTxCase(rows, cfg) {
  const t0 = process.hrtime.bigint();
  let txHash = "-";
  let chainStatus = "NOT_SENT";
  let revertName = "-";
  let gasUsed = 0n;
  let gasPrice = 0n;
  let gasCostWei = 0n;

  try {
    const tx = await cfg.sendTx();
    txHash = tx.hash;
    try {
      const rc = await tx.wait();
      chainStatus = rc.status === 1 ? "SUCCESS" : "FAILED";
      const st = await txStatsFromReceipt(rc);
      gasUsed = st.gasUsed;
      gasPrice = st.gasPrice;
      gasCostWei = st.feeWei;
    } catch (waitErr) {
      revertName = decodeRevertName(cfg.contractForDecode, waitErr);
      const rc = waitErr?.receipt;
      if (rc) {
        txHash = rc.hash ?? txHash;
        chainStatus = rc.status === 0 ? "REVERTED" : "FAILED";
        const st = await txStatsFromReceipt(rc);
        gasUsed = st.gasUsed;
        gasPrice = st.gasPrice;
        gasCostWei = st.feeWei;
      } else {
        chainStatus = "REVERTED";
      }
    }
  } catch (sendErr) {
    chainStatus = "SEND_FAIL";
    revertName = decodeRevertName(cfg.contractForDecode, sendErr);
  }

  const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;

  let verdict = "FAIL";
  if (cfg.expectedType === "success") {
    verdict = chainStatus === "SUCCESS" ? "PASS" : "FAIL";
  } else if (cfg.expectedType === "revert") {
    const isRevertLike =
      chainStatus === "REVERTED" || chainStatus === "FAILED" || chainStatus === "SEND_FAIL";
    verdict = isRevertLike && passRevertExpectation(revertName, cfg.expectedError) ? "PASS" : "FAIL";
  }

  const row = {
    case: cfg.label,
    expected: cfg.expectedType === "success" ? "SUCCESS" : `REVERT(${cfg.expectedError || "ANY"})`,
    status: chainStatus,
    verdict,
    timeSec: elapsedSec,
    gasUsed,
    gasPrice,
    gasCostWei,
    gasCostEth: hre.ethers.formatEther(gasCostWei),
    revert: revertName,
    txHash,
  };
  rows.push(row);

  return row;
}

function printRows(rows) {
  console.log(
    "Case | expected | status | verdict | time(s) | gas_used | gas_price(wei) | gas_cost(ETH) | revert | tx_hash"
  );
  console.log(
    "---------------------------------------------------------------------------------------------------------------------------------------"
  );
  for (const r of rows) {
    console.log(
      `${r.case} | ${r.expected} | ${r.status} | ${r.verdict} | ${r.timeSec.toFixed(3)} | ${r.gasUsed.toString()} | ${r.gasPrice.toString()} | ${r.gasCostEth} | ${r.revert} | ${r.txHash}`
    );
  }
}

function printTotals(rows) {
  const totalCases = rows.length;
  const passed = rows.filter((r) => r.verdict === "PASS").length;
  const failed = totalCases - passed;
  const totalTime = rows.reduce((a, b) => a + b.timeSec, 0);
  const totalGas = rows.reduce((a, b) => a + b.gasUsed, 0n);
  const totalCost = rows.reduce((a, b) => a + b.gasCostWei, 0n);

  console.log("\n===== TOTAL =====");
  console.log(`cases: ${passed}/${totalCases} PASS, ${failed} FAIL`);
  console.log(`time_total(s): ${totalTime.toFixed(3)}`);
  console.log(`time_avg(s): ${(totalTime / totalCases).toFixed(3)}`);
  console.log(`gas_used_total: ${totalGas.toString()}`);
  console.log(`gas_used_avg: ${(Number(totalGas) / totalCases).toFixed(2)}`);
  console.log(`gas_cost_total(ETH): ${hre.ethers.formatEther(totalCost)}`);
  console.log(`gas_cost_avg(ETH): ${hre.ethers.formatEther(totalCost / BigInt(totalCases))}`);
}

async function main() {
  if (!process.env.L1_ENFORCER_ADDR || !process.env.L1_ENFORCER_NOPOP_ADDR || !process.env.L1_REGISTRY_ADDR) {
    throw new Error("Missing L1_ENFORCER_ADDR or L1_ENFORCER_NOPOP_ADDR or L1_REGISTRY_ADDR");
  }
  const proverKey = resolveEnvKey("PRIVATE_KEY_PROVER", "PRIVATE_KEY_HOLDER");
  if (!process.env.PRIVATE_KEY || !proverKey || !process.env.PRIVATE_KEY_VERIFIER) {
    throw new Error("Missing PRIVATE_KEY, PRIVATE_KEY_PROVER (or legacy PRIVATE_KEY_HOLDER), or PRIVATE_KEY_VERIFIER");
  }

  const dove = await hre.ethers.getContractAt("DoveVerifier", process.env.L1_ENFORCER_ADDR);
  const noPoP = await hre.ethers.getContractAt("NoPoPVerifier", process.env.L1_ENFORCER_NOPOP_ADDR);
  const registry = await hre.ethers.getContractAt("DiplomaRegistry", process.env.L1_REGISTRY_ADDR);

  const ownerSigner = new hre.ethers.Wallet(process.env.PRIVATE_KEY, hre.ethers.provider);
  const prover = new hre.ethers.Wallet(proverKey, hre.ethers.provider);
  const verifier = new hre.ethers.Wallet(process.env.PRIVATE_KEY_VERIFIER, hre.ethers.provider);
  const issuer = process.env.PRIVATE_KEY_ISSUER
    ? new hre.ethers.Wallet(process.env.PRIVATE_KEY_ISSUER, hre.ethers.provider)
    : ownerSigner;

  const ownerAddr = await registry.owner();
  if (ownerSigner.address.toLowerCase() !== ownerAddr.toLowerCase()) {
    throw new Error(
      `PRIVATE_KEY is not registry owner. owner=${ownerAddr}, provided=${ownerSigner.address}`
    );
  }

  const picked = await pickCredential(registry, issuer, ownerSigner, prover.address);
  const C = picked.C;
  const sid = picked.sid;
  const ps = picked.proofStruct;
  const aud = verifier.address;
  const altVerifier = [ownerSigner, issuer].find((signer) => {
    const addr = signer.address.toLowerCase();
    return addr !== verifier.address.toLowerCase() && addr !== prover.address.toLowerCase();
  });
  if (!altVerifier) {
    throw new Error(
      "Need a second funded signer distinct from prover and verifier to run cross-verifier replay cases."
    );
  }
  const nonceBase = BigInt(Date.now());

  console.log("=== FAIL CASE RUNNER (Sepolia) ===");
  console.log("DOVE    =", await dove.getAddress());
  console.log("noPoP   =", await noPoP.getAddress());
  console.log("registry=", await registry.getAddress());
  console.log("issuer  =", issuer.address);
  console.log("prover  =", prover.address);
  console.log("verifier=", verifier.address);
  console.log("verifier2=", altVerifier.address);
  console.log(`picked round=${picked.round}, C=${C}, source=${picked.source}`);

  const rows = [];

  // 1) DOVE first submit (success)
  const exp1 = BigInt(nowSec() + 600);
  const ctxWithPoP = { C, sid, aud, nonce: nonceBase + 1n, exp: exp1 };
  const sigWithPoP = await signPoP(prover, ctxWithPoP, ps);
  await runTxCase(rows, {
    label: "DOVE-first",
    expectedType: "success",
    contractForDecode: dove,
    sendTx: () =>
      dove.connect(verifier).verifyAndConsume(ctxWithPoP, ps, sigWithPoP, TX_OVERRIDES),
  });

  // 2) DOVE duplicate nonce (revert)
  await runTxCase(rows, {
    label: "DOVE-dupNonce",
    expectedType: "revert",
    expectedError: "RequestUsed",
    contractForDecode: dove,
    sendTx: () =>
      dove.connect(verifier).verifyAndConsume(ctxWithPoP, ps, sigWithPoP, TX_OVERRIDES),
  });

  // 3) usedRequest replay even with new exp + new PoP signature (revert)
  const ctxWithPoPUsedRequest = {
    C,
    sid,
    aud,
    nonce: ctxWithPoP.nonce, // keep same request key
    exp: BigInt(nowSec() + 1200), // different exp
  };
  const sigWithPoPUsedRequest = await signPoP(prover, ctxWithPoPUsedRequest, ps);
  await runTxCase(rows, {
    label: "DOVE-usedRequest",
    expectedType: "revert",
    expectedError: "RequestUsed",
    contractForDecode: dove,
    sendTx: () =>
      dove
        .connect(verifier)
        .verifyAndConsume(ctxWithPoPUsedRequest, ps, sigWithPoPUsedRequest, TX_OVERRIDES),
  });

  // 4) noPoP first submit (success)
  const exp2 = BigInt(nowSec() + 600);
  const ctxNoPoP = { C, sid, aud, nonce: nonceBase + 2n, exp: exp2 };
  await runTxCase(rows, {
    label: "noPoP-first",
    expectedType: "success",
    contractForDecode: noPoP,
    sendTx: () =>
      noPoP.connect(verifier).verifyAndConsumeNoPoP(ctxNoPoP, ps, TX_OVERRIDES),
  });

  // 5) copied proof under fresh same-verifier context: DOVE rejects old PoP
  const expFreshSameVerifier = BigInt(nowSec() + 600);
  const ctxDoveCopiedFreshSameVerifier = {
    C,
    sid,
    aud,
    nonce: nonceBase + 101n,
    exp: expFreshSameVerifier,
  };
  await runTxCase(rows, {
    label: "DOVE-copiedProof-freshCtx",
    expectedType: "revert",
    expectedError: "BadPoPSignature",
    contractForDecode: dove,
    sendTx: () =>
      dove
        .connect(verifier)
        .verifyAndConsume(ctxDoveCopiedFreshSameVerifier, ps, sigWithPoP, TX_OVERRIDES),
  });

  // 6) copied proof under fresh same-verifier context: noPoP still accepts
  const ctxNoPoPCopiedFreshSameVerifier = {
    C,
    sid,
    aud,
    nonce: nonceBase + 102n,
    exp: expFreshSameVerifier,
  };
  await runTxCase(rows, {
    label: "noPoP-copiedProof-freshCtx",
    expectedType: "success",
    contractForDecode: noPoP,
    sendTx: () =>
      noPoP
        .connect(verifier)
        .verifyAndConsumeNoPoP(ctxNoPoPCopiedFreshSameVerifier, ps, TX_OVERRIDES),
  });

  // 7) copied proof under fresh cross-verifier context: DOVE rejects old PoP
  const expFreshCrossVerifier = BigInt(nowSec() + 600);
  const ctxDoveCopiedCrossVerifier = {
    C,
    sid,
    aud: altVerifier.address,
    nonce: nonceBase + 103n,
    exp: expFreshCrossVerifier,
  };
  await runTxCase(rows, {
    label: "DOVE-copiedProof-otherAud",
    expectedType: "revert",
    expectedError: "BadPoPSignature",
    contractForDecode: dove,
    sendTx: () =>
      dove
        .connect(altVerifier)
        .verifyAndConsume(ctxDoveCopiedCrossVerifier, ps, sigWithPoP, TX_OVERRIDES),
  });

  // 8) copied proof under fresh cross-verifier context: noPoP still accepts
  const ctxNoPoPCopiedCrossVerifier = {
    C,
    sid,
    aud: altVerifier.address,
    nonce: nonceBase + 104n,
    exp: expFreshCrossVerifier,
  };
  await runTxCase(rows, {
    label: "noPoP-copiedProof-otherAud",
    expectedType: "success",
    contractForDecode: noPoP,
    sendTx: () =>
      noPoP
        .connect(altVerifier)
        .verifyAndConsumeNoPoP(ctxNoPoPCopiedCrossVerifier, ps, TX_OVERRIDES),
  });

  // 9) noPoP duplicate nonce (revert)
  await runTxCase(rows, {
    label: "noPoP-dupNonce",
    expectedType: "revert",
    expectedError: "RequestUsed",
    contractForDecode: noPoP,
    sendTx: () =>
      noPoP.connect(verifier).verifyAndConsumeNoPoP(ctxNoPoP, ps, TX_OVERRIDES),
  });

  // 10) DOVE expired exp (revert)
  const latest = await hre.ethers.provider.getBlock("latest");
  const expPast = BigInt(latest.timestamp - 1);
  const ctxWithPoPExpired = { C, sid, aud, nonce: nonceBase + 3n, exp: expPast };
  const sigWithPoPExpired = await signPoP(prover, ctxWithPoPExpired, ps);
  await runTxCase(rows, {
    label: "DOVE-expired",
    expectedType: "revert",
    expectedError: "Expired",
    contractForDecode: dove,
    sendTx: () =>
      dove.connect(verifier).verifyAndConsume(ctxWithPoPExpired, ps, sigWithPoPExpired, TX_OVERRIDES),
  });

  // 11) noPoP expired exp (revert)
  const ctxNoPoPExpired = { C, sid, aud, nonce: nonceBase + 4n, exp: expPast };
  await runTxCase(rows, {
    label: "noPoP-expired",
    expectedType: "revert",
    expectedError: "Expired",
    contractForDecode: noPoP,
    sendTx: () =>
      noPoP.connect(verifier).verifyAndConsumeNoPoP(ctxNoPoPExpired, ps, TX_OVERRIDES),
  });

  // 12) revoke credential (success)
  const recBefore = await registry.records(C);
  if (!recBefore.active) {
    throw new Error(`Credential already revoked before revoke case: C=${C}`);
  }
  const issuerAddr = recBefore.issuer;
  let revoker = null;
  if (issuer.address.toLowerCase() === issuerAddr.toLowerCase()) {
    revoker = issuer;
  } else if (ownerSigner.address.toLowerCase() === ownerAddr.toLowerCase()) {
    revoker = ownerSigner;
  }
  if (!revoker) {
    throw new Error(`No authorized revoker. issuer=${issuerAddr}, owner=${ownerAddr}`);
  }

  await runTxCase(rows, {
    label: "revoke-first",
    expectedType: "success",
    contractForDecode: registry,
    sendTx: () => registry.connect(revoker).revoke(C, TX_OVERRIDES),
  });

  // 13) revoke again (revert)
  await runTxCase(rows, {
    label: "revoke-again",
    expectedType: "revert",
    expectedError: "AlreadyRevoked",
    contractForDecode: registry,
    sendTx: () => registry.connect(ownerSigner).revoke(C, TX_OVERRIDES),
  });

  // 14) DOVE verify revoked (revert)
  const exp3 = BigInt(nowSec() + 600);
  const ctxWithPoPRevoked = { C, sid, aud, nonce: nonceBase + 5n, exp: exp3 };
  const sigWithPoPRevoked = await signPoP(prover, ctxWithPoPRevoked, ps);
  await runTxCase(rows, {
    label: "DOVE-revoked",
    expectedType: "revert",
    expectedError: "InactiveOrRevoked",
    contractForDecode: dove,
    sendTx: () =>
      dove.connect(verifier).verifyAndConsume(ctxWithPoPRevoked, ps, sigWithPoPRevoked, TX_OVERRIDES),
  });

  // 15) noPoP verify revoked (revert)
  const ctxNoPoPRevoked = { C, sid, aud, nonce: nonceBase + 6n, exp: exp3 };
  await runTxCase(rows, {
    label: "noPoP-revoked",
    expectedType: "revert",
    expectedError: "InactiveOrRevoked",
    contractForDecode: noPoP,
    sendTx: () =>
      noPoP.connect(verifier).verifyAndConsumeNoPoP(ctxNoPoPRevoked, ps, TX_OVERRIDES),
  });

  console.log();
  printRows(rows);
  printTotals(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
