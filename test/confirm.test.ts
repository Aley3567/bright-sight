import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { precheckProfile, type Asker } from "../src/confirm.ts";
import { loadSettings, saveSettings, defaultSettings, withProfileAllowed } from "../src/settings.ts";

/** 一个只有 Default、且 Local State 与 mtime 一致的干净环境。 */
async function chromeDir(profile = "Default"): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/bright-sight-confirm-chrome-`);
  await mkdir(`${dir}/${profile}`, { recursive: true });
  await writeFile(`${dir}/${profile}/Preferences`, "{}");
  await writeFile(
    `${dir}/Local State`,
    JSON.stringify({ profile: { last_active_profiles: [profile], info_cache: { [profile]: { name: "某个账号" } } } }),
  );
  return dir;
}

function base(): Promise<string> {
  return mkdtemp(`${tmpdir()}/bright-sight-confirm-base-`);
}

/** 记下被问了什么，以及回答什么。 */
function asker(answer: boolean): Asker & { asked: string[] } {
  const asked: string[] = [];
  const fn = (q: string) => {
    asked.push(q);
    return Promise.resolve(answer);
  };
  return Object.assign(fn, { asked });
}

test("confirm: profile 已在名单里就直接放行，一句都不问", async () => {
  const b = await base();
  await saveSettings(withProfileAllowed(defaultSettings("盐"), "Default"), b);
  const ask = asker(false);
  const r = await precheckProfile({ base: b, dataDir: await chromeDir(), ask });
  assert.equal(r.gate.kind, "allowed");
  assert.equal(r.declined, false);
  assert.deepEqual(ask.asked, [], "名单里本来就有，不该打扰人");
});

test("confirm: 陌生 profile 答 y 就放行，并记进名单", async () => {
  const b = await base();
  const ask = asker(true);
  const r = await precheckProfile({ base: b, dataDir: await chromeDir(), ask });
  assert.equal(r.gate.kind, "allowed");
  assert.ok(r.gate.kind === "allowed" && r.gate.via === "prompt", "要分得清是人刚拍的板还是名单里本来就有");
  assert.equal(ask.asked.length, 1);
  assert.deepEqual((await loadSettings(b)).chrome.allowedProfiles, ["Default"], "答应过一次就不该再问第二次");
});

test("confirm: 问的那句话里带着显示名，人才认得出是哪个 profile", async () => {
  const ask = asker(true);
  await precheckProfile({ base: await base(), dataDir: await chromeDir(), ask });
  assert.match(ask.asked[0], /某个账号/);
  assert.match(ask.asked[0], /\[y\/N\]/);
});

test("confirm: 答 n 就收手，什么都不记", async () => {
  const b = await base();
  const r = await precheckProfile({ base: b, dataDir: await chromeDir(), ask: asker(false) });
  assert.equal(r.declined, true);
  assert.equal(r.gate.kind, "unknown", "被拒绝的闸门不该被改写成放行");
  assert.deepEqual((await loadSettings(b)).chrome.allowedProfiles, []);
});

test("confirm: 没人可问时不假装问过，把闸门原样交给 policy", async () => {
  // 非 TTY（CI、管道）下走这条路：预检不做决定，policy 那道兜底闸会拦成 confirm
  const b = await base();
  const r = await precheckProfile({ base: b, dataDir: await chromeDir(), ask: null });
  assert.equal(r.gate.kind, "unknown");
  assert.equal(r.declined, false, "没问过不等于被拒绝");
  assert.deepEqual((await loadSettings(b)).chrome.allowedProfiles, []);
});

test("confirm: 探测不出 profile 时答 y 只对这一次生效，不写进名单", async () => {
  const b = await base();
  const empty = await mkdtemp(`${tmpdir()}/bright-sight-confirm-空-`);
  const ask = asker(true);
  const r = await precheckProfile({ base: b, dataDir: empty, ask });
  assert.equal(r.gate.kind, "allowed");
  assert.ok(r.gate.kind === "allowed" && r.gate.via === "prompt");
  assert.match(ask.asked[0], /只对这一次生效/);
  assert.deepEqual((await loadSettings(b)).chrome.allowedProfiles, [], "连是哪个都不知道，记什么都是假的");
});

test("confirm: 探测不出 profile 时答 n 同样收手", async () => {
  const empty = await mkdtemp(`${tmpdir()}/bright-sight-confirm-空2-`);
  const r = await precheckProfile({ base: await base(), dataDir: empty, ask: asker(false) });
  assert.equal(r.declined, true);
  assert.equal(r.gate.kind, "undetectable");
});

test("confirm: 预检顺手让盐落盘，同一台机器上留痕指纹才稳定", async () => {
  const b = await base();
  const dataDir = await chromeDir();
  const first = await precheckProfile({ base: b, dataDir, ask: asker(true) });
  const second = await precheckProfile({ base: b, dataDir, ask: asker(true) });
  assert.equal(first.settings.journalSalt, second.settings.journalSalt);
});
