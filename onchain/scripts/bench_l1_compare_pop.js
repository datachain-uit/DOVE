const hre = require("hardhat");
const path = require("path");
require("dotenv").config();

const { BATCH_DIR } = require("./lib/paths");
const { nowStamp, ensureDir, readCsv, writeCsv } = require("./lib/io");
const { normalizePrivateKey, loadDeploymentAddresses, loadVerifierWallets } = require("./lib/config");
const { loadInstances } = require("./lib/inputs");
const { signPoP } = require("./lib/protocol");
const { withRetry } = require("./lib/rpc");
const { flushResults } = require("./lib/results");

async function maybeFundWallets(wallets, funder, minWei) {
  if (process.env.SKIP_VERIFIER_FUNDING === "1") return [];

  const rows = [];
  for (const wallet of wallets) {
    const balance = await withRetry(`getBalance ${wallet.address}`, () =>
      hre.ethers.provider.getBalance(wallet.address)
    );
    if (balance >= minWei) {
      rows.push({
        wallet: wallet.address,
        status: "ALREADY_FUNDED",
        balanceWei: balance.toString(),
        topupWei: "0",
        txHash: "-",
      });
      continue;
    }

    const topup = minWei - balance;
    const tx = await funder.sendTransaction({ to: wallet.address, value: topup });
    const rc = await withRetry(`fund wait ${wallet.address}`, () => tx.wait());
    rows.push({
      wallet: wallet.address,
      status: rc.status === 1 ? "FUNDED" : "FAILED",
      balanceWei: balance.toString(),
      topupWei: topup.toString(),
      txHash: rc.hash,
    });
  }
  return rows;
}

async function txStatsFromReceipt(rc) {
  const tx = await withRetry(`getTransaction ${rc.hash}`, () =>
    hre.ethers.provider.getTransaction(rc.hash)
  );
  const gasUsed = rc.gasUsed ?? 0n;
  const gasPrice =
    rc.gasPrice ??
    rc.effectiveGasPrice ??
    tx?.gasPrice ??
    tx?.maxFeePerGas ??
    0n;
  const feeWei = gasUsed * gasPrice;
  return { gasUsed, gasPrice, feeWei };
}

async function measureTx({ variant, round, batchId, C, sid, aud, nonce, exp, sendTx }) {
  const t0 = process.hrtime.bigint();
  let txHash = "-";
  let status = "NOT_SENT";
  let error = "-";
  let gasUsed = 0n;
  let gasPrice = 0n;
  let feeWei = 0n;

  try {
    const tx = await sendTx();
    txHash = tx.hash;
    const rc = await withRetry(`${variant} round ${round} wait`, () => tx.wait());
    status = rc.status === 1 ? "SUCCESS" : "FAILED";
    const stats = await txStatsFromReceipt(rc);
    gasUsed = stats.gasUsed;
    gasPrice = stats.gasPrice;
    feeWei = stats.feeWei;
  } catch (err) {
    status = "ERROR";
    error = err.shortMessage || err.reason || err.message || String(err);
    if (err.receipt) {
      txHash = err.receipt.hash ?? txHash;
      const stats = await txStatsFromReceipt(err.receipt);
      gasUsed = stats.gasUsed;
      gasPrice = stats.gasPrice;
      feeWei = stats.feeWei;
    }
  }

  const timeSec = Number(process.hrtime.bigint() - t0) / 1e9;
  return {
    round,
    batchId,
    variant,
    status,
    timeSec: Number(timeSec.toFixed(6)),
    gasUsed: gasUsed.toString(),
    gasPriceWei: gasPrice.toString(),
    gasCostEth: hre.ethers.formatEther(feeWei),
    C,
    sid,
    aud,
    nonce: nonce.toString(),
    exp: exp.toString(),
    txHash,
    error,
  };
}

async function ensureIssuerAllowed(registry, ownerSigner, issuerSigner, prepRows) {
  const allowed = await withRetry("issuerAllowed", () =>
    registry.issuerAllowed(issuerSigner.address)
  );
  if (allowed) return;

  const started = process.hrtime.bigint();
  const tx = await registry.connect(ownerSigner).setIssuerAllowed(issuerSigner.address, true);
  const rc = await withRetry("setIssuerAllowed wait", () => tx.wait());
  const stats = await txStatsFromReceipt(rc);
  prepRows.push({
    phase: "setIssuerAllowed",
    C: "-",
    status: rc.status === 1 ? "SUCCESS" : "FAILED",
    timeSec: Number((Number(process.hrtime.bigint() - started) / 1e9).toFixed(6)),
    gasUsed: stats.gasUsed.toString(),
    gasPriceWei: stats.gasPrice.toString(),
    gasCostEth: hre.ethers.formatEther(stats.feeWei),
    txHash: rc.hash,
  });
}

