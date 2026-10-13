/**
 * 承诺追问闭环状态机（纯函数，全项目核心）
 *
 * pending ──ASK──▶ asked ──START──▶ started   （写入胜利记录）
 *    ▲              │
 *    │            SNOOZE(10min)
 *    │              ▼
 *    └──────── snoozed ──ASK──▶ asked（followup_count+1）
 *
 * asked + SNOOZE 且 followup_count 已达上限 → given_up（温和收尾，次日提前提醒）
 * asked + GIVE_UP                        → given_up（同上）
 */
import type { Commitment, CommitmentStatus } from './db.js';

export const MAX_FOLLOWUPS = 2;      // 追问硬上限：超过即不再打扰（对应验证指标）
export const SNOOZE_MINUTES = 10;     // 「再拖10分钟」
export const DAY_REMINDER_OFFSET_MS = 19.9 * 3600 * 1000 - 0; // 次日 19:54 左右提前提醒（相对 due_at）

export type CommitmentEvent =
  | { type: 'ASK' }
  | { type: 'START' }
  | { type: 'SNOOZE' }
  | { type: 'GIVE_UP' };

export type Effect = 'ask' | 'victory' | 'gentle_close' | 'tomorrow_reminder';

export interface CommitmentState {
  status: CommitmentStatus;
  followup_count: number;
  next_action_at: number;
}

export interface TransitionResult {
  state: CommitmentState;
  effects: Effect[];
}

/** 纯状态转移：非法事件返回 null（由调用方决定如何处理） */
export function transition(
  c: CommitmentState, event: CommitmentEvent, now: number
): TransitionResult | null {
  switch (event.type) {
    case 'ASK': {
      if (c.status !== 'pending' && c.status !== 'snoozed') return null;
      const count = c.followup_count + 1;
      if (count > MAX_FOLLOWUPS) {
        // 已达追问上限：不再敲门，温和收尾
        return {
          state: { status: 'given_up', followup_count: c.followup_count, next_action_at: 0 },
          effects: ['gentle_close'],
        };
      }
      return {
        state: { status: 'asked', followup_count: count, next_action_at: 0 },
        effects: ['ask'],
      };
    }
    case 'START': {
      if (c.status !== 'asked' && c.status !== 'pending' && c.status !== 'snoozed') return null;
      return {
        state: { status: 'started', followup_count: c.followup_count, next_action_at: 0 },
        effects: ['victory'],
      };
    }
    case 'SNOOZE': {
      if (c.status !== 'asked') return null;
      if (c.followup_count >= MAX_FOLLOWUPS) {
        // 第 N 次想再拖：已达上限，温和收尾并安排次日提醒
        return {
          state: { status: 'given_up', followup_count: c.followup_count, next_action_at: 0 },
          effects: ['gentle_close', 'tomorrow_reminder'],
        };
      }
      return {
        state: {
          status: 'snoozed',
          followup_count: c.followup_count,
          next_action_at: now + SNOOZE_MINUTES * 60 * 1000,
        },
        effects: [],
      };
    }
    case 'GIVE_UP': {
      if (c.status !== 'asked' && c.status !== 'pending' && c.status !== 'snoozed') return null;
      return {
        state: { status: 'given_up', followup_count: c.followup_count, next_action_at: 0 },
        effects: ['gentle_close', 'tomorrow_reminder'],
      };
    }
  }
}

/** 把 DB 行转为状态机输入 */
export function toState(c: Commitment): CommitmentState {
  return { status: c.status, followup_count: c.followup_count, next_action_at: c.next_action_at };
}
