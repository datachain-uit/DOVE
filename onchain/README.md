# Onchain

This workspace contains the Solidity contracts, Hardhat configuration, deployment scripts, and benchmarking scripts used to evaluate DOVE on Ethereum Sepolia.

The focus here is the on-chain comparison between:

- `DoveVerifier`: transcript-bound PoP verification
- `NoPoPVerifier`: ablation baseline without PoP verification
- `ZKOnlyVerifier`: proof-validity baseline without PoP, audience/session binding, expiration, or replay consumption

## Purpose

The on-chain workflow is used to:

- deploy the DOVE contract stack on Sepolia
- benchmark DOVE against the noPoP and ZKOnly baselines
- test replay and failure cases under changed verification contexts

## Install

```bash
cd onchain
npm install
```

## Environment Configuration

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Important variables:

- `SEPOLIA_RPC_URL` or `RPC_URL`
- `PRIVATE_KEY` for the deployer / default owner
- `PRIVATE_KEY_ISSUER`
- `PRIVATE_KEY_PROVER`
- `PRIVATE_KEY_VERIFIER`
- `PRIVATE_KEY_OWNER`

Optional deployed addresses:

- `L1_REGISTRY_ADDR`
- `L1_ENFORCER_ADDR`
- `L1_ENFORCER_NOPOP_ADDR`
- `L1_ENFORCER_ZKONLY_ADDR`
- `L1_GROTH16_ADDR`

## Main Contracts

- `contracts/DiplomaRegistry.sol`
- `contracts/DoveVerifier.sol`
- `contracts/NoPoPVerifier.sol`
- `contracts/ZKOnlyVerifier.sol`
- `contracts/Groth16Verifier.sol`

## Common Commands

Compile contracts:

```bash
npx hardhat compile
```

Deploy the benchmark stack on Sepolia:

```bash
npx hardhat run scripts/l1_deploy_compare_pop.js --network sepolia
```

The deployment script writes `results/latest-deployment.json`. The benchmark uses this file when the complete set of addresses is not provided through environment variables; `L1_DEPLOYMENT_FILE` selects an explicit deployment JSON file.

Run the DOVE vs noPoP vs ZKOnly benchmark:

```bash
HARDHAT_NETWORK=sepolia node scripts/bench_l1_compare_pop.js 100
```

Run replay and failure cases:

```bash
HARDHAT_NETWORK=sepolia node scripts/l1_fail_cases.js
```

## Benchmark Inputs

The benchmark uses proof/public-input batches stored under:

- `zkp/batch/`

These files are produced from the zk workflow in [../zk/README.md](../zk/README.md) and consumed by the on-chain scripts during benchmarking.
For the full DOVE benchmark, `zkp/batch/batch_manifest.json` is also required because it stores the generated holder key for each distinct `sid_i`; this lets the benchmark sign one transcript per proof.

## Output

The benchmark scripts report:

- transaction status
- verification time
- gas used
- gas price
- gas cost

Deployment and benchmark runs are written under:

- `results/deploy_*/deployment.json`
- `results/deploy_*/deployment.csv`
- `results/bench_*/dove.csv`
- `results/bench_*/nopop.csv`
- `results/bench_*/zkonly.csv`
- `results/bench_*/summary.json`

This makes the onchain workspace the main entry point for reproducing the Sepolia measurements reported for DOVE. Previously recorded result files retain their original contents, including historical workspace paths in metadata.

The existing `L1_*` environment-variable names and script filenames remain supported.

## Script Organization

The three existing script entrypoints use shared helpers under `scripts/lib/`:

| Module | Responsibility |
| --- | --- |
| `protocol.js` | Public-input conversion, proof encoding, transcript hashing, and PoP signing |
| `inputs.js` | Proof/public-input batches and holder manifests |
| `config.js` | Deployment-address selection and verifier-wallet configuration |
| `io.js` | JSON reads, timestamps, directories, and existing CSV formats |
| `results.js` | Benchmark statistics and result exports |
| `rpc.js` | Existing RPC retry policy |
| `paths.js` | Shared artifact paths |

This extraction preserves the original CLI, scenario order, nonce allocation, transaction payloads, timing boundaries, and summary calculations. Contracts, circuit, and previously recorded experiment artifacts are unchanged. Corrections to measurement or failure-case behavior are separate from this refactor.

Run the local helper regression checks with:

```bash
npx hardhat test test/script_helpers.test.js
```

The protocol fixtures were captured before extraction. They contain synthetic proof coordinates and a public test key, and check serialization and signing rather than Groth16 proof validity.