async function ensureActiveCommitment(registry, ownerSigner, issuerSigner, C, prepRows) {
  const rec = await withRetry(`records ${C}`, () => registry.records(C));
  if (rec.issuedAt !== 0n) {
    if (!rec.active) {
      throw new Error(`Commitment ${C} exists but is revoked/inactive`);
    }
    prepRows.push({
      phase: "register",
      C,
      status: "ALREADY_ACTIVE",
      timeSec: 0,
      gasUsed: "0",
      gasPriceWei: "0",
      gasCostEth: "0.0",
      txHash: "-",
    });
    return;
  }

  await ensureIssuerAllowed(registry, ownerSigner, issuerSigner, prepRows);
  const started = process.hrtime.bigint();
  const tx = await registry.connect(issuerSigner).register(C);
  const rc = await withRetry(`register wait ${C}`, () => tx.wait());
  const stats = await txStatsFromReceipt(rc);
  prepRows.push({
    phase: "register",
    C,
    status: rc.status === 1 ? "SUCCESS" : "FAILED",
    timeSec: Number((Number(process.hrtime.bigint() - started) / 1e9).toFixed(6)),
    gasUsed: stats.gasUsed.toString(),
    gasPriceWei: stats.gasPrice.toString(),
    gasCostEth: hre.ethers.formatEther(stats.feeWei),
    txHash: rc.hash,
  });
}

function printVariantRow(row) {
  console.log(
    `${String(row.round).padStart(5)} | ${row.variant.padEnd(7)} | ${row.status.padEnd(7)} | ${String(row.timeSec.toFixed(3)).padStart(8)} | ${String(row.gasUsed).padStart(8)} | ${row.txHash}`
  );
}

