import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal, readJournal, ulid } from "../src/journal.ts";
import { makeRedactor } from "../src/redact.ts";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bright-sight-journal-"));
}

test("journal: 四步事件按发生顺序落盘，读回来一模一样", async () => {
  const dir = await tmp();
  const j = await openJournal({ dir });
  await j.append("observe", 1, { front: "Terminal" });
  await j.append("judge", 1, { action: "Notes.make-note" });
  await j.append("act", 1, { argv: ["标题", "正文"] });
  await j.append("verify", 1, { ok: true });

  const { events, broken } = await readJournal(j.path);
  assert.equal(broken, 0);
  assert.deepEqual(events.map((e) => e.phase), ["observe", "judge", "act", "verify"]);
  assert.equal(events.every((e) => e.runId === j.runId), true);
  assert.deepEqual((events[2].data as { argv: string[] }).argv, ["标题", "正文"]);
});

test("journal: 每行是独立的 JSON，坏掉一行不影响其余", async () => {
  const dir = await tmp();
  const j = await openJournal({ dir });
  await j.append("observe", 1, { a: 1 });
  await writeFile(j.path, "{这行不是 JSON\n", { flag: "a" });
  await j.append("judge", 1, { b: 2 });

  const { events, broken } = await readJournal(j.path);
  assert.equal(events.length, 2, "损坏的行不该带走好的行");
  assert.equal(broken, 1);
});

test("journal: 值里的换行和引号不会破坏行结构", async () => {
  const dir = await tmp();
  const j = await openJournal({ dir });
  const nasty = 'a"b\nc\\d\u001e末尾';
  await j.append("act", 1, { argv: [nasty] });
  const { events, broken } = await readJournal(j.path);
  assert.equal(broken, 0);
  assert.equal((events[0].data as { argv: string[] }).argv[0], nasty);
});

test("journal: 目录写不进去时不抛异常，但如实计数", async () => {
  // 留痕失败不能把正在进行的操作搞崩——但也不能假装记下了
  const j = await openJournal({ dir: "/dev/null/不可能存在的目录" });
  // 断言的是契约本身（不抛、不假装成功），不是具体数字——建目录失败也算一次，
  // 把那个数钉死只会让计数语义的任何调整都变成一次假警报
  await j.append("observe", 1, { a: 1 });
  await j.append("judge", 1, { b: 2 });
  assert.ok(j.failures() >= 2, `两次写入都该被记为失败，实际 ${j.failures()}`);
});

test("journal: 同一次 run 的事件写进同一个文件", async () => {
  const dir = await tmp();
  const j = await openJournal({ dir, runId: "FIXEDRUNID" });
  await j.append("observe", 1, {});
  assert.match(j.path, /FIXEDRUNID/);
  const raw = await readFile(j.path, "utf8");
  assert.equal(raw.trimEnd().split("\n").length, 1);
});

test("ulid: 同一毫秒内也各不相同，且按时间字典序递增", () => {
  let t = 1_758_326_400_000;
  const fixed = ulid({ now: () => t });
  const same = ulid({ now: () => t });
  assert.equal(fixed.length, 26);
  assert.notEqual(fixed, same, "随机段要保证同毫秒不撞");
  assert.equal(fixed.slice(0, 10), same.slice(0, 10), "同一毫秒的时间段应当相同");

  t += 1;
  const later = ulid({ now: () => t });
  assert.ok(later.slice(0, 10) > fixed.slice(0, 10), "时间段必须字典序递增，否则按文件名排序就失效");
});

test("ulid: 只用 Crockford base32 字符，能安全当文件名", () => {
  let t = 1_758_326_400_000;
  for (let i = 0; i < 200; i++) {
    assert.match(ulid({ now: () => t++ }), /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  }
});

test("journal: 读不存在的文件返回空而不是抛异常", async () => {
  const { events, broken } = await readJournal(join(await tmp(), "不存在.jsonl"));
  assert.deepEqual(events, []);
  assert.equal(broken, 0);
});

test("journal: 传了脱敏函数就用它，且逐条标注这一行是脱敏过的", async () => {
  const dir = `${await mkdtemp(`${tmpdir()}/bright-sight-journal-`)}/j`;
  const j = await openJournal({
    dir,
    runId: "RUN1",
    redact: (phase, data) => ({ phase, 脱敏: true, 原样: false, src: data }),
  });
  await j.append("observe", 1, { front: "Notes", window: "私密标题" });
  const { events } = await readJournal(j.path);
  assert.equal(events.length, 1);
  assert.equal(events[0].redacted, true);
  assert.equal((events[0].data as Record<string, unknown>).脱敏, true);
});

test("journal: 没传脱敏函数时如实标注这一行是原文", async () => {
  const dir = `${await mkdtemp(`${tmpdir()}/bright-sight-journal-`)}/j`;
  const j = await openJournal({ dir, runId: "RUN2" });
  await j.append("observe", 1, { front: "Notes", window: "私密标题" });
  const { events } = await readJournal(j.path);
  assert.equal(events[0].redacted, false, "分不清哪几行是原文，就答不出这份记录能不能给别人看");
  assert.equal((events[0].data as Record<string, unknown>).window, "私密标题");
});

test("journal: 脱敏发生在落盘之前——原文一个字都不该出现在文件里", async () => {
  const dir = `${await mkdtemp(`${tmpdir()}/bright-sight-journal-`)}/j`;
  const salt = "测试盐";
  const j = await openJournal({ dir, runId: "RUN3", redact: makeRedactor("hash", salt).event });
  await j.append("act", 1, { ok: true, argv: ["https://example.com/私密路径"], readback: { url: "私密回读" } });
  const raw = await readFile(j.path, "utf8");
  assert.ok(!raw.includes("私密路径"), "原文进了磁盘，脱敏就是摆设");
  assert.ok(!raw.includes("私密回读"));
  assert.ok(raw.includes("RUN3"));
});

test("journal: 脱敏函数抛错时不写坏行，也不把正在进行的操作搞崩", async () => {
  const dir = `${await mkdtemp(`${tmpdir()}/bright-sight-journal-`)}/j`;
  const j = await openJournal({
    dir,
    runId: "RUN4",
    redact: () => {
      throw new Error("脱敏炸了");
    },
  });
  await assert.rejects(() => j.append("observe", 1, { window: "私密" }), /脱敏炸了/);
  const raw = await readFile(j.path, "utf8").catch(() => "");
  assert.ok(!raw.includes("私密"), "脱敏失败时宁可不记，也不能把原文漏出去");
});

test("journal: 早于脱敏字段的旧记录，不能被当成已脱敏", async () => {
  // 这个字段是后加的。按 `=== false` 判的话，旧记录会因为字段缺失而被静默算成安全的——
  // 把「不知道」当成「没问题」，正是这类提示最该避免的失败。
  const dir = await tmp();
  const path = `${dir}/OLD.jsonl`;
  await writeFile(path, `${JSON.stringify({ id: "x", at: "2026-01-01T00:00:00.000Z", runId: "OLD", step: 1, phase: "observe", data: { window: "私密标题" } })}\n`);
  const { events } = await readJournal(path);
  assert.notEqual(events[0].redacted, true, "缺字段就是不知道，不能推定为已脱敏");
});

test("journal: 留痕文件权限是 0600，同机的其他用户读不到", async () => {
  const dir = `${await tmp()}/j`;
  const j = await openJournal({ dir, runId: "PERM" });
  await j.append("observe", 1, { front: "Notes" });
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(j.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});
