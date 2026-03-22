#!/usr/bin/env bash
set -euo pipefail

N=${1:-10}

WASM="build/circuits/diploma_trust_js/diploma_trust.wasm"
ZKEY="build/circuits/keys/diploma_trust_final.zkey"
OUT_DIR="${OUT_DIR:-build/batch}"
LAYER1_BATCH_DIR="${LAYER1_BATCH_DIR:-../Layer1/zkp/batch}"
SEED_PREFIX="${SEED_PREFIX:-DIPLOMA-2026}"
ISSUED_AT_BASE="${ISSUED_AT_BASE:-1760000000}"

if command -v snarkjs >/dev/null 2>&1; then
  SNARKJS=(snarkjs)
else
  SNARKJS=(npx snarkjs)
fi

mkdir -p "$OUT_DIR"

for i in $(seq 1 $N); do
  echo "=== Round $i ==="

  export PROOF_INDEX="$i"
  export DIPLOMA_ID_SEED="${SEED_PREFIX}-$(printf '%04d' "$i")"
  export ISSUED_AT="$((ISSUED_AT_BASE + i))"
  node scripts/make_input.js

  node build/circuits/diploma_trust_js/generate_witness.js \
    "$WASM" circuits/input.json "$OUT_DIR/witness_$i.wtns"

  "${SNARKJS[@]}" groth16 prove \
    "$ZKEY" "$OUT_DIR/witness_$i.wtns" \
    "$OUT_DIR/proof_$i.json" "$OUT_DIR/public_$i.json"
done

mkdir -p "$LAYER1_BATCH_DIR"
cp "$OUT_DIR"/proof_*.json "$OUT_DIR"/public_*.json "$OUT_DIR"/witness_*.wtns "$LAYER1_BATCH_DIR"/

echo "✅ Generated $N distinct proof batches in $OUT_DIR/"
echo "✅ Synced batches to $LAYER1_BATCH_DIR/"
