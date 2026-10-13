import type { DatabaseSync } from 'node:sqlite';
import type { Commitment, CommitmentStatus, Message, Task, Victory } from './db.js';

/* ============ 任务 ============ */
export function listTasks(db: DatabaseSync): Task[] {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all() as Task[];
}
export function listErrands(db: DatabaseSync): Task[] {
  return db.prepare("SELECT * FROM tasks WHERE kind='errand' AND status='open' ORDER BY id").all() as Task[];
}
export function createTask(db: DatabaseSync, t: {
  title: string; quadrant?: number; is_tiny?: boolean; kind?: 'todo' | 'errand'; now: number;
}): Task {
  const { title, quadrant = 2, is_tiny = false, kind = 'todo', now } = t;
  const r = db.prepare(
    'INSERT INTO tasks(title, quadrant, is_tiny, kind, status, created_at) VALUES(?,?,?,?,?,?)'
  ).run(title, quadrant, is_tiny ? 1 : 0, kind, 'open', now);
  return getTask(db, Number(r.lastInsertRowid))!;
}
export function getTask(db: DatabaseSync, id: number): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | undefined;
}
export function completeTask(db: DatabaseSync, id: number, now: number): Task | undefined {
  const r = db.prepare("UPDATE tasks SET status='done', done_at=? WHERE id=? AND status='open'").run(now, id);
  if (Number(r.changes) === 0) return undefined;
  return getTask(db, id);
}

/* ============ 承诺 ============ */
export function createCommitment(db: DatabaseSync, c: {
  task_id: number; due_at: number; now: number;
}): Commitment {
  db.prepare(
    'INSERT INTO commitments(task_id, due_at, status, followup_count, next_action_at) VALUES(?,?,?,?,?)'
  ).run(c.task_id, c.due_at, 'pending', 0, c.due_at);
  return db.prepare('SELECT * FROM commitments WHERE task_id=? ORDER BY id DESC LIMIT 1')
    .get(c.task_id) as Commitment;
}
export function getCommitment(db: DatabaseSync, id: number): Commitment | undefined {
  return db.prepare('SELECT * FROM commitments WHERE id=?').get(id) as Commitment | undefined;
}
export function latestOpenCommitment(db: DatabaseSync, taskId: number): Commitment | undefined {
  return db.prepare(
    "SELECT * FROM commitments WHERE task_id=? AND status IN('pending','asked','snoozed') ORDER BY id DESC LIMIT 1"
  ).get(taskId) as Commitment | undefined;
}
/** 当前待用户回应的追问（asked 状态） */
export function latestAskedCommitment(db: DatabaseSync): Commitment | undefined {
  return db.prepare(
    "SELECT * FROM commitments WHERE status='asked' ORDER BY id DESC LIMIT 1"
  ).get() as Commitment | undefined;
}
export function updateCommitment(db: DatabaseSync, c: Commitment): void {
  db.prepare('UPDATE commitments SET status=?, followup_count=?, next_action_at=? WHERE id=?')
    .run(c.status, c.followup_count, c.next_action_at, c.id);
}
/** 到期需要追问的承诺（pending / snoozed 且到点） */
export function dueCommitments(db: DatabaseSync, now: number): Commitment[] {
  return db.prepare(
    "SELECT * FROM commitments WHERE status IN('pending','snoozed') AND next_action_at<=?"
  ).all(now) as Commitment[];
}
/** 演示用：把所有未完成的承诺立即置为到期 */
export function accelerateAll(db: DatabaseSync, now: number): number {
  const r = db.prepare(
    "UPDATE commitments SET next_action_at=? WHERE status IN('pending','snoozed')"
  ).run(now);
  return Number(r.changes);
}

/* ============ 消息 ============ */
export function addMessage(db: DatabaseSync, role: 'user' | 'bot', content: string, now: number): Message {
  const r = db.prepare('INSERT INTO messages(role, content, created_at) VALUES(?,?,?)')
    .run(role, content, now);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(Number(r.lastInsertRowid)) as Message;
}
export function listMessages(db: DatabaseSync, limit = 100): Message[] {
  const rows = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(limit) as Message[];
  return rows.reverse();
}

/* ============ 胜利记录 ============ */
export function addVictory(db: DatabaseSync, note: string, taskId: number | null, now: number): Victory {
  const r = db.prepare('INSERT INTO victories(task_id, note, created_at) VALUES(?,?,?)')
    .run(taskId, note, now);
  return db.prepare('SELECT * FROM victories WHERE id=?').get(Number(r.lastInsertRowid)) as Victory;
}
export function listVictories(db: DatabaseSync): Victory[] {
  return db.prepare('SELECT * FROM victories ORDER BY id DESC').all() as Victory[];
}
export function countVictoriesSince(db: DatabaseSync, since: number): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM victories WHERE created_at>=?')
    .get(since) as { n: number }).n);
}
