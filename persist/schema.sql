PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. 事件收件箱
-- ============================================================
CREATE TABLE IF NOT EXISTS event_inbox (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  source_event_id TEXT,
  event_type      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT DEFAULT 'pending',
  workflow_run_id TEXT,
  created_at      INTEGER NOT NULL,
  processed_at    INTEGER,
  UNIQUE(source, source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_event_inbox_status ON event_inbox(status);

-- ============================================================
-- 2. 会话（多轮对话上下文）
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  user_id       TEXT,
  last_run_id   TEXT,
  context_json  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_channel ON conversations(source, channel_id);

-- ============================================================
-- 3. 工作流运行记录
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_runs (
  id              TEXT PRIMARY KEY,
  workflow_id     TEXT NOT NULL,
  conversation_id TEXT,
  event_id        TEXT,
  status          TEXT DEFAULT 'pending',
  context_json    TEXT,
  current_step    TEXT,
  error           TEXT,
  started_at      INTEGER,
  finished_at     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);

-- ============================================================
-- 4. Step 运行记录
-- ============================================================
CREATE TABLE IF NOT EXISTS step_runs (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES workflow_runs(id),
  step_name    TEXT NOT NULL,
  step_index   INTEGER NOT NULL,
  status       TEXT DEFAULT 'pending',
  input_json   TEXT,
  output_json  TEXT,
  error        TEXT,
  retry_count  INTEGER DEFAULT 0,
  duration_ms  INTEGER,
  token_used   INTEGER,
  started_at   INTEGER,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_step_runs_run ON step_runs(run_id);

-- ============================================================
-- 5. 消息出站箱
-- ============================================================
CREATE TABLE IF NOT EXISTS message_outbox (
  id          TEXT PRIMARY KEY,
  run_id      TEXT,
  target      TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  content     TEXT NOT NULL,
  status      TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON message_outbox(status);

-- ============================================================
-- 6. 死信队列
-- ============================================================
CREATE TABLE IF NOT EXISTS dlq (
  id          TEXT PRIMARY KEY,
  run_id      TEXT,
  step_name   TEXT,
  error       TEXT,
  input_json  TEXT,
  retry_count INTEGER,
  created_at  INTEGER NOT NULL,
  replayed_at INTEGER
);

-- ============================================================
-- 7. 知识库 - 文档
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id          TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL UNIQUE,
  file_hash   TEXT NOT NULL,
  title       TEXT,
  status      TEXT DEFAULT 'active',
  chunk_count INTEGER DEFAULT 0,
  indexed_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ============================================================
-- 8. 知识库 - 分块
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES knowledge_docs(id),
  chunk_index INTEGER NOT NULL,
  heading     TEXT,
  content     TEXT NOT NULL,
  token_count INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON knowledge_chunks(doc_id);

-- ============================================================
-- 9. 知识库 - 向量索引 (sqlite-vec)
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vectors USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding float[1024]
);
