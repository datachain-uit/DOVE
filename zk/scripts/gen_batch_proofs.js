const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ethers = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const N = Number(process.argv[2] || 100);
const WASM = process.env.WASM || "build/circuits/diploma_trust_js/diploma_trust.wasm";
const WITNESS_JS =
  process.env.WITNESS_JS || "build/circuits/diploma_trust_js/generate_witness.js";
const ZKEY = process.env.ZKEY || "build/circuits/keys/diploma_trust_final.zkey";
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || "build/batch");
const ONCHAIN_BATCH_DIR = path.resolve(
  ROOT,
  process.env.LAYER1_BATCH_DIR || "../onchain/zkp/batch"
);
const SEED_PREFIX = process.env.SEED_PREFIX || "DIPLOMA-2026";
const ISSUED_AT_BASE = BigInt(process.env.ISSUED_AT_BASE || "1760000000");
const HOLDER_SEED = process.env.HOLDER_SEED || process.env.DOVE_HOLDER_SEED || null;

const utils = ethers.utils || ethers;
const keccak256 = ethers.keccak256 || utils.keccak256;
const solidityPack = ethers.solidityPacked || utils.solidityPack;
const getAddress = ethers.getAddress || utils.getAddress;
const hexZeroPad = ethers.zeroPadValue || utils.hexZeroPad;
const BigNumber = ethers.BigNumber;

function ensureFile(p) {
  const abs = path.resolve(ROOT, p);
  if (!fs.existsSync(abs)) throw new Error(`Missing required file: ${abs}`);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function commandExists(cmd) {
  const probe = spawnSync(cmd, ["--version"], {
    cwd: ROOT,
    stdio: "ignore",
    shell: false,
  });
  return probe.status === 0;
}

function snarkCommand() {
  if (process.env.SNARKJS) return [process.env.SNARKJS];
  if (commandExists("snarkjs")) return ["snarkjs"];
  return [process.platform === "win32" ? "npx.cmd" : "npx", "snarkjs"];
}

function run(cmd, args, env = {}) {
  const proc = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false,
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(`Command failed (${proc.status}): ${cmd} ${args.join(" ")}`);
  }
}

function runSnark(args) {
  const [cmd, ...prefix] = snarkCommand();
  run(cmd, [...prefix, ...args]);
}

function derivePrivateKey(seed, index) {
  for (let salt = 0; salt < 16; salt++) {
    const key = keccak256(
      solidityPack(
        ["string", "string", "uint256", "uint256"],
        ["DOVE_HOLDER_WALLET", seed, index, salt]
      )
    );
    try {
      new ethers.Wallet(key);
      return key;
    } catch (_) {}
  }
  throw new Error(`Unable to derive holder key for index ${index}`);
}

function makeHolder(index) {
  if (HOLDER_SEED) return new ethers.Wallet(derivePrivateKey(HOLDER_SEED, index));
  return ethers.Wallet.createRandom();
}

function toHex32FromDecimal(x) {
  return hexZeroPad(BigNumber.from(String(x)).toHexString(), 32);
}

function toAddressFromDecimal(x) {
  return getAddress(hexZeroPad(BigNumber.from(String(x)).toHexString(), 20));
}

function copyBatchFile(outName) {
  fs.copyFileSync(path.join(OUT_DIR, outName), path.join(ONCHAIN_BATCH_DIR, outName));
}

async function main() {
  if (!Number.isInteger(N) || N <= 0) throw new Error(`Invalid N: ${N}`);
  ensureFile(WASM);
  ensureFile(WITNESS_JS);
  ensureFile(ZKEY);
  ensureDir(OUT_DIR);
  ensureDir(ONCHAIN_BATCH_DIR);

  const manifest = {
    generatedAt: new Date().toISOString(),
    count: N,
    seed: HOLDER_SEED ? "provided" : null,
    seedPrefix: SEED_PREFIX,
    issuedAtBase: ISSUED_AT_BASE.toString(),
    instances: [],
  };

  console.log(`Generating ${N} proof batches...`);
  console.log(`outDir          = ${OUT_DIR}`);
  console.log(`onchainBatchDir = ${ONCHAIN_BATCH_DIR}`);
  console.log(`holderSeeded    = ${Boolean(HOLDER_SEED)}`);

  const seenSid = new Set();
  const seenC = new Set();

  for (let i = 1; i <= N; i++) {
    console.log(`\n=== Round ${i}/${N} ===`);
    const holder = makeHolder(i);
    const diplomaSeed = `${SEED_PREFIX}-${String(i).padStart(4, "0")}`;
    const issuedAt = ISSUED_AT_BASE + BigInt(i);
    const inputPath = path.join(OUT_DIR, `input_${i}.json`);
    const witnessPath = path.join(OUT_DIR, `witness_${i}.wtns`);
    const proofPath = path.join(OUT_DIR, `proof_${i}.json`);
    const publicPath = path.join(OUT_DIR, `public_${i}.json`);

    run("node", ["scripts/make_input.js"], {
      PRIVATE_KEY_PROVER: holder.privateKey,
      PROOF_INDEX: String(i),
      DIPLOMA_ID_SEED: diplomaSeed,
      ISSUED_AT: issuedAt.toString(),
      INPUT_PATH: inputPath,
    });

    run("node", [WITNESS_JS, WASM, inputPath, witnessPath]);
    runSnark(["groth16", "prove", ZKEY, witnessPath, proofPath, publicPath]);

    const pub = JSON.parse(fs.readFileSync(publicPath, "utf8"));
    if (!Array.isArray(pub) || pub.length !== 2) {
      throw new Error(`Invalid public output for round ${i}`);
    }
    const C = toHex32FromDecimal(pub[0]);
    const sid = toAddressFromDecimal(pub[1]);
    if (sid.toLowerCase() !== holder.address.toLowerCase()) {
      throw new Error(`sid mismatch for round ${i}: public=${sid}, holder=${holder.address}`);
    }
    if (seenSid.has(sid.toLowerCase())) throw new Error(`Duplicate sid: ${sid}`);
    if (seenC.has(C.toLowerCase())) throw new Error(`Duplicate commitment: ${C}`);
    seenSid.add(sid.toLowerCase());
    seenC.add(C.toLowerCase());

    manifest.instances.push({
      id: i,
      holderAddress: holder.address,
      holderPrivateKey: holder.privateKey,
      commitment: C,
      sid,
      diplomaIdSeed: diplomaSeed,
      issuedAt: issuedAt.toString(),
      proofFile: `proof_${i}.json`,
      publicFile: `public_${i}.json`,
    });

    copyBatchFile(`proof_${i}.json`);
    copyBatchFile(`public_${i}.json`);
  }

  const manifestFile = path.join(OUT_DIR, "batch_manifest.json");
  const onchainManifestFile = path.join(ONCHAIN_BATCH_DIR, "batch_manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(onchainManifestFile, JSON.stringify(manifest, null, 2));

  console.log("\nDone.");
  console.log(`generated proofs       = ${N}`);
  console.log(`unique commitments     = ${seenC.size}`);
  console.log(`unique holder sid      = ${seenSid.size}`);
  console.log(`manifest               = ${manifestFile}`);
  console.log(`onchain manifest       = ${onchainManifestFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
