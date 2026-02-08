#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA_DIR="${JAGC_PGDATA_DIR:-$ROOT_DIR/.local/pgdata}"
PGLOG_FILE="${JAGC_PGLOG_FILE:-$ROOT_DIR/.local/postgres.log}"
PGHOST="${JAGC_PGHOST:-127.0.0.1}"
PGPORT="${JAGC_PGPORT:-5432}"
PGUSER="${JAGC_PGUSER:-postgres}"
PGDATABASE="${JAGC_PGDATABASE:-jagc}"

usage() {
  cat <<'EOF'
Usage: scripts/dev-postgres.sh <start|stop|status|createdb|drop-testdb>

Environment overrides:
  JAGC_PGDATA_DIR    (default: .local/pgdata)
  JAGC_PGLOG_FILE    (default: .local/postgres.log)
  JAGC_PGHOST        (default: 127.0.0.1)
  JAGC_PGPORT        (default: 5432)
  JAGC_PGUSER        (default: postgres)
  JAGC_PGDATABASE    (default: jagc)
  JAGC_TEST_DATABASE (default: ${JAGC_PGDATABASE}_test)
EOF
}

ensure_cluster() {
  if [[ -f "$PGDATA_DIR/PG_VERSION" ]]; then
    return
  fi

  mkdir -p "$PGDATA_DIR"
  mkdir -p "$(dirname "$PGLOG_FILE")"

  mise exec postgres@18.1 -- initdb -D "$PGDATA_DIR" -U "$PGUSER" --auth=trust >/dev/null
}

start_postgres() {
  ensure_cluster

  if mise exec postgres@18.1 -- pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
    return
  fi

  mise exec postgres@18.1 -- pg_ctl -D "$PGDATA_DIR" -l "$PGLOG_FILE" -o "-h $PGHOST -p $PGPORT" start >/dev/null
  mise exec postgres@18.1 -- pg_isready -h "$PGHOST" -p "$PGPORT"
}

stop_postgres() {
  if [[ ! -f "$PGDATA_DIR/PG_VERSION" ]]; then
    echo "postgres is not initialized"
    return
  fi

  if ! mise exec postgres@18.1 -- pg_ctl -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    echo "postgres is not running"
    return
  fi

  mise exec postgres@18.1 -- pg_ctl -D "$PGDATA_DIR" stop -m fast >/dev/null
  echo "postgres stopped"
}

postgres_status() {
  mise exec postgres@18.1 -- pg_isready -h "$PGHOST" -p "$PGPORT"
}

create_database() {
  ensure_cluster
  start_postgres

  local db_exists_output
  local database_literal
  database_literal="$(quote_literal "$PGDATABASE")"

  db_exists_output="$(mise exec postgres@18.1 -- psql -X -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -tAc "SELECT 1 FROM pg_database WHERE datname = $database_literal")"

  if [[ "$db_exists_output" == *"1"* ]]; then
    echo "database $PGDATABASE already exists"
    return
  fi

  mise exec postgres@18.1 -- createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$PGDATABASE"
  echo "created database $PGDATABASE"
}

quote_identifier() {
  local value="$1"
  value="${value//\"/\"\"}"
  printf '"%s"' "$value"
}

quote_literal() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

drop_test_databases() {
  ensure_cluster
  start_postgres

  local test_database_base="${JAGC_TEST_DATABASE:-${PGDATABASE}_test}"
  local test_database_base_literal
  test_database_base_literal="$(quote_literal "$test_database_base")"

  local databases
  databases="$(mise exec postgres@18.1 -- psql -X -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -tAc "SELECT datname FROM pg_database WHERE datname = $test_database_base_literal OR datname LIKE replace($test_database_base_literal, '_', '\\_') || '\\_%' ESCAPE '\\';")"

  if [[ -z "${databases//[$'\n''\t'' ']/}" ]]; then
    echo "no test databases found for base $test_database_base"
    return
  fi

  while IFS= read -r db_name; do
    if [[ -z "$db_name" ]]; then
      continue
    fi

    local quoted
    quoted="$(quote_identifier "$db_name")"
    mise exec postgres@18.1 -- psql -X -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -tAc "DROP DATABASE IF EXISTS $quoted WITH (FORCE)"
    echo "dropped database $db_name"
  done <<<"$databases"
}

main() {
  local action="${1:-}"

  case "$action" in
    start)
      start_postgres
      ;;
    stop)
      stop_postgres
      ;;
    status)
      postgres_status
      ;;
    createdb)
      create_database
      ;;
    drop-testdb)
      drop_test_databases
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
