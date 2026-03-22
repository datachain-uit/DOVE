# DOVE

DOVE is an EVM-native privacy-preserving diploma verification protocol built around Groth16 proofs and a transcript-bound Proof of Possession (PoP) signature. The implementation in this repository focuses on two parts:

- the Layer1 smart contracts and Sepolia benchmarking workflow
- the zkSNARK circuit and proof-generation utilities

The core idea is simple: a valid zero-knowledge proof alone is not enough. In DOVE, the prover must also sign a transcript that ties the proof to a specific verifier, session, and validity window. The verifier contract then checks those conditions on-chain before accepting the presentation.

## Project Overview

DOVE is designed to support privacy-preserving diploma verification on Ethereum while still enforcing the properties that matter in practice:

- ownership-bound presentation through transcript-bound PoP signatures
- audience binding to the intended verifier
- session binding through nonce and expiration checks
- replay protection through request consumption
- revocation awareness through on-chain registry state

This repository is organized as an implementation-first codebase for the on-chain workflow and the zk proof pipeline used in the experiments.

## Key Features

- Groth16-based hidden-statement verification for diploma commitments
- Transcript-bound PoP signature tied to proof, verifier, session, and validity window
- On-chain checks for verifier binding, freshness, replay control, and revocation status
- DOVE vs noPoP benchmarking on Ethereum Sepolia
- Replay and failure-case scripts for changed-session and changed-verifier scenarios

## System Architecture

The protocol has three main actors: Issuer, Prover, and Verifier.

- The issuer registers a diploma commitment in `DiplomaRegistry`.
- The prover generates a Groth16 proof and signs a transcript over the proof and verification context.
- The verifier submits the presentation to `DoveVerifier`.
- The verifier contract checks registry state, freshness, replay status, PoP validity, and the Groth16 proof on-chain.

Core contracts:

- `Layer1/contracts/DiplomaRegistry.sol`
- `Layer1/contracts/DoveVerifier.sol`
- `Layer1/contracts/NoPoPVerifier.sol`
- `Layer1/contracts/Groth16Verifier.sol`

## Repository Structure

```text
DOVE/
├── README.md                # Root overview and run instructions
├── Layer1/                  # Solidity contracts, Hardhat config, deploy/benchmark scripts
│   ├── contracts/
│   ├── scripts/
│   ├── zkp/
│   ├── hardhat.config.js
│   ├── package.json
│   └── README.md
└── zkSnark/                 # Circom circuit, proof-generation scripts, local zk workflow
    ├── circuits/
    ├── scripts/
    ├── Dockerfile
    ├── package.json
    └── README.md
```

## Quick Start

### Prerequisites

- Node.js 18+
- npm
- a Sepolia RPC endpoint
- funded Sepolia accounts for deployer, issuer, prover, and verifier
- `circom` and `snarkjs` for the zk workflow

### Install dependencies

```bash
cd zkSnark
npm install

cd ../Layer1
npm install
```

### Configure environment

Create `Layer1/.env` from `Layer1/.env.example`:

```bash
cp Layer1/.env.example Layer1/.env
```

Important variables:

- `SEPOLIA_RPC_URL`
- `PRIVATE_KEY`
- `PRIVATE_KEY_ISSUER`
- `PRIVATE_KEY_PROVER`
- `PRIVATE_KEY_VERIFIER`
- `PRIVATE_KEY_OWNER`

## Reproduce Experiments

### 1. Prepare proof artifacts

The zk workflow lives in `zkSnark/`. The Layer1 benchmark expects proof/public-input JSON files under `Layer1/zkp/batch/`.

Basic setup:

```bash
cd zkSnark
node scripts/make_input.js

mkdir -p build/circuits
circom circuits/diploma_trust.circom --r1cs --wasm --sym -o build/circuits
```

Then run the Groth16 setup and proof generation flow described in `zkSnark/README.md`.

### 2. Deploy contracts on Sepolia

```bash
cd Layer1
npx hardhat run scripts/l1_deploy_compare_pop.js --network sepolia
```

This deploys:

- `DiplomaRegistry`
- `Groth16Verifier`
- `DoveVerifier`
- `NoPoPVerifier`

### 3. Run the DOVE vs noPoP benchmark

```bash
cd Layer1
HARDHAT_NETWORK=sepolia node scripts/bench_l1_compare_pop.js 20
```

This benchmark reports:

- verification status
- verification time
- gas used
- gas price
- gas cost

### 4. Run replay and failure cases

```bash
cd Layer1
HARDHAT_NETWORK=sepolia node scripts/l1_fail_cases.js
```

This script exercises failure scenarios such as replay under a changed verification context.

## Results Summary

Current Sepolia benchmark results:

- DOVE average gas used: `272,951`
- noPoP average gas used: `262,700`
- Additional DOVE cost over noPoP: `10,251` gas
- Relative overhead: approximately `3.90%`
- Security behavior: DOVE rejects copied-proof reuse under fresh-nonce and cross-verifier scenarios, while noPoP accepts the same copied proof when the underlying statement still verifies

These results show the on-chain cost of adding transcript-bound ownership and context binding on top of the same verification workflow.

## Tech Stack

- Solidity
- Hardhat
- Ethers.js
- Groth16
- Circom
- snarkjs
- Ethereum Sepolia

## Notes

This repository is intentionally implementation-focused. Some generated proof artifacts are included because they are used directly in the benchmark and failure-case workflows.
