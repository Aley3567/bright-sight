import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { parseSdef } from "../src/actions.ts";
import { REGISTRY } from "../src/scripts.ts";

const run = promisify(execFile);
const DIR = new URL("../fixtures/sdef/", import.meta.url);

/** 对着提交进仓库的快照断言，结论就不会随本机应用版本漂移。 */
async function fixture(name: string): Promise<string> {
  return readFile(new URL(`${name}.sdef`, DIR), "utf8");
}

test("sdef: Notes 的 note 展开后参数恰好是 name 和 body", async () => {
  const specs = parseSdef(await fixture("Notes"), "Notes", await fixture("CocoaStandard"));
  const note = specs.find((s) => s.id === "Notes.make-note");
  assert.ok(note, "没有解析出 Notes.make-note");
  assert.deepEqual(note.params.map((p) => p.name).sort(), ["body", "name"]);
});

test("sdef: 只读属性被滤掉，不会当成可填的槽位喂给模型", async () => {
  const specs = parseSdef(await fixture("Notes"), "Notes", await fixture("CocoaStandard"));
  const names = specs.find((s) => s.id === "Notes.make-note")!.params.map((p) => p.name);
  for (const readonly of ["plaintext", "creation date", "id", "container", "modification date"]) {
    assert.ok(!names.includes(readonly), `只读属性 ${readonly} 不该出现在参数里`);
  }
});

test("sdef: 通用的 make 被展开项取代，不再和展开项互相稀释概率", async () => {
  const specs = parseSdef(await fixture("Notes"), "Notes", await fixture("CocoaStandard"));
  assert.equal(specs.find((s) => s.id === "Notes.make"), undefined);
  assert.ok(specs.some((s) => s.id.startsWith("Notes.make-")));
});

test("sdef: Chrome 展开出 make-tab，且它的参数是 URL", async () => {
  const specs = parseSdef(await fixture("Google Chrome"), "Google Chrome", await fixture("CocoaStandard"));
  const tab = specs.find((s) => s.id === "Google Chrome.make-tab");
  assert.ok(tab);
  assert.ok(tab.params.some((p) => p.name === "URL"));
});

test("sdef: 展开出的 id 与执行模板注册表的键对得上", async () => {
  const notes = parseSdef(await fixture("Notes"), "Notes", await fixture("CocoaStandard"));
  const chrome = parseSdef(await fixture("Google Chrome"), "Google Chrome", await fixture("CocoaStandard"));
  const ids = new Set([...notes, ...chrome].map((s) => s.id));
  // 两边对不上，模型就会选中一个执行层根本认不出的动作
  for (const id of Object.keys(REGISTRY)) assert.ok(ids.has(id), `注册表里的 ${id} 在动作面里不存在`);
});

test("sdef: Chrome 的任意 JavaScript 执行确实被解析了出来——它只是不进执行路径", async () => {
  const specs = parseSdef(await fixture("Google Chrome"), "Google Chrome", await fixture("CocoaStandard"));
  const exec = specs.find((s) => s.id === "Google Chrome.execute");
  assert.ok(exec, "动作面本来就该如实反映 sdef 里有什么");
  assert.equal(exec.risk, "safe", "动词黑名单判不出它危险——这正是改用允许清单的理由");
});

test("sdef: 解析器对空输入和畸形输入都不抛异常", () => {
  assert.deepEqual(parseSdef("", "X"), []);
  assert.deepEqual(parseSdef("   ", "X"), []);
  assert.deepEqual(parseSdef("<dictionary><command", "X"), []);
});

test("sdef: 本机真实 sdef 没有偏离快照的关键结论（漂移探测）", async (t) => {
  let own: string;
  try {
    own = (await run("sdef", ["/System/Applications/Notes.app"], { maxBuffer: 8 << 20 })).stdout;
  } catch {
    return t.skip("本机没有 Notes.app");
  }
  const specs = parseSdef(own, "Notes", await fixture("CocoaStandard"));
  assert.ok(specs.length > 0, "本机 sdef 一条命令都解析不出来，解析器多半已经失效");
  assert.ok(specs.some((s) => s.id === "Notes.make-note"), "本机 Notes ���不再提供 make-note，闭环需要重新对齐");
});
