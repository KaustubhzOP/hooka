#!/usr/bin/env bash
# Runs the migration (twice, to check it is re-runnable) and the database tests
# against a throw-away Postgres database. Usage: supabase/tests/run.sh [psql args…]
set -euo pipefail
cd "$(dirname "$0")/../.."
PSQL=(psql -v ON_ERROR_STOP=1 -q "$@")
"${PSQL[@]}" -d postgres -c "drop database if exists hookah_test" -c "create database hookah_test"
"${PSQL[@]}" -d hookah_test -f supabase/tests/supabase_stub.sql
for f in supabase/migrations/*.sql; do "${PSQL[@]}" -d hookah_test -f "$f"; "${PSQL[@]}" -d hookah_test -f "$f"; done
"${PSQL[@]}" -d hookah_test -f supabase/tests/db_test.sql
