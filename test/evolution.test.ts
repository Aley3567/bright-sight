import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeScheduled,
  evidenceFromJournal,
  openEvolutionStore,
  type CorrectionInput,
  type MemoryScope,
} from "../src/evolution.ts";
import type { JournalEvent } from "../src/journal.ts";

const SCOPE: MemoryScope = { application: "Google Chrome+Notes", taskKind: "Google Chrome.make-tab>Notes.make-note" };

function preference(instruction: string, runId = "run-1"): CorrectionInput {
  return {
    runId,
    scope: SCOPE,
    rawConversation: [instruction],
    verifyFailures: [],
    proposed: { kind: "preference", instruction },
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "bright-sight-evolution-"));
  let seq = 0;
  let clock = Date.parse("2026-09-20T00:00:00.000Z");
  const store = openEvolutionStore({ dir, now: () => clock, nextId: () => `id-${++seq}` });
  return {
    dir,
    store,
    advance: (days: number) => { clock += days * 24 * 60 * 60 * 1000; },
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test("明确纠正生成候选，同一作用域的再次纠正合并而不堆积", async () => {
  const f = await fixture();
  try {
    const first = await f.store.recordCorrection(preference("先筛选，再打开"));
    const second = await f.store.recordCorrection(preference("先按时间筛选，再打开", "run-2"));
    const memories = await f.store.list();
    assert.equal(memories.length, 1);
    assert.equal(second.memory.id, first.memory.id);
    assert.equal(second.memory.evidenceIds.length, 2);
    assert.deepEqual((second.memory.body as { instruction: string }).instruction, "先按时间筛选，再打开");

    const raw = await readFile(join(f.dir, "corrections.jsonl"), "utf8");
    assert.match(raw, /先筛选，再打开/);
    assert.match(raw, /先按时间筛选，再打开/);
  } finally {
    await f.close();
  }
});

test("新版本启用时，同作用域旧活动版本被替代", async () => {
  const f = await fixture();
  try {
    const v1 = (await f.store.recordCorrection(preference("按时间排序"))).memory;
    await assert.rejects(() => f.store.activate(v1.id), /尚未通过/);
    await f.store.markValidated(v1.id, true, ["fixture_replayed"]);
    await f.store.activate(v1.id);
    const v2 = (await f.store.recordCorrection(preference("先过滤未读，再按时间排序", "run-2"))).memory;
    await f.store.markValidated(v2.id, true, ["fixture_replayed"]);
    await f.store.activate(v2.id);
    const memories = await f.store.list();
    assert.equal(memories.find((m) => m.id === v1.id)?.status, "superseded");
    assert.equal(memories.find((m) => m.id === v2.id)?.status, "active");
    assert.equal(memories.filter((m) => m.status === "active").length, 1);
  } finally {
    await f.close();
  }
});

test("负面反馈暂停当前版本；清理保留活动版本并按 30/90 天删除历史", async () => {
  const f = await fixture();
  try {
    const active = (await f.store.recordCorrection(preference("活动规则"))).memory;
    await f.store.markValidated(active.id, true, ["fixture_replayed"]);
    await f.store.activate(active.id);
    const candidate = (await f.store.recordCorrection({ ...preference("另一作用域"), scope: { application: "Notes", taskKind: "Notes.make-note" } })).memory;
    await f.store.setStatus(active.id, "suspended");
    f.advance(31);
    assert.equal(await f.store.prune(), 1, "30 天只清除未采用候选");
    assert.ok(!(await f.store.list()).some((m) => m.id === candidate.id));
    assert.doesNotMatch(await readFile(join(f.dir, "corrections.jsonl"), "utf8"), /另一作用域/);
    f.advance(60);
    assert.equal(await f.store.prune(), 1, "暂停版本进入 90 天历史清理");
    assert.equal(await readFile(join(f.dir, "corrections.jsonl"), "utf8"), "");
  } finally {
    await f.close();
  }
});

test("忘记会删除同作用域派生记忆和原始纠正，只留下无内容删除记录", async () => {
  const f = await fixture();
  try {
    const memory = (await f.store.recordCorrection(preference("这是一条需要删除的原始纠正"))).memory;
    assert.equal(await f.store.forget(memory.id), 1);
    assert.deepEqual(await f.store.list(), []);
    assert.doesNotMatch(await readFile(join(f.dir, "corrections.jsonl"), "utf8"), /需要删除/);
    assert.doesNotMatch(await readFile(join(f.dir, "deletions.jsonl"), "utf8"), /需要删除/);
  } finally {
    await f.close();
  }
});

test("journal 只提供结构化证据；定时授权必须精确匹配且永不允许 destroy", () => {
  const event = (phase: JournalEvent["phase"], step: number, data: unknown): JournalEvent => ({
    id: `${phase}-${step}`,
    at: "2026-09-20T00:00:00.000Z",
    runId: "run",
    step,
    phase,
    redacted: true,
    data,
  });
  const evidence = evidenceFromJournal([
    event("judge", 1, { judgement: { action: "Google Chrome.make-tab" } }),
    event("act", 1, { ok: true }),
    event("verify", 1, { checks: [{ name: "tab_appeared", ok: true }] }),
    event("judge", 2, { judgement: { action: "Notes.make-note" } }),
    event("act", 2, { ok: true }),
    event("verify", 2, { checks: [{ name: "note_appeared", ok: false }] }),
  ]);
  assert.equal(evidence.scope.taskKind, "Google Chrome.make-tab>Notes.make-note");
  assert.deepEqual(evidence.verifyFailures, ["note_appeared"]);

  const grant = {
    memoryVersionId: "memory-v2",
    application: "Notes",
    target: "default-folder",
    inputFingerprint: "abc123",
    effect: "submit" as const,
    verify: ["note_appeared"],
  };
  assert.equal(authorizeScheduled({ ...grant }, grant).allowed, true);
  assert.equal(authorizeScheduled({ ...grant, target: "other" }, grant).allowed, false);
  assert.equal(authorizeScheduled({ ...grant, effect: "destroy" }, grant).allowed, false);
});
