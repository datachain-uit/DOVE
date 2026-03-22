const fs = require("fs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");
const ethers = require("ethers");

// BN254 scalar field prime (same as Groth16Verifier.r)
const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ethers v6: ethers.toUtf8Bytes / ethers.keccak256
// ethers v5: ethers.utils.toUtf8Bytes / ethers.utils.keccak256
const toUtf8Bytes = ethers.toUtf8Bytes ?? ethers.utils?.toUtf8Bytes;
const keccak256 = ethers.keccak256 ?? ethers.utils?.keccak256;
const getAddress = ethers.getAddress ?? ethers.utils?.getAddress;

if (!toUtf8Bytes || !keccak256 || !getAddress) {
  throw new Error("Cannot find toUtf8Bytes/keccak256/getAddress in ethers. Check ethers version/import.");
}

function addrToField(addr) {
  // addr is "0x..." 20 bytes, fits into field
  return BigInt(addr);
}

function keccakToField(str) {
  const h = keccak256(toUtf8Bytes(str)); // 0x...
  return BigInt(h) % FIELD;
}

function readEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Source of truth: Layer1/.env
  const layer1EnvPath = path.resolve(__dirname, "../../Layer1/.env");
  const env = {
    ...readEnvFile(layer1EnvPath),
    ...process.env,
  };

  let PROVER_ADDR = "0x42EEEb18286651655B35820cfe2d37bdaACc15b8";
  if (env.PRIVATE_KEY_PROVER) {
    PROVER_ADDR = new ethers.Wallet(env.PRIVATE_KEY_PROVER).address;
  } else if (env.PRIVATE_KEY_HOLDER) {
    PROVER_ADDR = new ethers.Wallet(env.PRIVATE_KEY_HOLDER).address;
  } else if (env.PROVER_ADDR) {
    PROVER_ADDR = ethers.getAddress(env.PROVER_ADDR);
  } else if (env.HOLDER_ADDR) {
    PROVER_ADDR = ethers.getAddress(env.HOLDER_ADDR);
  }

  let ISSUER_ADDR = "0x00000000000000000000000000000000000000A1";
  if (env.PRIVATE_KEY_ISSUER) {
    ISSUER_ADDR = new ethers.Wallet(env.PRIVATE_KEY_ISSUER).address;
  } else if (env.ISSUER_ADDR) {
    ISSUER_ADDR = getAddress(env.ISSUER_ADDR);
  }

  // Credential fields.
  const proofIndex = env.PROOF_INDEX ? BigInt(env.PROOF_INDEX) : null;
  const issuedAtBase = env.ISSUED_AT_BASE ? BigInt(env.ISSUED_AT_BASE) : 1760000000n;
  const issuedAt =
    env.ISSUED_AT
      ? BigInt(env.ISSUED_AT)
      : proofIndex !== null
        ? issuedAtBase + proofIndex
        : 1760000000n;
  const diplomaIdSeed =
    env.DIPLOMA_ID_SEED ||
    (proofIndex !== null
      ? `${env.DIPLOMA_ID_PREFIX || "DIPLOMA-2026"}-${proofIndex.toString().padStart(4, "0")}`
      : "DIPLOMA-2026-0001");
  const diplomaId = keccakToField(diplomaIdSeed);

  // Map to field elements
  const sid = addrToField(PROVER_ADDR);
  const issuer = addrToField(ISSUER_ADDR);

  // Compute C (must match circuit constraints)
  const C = F.toObject(poseidon([sid, issuer, diplomaId, issuedAt]));

  const input = {
    // Public inputs
    C: C.toString(),
    sid: sid.toString(),

    // Witness/private inputs
    sid_w: sid.toString(),
    issuer: issuer.toString(),
    diplomaId: diplomaId.toString(),
    issuedAt: issuedAt.toString(),
  };

  const outPath = path.resolve(__dirname, env.INPUT_PATH || "../circuits/input.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(input, null, 2));

  console.log("✅ Wrote:", outPath);
  console.log("source env     =", layer1EnvPath);
  console.log("proof index    =", proofIndex === null ? "(default)" : proofIndex.toString());
  console.log("sid (prover)   =", PROVER_ADDR);
  console.log("issuer         =", ISSUER_ADDR);
  console.log("diplomaId seed =", diplomaIdSeed);
  console.log("issuedAt       =", issuedAt.toString());
  console.log("C =", input.C);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
