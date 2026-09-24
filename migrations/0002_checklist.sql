CREATE TABLE checklist_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
