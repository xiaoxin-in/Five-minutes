import * as repo from './repo.js';
import type { DatabaseSync } from 'node:sqlite';

/** 首次启动时的种子数据：与 Demo 交互流程一致 */
export function seedIfEmpty(db: DatabaseSync): void {
  const hasMsg = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n > 0;
  if (hasMsg) return;
  const now = Date.now();
  const t = (ms: number) => now - ms;

  // 预置对话（展示 Agent 语气）
  repo.addMessage(db, 'user', '我又废了一整天，啥也没干 😮‍💨', t(30 * 60_000));
  repo.addMessage(db, 'bot',
    '正常。人回避的从来不是任务，是不适感。<br>现在别想"一整天"，想<b>接下来 5 分钟</b>——去倒杯水回来，我等你。', t(30 * 60_000));

  // 待办
  repo.createTask(db, { title: '回导师消息', quadrant: 2, is_tiny: true, now: t(2 * 86400_000) });
  repo.createTask(db, { title: '给妈妈买生日礼物', quadrant: 2, now: t(86400_000) });
  repo.createTask(db, { title: '季度报告初稿', quadrant: 1, now: t(3 * 86400_000) });

  // 琐事清单
  const errands = ['取快递', '缴电费', '预约牙医复查', '整理书桌一角'];
  for (const e of errands) repo.createTask(db, { title: e, kind: 'errand', is_tiny: true, quadrant: 3, now: t(4 * 86400_000) });

  // 历史胜利记录（周统计用）
  const week = [
    ['周一：只是打开了论文文档，写了一句标题', 6],
    ['周二：把拖了 11 天的牙医约上了', 5],
    ['周三：倒垃圾顺手取了快递 ×2', 4],
    ['周四：运动鞋穿上了，在楼下走了 10 分钟', 3],
    ['周五：把最重要的那封邮件发出去了', 2],
  ] as const;
  for (const [note, daysAgo] of week) {
    const d = new Date(now - daysAgo * 86400_000);
    d.setHours(20, 0, 0, 0);
    repo.addVictory(db, note, null, d.getTime());
  }
}
