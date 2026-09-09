#!/usr/bin/env bash
# Run several suites CONCURRENTLY, repeatedly — the condition that produces the false failures.
# Usage: stress.sh <rounds> <suite> [suite...]
cd "E:/School Managment System/backend" || exit 1
rounds=$1; shift
out=$(mktemp -d)
declare -A red
for s in "$@"; do red[$s]=0; done
for r in $(seq 1 "$rounds"); do
  pids=()
  for s in "$@"; do
    node "scripts/verify-$s.js" > "$out/$s-$r.txt" 2>&1 &
    pids+=("$!:$s")
  done
  for p in "${pids[@]}"; do
    pid=${p%%:*}; s=${p##*:}
    if ! wait "$pid"; then red[$s]=$(( ${red[$s]} + 1 )); fi
  done
  printf 'round %s done\n' "$r"
done
echo "════════════════════════════════════════"
total=0
for s in "$@"; do
  n=${red[$s]}
  total=$(( total + n ))
  printf '%-22s %s/%s RED\n' "verify-$s.js" "$n" "$rounds"
  if [ "$n" != "0" ]; then
    grep -h '^FAIL' "$out"/$s-*.txt 2>/dev/null | sort -u | head -4 | sed 's/^/      /'
  fi
done
echo "TOTAL RED: $total across $(( rounds * $# )) runs"
