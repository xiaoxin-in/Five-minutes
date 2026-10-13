import type { DatabaseSync } from 'node:sqlite';
import * as repo from '../repo.js';

/** Agent 动作：由 API 层落库（与 LLM 工具调用一一对应） */
export type AgentAction =
  | { type: 'create_task'; title: string; quadrant?: number; is_tiny?: boolean; kind?: 'todo' | 'errand' }
  | { type: 'create_commitment'; title: string; due_at: number }
  | { type: 'complete_task'; note: string };

export interface AgentReply {
  text: string;
  chips?: string[];
  actions: AgentAction[];
}

export interface AgentService {
  reply(userText: string): AgentReply;
}

/** 中文数字 → 阿拉伯数字（支持：八、十、十一、二十三、两、零） */
function cnNum(s: string): number | null {
  if (/^\d+$/.test(s)) { const n = Number(s); return n >= 0 && n <= 59 ? n : null; }
  const M: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s.length === 1 && s in M) return M[s];
  const i = s.indexOf('十');
  if (i === -1) return s.split('').every(c => c in M) ? M[s] : null;
  const high = i === 0 ? 1 : M[s.slice(0, i)];
  const low = i === s.length - 1 ? 0 : M[s.slice(i + 1)];
  if (high === undefined || low === undefined) return null;
  return high * 10 + low;
}

/**
 * 解析时间表述，返回 epoch ms；解析不出返回 null
 * 支持：今晚8点 / 今晚八点 / 晚上八点半 / 明早七点 / 20:00
 * 带"晚"前缀且小时 <12 自动转 PM；已过时刻顺延到明天
 */
export function parseTime(text: string, now: number): number | null {
  const m = text.match(/(今晚|晚上|今天|明早|明天|明晚)?\s*([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*[:点时]\s*([0-9]{1,2})?\s*(半)?/);
  if (!m) return null;
  let hour = cnNum(m[2]);
  let minute = m[4] ? 30 : (m[3] ? Number(m[3]) : 0);
  if (hour === null || hour > 23 || minute > 59) return null;
  const rel = m[1];
  if (rel && /晚/.test(rel) && hour < 12) hour += 12;   // 今晚八点 → 20 点
  if (rel === '明早' && hour >= 12) hour -= 12;           // 明早七点按 AM 处理
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  const tomorrow = rel === '明早' || rel === '明天' || rel === '明晚';
  if (tomorrow) d.setDate(d.getDate() + 1);
  if (d.getTime() <= now && !tomorrow) d.setDate(d.getDate() + 1); // 已过则顺延到明天
  return d.getTime();
}

/**
 * 规则引擎 Agent：LLM 未配置 key 时的降级实现（对应技术方案「LLM 失败降级」）。
 * 语气与 prompts.ts 中的铁律保持一致。
 */
export class RuleBasedAgent implements AgentService {
  constructor(private db: DatabaseSync) {}

  reply(userText: string): AgentReply {
    const t = userText.trim();
    const now = Date.now();
    const victoryCount = repo.countVictoriesSince(this.db, 0);

    // 情绪优先：接住"我又废了"
    if (/又废|啥也没干|浪费了|拖延|自责|烦/.test(t)) {
      return {
        text: '正常。人回避的从来不是任务，是不适感。<br>现在别想一整天，想<b>接下来 5 分钟</b>——去倒杯水回来，我等你。',
        chips: ['倒了，回来了'],
        actions: [],
      };
    }
    if (t === '倒了，回来了') {
      return {
        text: '好，重启成功 🌱<br>把你心里挂着的那件事告诉我，哪怕它大得吓人。',
        actions: [],
      };
    }

    // 承诺：我打算 + 时间
    if (/我打算|我要|计划|今晚|明早|明天/.test(t) && /跑步|运动|锻炼|健身|走|跑/.test(t)) {
      const due = parseTime(t, now) ?? now + 2 * 3600 * 1000;
      const hm = new Date(due).toTimeString().slice(0, 5);
      const sameDay = new Date(due).toDateString() === new Date(now).toDateString();
      const dueTxt = (sameDay ? '' : '明天 ') + hm;
      return {
        text: `收到。我先记下了：<b>${dueTxt}</b>。<br>启动门槛帮你降一下——目标改成：<b>穿上运动鞋下楼站 5 分钟</b>。跑不跑随意，站够就算赢。<br>到点我来问你，跑不掉的 😏`,
        actions: [
          { type: 'create_task', title: '穿上运动鞋下楼站 5 分钟', quadrant: 1, is_tiny: true },
          { type: 'create_commitment', title: '穿上运动鞋下楼站 5 分钟', due_at: due },
        ],
      };
    }

    // 大块头任务 → 2分钟启动器
    if (/我打算|我要|计划/.test(t)) {
      const raw = t.replace(/我打算|我要|计划/g, '').trim().slice(0, 12);
      return {
        text: `收到。这事听起来还不小，我先拆到<b>小到不好意思拒绝</b>：<br>👉 第一步只要 5 分钟：<b>打开它，只做第一小格</b>。<br>做完告诉我，我记进你的胜利清单。`,
        actions: [{ type: 'create_task', title: `（拆解版）${raw} · 第一步`, quadrant: 2, is_tiny: true }],
      };
    }
    if (/论文|报告|总结|简历|报税|大扫除|体检/.test(t)) {
      return {
        text: '这种大块头拖着最正常。不上价值，直接拆：<br>1️⃣ 打开文档（就这一下）<br>2️⃣ 写一句标题/删一句话（随便哪个）<br>3️⃣ 关掉，明天再说也行<br>今天只要走到第 1 步，就赢了。现在打开？',
        chips: ['打开了', '还是算了'],
        actions: [],
      };
    }
    if (t === '打开了') {
      return {
        text: '记下了 ✅ 你今天"启动了"它。<br>别小看这一下——昨天它在你后台挂了 6 天。',
        actions: [{ type: 'complete_task', note: '启动了大块头任务' }],
      };
    }
    if (t === '还是算了') {
      return {
        text: '行，不逼你。它先在清单里躺着，我只负责在你状态好的时候提醒你一句。',
        actions: [],
      };
    }

    // 完成汇报 → 微小胜利
    if (/完成了|搞定|做完了|干完了|胜利/.test(t)) {
      return {
        text: `记下了 ✅ 胜利清单 +1<br>你一共完成了 <b>${victoryCount + 1}</b> 件事——不是"啥也没干"。`,
        actions: [{ type: 'complete_task', note: '口头汇报完成' }],
      };
    }

    return {
      text: '嗯，我在。想从一件 5 分钟的小事开始，还是先跟我说说挂着的事？',
      actions: [],
    };
  }
}

/**
 * LLM Agent 适配器：配置 FIVEMIN_LLM_KEY 后启用（M2 后续接入真实调用）。
 * 当前返回 null 表示未启用，调用方降级到 RuleBasedAgent。
 */
export class LlmAgent implements AgentService {
  constructor(private apiKey: string | undefined) {}
  get enabled(): boolean { return Boolean(this.apiKey); }
  reply(): AgentReply {
    throw new Error('LLM Agent 未实现：请使用 RuleBasedAgent');
  }
}

/** 工厂：有 key 用 LLM，没 key 用规则引擎 */
export function createAgent(db: DatabaseSync): AgentService {
  const llm = new LlmAgent(process.env.FIVEMIN_LLM_KEY);
  return llm.enabled ? llm : new RuleBasedAgent(db);
}
