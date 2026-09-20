import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  defaultSettings,
  ensureSettings,
  isProfileAllowed,
  loadSettings,
  saveSettings,
  settingsPath,
  withProfileAllowed,
  withProfileForgotten,
} from "../src/settings.ts";

/** 每个用例一个临时目录：设置是真实文件，测试之间不该互相看见对方写的东西。 */
function tmp(): Promise<string> {
  return mkdtemp(`${tmpdir()}/bright-sight-settings-`);
}

test("settings: 默认允许名单是空的——没人确认过就谁都不放行", () => {
  assert.deepEqual(defaultSettings().chrome.allowedProfiles, []);
});

test("settings: 每次生成的盐都不一样", () => {
  assert.notEqual(defaultSettings().journalSalt, defaultSettings().journalSalt);
});

test("settings: 文件不存在时返回默认值而不是抛错", async () => {
  const s = await loadSettings(`${await tmp()}/根本没建过`);
  assert.deepEqual(s.chrome.allowedProfiles, []);
  assert.ok(s.journalSalt.length > 0);
});

test("settings: 写进去再读回来，允许名单与盐都对得上", async () => {
  const dir = await tmp();
  const s = withProfileAllowed(defaultSettings("固定盐"), "Profile 3");
  await saveSettings(s, dir);
  const back = await loadSettings(dir);
  assert.deepEqual(back.chrome.allowedProfiles, ["Profile 3"]);
  assert.equal(back.journalSalt, "固定盐");
});

test("settings: 手改坏了一个字段，其余字段仍然有效", async () => {
  const dir = await tmp();
  await saveSettings(defaultSettings("固定盐"), dir);
  await writeFile(settingsPath(dir), JSON.stringify({ journalSalt: "固定盐", chrome: { allowedProfiles: "不是数组" } }));
  const back = await loadSettings(dir);
  assert.equal(back.journalSalt, "固定盐", "一个字段写错不该把整份设置作废");
  assert.deepEqual(back.chrome.allowedProfiles, []);
});

test("settings: 整个文件不是 JSON 时落回默认值，不影响只读命令", async () => {
  const dir = await tmp();
  await saveSettings(defaultSettings(), dir);
  await writeFile(settingsPath(dir), "{ 这不是 JSON");
  const back = await loadSettings(dir);
  assert.deepEqual(back.chrome.allowedProfiles, []);
});

test("settings: 名单里混进非字符串时被剔除，不会流到下游当成目录名", async () => {
  const dir = await tmp();
  await saveSettings(defaultSettings(), dir);
  await writeFile(settingsPath(dir), JSON.stringify({ chrome: { allowedProfiles: ["Default", 7, null] } }));
  const back = await loadSettings(dir);
  assert.deepEqual(back.chrome.allowedProfiles, ["Default"]);
});

test("settings: ensureSettings 让盐落盘，两次调用拿到同一把盐", async () => {
  const dir = await tmp();
  const first = await ensureSettings(dir);
  const second = await ensureSettings(dir);
  assert.equal(first.journalSalt, second.journalSalt, "盐每次都变的话，留痕里同一个值就对不上了");
  const onDisk = JSON.parse(await readFile(settingsPath(dir), "utf8"));
  assert.equal(onDisk.journalSalt, first.journalSalt);
});

test("settings: 加入名单是幂等的，不会攒出重复项", () => {
  const once = withProfileAllowed(defaultSettings(), "Default");
  const twice = withProfileAllowed(once, "Default");
  assert.deepEqual(twice.chrome.allowedProfiles, ["Default"]);
  assert.equal(once, twice, "已经在名单里就不该造一份新的");
});

test("settings: 增删都不改入参——策略函数要能被反复调用", () => {
  const base = defaultSettings();
  withProfileAllowed(base, "Profile 1");
  assert.deepEqual(base.chrome.allowedProfiles, []);
});

test("settings: 移出名单后就不再放行", () => {
  const s = withProfileAllowed(defaultSettings(), "Profile 1");
  assert.equal(isProfileAllowed(s, "Profile 1"), true);
  assert.equal(isProfileAllowed(withProfileForgotten(s, "Profile 1"), "Profile 1"), false);
});

test("settings: 移出一个本来就不在名单里的目录名，不报错也不改别的", () => {
  const s = withProfileAllowed(defaultSettings(), "Default");
  assert.deepEqual(withProfileForgotten(s, "Profile 9").chrome.allowedProfiles, ["Default"]);
});

test("settings: 配置文件权限是 0600，不听凭 umask", async () => {
  // 里面有留痕指纹盐。盐被同机的其他用户读到，加盐哈希对他就退化成了裸哈希。
  // 作者机器上 umask 恰好是 077 看不出问题，别人机器上默认是 022。
  const dir = await tmp();
  await saveSettings(defaultSettings(), dir);
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(settingsPath(dir))).mode & 0o777, 0o600);
});
