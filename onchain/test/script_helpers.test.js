const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");
const fixture = require("./fixtures/script_refactor.json");
const protocol = require("../scripts/lib/protocol");
const inputs = require("../scripts/lib/inputs");
const config = require("../scripts/lib/config");
const io = require("../scripts/lib/io");
const results = require("../scripts/lib/results");
const { BATCH_DIR, DEFAULT_MANIFEST } = require("../scripts/lib/paths");

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("Script helper refactor", function () {
  let tempDir;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dove-script-test-"));
  });

  afterEach(function () {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("preserves the snarkjs coordinate order and public-input conversion", function () {
    assert.deepEqual(protocol.proofStructFromJson(fixture.proof), fixture.proofStruct);
    assert.equal(protocol.toHex32(fixture.publicInputs[0]), fixture.context.C);
    assert.equal(protocol.toAddressFromUint(fixture.publicInputs[1]), fixture.context.sid);
  });

  it("matches proof hash, transcript hash and signature captured before extraction", async function () {
    assert.equal(protocol.buildProofHash(fixture.proofStruct), fixture.proofHash);
    assert.equal(protocol.buildTranscriptHash(fixture.context, fixture.proofStruct), fixture.transcriptHash);
    const holder = new hre.ethers.Wallet(fixture.holderPrivateKey);
    assert.equal(await protocol.signPoP(holder, fixture.context, fixture.proofStruct), fixture.signature);
    assert.equal(hre.ethers.verifyMessage(hre.ethers.getBytes(fixture.transcriptHash), fixture.signature), holder.address);
  });

  it("preserves calldata for all three verifier entrypoints", async function () {
    for (const [name, method] of [
      ["DoveVerifier", "verifyAndConsume"],
      ["NoPoPVerifier", "verifyAndConsumeNoPoP"],
      ["ZKOnlyVerifier", "verifyZKOnly"],
    ]) {
      const iface = new hre.ethers.Interface((await hre.artifacts.readArtifact(name)).abi);
      const args = [fixture.context, fixture.proofStruct];
      if (name === "DoveVerifier") args.push(fixture.signature);
      assert.equal(hre.ethers.keccak256(iface.encodeFunctionData(method, args)), fixture.calldataHashes[name]);
    }
  });

  it("keeps the same batch shapes for benchmark and failure-case callers", function () {
    const files = new Map([
      [path.join(BATCH_DIR, "proof_7.json"), JSON.stringify(fixture.proof)],
      [path.join(BATCH_DIR, "public_7.json"), JSON.stringify(fixture.publicInputs)],
      [DEFAULT_MANIFEST, JSON.stringify({
        instances: [{ id: 7, holderPrivateKey: fixture.holderPrivateKey }],
      })],
    ]);
    const readFile = fs.readFileSync;
    const readDir = fs.readdirSync;
    const exists = fs.existsSync;
    try {
      fs.readFileSync = (file, ...args) => files.has(file) ? files.get(file) : readFile(file, ...args);
      fs.readdirSync = (dir, ...args) => dir === BATCH_DIR ? ["proof_7.json", "public_7.json"] : readDir(dir, ...args);
      fs.existsSync = (file) => files.has(file) || exists(file);
      const round = inputs.loadBatchRound(7);
      assert.deepEqual(round, {
        round: 7, C: fixture.context.C, sid: fixture.context.sid, proofStruct: fixture.proofStruct,
      });
      const loaded = inputs.loadInstances(1);
      assert.deepEqual(loaded.batchIds, [7]);
      assert.equal(loaded.instances[0].holder.address, fixture.context.sid);
      assert.deepEqual(loaded.instances[0].proofStruct, round.proofStruct);
    } finally {
      fs.readFileSync = readFile;
      fs.readdirSync = readDir;
      fs.existsSync = exists;
    }
  });

  it("preserves deployment-file precedence over environment addresses", function () {
    const file = path.join(tempDir, "deployment.json");
    const addresses = Object.fromEntries([
      "L1_REGISTRY_ADDR", "L1_GROTH16_ADDR", "L1_ENFORCER_ADDR",
      "L1_ENFORCER_NOPOP_ADDR", "L1_ENFORCER_ZKONLY_ADDR",
    ].map((key, i) => [key, hre.ethers.toBeHex(i + 1, 20)]));
    fs.writeFileSync(file, JSON.stringify({ addresses }));
    withEnv({ L1_DEPLOYMENT_FILE: file, L1_REGISTRY_ADDR: fixture.context.aud }, () => {
      assert.deepEqual(config.loadDeploymentAddresses(), { addresses, source: file });
    });
  });

  it("derives the same five verifier addresses from the same seed", function () {
    const env = {
      PRIVATE_KEYS_VERIFIERS: undefined, VERIFIER_PRIVATE_KEYS: undefined,
      PRIVATE_KEY_VERIFIER: fixture.holderPrivateKey,
    };
    for (let i = 1; i <= 5; i++) env[`PRIVATE_KEY_VERIFIER_${i}`] = undefined;
    withEnv(env, () => {
      assert.deepEqual(config.loadVerifierWallets(5).map((wallet) => wallet.address), fixture.verifierAddresses);
    });
  });

  it("preserves CSV quoting and string values when reloading results", function () {
    const file = path.join(tempDir, "results.csv");
    const rows = [{ status: "SUCCESS", error: 'comma, "quotes"', gasUsed: 123n, absent: null }];
    io.writeCsv(file, rows);
    assert.equal(fs.readFileSync(file, "utf8"), 'status,error,gasUsed,absent\nSUCCESS,"comma, ""quotes""",123,\n');
    assert.deepEqual(io.readCsv(file), [{ status: "SUCCESS", error: 'comma, "quotes"', gasUsed: "123", absent: "" }]);
  });

  it("preserves the two entrypoints' existing empty and null CSV semantics", function () {
    const file = path.join(tempDir, "deployment.csv");
    fs.writeFileSync(file, "previous");
    io.writeDeploymentCsv(file, []);
    assert.equal(fs.readFileSync(file, "utf8"), "previous");
    io.writeDeploymentCsv(file, [{ a: null, b: undefined }]);
    assert.equal(fs.readFileSync(file, "utf8"), "a,b\nnull,undefined\n");
    io.writeCsv(file, [{ a: null, b: undefined }]);
    assert.equal(fs.readFileSync(file, "utf8"), "a,b\n,\n");
    io.writeCsv(file, []);
    assert.equal(fs.readFileSync(file, "utf8"), "");
  });

  it("preserves success filtering, population deviation and integer fee averaging", function () {
    const rows = [
      { status: "SUCCESS", gasUsed: "100", timeSec: 1, gasCostEth: "0.000000000000000001" },
      { status: "ERROR", gasUsed: "900", timeSec: 9, gasCostEth: "0.000000000000000009" },
      { status: "SUCCESS", gasUsed: "104", timeSec: 3, gasCostEth: "0.000000000000000002" },
    ];
    assert.deepEqual(results.summarizeRows(rows), {
      rounds: 3, success: 2,
      gas: { avg: 102, min: 100, max: 104, std: 2 },
      time: { avg: 2, min: 1, max: 3, std: 1 },
      gasCostEthTotal: "0.000000000000000003",
      gasCostEthAvg: "0.000000000000000001",
    });
    assert.deepEqual(results.summarizeRows([rows[1]]), {
      rounds: 1, success: 0, gas: null, time: null,
      gasCostEthTotal: "0.0", gasCostEthAvg: "0.0",
    });
  });
});

