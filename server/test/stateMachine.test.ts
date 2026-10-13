import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition, MAX_FOLLOWUPS, SNOOZE_MINUTES, type CommitmentState } from '../src/stateMachine.js';

const NOW = 1_700_000_000_000;

function st(status: CommitmentState['status'], followup_count = 0, next_action_at = NOW): CommitmentState {
  return { status, followup_count, next_action_at };
}

interface Case {
  name: string; from: CommitmentState;
  event: Parameters<typeof transition>[1];
  expect: { status?: string; followup?: number; next?: 'unchanged' | number; effects?: string[] } | null;
}

const CASES: Case[] = [
  // ---- ASK ----
  { name: 'pending + ASK → asked, 第1次追问', from: st('pending'),
    event: { type: 'ASK' }, expect: { status: 'asked', followup: 1, effects: ['ask'] } },
  { name: 'snoozed + ASK → asked, 第2次追问', from: st('snoozed', 1, NOW),
    event: { type: 'ASK' }, expect: { status: 'asked', followup: 2, effects: ['ask'] } },
  { name: '已追问上限次后再 ASK → 温和收尾 given_up', from: st('snoozed', MAX_FOLLOWUPS, NOW),
    event: { type: 'ASK' }, expect: { status: 'given_up', effects: ['gentle_close'] } },
  { name: 'asked + ASK → 非法（不重复敲门）', from: st('asked', 1),
    event: { type: 'ASK' }, expect: null },
  { name: 'started + ASK → 非法', from: st('started'),
    event: { type: 'ASK' }, expect: null },

  // ---- START ----
  { name: 'asked + START → started + 胜利记录', from: st('asked', 1),
    event: { type: 'START' }, expect: { status: 'started', effects: ['victory'] } },
  { name: 'pending + START → started（主动提前开始也允许）', from: st('pending'),
    event: { type: 'START' }, expect: { status: 'started', effects: ['victory'] } },
  { name: 'given_up + START → 非法', from: st('given_up'),
    event: { type: 'START' }, expect: null },

  // ---- SNOOZE ----
  { name: 'asked + SNOOZE → snoozed，10分钟后二次敲门', from: st('asked', 1),
    event: { type: 'SNOOZE' },
    expect: { status: 'snoozed', next: NOW + SNOOZE_MINUTES * 60_000, effects: [] } },
  { name: 'asked(f=上限) + SNOOZE → 温和收尾 + 次日提醒', from: st('asked', MAX_FOLLOWUPS),
    event: { type: 'SNOOZE' },
    expect: { status: 'given_up', effects: ['gentle_close', 'tomorrow_reminder'] } },
  { name: 'pending + SNOOZE → 非法（还没问就拖）', from: st('pending'),
    event: { type: 'SNOOZE' }, expect: null },

  // ---- GIVE_UP ----
  { name: 'asked + GIVE_UP → given_up + 次日提醒', from: st('asked', 1),
    event: { type: 'GIVE_UP' },
    expect: { status: 'given_up', effects: ['gentle_close', 'tomorrow_reminder'] } },
  { name: 'started + GIVE_UP → 非法', from: st('started'),
    event: { type: 'GIVE_UP' }, expect: null },
];

test('状态机：表格驱动覆盖全部合法与非法转移（' + CASES.length + ' 例）', () => {
  for (const c of CASES) {
    const r = transition(c.from, c.event, NOW);
    if (c.expect === null) {
      assert.equal(r, null, `[${c.name}] 应为非法转移`);
      continue;
    }
    assert.ok(r, `[${c.name}] 应为合法转移`);
    if (c.expect.status !== undefined)
      assert.equal(r.state.status, c.expect.status, `[${c.name}] status`);
    if (c.expect.followup !== undefined)
      assert.equal(r.state.followup_count, c.expect.followup, `[${c.name}] followup_count`);
    if (c.expect.next === 'unchanged')
      assert.equal(r.state.next_action_at, c.from.next_action_at, `[${c.name}] next_action_at`);
    else if (typeof c.expect.next === 'number')
      assert.equal(r.state.next_action_at, c.expect.next, `[${c.name}] next_action_at`);
    if (c.expect.effects)
      assert.deepEqual(r.effects, c.expect.effects, `[${c.name}] effects`);
  }
});

test('追问硬上限保护：任何路径都不可能追问超过 MAX_FOLLOWUPS 次', () => {
  // 模拟「无限拖延」：ask → snooze → ask → snooze → ...
  let s = st('pending');
  let asks = 0;
  for (let i = 0; i < 20; i++) {
    const r1 = transition(s, { type: 'ASK' }, NOW);
    assert.ok(r1);
    if (r1.effects.includes('ask')) asks++;
    if (r1.state.status === 'given_up') break;
    const r2 = transition(r1.state, { type: 'SNOOZE' }, NOW);
    assert.ok(r2);
    if (r2.state.status === 'given_up') break;
    s = r2.state;
  }
  assert.ok(asks <= MAX_FOLLOWUPS, `实际追问 ${asks} 次，超过上限`);
});
