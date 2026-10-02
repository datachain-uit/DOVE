#!/usr/bin/env bash
set -euo pipefail

N=${1:-10}
node scripts/gen_batch_proofs.js "$N"
