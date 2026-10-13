import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDb } from '../src/db.js';
import { buildServer } from '../src/api.js';
import { seedIfEmpty } from '../src/seed.js';
import { Scheduler } from '../src/scheduler.js';
import * as repo from '../src/repo.js';
import type { FastifyInstance } from 'fastify';

let db: DatabaseSync, app: FastifyInstance, scheduler: Scheduler;

beforeEach(() => {
  db = createDb(':memory:');
  seedIfEmpty(db);
  app = buildServer(db);
  scheduler = new Scheduler(db);
});

const post = (url: string, body?: object) => app.inject({ method: 'POST', url, payload: body });
const get = (url: string) => app.inject({ method: 'GET', url });

test('GET /api/state 返回种子数据结构完整', async () => {
  const r = await get('/api/state');
  assert.equal(r.statusCode, 200);
  const s = r.json();
  assert.ok(Array.isArray(s.tasks) && s.tasks.length >= 5);
  assert.ok(s.errands.length === 4);
  assert.ok(s.messages.length === 2);
  assert.equal(s.stats.week, 5);
});

test('完整追问闭环：承诺→到期追问→拖延→二次追问→开始→胜利', async () => {
  // 1. 用户承诺跑步
  const chat = await post('/api/chat', { text: '我打算今晚8点跑步' });
  assert.equal(chat.statusCode, 200);
  assert.match(chat.json().reply, /运动鞋/);

  const task = repo.listTasks(db).find(t => t.title.includes('运动鞋'));
  assert.ok(task, '应创建降门槛任务');
  let c = repo.latestOpenCommitment(db, task!.id);
  assert.ok(c, '应创建承诺');
  const due = c!.due_at;

  // 2. 到期 → 调度器触发第 1 次追问
  repo.accelerateAll(db, Date.now());
  const asked1 = scheduler.tick();
  assert.equal(asked1, 1);
  c = repo.getCommitment(db, c!.id)!;
  assert.equal(c.status, 'asked');
  assert.equal(c.followup_count, 1);
  const msgs1 = repo.listMessages(db);
  assert.ok(msgs1.some(m => m.role === 'bot' && m.content.includes('开始了吗')), '应写入追问消息');

  // 2b. /api/state 应暴露待回应的追问（前端渲染选项用）
  const st = (await get('/api/state')).json();
  assert.ok(st.askedCommitment, 'state 应包含 askedCommitment');
  assert.equal(st.askedCommitment.id, c.id);
  assert.match(st.askedCommitment.taskTitle, /运动鞋/);

  // 3. 用户选择再拖 10 分钟
  const sn = await post(`/api/commitments/${c.id}/respond`, { choice: 'snooze' });
  assert.equal(sn.statusCode, 200);
  c = repo.getCommitment(db, c.id)!;
  assert.equal(c.status, 'snoozed');
  assert.ok(c.next_action_at > Date.now(), '二次敲门时间应为未来');

  // 4. 10 分钟后 → 第 2 次追问
  repo.accelerateAll(db, Date.now());
  const asked2 = scheduler.tick();
  assert.equal(asked2, 1);
  c = repo.getCommitment(db, c.id)!;
  assert.equal(c.followup_count, 2);

  // 5. 再次拖延 → 触达上限 → 温和收尾 + 次日提醒
  const sn2 = await post(`/api/commitments/${c.id}/respond`, { choice: 'snooze' });
  assert.equal(sn2.statusCode, 200);
  c = repo.getCommitment(db, c.id)!;
  assert.equal(c.status, 'given_up', '第二次拖延应温和收尾');
  // 次日提醒承诺已创建（新行 pending）
  const nextDay = repo.latestOpenCommitment(db, task!.id);
  assert.ok(nextDay && nextDay.id !== c.id && nextDay.due_at > due, '应安排次日提前提醒');

  // 6. 次日提醒触发 → 用户开始 → 胜利 + 任务完成
  repo.accelerateAll(db, Date.now());
  scheduler.tick();
  const c3 = repo.latestOpenCommitment(db, task!.id)!;
  const start = await post(`/api/commitments/${c3.id}/respond`, { choice: 'start' });
  assert.equal(start.statusCode, 200);
  assert.equal(repo.getTask(db, task!.id)!.status, 'done');
  assert.ok(repo.listVictories(db).some(v => v.note.includes('运动鞋')));
});

