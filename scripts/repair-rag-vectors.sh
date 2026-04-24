#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${DB_PATH:-$ROOT_DIR/data/engine.db}"
BACKUP_DIR="$ROOT_DIR/data/backups"
STAMP="$(date +%Y%m%d_%H%M%S)"

printf '[repair-rag] project: %s\n' "$ROOT_DIR"
printf '[repair-rag] db: %s\n' "$DB_PATH"

if [ ! -f "$DB_PATH" ]; then
  printf '[repair-rag] database does not exist, running fresh ingest\n'
  node rag/ingest.js
  exit 0
fi

mkdir -p "$BACKUP_DIR"
cp "$DB_PATH" "$BACKUP_DIR/engine.$STAMP.db"
[ -f "$DB_PATH-wal" ] && cp "$DB_PATH-wal" "$BACKUP_DIR/engine.$STAMP.db-wal"
[ -f "$DB_PATH-shm" ] && cp "$DB_PATH-shm" "$BACKUP_DIR/engine.$STAMP.db-shm"
printf '[repair-rag] backup created: %s\n' "$BACKUP_DIR/engine.$STAMP.db"

node <<'NODE'
'use strict'

const { getDb, closeDb } = require('./persist/db')

const db = getDb()
const tx = db.transaction(() => {
  db.prepare('DELETE FROM knowledge_vectors').run()
  db.prepare('DELETE FROM knowledge_chunks').run()
  db.prepare("UPDATE knowledge_docs SET file_hash = '__repair_pending__' || id, chunk_count = 0, indexed_at = NULL, updated_at = ? WHERE status = 'active'").run(Date.now())
})

tx()
closeDb()
console.log('[repair-rag] cleared knowledge vectors/chunks and invalidated active document hashes')
NODE

printf '[repair-rag] rebuilding vectors with current chunker/config\n'
node rag/ingest.js
printf '[repair-rag] done\n'
