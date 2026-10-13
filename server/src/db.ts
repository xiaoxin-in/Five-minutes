import { DatabaseSync } from 'node:sqlite';

export type TaskStatus = 'open' | 'done';
export type CommitmentStatus = 'pending' | 'asked' | 'started' | 'snoozed' | 'given_up';

export interface Task {
  id: number; title: string; quadrant: number; is_tiny: number;
  kind: 'todo' | 'errand'; status: TaskStatus;
  created_at: number; done_at: number | null;
}
export interface Commitment {
  id: number; task_id: number; due_at: number;
  status: CommitmentStatus; followup_count: number; next_action_at: number;
}
export interface Message {
  id: number; role: 'user' | 'bot'; content: string; created_at: number;
}
export interface Victory { id: number; task_id: number | null; note: string; created_at: number; }

/** 打开（或创建）数据库并建表 */
export function createDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      quadrant INTEGER NOT NULL DEFAULT 2,
      is_tiny INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'todo',
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      done_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS commitments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      due_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      followup_count INTEGER NOT NULL DEFAULT 0,
      next_action_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS victories(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}
