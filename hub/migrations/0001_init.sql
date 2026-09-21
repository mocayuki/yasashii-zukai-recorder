-- 投稿ハブの表。時刻はすべて UNIX ミリ秒
CREATE TABLE IF NOT EXISTS accounts (
	platform TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	username TEXT NOT NULL,
	access_token TEXT NOT NULL,
	refresh_token TEXT,
	expires_at INTEGER,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
	state TEXT PRIMARY KEY,
	platform TEXT NOT NULL,
	verifier TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
	key TEXT PRIMARY KEY,
	size INTEGER NOT NULL,
	content_type TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	platform TEXT NOT NULL,
	media_key TEXT NOT NULL,
	payload TEXT NOT NULL,
	scheduled_at INTEGER NOT NULL,
	status TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	error TEXT,
	result_url TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, scheduled_at);
