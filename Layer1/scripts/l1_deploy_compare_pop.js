const hre = require("hardhat");
require("dotenv").config();

async function printTxStats(label, rc) {
  const tx = await hre.ethers.provider.getTransaction(rc.hash);
  const gasUsed = rc.gasUsed;
  const gasPrice =
    rc.gasPrice ??
    rc.effectiveGasPrice ??
    tx?.gasPrice ??
    tx?.maxFeePerGas ??
    0n;
  const feeWei = gasUsed * gasPrice;

  console.log(`\n[${label}]`);
  console.log("txHash =", rc.hash);
  console.log("block  =", rc.blockNumber.toString());
  console.log("gasUsed =", gasUsed.toString());
  console.log("gasPrice(wei) =", gasPrice.toString());
  console.log("gasCost(ETH) =", hre.ethers.formatEther(feeWei));

  return { gasUsed, feeWei };
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("deployer =", deployer.address);

  let totalGas = 0n;
  let totalFeeWei = 0n;

  const Registry = await hre.ethers.getContractFactory("DiplomaRegistry");
  const registry = await Registry.deploy(deployer.address);
  const rcRegistry = await registry.deploymentTransaction().wait();
  {
    const s = await printTxStats("Deploy DiplomaRegistry", rcRegistry);
    totalGas += s.gasUsed;
    totalFeeWei += s.feeWei;
  }

  const Groth16 = await hre.ethers.getContractFactory("Groth16Verifier");
  const groth16 = await Groth16.deploy();
  const rcGroth16 = await groth16.deploymentTransaction().wait();
  {
    const s = await printTxStats("Deploy Groth16Verifier", rcGroth16);
    totalGas += s.gasUsed;
    totalFeeWei += s.feeWei;
  }

  const Dove = await hre.ethers.getContractFactory("DoveVerifier");
  const dove = await Dove.deploy(await groth16.getAddress(), await registry.getAddress());
  const rcDove = await dove.deploymentTransaction().wait();
  {
    const s = await printTxStats("Deploy DoveVerifier", rcDove);
    totalGas += s.gasUsed;
    totalFeeWei += s.feeWei;
  }

  const NoPoP = await hre.ethers.getContractFactory("NoPoPVerifier");
  const noPoP = await NoPoP.deploy(await groth16.getAddress(), await registry.getAddress());
  const rcNoPoP = await noPoP.deploymentTransaction().wait();
  {
    const s = await printTxStats("Deploy NoPoPVerifier", rcNoPoP);
    totalGas += s.gasUsed;
    totalFeeWei += s.feeWei;
  }

  const issuerFromEnv = process.env.ISSUER_ADDR;
  if (issuerFromEnv) {
    const tx = await registry.setIssuerAllowed(issuerFromEnv, true);
    const rcAllow = await tx.wait();
    const s = await printTxStats("setIssuerAllowed(true)", rcAllow);
    totalGas += s.gasUsed;
    totalFeeWei += s.feeWei;
    console.log("issuer allowed =", issuerFromEnv);
  } else {
    console.log("ISSUER_ADDR not set, skip setIssuerAllowed");
  }

  console.log("\nL1_REGISTRY_ADDR =", await registry.getAddress());
  console.log("L1_GROTH16_ADDR =", await groth16.getAddress());
  console.log("L1_ENFORCER_ADDR =", await dove.getAddress());
  console.log("L1_ENFORCER_NOPOP_ADDR =", await noPoP.getAddress());

  console.log("\n===== DEPLOY SUMMARY =====");
  console.log("totalGasUsed =", totalGas.toString());
  console.log("totalGasCost(ETH) =", hre.ethers.formatEther(totalFeeWei));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
