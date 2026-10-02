# ZK

This workspace contains the Circom circuit and proof-generation utilities used by DOVE.

The current circuit exposes the public inputs:

- `C`
- `sid`

where `C` is the diploma commitment and `sid` is the prover address encoded as a field element.

## Purpose

The zk workflow is used to:

- generate input data for the circuit
- compile the Circom circuit
- run the Groth16 setup
- generate witness, proof, and public-input artifacts
- produce batch proof/public-input files for the on-chain benchmark

## Prerequisites

You can use the included `Dockerfile` or install the tools locally.

Required tools:

- `node >= 18`
- `circom`
- `snarkjs`

## Install

```bash
cd zk
npm install
```

## Basic Workflow

### 1. Generate sample input

```bash
node scripts/make_input.js
```

`make_input.js` reads prover and issuer information from `../onchain/.env` when available, computes the Poseidon commitment, and writes the circuit input to:

- `circuits/input.json`

### 2. Compile the circuit

```bash
mkdir -p build/circuits
circom circuits/diploma_trust.circom --r1cs --wasm --sym -o build/circuits
```

### 3. Run Groth16 setup

```bash
mkdir -p build/circuits/keys
snarkjs groth16 setup build/circuits/diploma_trust.r1cs path/to/powersOfTau28_hez_final_10.ptau build/circuits/diploma_trust_0000.zkey
snarkjs zkey contribute build/circuits/diploma_trust_0000.zkey build/circuits/keys/diploma_trust_final.zkey --name="1st Contributor" -v
snarkjs zkey export verificationkey build/circuits/keys/diploma_trust_final.zkey build/circuits/keys/verification_key.json
```

### 4. Generate witness, proof, and public inputs

```bash
node build/circuits/diploma_trust_js/generate_witness.js build/circuits/diploma_trust_js/diploma_trust.wasm circuits/input.json build/witness.wtns
snarkjs groth16 prove build/circuits/keys/diploma_trust_final.zkey build/witness.wtns build/proof.json build/public.json
snarkjs groth16 verify build/circuits/keys/verification_key.json build/public.json build/proof.json
```

`build/public.json` must contain exactly two values in this order:

- `[C, sid]`

## Batch Generation

To generate multiple proof/public-input pairs for the on-chain benchmark:

```bash
node scripts/gen_batch_proofs.js 100
```

By default, the script also copies the generated batch files to:

- `../onchain/zkp/batch/`

The batch generator creates one fresh holder wallet per proof, so every generated instance has a distinct `sid_i`, distinct diploma witness, and distinct commitment `C_i`. It also writes `batch_manifest.json` beside the batch files; the onchain workspace uses that manifest to sign the DOVE transcript with the private key matching each `sid_i`.

The existing `LAYER1_BATCH_DIR` environment variable can still override the destination. Its default is now `../onchain/zkp/batch/`; paths supplied through it are resolved relative to the zk workspace. See [../onchain/README.md](../onchain/README.md) for deployment, benchmarking, and local regression checks.

## Benchmarking the zk Workflow

To benchmark witness generation, proof generation, and proof verification:

```bash
bash scripts/bench_zkp.sh 10
```

This writes logs to:

- `build/bench_logs/`

## Important Files

- `circuits/diploma_trust.circom`
- `scripts/make_input.js`
- `scripts/gen_batch_proofs.js`
- `scripts/gen_10_proofs.sh`
- `scripts/bench_zkp.sh`