async function main() {
  const N = Number(process.argv[2] || 100);
  const nonceBase = BigInt(process.argv[3] || Date.now());
  const ttlSec = Number(process.argv[4] || process.env.PRESENTATION_TTL_SEC || 7200);
  const verifierCount = Number(process.env.VERIFIER_COUNT || 5);
  const minVerifierBalance = hre.ethers.parseEther(process.env.MIN_VERIFIER_BALANCE_ETH || "0.05");
  const stamp = nowStamp();
  const resultDir = process.env.RESUME_RESULT_DIR
    ? path.resolve(process.env.RESUME_RESULT_DIR)
    : path.join(__dirname, "..", "results", `bench_${stamp}`);
  ensureDir(resultDir);

  const { addresses, source: addressSource } = loadDeploymentAddresses();
  const { instances, manifestFile, manifest, batchIds } = loadInstances(N);

  const dove = await hre.ethers.getContractAt("DoveVerifier", addresses.L1_ENFORCER_ADDR);
  const noPoP = await hre.ethers.getContractAt("NoPoPVerifier", addresses.L1_ENFORCER_NOPOP_ADDR);
  const zkOnly = await hre.ethers.getContractAt("ZKOnlyVerifier", addresses.L1_ENFORCER_ZKONLY_ADDR);
  const registry = await hre.ethers.getContractAt("DiplomaRegistry", addresses.L1_REGISTRY_ADDR);

  const [defaultSigner] = await hre.ethers.getSigners();
  const ownerKey = process.env.PRIVATE_KEY_OWNER || process.env.PRIVATE_KEY;
  const ownerSigner = ownerKey
    ? new hre.ethers.Wallet(normalizePrivateKey(ownerKey), hre.ethers.provider)
    : defaultSigner;
  const issuerKey = process.env.PRIVATE_KEY_ISSUER || ownerKey;
  const issuerSigner = issuerKey
    ? new hre.ethers.Wallet(normalizePrivateKey(issuerKey), hre.ethers.provider)
    : ownerSigner;
  const ownerAddr = await registry.owner();
  if (ownerSigner.address.toLowerCase() !== ownerAddr.toLowerCase()) {
    throw new Error(`Owner signer mismatch: registry owner=${ownerAddr}, provided=${ownerSigner.address}`);
  }

  const verifierWallets = loadVerifierWallets(verifierCount);
  const fundingRows = await maybeFundWallets(verifierWallets, ownerSigner, minVerifierBalance);
  writeCsv(path.join(resultDir, "verifier_funding.csv"), fundingRows);

  const network = await withRetry("getNetwork", () => hre.ethers.provider.getNetwork());
  const prepRows = [];
  console.log("=== DOVE L1 ABLATION BENCHMARK ===");
  console.log("network       =", network.name);
  console.log("chainId       =", network.chainId.toString());
  console.log("rounds        =", N.toString());
  console.log("resultDir     =", resultDir);
  console.log("addressSource =", addressSource);
  console.log("manifest      =", manifestFile);
  console.log("registry      =", addresses.L1_REGISTRY_ADDR);
  console.log("groth16       =", addresses.L1_GROTH16_ADDR);
  console.log("DOVE          =", addresses.L1_ENFORCER_ADDR);
  console.log("NoPoP         =", addresses.L1_ENFORCER_NOPOP_ADDR);
  console.log("ZKOnly        =", addresses.L1_ENFORCER_ZKONLY_ADDR);
  console.log("issuer        =", issuerSigner.address);
  console.log("verifiers     =", verifierWallets.map((w) => w.address).join(", "));
  console.log();

  console.log(`Preparing registry for ${instances.length} commitments...`);
  for (let i = 0; i < instances.length; i++) {
    await ensureActiveCommitment(registry, ownerSigner, issuerSigner, instances[i].C, prepRows);
    if ((i + 1) % 10 === 0 || i + 1 === instances.length) {
      console.log(`registry prep ${i + 1}/${instances.length}`);
    }
  }

  const variantRows = process.env.RESUME_RESULT_DIR
    ? {
        dove: readCsv(path.join(resultDir, "dove.csv")),
        nopop: readCsv(path.join(resultDir, "nopop.csv")),
        zkonly: readCsv(path.join(resultDir, "zkonly.csv")),
      }
    : { dove: [], nopop: [], zkonly: [] };
  const hasSuccess = (variant, round) =>
    variantRows[variant].some((r) => Number(r.round) === round && r.status === "SUCCESS");
  const metadata = {
    timestamp: new Date().toISOString(),
    network: network.name,
    chainId: network.chainId.toString(),
    rounds: N,
    ttlSec,
    nonceBase: nonceBase.toString(),
    resumed: Boolean(process.env.RESUME_RESULT_DIR),
    verifierCount,
    addressSource,
    addresses,
    batchDir: BATCH_DIR,
    manifestFile,
    batchIds,
    holderGeneration: {
      distinctSid: true,
      distinctCommitment: true,
      manifestSeeded: Boolean(manifest.seed),
    },
  };

  console.log();
  console.log("Round | variant | status  |  time(s) | gasUsed | txHash");
  console.log("------------------------------------------------------------------------------------------");

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const round = i + 1;
    const verifier = verifierWallets[i % verifierWallets.length];
    const latest = await withRetry("getBlock latest", () => hre.ethers.provider.getBlock("latest"));
    const exp = BigInt(latest.timestamp + ttlSec);
    const aud = verifier.address;
    const ps = inst.proofStruct;

    if (hasSuccess("dove", round)) {
      console.log(`${String(round).padStart(5)} | dove    | SKIP    | existing successful row`);
    } else {
      const ctx = {
        C: inst.C,
        sid: inst.sid,
        aud,
        nonce: nonceBase + BigInt(round),
        exp,
      };
      const sig = await signPoP(inst.holder, ctx, ps);
      const row = await measureTx({
        variant: "dove",
        round,
        batchId: inst.id,
        C: inst.C,
        sid: inst.sid,
        aud,
        nonce: ctx.nonce,
        exp,
        sendTx: () => dove.connect(verifier).verifyAndConsume(ctx, ps, sig),
      });
      variantRows.dove.push(row);
      printVariantRow(row);
    }

    if (hasSuccess("nopop", round)) {
      console.log(`${String(round).padStart(5)} | nopop   | SKIP    | existing successful row`);
    } else {
      const ctx = {
        C: inst.C,
        sid: inst.sid,
        aud,
        nonce: nonceBase + BigInt(N + round),
        exp,
      };
      const row = await measureTx({
        variant: "nopop",
        round,
        batchId: inst.id,
        C: inst.C,
        sid: inst.sid,
        aud,
        nonce: ctx.nonce,
        exp,
        sendTx: () => noPoP.connect(verifier).verifyAndConsumeNoPoP(ctx, ps),
      });
      variantRows.nopop.push(row);
      printVariantRow(row);
    }

    if (hasSuccess("zkonly", round)) {
      console.log(`${String(round).padStart(5)} | zkonly  | SKIP    | existing successful row`);
    } else {
      const ctx = {
        C: inst.C,
        sid: inst.sid,
        aud,
        nonce: nonceBase + BigInt(2 * N + round),
        exp,
      };
      const row = await measureTx({
        variant: "zkonly",
        round,
        batchId: inst.id,
        C: inst.C,
        sid: inst.sid,
        aud,
        nonce: ctx.nonce,
        exp,
        sendTx: () => zkOnly.connect(verifier).verifyZKOnly(ctx, ps),
      });
      variantRows.zkonly.push(row);
      printVariantRow(row);
    }

    flushResults(resultDir, variantRows, prepRows, metadata);
  }

  const summary = flushResults(resultDir, variantRows, prepRows, metadata);
  console.log("\n===== SUMMARY =====");
  for (const [variant, s] of Object.entries(summary.variants)) {
    if (!s.gas) {
      console.log(`${variant}: success=${s.success}/${s.rounds}`);
      continue;
    }
    console.log(
      `${variant}: success=${s.success}/${s.rounds} gasAvg=${s.gas.avg} min=${s.gas.min} max=${s.gas.max} std=${s.gas.std} timeAvg=${s.time.avg}s`
    );
  }
  console.log("summaryJson =", path.join(resultDir, "summary.json"));
  console.log("doveCsv     =", path.join(resultDir, "dove.csv"));
  console.log("nopopCsv    =", path.join(resultDir, "nopop.csv"));
  console.log("zkonlyCsv   =", path.join(resultDir, "zkonly.csv"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
