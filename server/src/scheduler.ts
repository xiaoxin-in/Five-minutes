import type { DatabaseSync } from 'node:sqlite';
import * as repo from './repo.js';
import { transition, toState } from './stateMachine.js';

/** 追问文案：语气铁律 —— 队友不是监工 */
const ASK_TEXTS = [
  (title: string, dueHM: string) =>
    `⏰ ${dueHM} 了。你说过的事：<b>${title}</b>。<br>开始了吗？`,
  (title: string) =>
    `⏰ 第二次敲门 🚪 还差最后一下：<b>${title}</b>。<br>就 5 分钟，鞋穿了吗？`,
];

export interface SchedulerOpts { intervalMs?: number }

/**
 * 承诺调度器：轮询到期承诺 → 触发状态机 ASK → 写入追问消息。
 * tick() 暴露为公开方法，供测试手动驱动。
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(private db: DatabaseSync, opts: SchedulerOpts = {}) {
    this.intervalMs = opts.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 扫描一轮，返回本轮触发追问的承诺数 */
  tick(): number {
    const now = Date.now();
    let asked = 0;
    for (const c of repo.dueCommitments(this.db, now)) {
      const task = repo.getTask(this.db, c.task_id);
      const r = transition(toState(c), { type: 'ASK' }, now);
      if (!r) continue;
      repo.updateCommitment(this.db, {
        ...c, status: r.state.status,
        followup_count: r.state.followup_count, next_action_at: r.state.next_action_at,
      });
      if (r.effects.includes('ask') && task) {
        const hm = new Date(c.due_at).toTimeString().slice(0, 5);
        const text = ASK_TEXTS[Math.min(c.followup_count, ASK_TEXTS.length - 1)](task.title, hm);
        repo.addMessage(this.db, 'bot', text, now);
        asked++;
      }
      if (r.effects.includes('gentle_close')) {
        repo.addMessage(this.db, 'bot',
          '今天不催了。取消一次 ≠ 你是个失败的人，明天同一时间我还在。', now);
      }
    }
    return asked;
  }
}
