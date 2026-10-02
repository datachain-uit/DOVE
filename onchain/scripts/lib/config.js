const fs = require("fs");
const hre = require("hardhat");
const { readJson } = require("./io");
const { DEFAULT_LATEST_DEPLOYMENT } = require("./paths");

function normalizePrivateKey(key) {
  const s = String(key || "").trim();
  if (!s) throw new Error("Empty private key");
  return s.startsWith("0x") ? s : `0x${s}`;
}

function parsePrivateKeyList(raw) {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(normalizePrivateKey);
}

function resolveEnvKey(primaryName, legacyName) {
  return process.env[primaryName] || process.env[legacyName] || null;
}

function loadDeploymentAddresses() {
  const required = [
    "L1_REGISTRY_ADDR",
    "L1_GROTH16_ADDR",
    "L1_ENFORCER_ADDR",
    "L1_ENFORCER_NOPOP_ADDR",
    "L1_ENFORCER_ZKONLY_ADDR",
  ];
  const envAddresses = Object.fromEntries(required.map((k) => [k, process.env[k] || null]));

  let source = "env";
  let addresses = envAddresses;
  const explicitFile = process.env.L1_DEPLOYMENT_FILE;
  const shouldUseLatest =
    !explicitFile &&
    required.some((k) => !envAddresses[k]) &&
    fs.existsSync(DEFAULT_LATEST_DEPLOYMENT);

  if (explicitFile || shouldUseLatest) {
    const file = explicitFile || DEFAULT_LATEST_DEPLOYMENT;
    const deployment = readJson(file);
    addresses = deployment.addresses || {};
    source = file;
  }

  const missing = required.filter((k) => !addresses[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing deployed addresses: ${missing.join(", ")}. Run deploy first or set L1_DEPLOYMENT_FILE.`
    );
  }

  return { addresses, source };
}

function deriveVerifierKey(seedKey, index) {
  const seed = normalizePrivateKey(seedKey);
  for (let salt = 0; salt < 16; salt++) {
    const key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(
        ["string", "bytes32", "uint256", "uint256"],
        ["DOVE_VERIFIER_WALLET", seed, index, salt]
      )
    );
    try {
      return normalizePrivateKey(key);
    } catch (_) {}
  }
  throw new Error(`Unable to derive verifier key ${index}`);
}

function loadVerifierWallets(count) {
  const keys = [
    ...parsePrivateKeyList(process.env.PRIVATE_KEYS_VERIFIERS || process.env.VERIFIER_PRIVATE_KEYS),
  ];

  for (let i = 1; i <= count; i++) {
    if (process.env[`PRIVATE_KEY_VERIFIER_${i}`]) {
      keys.push(normalizePrivateKey(process.env[`PRIVATE_KEY_VERIFIER_${i}`]));
    }
  }

  if (process.env.PRIVATE_KEY_VERIFIER) {
    keys.push(normalizePrivateKey(process.env.PRIVATE_KEY_VERIFIER));
  }

  if (keys.length === 0) {
    throw new Error("Missing PRIVATE_KEY_VERIFIER or PRIVATE_KEYS_VERIFIERS");
  }

  const unique = [];
  const seen = new Set();
  for (const key of keys) {
    const wallet = new hre.ethers.Wallet(key);
    const addr = wallet.address.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    unique.push(key);
  }

  const seedKey = unique[0];
  let nextIndex = 1;
  while (unique.length < count) {
    const key = deriveVerifierKey(seedKey, nextIndex++);
    const wallet = new hre.ethers.Wallet(key);
    const addr = wallet.address.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    unique.push(key);
  }

  return unique.slice(0, count).map((key) => new hre.ethers.Wallet(key, hre.ethers.provider));
}

module.exports = {
  normalizePrivateKey,
  parsePrivateKeyList,
  resolveEnvKey,
  loadDeploymentAddresses,
  deriveVerifierKey,
  loadVerifierWallets,
};
