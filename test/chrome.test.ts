import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chromeUserDataDir, describeGate, detectActiveProfile, gateFor } from "../src/chrome.ts";
import { defaultSettings, withProfileAllowed } from "../src/settings.ts";

/**
 * 造一个假的 Chrome 用户数据目录。
 *
 * 用真实文件而不是 mock fs：这个模块的全部难点就在「磁盘上到底长什么样」——
 * Local State 缺失、profile 目录没有 Preferences、mtime 与 Local State 对不上，
 * 每一条都是实际会遇到的状态。把文件系统换成假的，这些状态就全都测不到了。
 */
async function fakeChrome(spec: {
  profiles: Record<string, { name?: string; mtime?: number } | null>;
  lastActive?: string[] | null;
  noLocalState?: boolean;
}): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/bright-sight-chrome-`);
  const infoCache: Record<string, { name: string }> = {};

  for (const [pf, cfg] of Object.entries(spec.profiles)) {
    await mkdir(`${dir}/${pf}`, { recursive: true });
    if (cfg) {
      const file = `${dir}/${pf}/Preferences`;
      await writeFile(file, "{}");
      if (cfg.mtime !== undefined) await utimes(file, cfg.mtime, cfg.mtime);
      if (cfg.name) infoCache[pf] = { name: cfg.name };
    }
  }
  // 一个不该被当成 profile 的同级目录
  await mkdir(`${dir}/System Profile`, { recursive: true });

  if (!spec.noLocalState) {
    await writeFile(
      `${dir}/Local State`,
      JSON.stringify({ profile: { last_active_profiles: spec.lastActive ?? [], info_cache: infoCache } }),
    );
  }
  return dir;
}

test("chrome: 用户数据目录从 homedir 拼出来，不写死任何人的家目录", () => {
  assert.equal(chromeUserDataDir("/home/某人"), "/home/某人/Library/Application Support/Google/Chrome");
});

test("chrome: Local State 指出的 profile 就是当前在用的", async () => {
  const dir = await fakeChrome({
    profiles: { Default: { name: "甲", mtime: 1000 }, "Profile 1": { name: "乙", mtime: 2000 } },
    lastActive: ["Profile 1"],
  });
  const d = await detectActiveProfile(dir);
  assert.equal(d.ok, true);
  assert.ok(d.ok && d.active.dir === "Profile 1");
  assert.ok(d.ok && d.active.name === "乙");
});

test("chrome: 只认 Default 与 Profile N，同级的其它目录不算 profile", async () => {
  const dir = await fakeChrome({ profiles: { Default: { mtime: 1000 } }, lastActive: ["Default"] });
  const d = await detectActiveProfile(dir);
  assert.ok(d.ok);
  assert.deepEqual(d.all.map((p) => p.dir), ["Default"], "System Profile 不是用户 profile");
});

test("chrome: Local State 缺席时退回 mtime 最新的那个", async () => {
  const dir = await fakeChrome({
    profiles: { Default: { mtime: 1000 }, "Profile 2": { mtime: 9000 } },
    noLocalState: true,
  });
  const d = await detectActiveProfile(dir);
  assert.ok(d.ok);
  assert.equal(d.active.dir, "Profile 2");
  assert.equal(d.byState, null);
  assert.equal(d.agree, false, "只有一路给出了答案，就不算两路印证过");
});

test("chrome: 两路对不上时如实记下来——Local State 的写入滞后数秒", async () => {
  const dir = await fakeChrome({
    profiles: { Default: { mtime: 1000 }, "Profile 1": { mtime: 9000 } },
    lastActive: ["Default"],
  });
  const d = await detectActiveProfile(dir);
  assert.ok(d.ok);
  assert.equal(d.active.dir, "Default", "Local State 优先，它的语义最直接");
  assert.equal(d.byMtime, "Profile 1");
  assert.equal(d.agree, false);
});

test("chrome: Local State 指向一个已经不存在的目录时不采信它", async () => {
  const dir = await fakeChrome({
    profiles: { Default: { mtime: 1000 } },
    lastActive: ["Profile 404"],
  });
  const d = await detectActiveProfile(dir);
  assert.ok(d.ok);
  assert.equal(d.active.dir, "Default");
});

test("chrome: 一个 profile 都没有时如实判失败", async () => {
  const dir = await mkdtemp(`${tmpdir()}/bright-sight-chrome-空-`);
  const d = await detectActiveProfile(dir);
  assert.equal(d.ok, false);
  assert.ok(!d.ok && /没有找到/.test(d.reason));
});

test("chrome: profile 目录没有 Preferences 时跳过它而不是整次探测失败", async () => {
  const dir = await fakeChrome({
    profiles: { Default: null, "Profile 1": { mtime: 5000 } },
    noLocalState: true,
  });
  const d = await detectActiveProfile(dir);
  assert.ok(d.ok);
  assert.equal(d.active.dir, "Profile 1");
});

test("chrome: 闸门默认不放行——名单是空的时候谁都要问一句", async () => {
  const dir = await fakeChrome({ profiles: { Default: { mtime: 1 } }, lastActive: ["Default"] });
  const d = await detectActiveProfile(dir);
  assert.equal(gateFor(d, defaultSettings()).kind, "unknown");
});

test("chrome: 名单里有、且两路印证一致，才放行", async () => {
  const dir = await fakeChrome({ profiles: { Default: { mtime: 1 } }, lastActive: ["Default"] });
  const d = await detectActiveProfile(dir);
  const gate = gateFor(d, withProfileAllowed(defaultSettings(), "Default"));
  assert.equal(gate.kind, "allowed");
  assert.ok(gate.kind === "allowed" && gate.via === "settings");
});

test("chrome: 两路对不上、且另一个候选没确认过时要问——结论本身不可靠", async () => {
  const dir = await fakeChrome({
    profiles: { Default: { mtime: 1000 }, "Profile 1": { mtime: 9000 } },
    lastActive: ["Default"],
  });
  const d = await detectActiveProfile(dir);
  const gate = gateFor(d, withProfileAllowed(defaultSettings(), "Default"));
  assert.equal(gate.kind, "unknown", "刚切过 profile 时，Local State 还停在上一个");
});

test("chrome: 两路对不上但两个候选都确认过，就不必再问", async () => {
  // 同时开着两个都已确认的 profile 是日常场景，真实答案必定是这两个之一，
  // 无论哪个都被允许——这时再打断一次纯属噪音
  const dir = await fakeChrome({
    profiles: { Default: { mtime: 1000 }, "Profile 1": { mtime: 9000 } },
    lastActive: ["Default"],
  });
  const d = await detectActiveProfile(dir);
  let s = withProfileAllowed(defaultSettings(), "Default");
  s = withProfileAllowed(s, "Profile 1");
  assert.equal(gateFor(d, s).kind, "allowed");
});

test("chrome: 两个候选里只要有一个没确认过，就退回要问", async () => {
  const dir = await fakeChrome({
    profiles: { Default: { mtime: 1000 }, "Profile 1": { mtime: 9000 }, "Profile 2": { mtime: 500 } },
    lastActive: ["Default"],
  });
  const d = await detectActiveProfile(dir);
  const s = withProfileAllowed(defaultSettings(), "Default");
  assert.equal(gateFor(d, s).kind, "unknown", "Profile 1 从没被确认过");
});

test("chrome: 探测失败一律不放行", async () => {
  const dir = await mkdtemp(`${tmpdir()}/bright-sight-chrome-空2-`);
  const d = await detectActiveProfile(dir);
  assert.equal(gateFor(d, withProfileAllowed(defaultSettings(), "Default")).kind, "undetectable");
});

test("chrome: 给人看的那句话里才出现显示名，且只在需要认人时出现", async () => {
  const dir = await fakeChrome({
    profiles: { Default: { name: "工作账号", mtime: 1 } },
    lastActive: ["Default"],
  });
  const d = await detectActiveProfile(dir);
  const gate = gateFor(d, defaultSettings());
  const text = describeGate(gate, d);
  assert.match(text, /Default/);
  assert.match(text, /工作账号/, "人得能认出这是哪个 profile");
  assert.match(text, /不在允许名单内/);
});

test("chrome: 探测不出来时那句话说的是探测不出来，不假装知道是哪个", async () => {
  const dir = await mkdtemp(`${tmpdir()}/bright-sight-chrome-空3-`);
  const d = await detectActiveProfile(dir);
  assert.match(describeGate(gateFor(d, defaultSettings()), d), /探测不到/);
});
