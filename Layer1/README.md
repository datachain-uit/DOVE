# Layer1

This workspace contains the Solidity contracts, Hardhat configuration, deployment scripts, and benchmarking scripts used to evaluate DOVE on Ethereum Sepolia.

The focus here is the on-chain comparison between:

- `DoveVerifier`: transcript-bound PoP verification
- `NoPoPVerifier`: ablation baseline without PoP verification

## Purpose

The Layer1 workflow is used to:

- deploy the DOVE contract stack on Sepolia
- benchmark DOVE against the noPoP baseline
- test replay and failure cases under changed verification contexts

## Install

```bash
cd Layer1
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
- `L1_GROTH16_ADDR`

## Main Contracts

- `contracts/DiplomaRegistry.sol`
- `contracts/DoveVerifier.sol`
- `contracts/NoPoPVerifier.sol`
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

After deployment, save the printed addresses if you want to reuse the same deployment for later runs.

Run the DOVE vs noPoP benchmark:

```bash
HARDHAT_NETWORK=sepolia node scripts/bench_l1_compare_pop.js 20
```

Run replay and failure cases:

```bash
HARDHAT_NETWORK=sepolia node scripts/l1_fail_cases.js
```

## Benchmark Inputs

The benchmark uses proof/public-input batches stored under:

- `zkp/batch/`

These files are produced from the zk workflow in `../zkSnark/` and consumed by the Layer1 scripts during deployment and benchmarking.

## Output

The benchmark scripts report:

- transaction status
- verification time
- gas used
- gas price
- gas cost

This makes the Layer1 workspace the main entry point for reproducing the Sepolia measurements reported for DOVE.
