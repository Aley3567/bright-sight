import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadSurface, defaultCacheDir } from "../src/actions.ts";

/**
 * 缓存测试用真实磁盘和真实 sdef 子进程，不 mock 文件系统——
 * 这条逻辑的全部风险都在「磁盘上到底发生了什么」，mock 掉就什么也没证明。
 * 扫描范围限定在 Utilities（18 个应用）而非全盘，保证测试在一秒级完成。
 */
const SMALL_DIRS = ["/System/Applications/Utilities"];

async function withCacheDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(`${tmpdir()}/bright-sight-surface-`);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("actions: 缓存命中时返回与重建完全一致的动作面", async () => {
  await withCacheDir(async (dir) => {
    const cold = await loadSurface({ dirs: SMALL_DIRS, cacheDir: dir });
    assert.equal(cold.fromCache, false, "首次必须重建");
    assert.ok(cold.actions.length > 0, "Utilities 里应当有可脚本化应用");

    const warm = await loadSurface({ dirs: SMALL_DIRS, cacheDir: dir });
    assert.equal(warm.fromCache, true, "第二次必须命中缓存");
    assert.deepEqual(warm.actions, cold.actions);
    assert.deepEqual(warm.apps, cold.apps);
    assert.deepEqual(warm.scriptable, cold.scriptable);
  });
});

test("actions: 指纹不符时丢弃缓存重建", async () => {
  await withCacheDir(async (dir) => {
    await loadSurface({ dirs: SMALL_DIRS, cacheDir: dir });
    const file = `${dir}/surface.json`;
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.fingerprint = "指纹对不上";
    await writeFile(file, JSON.stringify(raw), "utf8");

    const again = await loadSurface({ dirs: SMALL_DIRS, cacheDir: dir });
    assert.equal(again.fromCache, false);
    // 重建后指纹被改回真实值，下一次应当重新命中
    assert.equal((await loadSurface({ dirs: SMALL_DIRS, cacheDir: dir })).fromCache, true);
  });
});

test("actions: 扫描目录变化会让缓存失效", async () => {
  await withCacheDir(async (dir) => {
    await loadSurface({ dirs: SMALL_DIRS, cacheDir: dir });
    // 换一组目录 = 换一份应用清单 = 换指纹，绝不能拿上一组的结果冒充
    const other = await loadSurface({ dirs: ["/System/Applications"], cacheDir: dir });
    assert.equal(other.fromCache, false);
  });
});

test("actions: 缓存损坏或不可写都不抛出，降级为重建", async () => {
  await withCacheDir(async (dir) => {
    await writeFile(`${dir}/surface.json`, "{ 这不是合法 JSON", "utf8");
    const broken = await loadSurface({ dirs: SMALL_DIRS, cacheDir: dir });
    assert.equal(broken.fromCache, false);
    assert.ok(broken.actions.length > 0, "缓存坏掉不能影响本次结果");

    // /dev/null 底下建不出目录，写缓存必然失败
    const unwritable = await loadSurface({ dirs: SMALL_DIRS, cacheDir: "/dev/null/bright-sight" });
    assert.equal(unwritable.fromCache, false);
    assert.deepEqual(unwritable.actions, broken.actions);
  });
});

test("actions: 写缓存不留临时文件", async () => {
  await withCacheDir(async (dir) => {
    await loadSurface({ dirs: SMALL_DIRS, cacheDir: dir });
    // 先写 .tmp-<pid> 再 rename，成功路径上临时文件必须已经消失
    await assert.rejects(() => stat(`${dir}/surface.json.tmp-${process.pid}`));
    assert.ok((await stat(`${dir}/surface.json`)).size > 0);
  });
});

test("actions: 默认缓存目录在用户 home 下，不落到仓库里", () => {
  const d = defaultCacheDir();
  assert.match(d, /\/\.bright-sight$/);
  assert.ok(!d.startsWith(process.cwd()), "缓存是机器本地状态，不能污染工作区");
});