test('直接开始分支：asked 状态点开始 → 任务完成 + 胜利 + 状态机收尾', async () => {
  await post('/api/chat', { text: '我打算今晚8点跑步' });
  const task = repo.listTasks(db).find(t => t.title.includes('运动鞋'))!;
  repo.accelerateAll(db, Date.now());
  scheduler.tick();
  const c = repo.latestOpenCommitment(db, task.id)!;
  assert.equal(c.status, 'asked');

  const r = await post(`/api/commitments/${c.id}/respond`, { choice: 'start' });
  assert.equal(r.statusCode, 200);
  assert.equal(repo.getTask(db, task.id)!.status, 'done');
  assert.equal(repo.getCommitment(db, c.id)!.status, 'started');
});

test('非法转移返回 409（如 started 后再 respond start）', async () => {
  await post('/api/chat', { text: '我打算今晚8点跑步' });
  const task = repo.listTasks(db).find(t => t.title.includes('运动鞋'))!;
  repo.accelerateAll(db, Date.now());
  scheduler.tick();
  const c = repo.latestOpenCommitment(db, task.id)!;
  await post(`/api/commitments/${c.id}/respond`, { choice: 'start' });
  const again = await post(`/api/commitments/${c.id}/respond`, { choice: 'snooze' });
  assert.equal(again.statusCode, 409);
});

test('POST /api/chat 参数校验：空文本 400', async () => {
  const r = await post('/api/chat', { text: '' });
  assert.equal(r.statusCode, 400);
});

test('回归：带 json content-type 的空 body POST 不再 400（旧前端缓存兼容）', async () => {
  for (const url of ['/api/demo/accelerate', '/api/errands/batch']) {
    const r = await app.inject({
      method: 'POST', url,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    assert.equal(r.statusCode, 200, `${url} 应接受空 json body`);
  }
});

test('2分钟启动器：大块头任务被拆解入库，且给出「打开了」选项', async () => {
  const r = await post('/api/chat', { text: '我要开始写论文' });
  assert.equal(r.statusCode, 200);
  assert.match(r.json().reply, /大块头/);
  assert.deepEqual(r.json().chips, ['打开了', '还是算了']);
  assert.ok(repo.listTasks(db).some(t => t.title.includes('打开文档') && t.title.includes('论文')),
    '应创建拆解后的第一步任务');

  // 点「打开了」→ 完成拆解任务 + 胜利记录
  const before = repo.countVictoriesSince(db, 0);
  const r2 = await post('/api/chat', { text: '打开了' });
  assert.equal(r2.statusCode, 200);
  assert.equal(repo.countVictoriesSince(db, 0), before + 1);
});

test('accelerate 无可触发承诺时，Agent 在对话中解释原因', async () => {
  const before = repo.listMessages(db).length;
  const r = await post('/api/demo/accelerate');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().triggered, 0);
  const msgs = repo.listMessages(db);
  assert.equal(msgs.length, before + 1, '应新增一条 bot 解释消息');
  assert.match(msgs[msgs.length - 1].content, /带时间的承诺/);
});

test('口头完成汇报 → 胜利记录 +1', async () => {
  const before = repo.countVictoriesSince(db, 0);
  const r = await post('/api/chat', { text: '搞定了' });
  assert.equal(r.statusCode, 200);
  assert.equal(repo.countVictoriesSince(db, 0), before + 1);
});

test('琐事批处理：一次清 3 件并写消息', async () => {
  const before = repo.listErrands(db).length;
  const r = await post('/api/errands/batch');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().cleared, Math.min(3, before));
  assert.equal(repo.listErrands(db).length, Math.max(0, before - 3));
});

test('任务完成接口：完成后不可重复完成（404）', async () => {
  const task = repo.listTasks(db)[0];
  const ok = await post(`/api/tasks/${task.id}/complete`);
  assert.equal(ok.statusCode, 200);
  const dup = await post(`/api/tasks/${task.id}/complete`);
  assert.equal(dup.statusCode, 404);
});
