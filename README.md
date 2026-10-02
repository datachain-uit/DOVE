# DOVE

DOVE is an EVM-native privacy-preserving diploma verification protocol built around Groth16 proofs and a transcript-bound Proof of Possession (PoP) signature. The implementation in this repository focuses on two parts:

- the on-chain smart contracts and Sepolia benchmarking workflow
- the zkSNARK circuit and proof-generation utilities

The core idea is simple: a valid zero-knowledge proof alone is not enough. In DOVE, the prover must also sign a transcript that ties the proof to a specific verifier, session, and validity window. The verifier contract then checks those conditions on-chain before accepting the presentation.

## Project Overview

DOVE is designed to support privacy-preserving diploma verification on Ethereum while still enforcing the properties that matter in practice:

- ownership-bound presentation through transcript-bound PoP signatures
- audience binding to the intended verifier
- session binding through nonce and expiration checks
- replay protection through request consumption
- revocation awareness through on-chain registry state
- controlled `ZKOnly` and `noPoP` ablations for isolating the cost of proof validity, session/replay checks, and transcript-bound ownership

This repository is organized as an implementation-first codebase for the on-chain workflow and the zk proof pipeline used in the experiments.

## Key Features

- Groth16-based hidden-statement verification for diploma commitments
- Transcript-bound PoP signature tied to proof, verifier, session, and validity window
- On-chain checks for verifier binding, freshness, replay control, and revocation status
- DOVE vs noPoP vs ZKOnly benchmarking on Ethereum Sepolia
- Replay and failure-case scripts for changed-session and changed-verifier scenarios

## System Architecture

The protocol has three main actors: Issuer, Prover, and Verifier.

- The issuer registers a diploma commitment in `DiplomaRegistry`.
- The prover generates a Groth16 proof and signs a transcript over the proof and verification context.
- The verifier submits the presentation to `DoveVerifier`.
- The verifier contract checks registry state, freshness, replay status, PoP validity, and the Groth16 proof on-chain.

Core contracts:

- `onchain/contracts/DiplomaRegistry.sol`
- `onchain/contracts/DoveVerifier.sol`
- `onchain/contracts/NoPoPVerifier.sol`
- `onchain/contracts/ZKOnlyVerifier.sol`
- `onchain/contracts/Groth16Verifier.sol`

## Repository Structure

```text
DOVE/
├── README.md                # Root overview and run instructions
├── onchain/                 # Solidity contracts, Hardhat config, deploy/benchmark scripts
│   ├── contracts/
│   ├── scripts/
│   │   └── lib/              # Shared script helpers
│   ├── test/                # Local helper regression checks
│   ├── zkp/
│   ├── hardhat.config.js
│   ├── package.json
│   └── README.md
└── zk/                      # Circom circuit, proof-generation scripts, local zk workflow
    ├── circuits/
    ├── scripts/
    ├── Dockerfile
    ├── package.json
    └── README.md
```

Workspace instructions are in [onchain/README.md](onchain/README.md) and [zk/README.md](zk/README.md). Commands starting with `cd onchain` or `cd zk` below assume the repository root.

## Quick Start

### Prerequisites

- Node.js 18+
- npm
- a Sepolia RPC endpoint
- funded Sepolia accounts for deployer, issuer, prover, and verifier
- `circom` and `snarkjs` for the zk workflow

### Install dependencies

```bash
cd zk
npm install

cd ../onchain
npm install
```

### Configure environment

Create `onchain/.env` from `onchain/.env.example`:

```bash
cp onchain/.env.example onchain/.env
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

The zk workflow lives in `zk/`. The on-chain benchmark expects proof/public-input JSON files under `onchain/zkp/batch/`.

Basic setup:

```bash
cd zk
node scripts/make_input.js

mkdir -p build/circuits
circom circuits/diploma_trust.circom --r1cs --wasm --sym -o build/circuits
```

Then run the Groth16 setup and proof generation flow described in [zk/README.md](zk/README.md), including `node scripts/gen_batch_proofs.js 100` for the independent-holder benchmark batch.

### 2. Deploy contracts on Sepolia

```bash
cd onchain
npx hardhat run scripts/l1_deploy_compare_pop.js --network sepolia
```

This deploys:

- `DiplomaRegistry`
- `Groth16Verifier`
- `DoveVerifier`
- `NoPoPVerifier`
- `ZKOnlyVerifier`

### 3. Run the DOVE vs noPoP vs ZKOnly benchmark

```bash
cd onchain
HARDHAT_NETWORK=sepolia node scripts/bench_l1_compare_pop.js 100
```

This benchmark reports:

- verification status
- verification time
- gas used
- gas price
- gas cost

### 4. Run replay and failure cases

```bash
cd onchain
HARDHAT_NETWORK=sepolia node scripts/l1_fail_cases.js
```

This script exercises failure scenarios such as replay under a changed verification context.

## Results Summary

Benchmark and deployment output is written to `onchain/results/`, with separate CSV files for `dove`, `nopop`, and `zkonly` plus JSON summaries.

Existing result files were moved with the workspace without rewriting their contents. Historical metadata may therefore contain the former workspace paths.

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

## Contributors

- **Leader**: M.Sc. IT. Khoa Tan VO
- **Members**: Anh-Vu Duong, Duc-Manh Chau
