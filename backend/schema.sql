CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id TEXT,
  run_id TEXT,
  source TEXT,
  analysis_type TEXT,
  text TEXT NOT NULL,
  text_length INTEGER NOT NULL,
  created_at TEXT,
  received_at TEXT NOT NULL,
  stage_index INTEGER,
  stage_name TEXT,
  stage_duration_ms INTEGER,
  stage_word_count INTEGER,
  formatted_text TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_response_id
  ON responses(response_id);

CREATE TABLE IF NOT EXISTS four_gate_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL,
  run_id TEXT,
  source TEXT,
  analysis_type TEXT,
  created_at TEXT,
  received_at TEXT NOT NULL,
  decision_date TEXT,
  decision_status TEXT,
  company TEXT,
  short_thesis TEXT,
  source_material TEXT,
  investment_thesis TEXT,
  concerns TEXT,
  gate_rating TEXT,
  asymmetry_divergence TEXT,
  voi_falsifiers TEXT,
  sector TEXT,
  region TEXT,
  currency TEXT,
  why_buy TEXT,
  why_avoid TEXT,
  raw_line TEXT,
  UNIQUE(response_id),
  FOREIGN KEY(response_id) REFERENCES responses(id)
);
