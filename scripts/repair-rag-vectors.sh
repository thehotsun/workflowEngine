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

set +e
node <<'NODE'
'use strict'

const path = require('path')
const { getDb, closeDb } = require('./persist/db')

const db = getDb()
const now = Date.now()
const rootDir = process.cwd()

const targets = db.prepare(`
  SELECT
    kd.id,
    kd.file_path,
    kd.status,
    kd.chunk_count AS expected_chunks,
    COALESCE(cs.total, 0) AS actual_chunks,
    COALESCE(vs.total, 0) AS actual_vectors
  FROM knowledge_docs kd
  LEFT JOIN (
    SELECT doc_id, COUNT(1) AS total
    FROM knowledge_chunks
    GROUP BY doc_id
  ) cs ON cs.doc_id = kd.id
  LEFT JOIN (
    SELECT kc.doc_id, COUNT(1) AS total
    FROM knowledge_chunks kc
    JOIN knowledge_vectors kv ON kv.chunk_id = kc.id
    GROUP BY kc.doc_id
  ) vs ON vs.doc_id = kd.id
  WHERE kd.status = 'failed'
     OR (
      kd.status = 'active'
      AND (
        COALESCE(cs.total, 0) <> kd.chunk_count
        OR COALESCE(vs.total, 0) <> kd.chunk_count
      )
    )
  ORDER BY kd.file_path
`).all()

if (!targets.length) {
  closeDb()
  console.log('[repair-rag] no failed or incomplete document indexes found')
  process.exit(2)
}

const tx = db.transaction((rows) => {
  const deleteVectors = db.prepare(`
    DELETE FROM knowledge_vectors
    WHERE chunk_id IN (
      SELECT id FROM knowledge_chunks WHERE doc_id = ?
    )
  `)
  const deleteChunks = db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?')
  const invalidateDoc = db.prepare(`
    UPDATE knowledge_docs
    SET file_hash = '__repair_pending__' || id,
        chunk_count = 0,
        indexed_at = NULL,
        updated_at = ?
    WHERE id = ?
  `)

  for (const row of rows) {
    deleteVectors.run(row.id)
    deleteChunks.run(row.id)
    invalidateDoc.run(now, row.id)
  }
})

tx(targets)
closeDb()

console.log(`[repair-rag] invalidated ${targets.length} failed/incomplete document index(es)`)
for (const row of targets) {
  const relativePath = path.relative(rootDir, row.file_path) || row.file_path
  console.log(`[repair-rag] - ${relativePath} (${row.status}, chunks ${row.actual_chunks}/${row.expected_chunks}, vectors ${row.actual_vectors}/${row.expected_chunks})`)
}
NODE
repair_status=$?
set -e

if [ "$repair_status" -eq 2 ]; then
  printf '[repair-rag] done\n'
  exit 0
fi

if [ "$repair_status" -ne 0 ]; then
  exit "$repair_status"
fi

printf '[repair-rag] rebuilding invalidated documents with current chunker/config\n'
node rag/ingest.js
printf '[repair-rag] done\n'
