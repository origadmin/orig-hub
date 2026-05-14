package state

import (
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/origadmin/orig-hub/internal/engine/types"
	_ "modernc.org/sqlite"
)

type DB struct {
	db *sql.DB
}

func Open(path string) (*DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to set WAL mode: %w", err)
	}
	if _, err := db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to set busy_timeout: %w", err)
	}

	d := &DB{db: db}
	if err := d.migrate(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("failed to migrate: %w", err)
	}

	return d, nil
}

func (d *DB) Close() error {
	return d.db.Close()
}

func (d *DB) migrate() error {
	query := `
	CREATE TABLE IF NOT EXISTS downloads (
		id TEXT PRIMARY KEY,
		url TEXT NOT NULL,
		dest_path TEXT NOT NULL,
		filename TEXT,
		status TEXT NOT NULL DEFAULT 'queued',
		total_size INTEGER DEFAULT 0,
		downloaded INTEGER DEFAULT 0,
		url_hash TEXT,
		created_at INTEGER,
		paused_at INTEGER,
		completed_at INTEGER,
		time_taken INTEGER,
		mirrors TEXT,
		avg_speed REAL DEFAULT 0,
		protocol TEXT DEFAULT 'http'
	);

	CREATE TABLE IF NOT EXISTS tasks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		download_id TEXT NOT NULL,
		offset INTEGER NOT NULL,
		length INTEGER NOT NULL,
		FOREIGN KEY(download_id) REFERENCES downloads(id) ON DELETE CASCADE
	);

	CREATE INDEX IF NOT EXISTS idx_tasks_download_id ON tasks(download_id);
	CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
	`
	_, err := d.db.Exec(query)
	return err
}

func (d *DB) SaveDownload(entry *types.DownloadEntry) error {
	mirrorsJSON, _ := json.Marshal(entry.Mirrors)

	_, err := d.db.Exec(`
		INSERT OR REPLACE INTO downloads
		(id, url, dest_path, filename, status, total_size, downloaded, url_hash,
		 created_at, completed_at, time_taken, mirrors, avg_speed)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		entry.ID, entry.URL, entry.DestPath, entry.Filename, entry.Status,
		entry.TotalSize, entry.Downloaded, entry.URLHash,
		0, entry.CompletedAt, entry.TimeTaken, string(mirrorsJSON), entry.AvgSpeed)
	return err
}

func (d *DB) GetDownload(id string) (*types.DownloadEntry, error) {
	row := d.db.QueryRow(`
		SELECT id, url, dest_path, filename, status, total_size, downloaded, url_hash,
		       completed_at, time_taken, mirrors, avg_speed
		FROM downloads WHERE id = ?`, id)

	var entry types.DownloadEntry
	var mirrorsJSON string
	var completedAt, timeTaken sql.NullInt64
	var avgSpeed sql.NullFloat64

	err := row.Scan(&entry.ID, &entry.URL, &entry.DestPath, &entry.Filename, &entry.Status,
		&entry.TotalSize, &entry.Downloaded, &entry.URLHash,
		&completedAt, &timeTaken, &mirrorsJSON, &avgSpeed)
	if err == sql.ErrNoRows {
		return nil, types.ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	if completedAt.Valid {
		entry.CompletedAt = completedAt.Int64
	}
	if timeTaken.Valid {
		entry.TimeTaken = timeTaken.Int64
	}
	if avgSpeed.Valid {
		entry.AvgSpeed = avgSpeed.Float64
	}

	if mirrorsJSON != "" {
		if err := json.Unmarshal([]byte(mirrorsJSON), &entry.Mirrors); err != nil {
			return nil, fmt.Errorf("failed to unmarshal mirrors: %w", err)
		}
	}

	return &entry, nil
}

func (d *DB) ListDownloads(status string) ([]types.DownloadEntry, error) {
	var rows *sql.Rows
	var err error

	if status != "" {
		rows, err = d.db.Query(`
			SELECT id, url, dest_path, filename, status, total_size, downloaded, url_hash,
			       completed_at, time_taken, mirrors, avg_speed
			FROM downloads WHERE status = ? ORDER BY created_at DESC`, status)
	} else {
		rows, err = d.db.Query(`
			SELECT id, url, dest_path, filename, status, total_size, downloaded, url_hash,
			       completed_at, time_taken, mirrors, avg_speed
			FROM downloads ORDER BY created_at DESC`)
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var entries []types.DownloadEntry
	for rows.Next() {
		var entry types.DownloadEntry
		var mirrorsJSON string
		var completedAt, timeTaken sql.NullInt64
		var avgSpeed sql.NullFloat64

		err := rows.Scan(&entry.ID, &entry.URL, &entry.DestPath, &entry.Filename, &entry.Status,
			&entry.TotalSize, &entry.Downloaded, &entry.URLHash,
			&completedAt, &timeTaken, &mirrorsJSON, &avgSpeed)
		if err != nil {
			return nil, err
		}

		if completedAt.Valid {
			entry.CompletedAt = completedAt.Int64
		}
		if timeTaken.Valid {
			entry.TimeTaken = timeTaken.Int64
		}
		if avgSpeed.Valid {
			entry.AvgSpeed = avgSpeed.Float64
		}
		if mirrorsJSON != "" {
			if err := json.Unmarshal([]byte(mirrorsJSON), &entry.Mirrors); err != nil {
				return nil, fmt.Errorf("failed to unmarshal mirrors: %w", err)
			}
		}

		entries = append(entries, entry)
	}

	return entries, nil
}

func (d *DB) DeleteDownload(id string) error {
	_, err := d.db.Exec("DELETE FROM downloads WHERE id = ?", id)
	return err
}

func (d *DB) UpdateStatus(id string, status string, downloaded int64) error {
	_, err := d.db.Exec("UPDATE downloads SET status = ?, downloaded = ? WHERE id = ?", status, downloaded, id)
	return err
}

func (d *DB) SaveTasks(downloadID string, tasks []types.Task) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}

	_, err = tx.Exec("DELETE FROM tasks WHERE download_id = ?", downloadID)
	if err != nil {
		_ = tx.Rollback()
		return err
	}

	for _, task := range tasks {
		_, err = tx.Exec("INSERT INTO tasks (download_id, offset, length) VALUES (?, ?, ?)",
			downloadID, task.Offset, task.Length)
		if err != nil {
			_ = tx.Rollback()
			return err
		}
	}

	return tx.Commit()
}

func (d *DB) LoadTasks(downloadID string) ([]types.Task, error) {
	rows, err := d.db.Query("SELECT offset, length FROM tasks WHERE download_id = ?", downloadID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var tasks []types.Task
	for rows.Next() {
		var task types.Task
		if err := rows.Scan(&task.Offset, &task.Length); err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}

	return tasks, nil
}
