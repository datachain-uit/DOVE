const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { nowStamp, ensureDir, writeDeploymentCsv: writeCsv } = require("./lib/io");

async function receiptStats(rc, elapsedSec) {
  const tx = await hre.ethers.provider.getTransaction(rc.hash);
  const gasUsed = rc.gasUsed;
  const gasPrice =
    rc.gasPrice ??
    rc.effectiveGasPrice ??
    tx?.gasPrice ??
    tx?.maxFeePerGas ??
    0n;
  const feeWei = gasUsed * gasPrice;

  return {
    txHash: rc.hash,
    blockNumber: rc.blockNumber.toString(),
    status: rc.status === 1 ? "SUCCESS" : "FAILED",
    gasUsed: gasUsed.toString(),
    gasPriceWei: gasPrice.toString(),
    gasCostEth: hre.ethers.formatEther(feeWei),
    confirmationTimeSec: elapsedSec,
    feeWei,
  };
}

async function deployContract(label, factoryName, args) {
  const Factory = await hre.ethers.getContractFactory(factoryName);
  const t0 = process.hrtime.bigint();
  const contract = await Factory.deploy(...args);
  const rc = await contract.deploymentTransaction().wait();
  const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;
  const stats = await receiptStats(rc, elapsedSec);
  const address = await contract.getAddress();
  const { feeWei, ...rowStats } = stats;

  console.log(`\n[${label}]`);
  console.log("address =", address);
  console.log("txHash  =", stats.txHash);
  console.log("block   =", stats.blockNumber);
  console.log("status  =", stats.status);
  console.log("time(s) =", stats.confirmationTimeSec.toFixed(3));
  console.log("gasUsed =", stats.gasUsed);
  console.log("gasPrice(wei) =", stats.gasPriceWei);
  console.log("gasCost(ETH) =", stats.gasCostEth);

  return {
    contract,
    row: {
      label,
      contract: factoryName,
      address,
      ...rowStats,
      confirmationTimeSec: Number(stats.confirmationTimeSec.toFixed(6)),
    },
    feeWei: stats.feeWei,
    gasUsed: BigInt(stats.gasUsed),
  };
}

async function txStats(label, txPromise) {
  const t0 = process.hrtime.bigint();
  const tx = await txPromise;
  const rc = await tx.wait();
  const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;
  const stats = await receiptStats(rc, elapsedSec);
  const { feeWei, ...rowStats } = stats;

  console.log(`\n[${label}]`);
  console.log("txHash =", stats.txHash);
  console.log("block  =", stats.blockNumber);
  console.log("status =", stats.status);
  console.log("time(s) =", stats.confirmationTimeSec.toFixed(3));
  console.log("gasUsed =", stats.gasUsed);
  console.log("gasPrice(wei) =", stats.gasPriceWei);
  console.log("gasCost(ETH) =", stats.gasCostEth);

  return {
    row: {
      label,
      contract: "DiplomaRegistry",
      address: "-",
      ...rowStats,
      confirmationTimeSec: Number(stats.confirmationTimeSec.toFixed(6)),
    },
    feeWei: stats.feeWei,
    gasUsed: BigInt(stats.gasUsed),
  };
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const stamp = nowStamp();
  const resultDir = path.join(__dirname, "..", "results", `deploy_${stamp}`);
  ensureDir(resultDir);

  console.log("network  =", network.name);
  console.log("chainId  =", network.chainId.toString());
  console.log("deployer =", deployer.address);
  console.log("results  =", resultDir);

  let totalGas = 0n;
  let totalFeeWei = 0n;
  const rows = [];

  const registryDeploy = await deployContract("Deploy DiplomaRegistry", "DiplomaRegistry", [
    deployer.address,
  ]);
  rows.push(registryDeploy.row);
  totalGas += registryDeploy.gasUsed;
  totalFeeWei += registryDeploy.feeWei;

  const groth16Deploy = await deployContract("Deploy Groth16Verifier", "Groth16Verifier", []);
  rows.push(groth16Deploy.row);
  totalGas += groth16Deploy.gasUsed;
  totalFeeWei += groth16Deploy.feeWei;

  const registryAddr = await registryDeploy.contract.getAddress();
  const groth16Addr = await groth16Deploy.contract.getAddress();

  const doveDeploy = await deployContract("Deploy DoveVerifier", "DoveVerifier", [
    groth16Addr,
    registryAddr,
  ]);
  rows.push(doveDeploy.row);
  totalGas += doveDeploy.gasUsed;
  totalFeeWei += doveDeploy.feeWei;

  const noPoPDeploy = await deployContract("Deploy NoPoPVerifier", "NoPoPVerifier", [
    groth16Addr,
    registryAddr,
  ]);
  rows.push(noPoPDeploy.row);
  totalGas += noPoPDeploy.gasUsed;
  totalFeeWei += noPoPDeploy.feeWei;

  const zkOnlyDeploy = await deployContract("Deploy ZKOnlyVerifier", "ZKOnlyVerifier", [
    groth16Addr,
    registryAddr,
  ]);
  rows.push(zkOnlyDeploy.row);
  totalGas += zkOnlyDeploy.gasUsed;
  totalFeeWei += zkOnlyDeploy.feeWei;

  const issuerFromEnv = process.env.ISSUER_ADDR;
  if (issuerFromEnv) {
    const allow = await txStats(
      "setIssuerAllowed(true)",
      registryDeploy.contract.setIssuerAllowed(issuerFromEnv, true)
    );
    rows.push(allow.row);
    totalGas += allow.gasUsed;
    totalFeeWei += allow.feeWei;
    console.log("issuer allowed =", issuerFromEnv);
  } else {
    console.log("\nISSUER_ADDR not set, skip setIssuerAllowed");
  }

  const deployment = {
    network: network.name,
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    addresses: {
      L1_REGISTRY_ADDR: registryAddr,
      L1_GROTH16_ADDR: groth16Addr,
      L1_ENFORCER_ADDR: await doveDeploy.contract.getAddress(),
      L1_ENFORCER_NOPOP_ADDR: await noPoPDeploy.contract.getAddress(),
      L1_ENFORCER_ZKONLY_ADDR: await zkOnlyDeploy.contract.getAddress(),
    },
    transactions: rows,
    summary: {
      totalGasUsed: totalGas.toString(),
      totalGasCostEth: hre.ethers.formatEther(totalFeeWei),
    },
  };

  const jsonFile = path.join(resultDir, "deployment.json");
  const csvFile = path.join(resultDir, "deployment.csv");
  fs.writeFileSync(jsonFile, JSON.stringify(deployment, null, 2));
  writeCsv(csvFile, rows);

  const latestFile = path.join(__dirname, "..", "results", "latest-deployment.json");
  fs.writeFileSync(latestFile, JSON.stringify(deployment, null, 2));

  console.log("\n===== DEPLOYED ADDRESSES =====");
  for (const [key, value] of Object.entries(deployment.addresses)) {
    console.log(`${key}=${value}`);
  }

  console.log("\n===== DEPLOY SUMMARY =====");
  console.log("totalGasUsed =", deployment.summary.totalGasUsed);
  console.log("totalGasCost(ETH) =", deployment.summary.totalGasCostEth);
  console.log("deploymentJson =", jsonFile);
  console.log("deploymentCsv  =", csvFile);
  console.log("latestDeployment =", latestFile);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
