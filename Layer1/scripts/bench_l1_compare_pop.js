const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const BATCH_DIR = path.join(__dirname, "..", "zkp", "batch");
const TRANSCRIPT_TAG = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("TRANSCRIPT_V1"));

function resolveEnvKey(primaryName, legacyName) {
  return process.env[primaryName] || process.env[legacyName] || null;
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function minmaxavg(arr) {
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return { min, max, avg };
}

function stddev(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((acc, x) => acc + (x - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function stats(arr) {
  const base = minmaxavg(arr);
  return { ...base, std: stddev(arr) };
}

function minmaxavgBigInt(arr) {
  const min = arr.reduce((a, b) => (a < b ? a : b));
  const max = arr.reduce((a, b) => (a > b ? a : b));
  const sum = arr.reduce((a, b) => a + b, 0n);
  const avg = sum / BigInt(arr.length);
  return { min, max, avg };
}

async function txStats(rc) {
  const txOnchain = await hre.ethers.provider.getTransaction(rc.hash);
  const gasPrice =
    rc.gasPrice ??
    rc.effectiveGasPrice ??
    txOnchain?.gasPrice ??
    txOnchain?.maxFeePerGas ??
    0n;
  const gasUsed = rc.gasUsed;
  const feeWei = gasUsed * gasPrice;
  return { gasUsed, gasPrice, feeWei };
}

function proofStructFromJson(proof) {
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
  };
}

function availableBatchIds() {
  return fs
    .readdirSync(BATCH_DIR)
    .map((name) => {
      const m = name.match(/^proof_(\d+)\.json$/);
      return m ? Number(m[1]) : null;
    })
    .filter((x) => x !== null)
    .sort((a, b) => a - b);
}

async function ensureIssuerAllowed(registry, ownerSigner, issuerSigner) {
  const allowed = await registry.issuerAllowed(issuerSigner.address);
  if (!allowed) {
    await (await registry.connect(ownerSigner).setIssuerAllowed(issuerSigner.address, true)).wait();
  }
}

async function ensureActiveCommitment(registry, ownerSigner, issuerSigner, C) {
  await ensureIssuerAllowed(registry, ownerSigner, issuerSigner);
  const rec = await registry.records(C);
  if (rec.issuedAt === 0n) {
    await (await registry.connect(issuerSigner).register(C)).wait();
    return;
  }
  if (!rec.active) {
    throw new Error(`Commitment ${C} exists but is not active; benchmark requires an active registry state.`);
  }
}

async function maybeFundLocalWallet(funder, wallet, minWei) {
  const bal = await hre.ethers.provider.getBalance(wallet.address);
  if (bal >= minWei) return;
  const tx = await funder.sendTransaction({
    to: wallet.address,
    value: minWei - bal,
  });
  await tx.wait();
}

async function main() {
  const N = Number(process.argv[2] || 5);
  const nonceBase = BigInt(process.argv[3] || Date.now());
  const ttlSec = Number(process.argv[4] || 600);
  const batchIds = availableBatchIds();

  if (batchIds.length === 0) {
    throw new Error(`No proof_*.json files found in ${BATCH_DIR}`);
  }

  if (!process.env.L1_ENFORCER_ADDR || !process.env.L1_ENFORCER_NOPOP_ADDR || !process.env.L1_REGISTRY_ADDR) {
    throw new Error("Missing L1_ENFORCER_ADDR or L1_ENFORCER_NOPOP_ADDR or L1_REGISTRY_ADDR");
  }
  const proverKey = resolveEnvKey("PRIVATE_KEY_PROVER", "PRIVATE_KEY_HOLDER");
  if (!proverKey || !process.env.PRIVATE_KEY_VERIFIER) {
    throw new Error("Missing PRIVATE_KEY_PROVER (or legacy PRIVATE_KEY_HOLDER) or PRIVATE_KEY_VERIFIER");
  }

  const dove = await hre.ethers.getContractAt("DoveVerifier", process.env.L1_ENFORCER_ADDR);
  const noPoP = await hre.ethers.getContractAt("NoPoPVerifier", process.env.L1_ENFORCER_NOPOP_ADDR);
  const registry = await hre.ethers.getContractAt("DiplomaRegistry", process.env.L1_REGISTRY_ADDR);
  const [defaultSigner] = await hre.ethers.getSigners();

  const prover = new hre.ethers.Wallet(proverKey, hre.ethers.provider);
  const verifier = new hre.ethers.Wallet(process.env.PRIVATE_KEY_VERIFIER, hre.ethers.provider);
  const issuer = process.env.PRIVATE_KEY_ISSUER
    ? new hre.ethers.Wallet(process.env.PRIVATE_KEY_ISSUER, hre.ethers.provider)
    : defaultSigner;
  const owner = process.env.PRIVATE_KEY_OWNER
    ? new hre.ethers.Wallet(process.env.PRIVATE_KEY_OWNER, hre.ethers.provider)
    : defaultSigner;
  const network = await hre.ethers.provider.getNetwork();

  if (network.chainId !== 11155111n) {
    const minBalance = hre.ethers.parseEther("2.0");
    await maybeFundLocalWallet(defaultSigner, prover, minBalance);
    await maybeFundLocalWallet(defaultSigner, verifier, minBalance);
  }

  const doveGas = [];
  const doveTime = [];
  const dovePrice = [];
  const doveFee = [];

  const noGas = [];
  const noTime = [];
  const noPrice = [];
  const noFee = [];

  console.log("issuer   =", issuer.address);
  console.log("prover   =", prover.address);
  console.log("verifier =", verifier.address);
  console.log();
  console.log("Round | protocol | status  | verify_time(s) | gas_used | gas_price(wei) | gas_cost(ETH) | tx_hash");
  console.log("---------------------------------------------------------------------------------------------------------------------");

  for (let i = 1; i <= N; i++) {
    const batchId = batchIds[(i - 1) % batchIds.length];
    const proof = loadJson(path.join(BATCH_DIR, `proof_${batchId}.json`));
    const pub = loadJson(path.join(BATCH_DIR, `public_${batchId}.json`));
    if (!Array.isArray(pub) || pub.length !== 2) {
      throw new Error(`Invalid public_${batchId}.json: expected exactly [C, sid], got ${JSON.stringify(pub)}`);
    }

    const C = hre.ethers.toBeHex(BigInt(pub[0]), 32);
    const sid = hre.ethers.getAddress(hre.ethers.toBeHex(BigInt(pub[1]), 20));
    if (prover.address.toLowerCase() !== sid.toLowerCase()) {
      throw new Error(`prover key != sid for batch ${batchId} (round ${i})`);
    }

    await ensureActiveCommitment(registry, owner, issuer, C);

    const now = (await hre.ethers.provider.getBlock("latest")).timestamp;
    const exp = BigInt(now + ttlSec);
    const aud = verifier.address;
    const ps = proofStructFromJson(proof);

    // DOVE
    {
      const ctx = { C, sid, aud, nonce: nonceBase + BigInt(i), exp };
      const proofHash = hre.ethers.keccak256(
        hre.ethers.solidityPacked(
          ["uint256[2]", "uint256[2][2]", "uint256[2]"],
          [ps.a, ps.b, ps.c]
        )
      );
      const th = hre.ethers.keccak256(
        hre.ethers.solidityPacked(
          ["bytes32", "bytes32", "address", "address", "uint256", "uint256", "bytes32"],
          [TRANSCRIPT_TAG, C, sid, aud, ctx.nonce, exp, proofHash]
        )
      );
      const proverSig = await prover.signMessage(hre.ethers.getBytes(th));

      const t0 = process.hrtime.bigint();
      const tx = await dove.connect(verifier).verifyAndConsume(ctx, ps, proverSig);
      const rc = await tx.wait();
      const verifyTimeSec = Number(process.hrtime.bigint() - t0) / 1e9;
      const { gasUsed, gasPrice, feeWei } = await txStats(rc);
      const status = rc.status === 1 ? "SUCCESS" : "FAILED";

      doveGas.push(Number(gasUsed));
      doveTime.push(verifyTimeSec);
      dovePrice.push(gasPrice);
      doveFee.push(feeWei);

      console.log(
        `${String(i).padStart(5)} | DOVE     | ${status.padEnd(7)} | ${verifyTimeSec.toFixed(3).padStart(14)} | ${gasUsed.toString().padStart(8)} | ${gasPrice.toString().padStart(14)} | ${hre.ethers.formatEther(feeWei)} | ${rc.hash}`
      );
    }

    // without PoP
    {
      const ctx = { C, sid, aud, nonce: nonceBase + BigInt(N + i), exp };
      const t0 = process.hrtime.bigint();
      const tx = await noPoP.connect(verifier).verifyAndConsumeNoPoP(ctx, ps);
      const rc = await tx.wait();
      const verifyTimeSec = Number(process.hrtime.bigint() - t0) / 1e9;
      const { gasUsed, gasPrice, feeWei } = await txStats(rc);
      const status = rc.status === 1 ? "SUCCESS" : "FAILED";

      noGas.push(Number(gasUsed));
      noTime.push(verifyTimeSec);
      noPrice.push(gasPrice);
      noFee.push(feeWei);

      console.log(
        `${String(i).padStart(5)} | noPoP  | ${status.padEnd(7)} | ${verifyTimeSec.toFixed(3).padStart(14)} | ${gasUsed.toString().padStart(8)} | ${gasPrice.toString().padStart(14)} | ${hre.ethers.formatEther(feeWei)} | ${rc.hash}`
      );
    }
  }

  const sDoveGas = stats(doveGas);
  const sDoveTime = stats(doveTime);
  const sDovePrice = minmaxavgBigInt(dovePrice);
  const sDoveFee = minmaxavgBigInt(doveFee);

  const sNoGas = stats(noGas);
  const sNoTime = stats(noTime);
  const sNoPrice = minmaxavgBigInt(noPrice);
  const sNoFee = minmaxavgBigInt(noFee);

  console.log("\n===== SUMMARY: DOVE =====");
  console.log(`gasUsed  avg = ${sDoveGas.avg.toFixed(2)} | min = ${sDoveGas.min} | max = ${sDoveGas.max} | std = ${sDoveGas.std.toFixed(2)}`);
  console.log(`verify   avg = ${sDoveTime.avg.toFixed(3)} s | min = ${sDoveTime.min.toFixed(3)} | max = ${sDoveTime.max.toFixed(3)} | std = ${sDoveTime.std.toFixed(3)}`);
  console.log(`gasPrice avg = ${sDovePrice.avg.toString()} wei | min = ${sDovePrice.min.toString()} | max = ${sDovePrice.max.toString()}`);
  console.log(`gasCost  avg = ${hre.ethers.formatEther(sDoveFee.avg)} ETH | min = ${hre.ethers.formatEther(sDoveFee.min)} | max = ${hre.ethers.formatEther(sDoveFee.max)}`);

  console.log("\n===== SUMMARY: noPoP =====");
  console.log(`gasUsed  avg = ${sNoGas.avg.toFixed(2)} | min = ${sNoGas.min} | max = ${sNoGas.max} | std = ${sNoGas.std.toFixed(2)}`);
  console.log(`verify   avg = ${sNoTime.avg.toFixed(3)} s | min = ${sNoTime.min.toFixed(3)} | max = ${sNoTime.max.toFixed(3)} | std = ${sNoTime.std.toFixed(3)}`);
  console.log(`gasPrice avg = ${sNoPrice.avg.toString()} wei | min = ${sNoPrice.min.toString()} | max = ${sNoPrice.max.toString()}`);
  console.log(`gasCost  avg = ${hre.ethers.formatEther(sNoFee.avg)} ETH | min = ${hre.ethers.formatEther(sNoFee.min)} | max = ${hre.ethers.formatEther(sNoFee.max)}`);

  const deltaGas = sDoveGas.avg - sNoGas.avg;
  const deltaTime = sDoveTime.avg - sNoTime.avg;
  const deltaFeeWei = sDoveFee.avg - sNoFee.avg;
  console.log("\n===== DELTA (DOVE - noPoP) =====");
  console.log(`delta gasUsed = ${deltaGas.toFixed(2)}`);
  console.log(`delta verify  = ${deltaTime.toFixed(3)} s`);
  console.log(`delta gasCost = ${hre.ethers.formatEther(deltaFeeWei)} ETH`);

  console.log("\n===== SUMMARY_JSON =====");
  console.log(
    JSON.stringify(
      {
        rounds: N,
        batchIds,
        dove: {
          gas: sDoveGas,
          time: sDoveTime,
          gasPrice: {
            avg: sDovePrice.avg.toString(),
            min: sDovePrice.min.toString(),
            max: sDovePrice.max.toString(),
          },
          feeEth: {
            avg: hre.ethers.formatEther(sDoveFee.avg),
            min: hre.ethers.formatEther(sDoveFee.min),
            max: hre.ethers.formatEther(sDoveFee.max),
          },
        },
        noPoP: {
          gas: sNoGas,
          time: sNoTime,
          gasPrice: {
            avg: sNoPrice.avg.toString(),
            min: sNoPrice.min.toString(),
            max: sNoPrice.max.toString(),
          },
          feeEth: {
            avg: hre.ethers.formatEther(sNoFee.avg),
            min: hre.ethers.formatEther(sNoFee.min),
            max: hre.ethers.formatEther(sNoFee.max),
          },
        },
        delta: {
          gasUsed: Number(deltaGas.toFixed(2)),
          verifyTimeSec: Number(deltaTime.toFixed(3)),
          feeEth: hre.ethers.formatEther(deltaFeeWei),
        },
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
