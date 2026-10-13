import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime } from '../src/agent/agent.js';

/** 构造本地时间 */
function at(y: number, mo: number, d: number, h: number, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi).getTime();
}

test('parseTime：中文数字与晚前缀', () => {
  const now19 = at(2026, 10, 13, 19, 0);   // 19:00，8点还没到
  const now22 = at(2026, 10, 13, 22, 30);  // 22:30，8点已过

  // 中文数字 + 今晚 → PM
  assert.equal(parseTime('我打算今晚八点跑步', now19), at(2026, 10, 13, 20, 0));
  // 已过时刻顺延明天
  assert.equal(parseTime('我打算今晚八点跑步', now22), at(2026, 10, 14, 20, 0));
  // 阿拉伯数字 + 今晚 → 同样转 PM（不能解析成早上 08:00）
  assert.equal(parseTime('我打算今晚8点跑步', now19), at(2026, 10, 13, 20, 0));
  // 八点半
  assert.equal(parseTime('今晚八点半', now19), at(2026, 10, 13, 20, 30));
  // 晚上八点（带"晚上"前缀）
  assert.equal(parseTime('晚上八点开会', now19), at(2026, 10, 13, 20, 0));
  // 明早七点
  assert.equal(parseTime('明早七点起床', now22), at(2026, 10, 14, 7, 0));
  // 明天下午不处理（没有"下午"词表），但"明天8点" → 明天 08:00
  assert.equal(parseTime('明天8点交报告', now22), at(2026, 10, 14, 8, 0));
  // 24小时制 20:00
  assert.equal(parseTime('20:00 开始', now19), at(2026, 10, 13, 20, 0));
  // 中文十位数：十一点 → 23点（晚前缀）
  assert.equal(parseTime('今晚十一点前', now19), at(2026, 10, 13, 23, 0));
  // 无时间表述 → null
  assert.equal(parseTime('随便聊聊', now19), null);
});
