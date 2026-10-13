import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as repo from './repo.js';
import { transition, toState } from './stateMachine.js';
import { createAgent, type AgentAction } from './agent/agent.js';
import { Scheduler } from './scheduler.js';

const DAY_MS = 24 * 3600 * 1000;

/** 落库 Agent 动作 */
function applyActions(db: DatabaseSync, actions: AgentAction[], now: number): void {
  for (const a of actions) {
    if (a.type === 'create_task') {
      repo.createTask(db, { title: a.title, quadrant: a.quadrant, is_tiny: a.is_tiny, kind: a.kind, now });
    } else if (a.type === 'create_commitment') {
      const task = repo.listTasks(db).find(t => t.title === a.title && t.status === 'open');
      if (task) repo.createCommitment(db, { task_id: task.id, due_at: a.due_at, now });
    } else if (a.type === 'complete_task') {
      const open = repo.listTasks(db).find(t => t.status === 'open');
      if (open) repo.completeTask(db, open.id, now);
      repo.addVictory(db, a.note, null, now);
    }
  }
}

export function buildServer(db: DatabaseSync, opts: { schedulerIntervalMs?: number } = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const agent = createAgent(db);
  const scheduler = new Scheduler(db, { intervalMs: opts.schedulerIntervalMs ?? 60_000 });

  // 容忍「content-type: application/json + 空 body」的 POST（浏览器旧缓存页面会这样发）
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = body as string;
    if (!s || !s.trim()) return done(null, {});
    try { done(null, JSON.parse(s)); } catch (e) { done(e as Error, undefined); }
  });

  /* ============ 状态 ============ */
  app.get('/api/state', async () => {
    const now = Date.now();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const asked = repo.latestAskedCommitment(db);
    const askedTask = asked ? repo.getTask(db, asked.task_id) : undefined;
    return {
      time: new Date(now).toTimeString().slice(0, 5),
      tasks: repo.listTasks(db),
      errands: repo.listErrands(db),
      messages: repo.listMessages(db),
      victories: repo.listVictories(db),
      askedCommitment: asked ? { id: asked.id, taskTitle: askedTask?.title ?? '', followupCount: asked.followup_count } : null,
      stats: {
        today: repo.countVictoriesSince(db, dayStart.getTime()),
        total: repo.countVictoriesSince(db, 0),
        week: repo.countVictoriesSince(db, now - 7 * DAY_MS),
      },
    };
  });

  /* ============ 对话 ============ */
  app.post<{ Body: { text: string } }>('/api/chat', async (req, reply) => {
    const { text } = req.body ?? {};
    if (!text || typeof text !== 'string' || !text.trim())
      return reply.code(400).send({ error: 'text required' });
    const now = Date.now();
    repo.addMessage(db, 'user', text.trim(), now);
    const r = agent.reply(text);
    repo.addMessage(db, 'bot', r.text, now);
    applyActions(db, r.actions, now);
    return { reply: r.text, chips: r.chips ?? [] };
  });

  /* ============ 任务完成 ============ */
  app.post<{ Params: { id: string } }>('/api/tasks/:id/complete', async (req, reply) => {
    const id = Number(req.params.id);
    const now = Date.now();
    const task = repo.completeTask(db, id, now);
    if (!task) return reply.code(404).send({ error: 'task not found or already done' });
    repo.addVictory(db, `完成：${task.title}`, id, now);
    // 若有关联的未完结承诺 → 直接标记 started
    const c = repo.latestOpenCommitment(db, id);
    if (c) {
      const r = transition(toState(c), { type: 'START' }, now);
      if (r) repo.updateCommitment(db, { ...c, status: r.state.status, followup_count: r.state.followup_count, next_action_at: r.state.next_action_at });
    }
    return { ok: true };
  });

  /* ============ 承诺回应（追问闭环的用户侧） ============ */
  app.post<{ Params: { id: string }; Body: { choice: string } }>(
    '/api/commitments/:id/respond', async (req, reply) => {
      const c = repo.getCommitment(db, Number(req.params.id));
      if (!c) return reply.code(404).send({ error: 'commitment not found' });
      const { choice } = req.body ?? {};
      const now = Date.now();
      const task = repo.getTask(db, c.task_id);

      const event = choice === 'start' ? { type: 'START' as const }
        : choice === 'snooze' ? { type: 'SNOOZE' as const }
        : choice === 'giveup' ? { type: 'GIVE_UP' as const }
        : null;
      if (!event) return reply.code(400).send({ error: 'choice must be start|snooze|giveup' });

      const r = transition(toState(c), event, now);
      if (!r) return reply.code(409).send({ error: `invalid transition from ${c.status}` });

      repo.updateCommitment(db, {
        ...c, status: r.state.status, followup_count: r.state.followup_count, next_action_at: r.state.next_action_at,
      });

      let botText = '';
      if (r.state.status === 'started') {
        if (task) repo.completeTask(db, task.id, now);
        repo.addVictory(db, task ? `开始（并完成）：${task.title}` : '承诺开始', task?.id ?? null, now);
        botText = '🎉 启动成功 —— 这是最难的一步。记进胜利清单了。';
      } else if (r.state.status === 'snoozed') {
        botText = '可以，10 分钟后我再来问一次。这不丢人——你只是把开始时间推迟了 10 分钟，不是取消。';
      } else {
        // given_up：无论来自主动放弃还是拖延触达上限，都温和收尾 + 次日提前提醒
        botText = '好，今天翻篇。不自责——<b>取消一次 ≠ 你是个失败的人</b>。明天这个点之前我会提前提醒你，把鞋放门口就行。';
        if (task) {
          // 次日提前 6 分钟提醒（新承诺，一次性）
          const nextDay = c.due_at + DAY_MS - 6 * 60 * 1000;
          repo.createCommitment(db, { task_id: task.id, due_at: nextDay, now });
        }
      }
      if (botText) repo.addMessage(db, 'bot', botText, now);
      return { ok: true, status: r.state.status, reply: botText };
    });

  /* ============ 琐事批处理 ============ */
  app.post('/api/errands/batch', async () => {
    const now = Date.now();
    const take = repo.listErrands(db).slice(0, 3);
    for (const e of take) {
      repo.completeTask(db, e.id, now);
      repo.addVictory(db, `琐事清零：${e.title}`, e.id, now);
    }
    if (take.length) {
      repo.addMessage(db, 'bot',
        `顺手批处理完成 ✅：${take.map(e => e.title).join('、')}<br>${take.length} 件后台挂机任务下线，心理内存 +${take.length}。`, now);
    }
    return { ok: true, cleared: take.length };
  });

  /* ============ 演示：立即触发到期追问 ============ */
  app.post('/api/demo/accelerate', async () => {
    const n = repo.accelerateAll(db, Date.now());
    scheduler.tick();
    return { ok: true, triggered: n };
  });

  /* ============ 静态前端（web/，免构建） ============ */
  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
  app.get('/', async (_req, reply) => {
    const f = path.join(webDir, 'index.html');
    if (!existsSync(f)) return reply.code(404).send('web/index.html missing');
    reply.type('text/html; charset=utf-8').send(readFileSync(f, 'utf8'));
  });

  app.decorate('scheduler', scheduler);
  return app;
}
