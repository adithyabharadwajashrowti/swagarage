#!/usr/bin/env bash
# Load test on a throwaway local PostgreSQL: 5,000 products, 3,000 clients,
# concurrent anonymous browsing + quote submissions, all through RLS.
# Usage: scripts/load-test.sh [clients=50] [seconds=20]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(dirname "$(command -v initdb || echo /usr/lib/postgresql/16/bin/initdb)")}"
C="${1:-50}"; T="${2:-20}"
TMP="$(mktemp -d)"; PORT=54331; RUNAS=""
if [ "$(id -u)" = "0" ]; then useradd -m pgtest 2>/dev/null || true; chown -R pgtest "$TMP"; RUNAS="runuser -u pgtest --"; fi
cleanup() { $RUNAS "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
$RUNAS "$PGBIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
$RUNAS "$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses='' -c max_connections=200 -c shared_buffers=256MB" -l "$TMP/log" start >/dev/null
PSQL=(psql -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -f "$ROOT/supabase/tests/00_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f"; done
"${PSQL[@]}" -f "$ROOT/supabase/seed.sql"
"${PSQL[@]}" -f "$ROOT/supabase/tests/load/00_scale.sql"
"${PSQL[@]}" -c "select count(*) as live_products from public.products where status='live'"
L="$ROOT/supabase/tests/load"
B=("$PGBIN/pgbench" -h "$TMP" -p "$PORT" -U postgres -n -c "$C" -j 2 -T "$T" postgres)
echo "== OLD: raw catalogue query (anonymous, 1000 rows with joins)"; "${B[@]}" -f "$L/catalogue.sql" | grep -E "tps|latency average|failed"
echo "== NEW: catalogue snapshot, first visit (all products)"; "${B[@]}" -f "$L/snapshot.sql" | grep -E "tps|latency average|failed"
echo "== NEW: catalogue version check, repeat visit"; "${B[@]}" -f "$L/version.sql" | grep -E "tps|latency average|failed"
"${PSQL[@]}" -c "select pg_size_pretty(pg_column_size(payload)::bigint) as snapshot_size_compressed, pg_size_pretty(length(payload::text)::bigint) as snapshot_json_size, jsonb_array_length(payload->'products') as products from public.catalogue_state"
echo "== product page (anonymous)";                   "${B[@]}" -f "$L/product.sql"   | grep -E "tps|latency average|failed"
echo "== submit quote (signed in)";                   "${B[@]}" -f "$L/submit.sql"    | grep -E "tps|latency average|failed"
echo "== account page (signed in)";                   "${B[@]}" -f "$L/myquotes.sql"  | grep -E "tps|latency average|failed"
echo "== mixed: 55% product, 20% repeat visit, 10% first visit, 10% account, 5% submit"
"${B[@]}" -f "$L/product.sql@55" -f "$L/version.sql@20" -f "$L/snapshot.sql@10" -f "$L/myquotes.sql@10" -f "$L/submit.sql@5" | grep -E "tps|latency average|failed"
"${PSQL[@]}" -c "select count(*) as quotes, count(distinct user_id) as clients, max(c) as max_per_client from (select user_id, count(*) over (partition by user_id) c from public.quotes) x"
if [ -n "${EXPLAIN:-}" ]; then
  "${PSQL[@]}" -c "begin; select set_config('request.jwt.claims','{\"role\":\"anon\"}',true); set local role anon; explain (analyze, buffers, costs off) select * from public.products where status='live' order by name limit 1000; rollback;"
fi
