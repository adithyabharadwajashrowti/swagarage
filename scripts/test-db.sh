#!/usr/bin/env bash
# Runs all migrations and the security test-suite against a throwaway local
# PostgreSQL 15+/16 instance (no Supabase needed). Usage: scripts/test-db.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(dirname "$(command -v initdb || echo /usr/lib/postgresql/16/bin/initdb)")}"
TMP="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
RUNAS=""
if [ "$(id -u)" = "0" ]; then useradd -m pgtest 2>/dev/null || true; chown -R pgtest "$TMP"; RUNAS="runuser -u pgtest --"; fi
cleanup() { $RUNAS "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
$RUNAS "$PGBIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
$RUNAS "$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" start >/dev/null
PSQL=(psql -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -f "$ROOT/supabase/tests/00_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do echo "migrate: $(basename "$f")"; "${PSQL[@]}" -f "$f"; done
if [ "${WITH_SEED:-0}" = "1" ]; then
  echo "seed"; "${PSQL[@]}" -f "$ROOT/supabase/seed.sql"
  "${PSQL[@]}" -c "select (select count(*) from public.products) products, (select count(*) from public.vendor_offers) offers, (select count(*) from public.product_collections) collection_links, (select count(*) from public.vendors) vendors, (select count(*) from public.products where status='review') in_review"
  exit 0
fi
for f in "$ROOT"/supabase/tests/[123]*.sql; do echo "test: $(basename "$f")"; "${PSQL[@]}" -f "$f"; done
# Race test: 30 parallel submits by one client must not beat the 10-per-day limit.
"$PGBIN/pgbench" -h "$TMP" -p "$PORT" -U postgres -n -c 30 -j 2 -t 1 -f "$ROOT/supabase/tests/load/race.sql" postgres >/dev/null 2>&1 || true
N=$("${PSQL[@]}" -tAc "select count(*) from public.quotes q join test.users u on u.id = q.user_id where u.name = 'client2'")
if [ "$N" -gt 10 ]; then echo "FAIL race: client2 got $N quotes in parallel (limit 10)"; exit 1; fi
echo "race test: $N/10 quotes accepted under 30 parallel requests"
echo 'ALL DATABASE TESTS PASSED'
