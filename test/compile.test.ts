import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { PROBES, REGISTRY, type ScriptTemplate } from "../src/scripts.ts";
import { PERCEIVE_SCRIPTS } from "../src/perceive.ts";

const run = promisify(execFile);

/**
 * 静态语法门禁。
 *
 * `osacompile` 只编译，不执行，也不投递任何 Apple Event——所以这一档可以无条件跑，
 * 不需要自动化权限，也不会在别人的机器上产生副作用。
 *
 * 它存在的理由是一类反复出现的缺陷：AppleScript 的保留字表没有文档，踩中了只会在
 * **真跑的那一刻**报 -2741。本轮就踩了两个——`at`（`make new … at …` 的参数名）和
 * `st`（序数后缀，如 1st），此前还踩过 `after`。这三次都是等到发出 Apple Event 才发现的。
 * 编译一遍就能把它们全部提前到 `npm test`。
 */
const ALL: ScriptTemplate[] = [...Object.values(REGISTRY), ...Object.values(PROBES)];

async function compiles(src: string): Promise<{ ok: boolean; err: string }> {
  const dir = await mkdtemp(`${tmpdir()}/bright-sight-compile-`);
  const file = `${dir}/s.applescript`;
  await writeFile(file, src, "utf8");
  try {
    await run("osacompile", ["-o", `${dir}/s.scpt`, file], { timeout: 20_000 });
    return { ok: true, err: "" };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, err: (err.stderr ?? err.message ?? String(e)).trim() };
  }
}

for (const t of ALL) {
  test(`compile: ${t.id} 的脚本能通过 AppleScript 编译器`, async () => {
    const r = await compiles(t.src);
    assert.ok(r.ok, `${t.id} 编译失败：${r.err}`);
  });
}

/**
 * 感知层的脚本不在 scripts.ts 的注册表里（它们是只读感知，不是可被模型选中的动作），
 * 但保留字这个坑跟在不在注册表里毫无关系。不把它们挂进来就等于给自己开了个后门。
 */
for (const [id, src] of Object.entries(PERCEIVE_SCRIPTS)) {
  test(`compile: ${id} 的脚本能通过 AppleScript 编译器`, async () => {
    const r = await compiles(src);
    assert.ok(r.ok, `${id} 编译失败：${r.err}`);
  });
}

test("compile: 门禁本身有效——已知的保留字必须被判失败", async () => {
  // 阳性对照。没有它，上面那一批全过只能说明 osacompile 没在工作
  const bad = await compiles(`on run argv\n\tset at to 1\n\treturn at\nend run`);
  assert.equal(bad.ok, false, "编译器没有拦下已知的保留字，这道门禁是失效的");
  const worse = await compiles(`on run argv\n\tset st to 1\n\treturn st\nend run`);
  assert.equal(worse.ok, false);
});
