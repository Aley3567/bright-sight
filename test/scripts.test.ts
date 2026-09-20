import test from "node:test";
import assert from "node:assert/strict";
import { PROBES, REGISTRY, executableIds, probeOf, templateOf } from "../src/scripts.ts";
import { isAllowedApp } from "../src/config.ts";
import type { ScriptTemplate } from "../src/scripts.ts";

const ALL: ScriptTemplate[] = [...Object.values(REGISTRY), ...Object.values(PROBES)];

test("scripts: 每个模板的源码都不含模板插值，值只能走 argv", () => {
  // 纯字符串断言，一次挡掉整整一类注入 bug：源码里出现 ${ 就意味着有值被拼进了脚本文本
  for (const t of ALL) {
    assert.ok(!t.src.includes("${"), `${t.id} 的脚本源码里有模板插值`);
  }
});

test("scripts: 每个模板都用 on run argv 接收参数", () => {
  for (const t of ALL) {
    assert.match(t.src, /on run argv/, `${t.id} 没有 on run argv`);
    assert.match(t.src, /end run/, `${t.id} 没有 end run`);
  }
});

test("scripts: 脚本里引用的 argv 下标恰好覆盖声明的参数个数", () => {
  for (const t of ALL) {
    const used = new Set([...t.src.matchAll(/item\s+(\d+)\s+of\s+argv/g)].map((m) => Number(m[1])));
    assert.equal(used.size, t.argv.length, `${t.id} 声明 ${t.argv.length} 个参数，脚本里用了 ${used.size} 个`);
    for (let i = 1; i <= t.argv.length; i++) {
      assert.ok(used.has(i), `${t.id} 没有用到 item ${i} of argv`);
    }
  }
});

test("scripts: 每个模板都回传带前缀的记录，字段数与声明一致", () => {
  for (const t of ALL) {
    assert.match(t.src, /"RB1"/, `${t.id} 的回读没有 RB1 前缀，格式损坏将无法检测`);
    assert.ok(t.fields.length > 0, `${t.id} 没有声明回读字段`);
  }
});

test("scripts: 运行时注册表里没有任何破坏性模板", () => {
  for (const t of Object.values(REGISTRY)) {
    assert.notEqual(t.effect, "destroy", `${t.id} 是破坏性模板，不该出现在运行时注册表里`);
  }
});

test("scripts: 运行时注册表只涉及白名单内的应用", () => {
  for (const t of Object.values(REGISTRY)) {
    assert.ok(isAllowedApp(t.app), `${t.id} 的应用 ${t.app} 不在白名单内`);
  }
});

test("scripts: Chrome 的任意 JavaScript 执行不在注册表里", () => {
  // execute 的 riskOf() 判定是 safe，黑名单拦不住它；它压根不进注册表才是结构性解法
  for (const id of executableIds()) {
    assert.ok(!id.endsWith(".execute"), `${id} 提供了任意代码执行路径`);
  }
  assert.equal(templateOf("Google Chrome.execute"), undefined);
});

test("scripts: 注册表键与模板自述的 id 一致", () => {
  for (const [key, t] of Object.entries(REGISTRY)) assert.equal(key, t.id);
  for (const [key, t] of Object.entries(PROBES)) assert.equal(key, t.id);
});

test("scripts: 产物映射指向的字段必须真的会被回传", () => {
  for (const t of Object.values(REGISTRY)) {
    for (const [key, field] of Object.entries(t.produces ?? {})) {
      assert.ok(t.fields.includes(field), `${t.id} 的产物 ${key} 指向了不会回传的字段 ${field}`);
    }
  }
});

test("scripts: 需要 HTML 转义的参数下标都在范围内", () => {
  for (const t of ALL) {
    for (const i of t.htmlArgs ?? []) {
      assert.ok(i >= 0 && i < t.argv.length, `${t.id} 的 htmlArgs 下标 ${i} 越界`);
    }
  }
});

test("scripts: 会等待页面加载的模板，超时必须给够", () => {
  // 实测 Google 搜索页加载 7.6s，osa 默认 8s 超时会把成功的动作判成失败
  const tab = REGISTRY["Google Chrome.make-tab"];
  assert.ok(tab.timeoutMs >= 20_000, `make-tab 超时 ${tab.timeoutMs}ms 不足以覆盖实测的页面加载耗时`);
});

test("scripts: 探针可按动作查到，未注册的动作查不到", () => {
  assert.ok(probeOf("probe.notes-count"));
  assert.equal(probeOf("probe.不存在"), undefined);
});

test("scripts: Chrome 的模板不靠 window 1 回读——那是叠放顺序，不是我们的窗口", () => {
  // 实测：在另一个 profile 下新开的窗口排在 win2，原 profile 的窗口仍是 win1。
  // 按位置回读会读到别人的页面，这是同名 Notes 文件夹、同名笔记之后同一类缺陷的第三次出现。
  const tab = REGISTRY["Google Chrome.make-tab"];
  assert.ok(!/window 1/.test(tab.src), "make-tab 仍在按窗口序号定位");
  assert.match(tab.src, /id of t\b/, "没有在创建的那一瞬间抓住 tab id");
  assert.ok(tab.fields.includes("tab_id"), "tab id 必须回传，否则 verify 无从定向回读");
  assert.equal(tab.produces?.["chrome.tab_id"], "tab_id");
});

test("scripts: 定向回读探针按 tab id 查找，且查不到时如实回答", () => {
  const p = PROBES["probe.chrome-tab"];
  assert.ok(p, "缺少按 id 定向回读的探针");
  assert.deepEqual([...p.argv], ["tab_id"]);
  assert.ok(p.fields.includes("found"), "查不到必须能和查到区分开");
  assert.equal(p.effect, "read", "探针不得有副作用");
});

test("scripts: 计数探针数的是全部窗口的标签页，不是某一个窗口的", () => {
  // 新标签页落在哪个窗口由 Chrome 决定（profile 不同就会落在不同窗口），
  // 只数一个窗口会让 tab_appeared 在完全正常的情况下判失败
  const p = PROBES["probe.chrome-counts"];
  assert.match(p.src, /repeat with wi from 1 to nw/, "没有遍历全部窗口");
  assert.ok(!/count of tabs of window 1/.test(p.src), "仍在只数 window 1 的标签页");
});

test("scripts: 探针一律是只读的，模型永远选不到它们", () => {
  for (const p of Object.values(PROBES)) {
    assert.equal(p.effect, "read", `${p.id} 不是只读探针`);
    assert.equal(templateOf(p.id), undefined, `${p.id} 出现在了模型可选的注册表里`);
  }
});
