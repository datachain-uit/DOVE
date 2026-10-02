#!/usr/bin/env bash
set -euo pipefail

N=${1:-10}

WASM="build/circuits/diploma_trust_js/diploma_trust.wasm"
INPUT="circuits/input.json"
ZKEY="build/circuits/keys/diploma_trust_final.zkey"
VK="build/circuits/keys/verification_key.json"

if command -v snarkjs >/dev/null 2>&1; then
  SNARKJS=(snarkjs)
else
  SNARKJS=(npx snarkjs)
fi

for f in "$WASM" "$INPUT" "$ZKEY" "$VK"; do
  if [ ! -f "$f" ]; then
    echo "Missing required file: $f" >&2
    exit 1
  fi
done

LOG_DIR="build/bench_logs"
mkdir -p "$LOG_DIR"

now_ns() {
  node -e 'process.stdout.write(process.hrtime.bigint().toString())'
}

elapsed_s() {
  local start_ns="$1"
  local end_ns="$2"
  node -e '
const s = BigInt(process.argv[1]);
const e = BigInt(process.argv[2]);
process.stdout.write(((Number(e - s)) / 1e9).toFixed(6));
' "$start_ns" "$end_ns"
}

run_timed() {
  local round="$1"
  local phase="$2"
  shift 2

  local stdout_log="$LOG_DIR/round_${round}_${phase}.stdout.log"
  local stderr_log="$LOG_DIR/round_${round}_${phase}.stderr.log"
  local start_ns end_ns elapsed rc

  start_ns=$(now_ns)
  set +e
  "$@" >"$stdout_log" 2>"$stderr_log"
  rc=$?
  set -e
  end_ns=$(now_ns)

  elapsed=$(elapsed_s "$start_ns" "$end_ns")
  echo "$elapsed $rc"
}

sum_w=0; sum_p=0; sum_v=0
min_w=999999; min_p=999999; min_v=999999
max_w=0; max_p=0; max_v=0

echo "Running bench $N rounds..."
echo "Logs are saved at: $LOG_DIR/"
echo "Round | witness(s)/rc | prove(s)/rc | verify(s)/rc"
echo "---------------------------------------------------"

for i in $(seq 1 $N); do
  # witness
  read -r tw rcw <<<"$(run_timed "$i" witness node build/circuits/diploma_trust_js/generate_witness.js "$WASM" "$INPUT" build/witness.wtns)"
  # prove
  read -r tp rcp <<<"$(run_timed "$i" prove "${SNARKJS[@]}" groth16 prove "$ZKEY" build/witness.wtns build/proof.json build/public.json)"
  # verify
  read -r tv rcv <<<"$(run_timed "$i" verify "${SNARKJS[@]}" groth16 verify "$VK" build/public.json build/proof.json)"

  printf "%5d | %9s/%-2s | %8s/%-2s | %9s/%-2s\n" "$i" "$tw" "$rcw" "$tp" "$rcp" "$tv" "$rcv"

  if [ "$rcw" -ne 0 ] || [ "$rcp" -ne 0 ] || [ "$rcv" -ne 0 ]; then
    echo "Round $i has non-zero return code. Check logs in $LOG_DIR." >&2
  fi

  sum_w=$(awk -v a="$sum_w" -v b="$tw" 'BEGIN{printf "%.6f", a+b}')
  sum_p=$(awk -v a="$sum_p" -v b="$tp" 'BEGIN{printf "%.6f", a+b}')
  sum_v=$(awk -v a="$sum_v" -v b="$tv" 'BEGIN{printf "%.6f", a+b}')

  min_w=$(awk -v a="$min_w" -v b="$tw" 'BEGIN{printf "%.6f", (a<b?a:b)}')
  min_p=$(awk -v a="$min_p" -v b="$tp" 'BEGIN{printf "%.6f", (a<b?a:b)}')
  min_v=$(awk -v a="$min_v" -v b="$tv" 'BEGIN{printf "%.6f", (a<b?a:b)}')

  max_w=$(awk -v a="$max_w" -v b="$tw" 'BEGIN{printf "%.6f", (a>b?a:b)}')
  max_p=$(awk -v a="$max_p" -v b="$tp" 'BEGIN{printf "%.6f", (a>b?a:b)}')
  max_v=$(awk -v a="$max_v" -v b="$tv" 'BEGIN{printf "%.6f", (a>b?a:b)}')
done

avg_w=$(awk -v s="$sum_w" -v n="$N" 'BEGIN{printf "%.6f", s/n}')
avg_p=$(awk -v s="$sum_p" -v n="$N" 'BEGIN{printf "%.6f", s/n}')
avg_v=$(awk -v s="$sum_v" -v n="$N" 'BEGIN{printf "%.6f", s/n}')

echo ""
echo "===== SUMMARY over $N rounds ====="
echo "witness: avg=${avg_w}s  min=${min_w}s  max=${max_w}s"
echo "prove  : avg=${avg_p}s  min=${min_p}s  max=${max_p}s"
echo "verify : avg=${avg_v}s  min=${min_v}s  max=${max_v}s"
