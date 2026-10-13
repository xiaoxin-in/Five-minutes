// smoke-test.mjs — demo/index.html 结构冒烟测试
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
let failed = 0;
const check = (name, cond) => {
  console.log((cond ? '  PASS' : '✗ FAIL') + '  ' + name);
  if (!cond) failed++;
};

// 1. 三个核心页面存在
for (const id of ['page-chat', 'page-todo', 'page-review']) {
  check(`包含页面 #${id}`, html.includes(`id="${id}"`));
}

// 2. 核心交互元素存在
for (const id of ['btn-jump', 'btn-reset', 'btn-batch', 'send', 'input', 'clock', 'toast']) {
  check(`包含交互元素 #${id}`, html.includes(`id="${id}"`));
}

// 3. 核心功能代码存在（追问闭环 / 启动器 / 批处理 / 胜利记录）
for (const kw of ['followedUp', 'addChips', 'agentReply', 'refreshStats', 'renderErrands']) {
  check(`包含逻辑函数 ${kw}`, html.includes(kw));
}

// 4. 无外部占位符资源（所有资源必须内联/本地）
check('无外链 http(s) 资源引用', !/src\s*=\s*["']https?:\/\//.test(html) && !/href\s*=\s*["']https?:\/\//.test(html));

// 5. 关键 UI 文案存在（验证内容非空壳）
for (const txt of ['5分钟', '微小胜利', '时间照妖镜', '琐事清单']) {
  check(`包含关键文案「${txt}」`, html.includes(txt));
}

// 6. 基本标签配对
const open = (html.match(/<div/g) || []).length;
const close = (html.match(/<\/div>/g) || []).length;
check(`div 标签配对 (${open}/${close})`, open === close);

console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
