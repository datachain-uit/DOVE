const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { readJson } = require("./io");
const { BATCH_DIR, DEFAULT_MANIFEST } = require("./paths");
const { normalizePrivateKey } = require("./config");
const { toHex32, toAddressFromUint, proofStructFromJson } = require("./protocol");

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

function loadManifest() {
  const manifestFile = process.env.BATCH_MANIFEST || DEFAULT_MANIFEST;
  if (!fs.existsSync(manifestFile)) {
    throw new Error(
      `Missing holder manifest: ${manifestFile}. Generate a distinct-sid batch with: cd ../zk && node scripts/gen_batch_proofs.js 100`
    );
  }
  const manifest = readJson(manifestFile);
  const instances = manifest.instances || [];
  const byId = new Map(instances.map((x) => [Number(x.id), x]));
  return { manifestFile, manifest, byId };
}

function loadInstances(N) {
  const batchIds = availableBatchIds();
  if (batchIds.length < N) {
    throw new Error(`Need ${N} proof batches, found ${batchIds.length} in ${BATCH_DIR}`);
  }

  const { manifestFile, manifest, byId } = loadManifest();
  const selected = batchIds.slice(0, N).map((id) => {
    const proof = readJson(path.join(BATCH_DIR, `proof_${id}.json`));
    const pub = readJson(path.join(BATCH_DIR, `public_${id}.json`));
    if (!Array.isArray(pub) || pub.length !== 2) {
      throw new Error(`Invalid public_${id}.json: expected exactly [C, sid]`);
    }

    const C = toHex32(pub[0]);
    const sid = toAddressFromUint(pub[1]);
    const manifestRow = byId.get(id);
    if (!manifestRow) {
      throw new Error(`batch_manifest.json has no holder key for proof id ${id}`);
    }

    const holderPrivateKey = normalizePrivateKey(
      manifestRow.holderPrivateKey || manifestRow.privateKey
    );
    const holder = new hre.ethers.Wallet(holderPrivateKey);
    if (holder.address.toLowerCase() !== sid.toLowerCase()) {
      throw new Error(
        `Holder key mismatch for proof ${id}: manifest=${holder.address}, public sid=${sid}`
      );
    }

    return {
      id,
      C,
      sid,
      holder,
      proofStruct: proofStructFromJson(proof),
    };
  });

  const uniqueC = new Set(selected.map((x) => x.C.toLowerCase()));
  const uniqueSid = new Set(selected.map((x) => x.sid.toLowerCase()));
  if (uniqueC.size !== selected.length) {
    throw new Error(`Expected ${selected.length} unique commitments, got ${uniqueC.size}`);
  }
  if (uniqueSid.size !== selected.length) {
    throw new Error(`Expected ${selected.length} unique sid addresses, got ${uniqueSid.size}`);
  }

  return { instances: selected, manifestFile, manifest, batchIds: selected.map((x) => x.id) };
}

function loadBatchRound(i) {
  const proof = readJson(path.join(BATCH_DIR, `proof_${i}.json`));
  const pub = readJson(path.join(BATCH_DIR, `public_${i}.json`));
  if (!Array.isArray(pub) || pub.length !== 2) {
    throw new Error(`Invalid public_${i}.json`);
  }
  return {
    round: i,
    C: toHex32(pub[0]),
    sid: toAddressFromUint(pub[1]),
    proofStruct: proofStructFromJson(proof),
  };
}

module.exports = {
  availableBatchIds,
  loadManifest,
  loadInstances,
  loadBatchRound,
};
