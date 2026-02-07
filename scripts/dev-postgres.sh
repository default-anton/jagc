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
  cat <<EOF
Usage: scripts/dev-postgres.sh <start|stop|status|createdb>

Environment overrides:
  JAGC_PGDATA_DIR   (default: .local/pgdata)
  JAGC_PGLOG_FILE   (default: .local/postgres.log)
  JAGC_PGHOST       (default: 127.0.0.1)
  JAGC_PGPORT       (default: 5432)
  JAGC_PGUSER       (default: postgres)
  JAGC_PGDATABASE   (default: jagc)
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
    echo "postgres already running on $PGHOST:$PGPORT"
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
  db_exists_output="$(mise exec postgres@18.1 -- psql -X -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -tAc "SELECT 1 FROM pg_database WHERE datname='$PGDATABASE'")"

  if [[ "$db_exists_output" == *"1"* ]]; then
    echo "database $PGDATABASE already exists"
    return
  fi

  mise exec postgres@18.1 -- createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$PGDATABASE"
  echo "created database $PGDATABASE"
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
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
