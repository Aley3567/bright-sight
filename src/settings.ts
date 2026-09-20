import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { defaultCacheDir } from "./actions.ts";

/**
 * 本机设置：允许名单与留痕指纹盐。
 *
 * 这个文件的存在理由是「零硬编码」这条约束。允许在哪个 Chrome profile 下执行、
 * 留痕指纹用什么盐，都是**因人因机而异的运行时事实**，不是代码。
 * 源码里写死任何一个 profile 目录名、显示名或账号，项目就只能在作者那台机器上讲得通。
 *
 * 所以它落在家目录（`~/.bright-sight/config.json`）而不是仓库里：
 * 仓库能被 clone，家目录不能。CLAUDE.md 把这条列成了硬规矩。
 */

export type Settings = {
  version: 1;
  /**
   * 留痕指纹盐，hex。
   *
   * 不加盐的 8 位哈希对已知候选集（常见网站、常见应用名）是可爆破的——
   * journal 的脱敏就形同虚设。盐每台机器随机生成一次、只存家目录，
   * 于是同一台机器上「两条记录是不是同一个值」仍然可比，跨机器则无从反推。
   */
  journalSalt: string;
  chrome: {
    /**
     * 允许执行的 Chrome profile **目录名**（`Default` / `Profile 3` 这种）。
     *
     * 刻意存目录名而不是显示名：显示名由用户自己起，常常就是真名或邮箱，
     * 属于个人数据。目录名是 Chrome 自己分配的序号，不含个人信息。
     */
    allowedProfiles: string[];
  };
};

export function settingsPath(base = defaultCacheDir()): string {
  return `${base}/config.json`;
}

export function defaultSettings(salt = randomBytes(16).toString("hex")): Settings {
  return { version: 1, journalSalt: salt, chrome: { allowedProfiles: [] } };
}

/**
 * 把磁盘上的任意 JSON 收窄成 Settings。
 *
 * 手写用户会手改这个文件，所以每个字段都要独立兜底：缺一个字段不该让整份设置作废，
 * 那会让用户在「配置写错一个字」和「允许名单被静默清空」之间猝不及防。
 */
function coerce(raw: unknown, fallbackSalt: string): Settings {
  const o = (raw ?? {}) as Partial<Settings> & { chrome?: Partial<Settings["chrome"]> };
  const salt = typeof o.journalSalt === "string" && o.journalSalt.length > 0 ? o.journalSalt : fallbackSalt;
  const list = Array.isArray(o.chrome?.allowedProfiles) ? o.chrome.allowedProfiles : [];
  return {
    version: 1,
    journalSalt: salt,
    chrome: { allowedProfiles: list.filter((x): x is string => typeof x === "string") },
  };
}

/** 读设置。文件不存在或读坏了都返回一份默认值，不抛——设置缺失不该挡住只读命令。 */
export async function loadSettings(base = defaultCacheDir()): Promise<Settings> {
  const fresh = defaultSettings();
  try {
    return coerce(JSON.parse(await readFile(settingsPath(base), "utf8")), fresh.journalSalt);
  } catch {
    return fresh;
  }
}

export async function saveSettings(s: Settings, base = defaultCacheDir()): Promise<void> {
  // 0o700 / 0o600 显式写出来，不听凭 umask：这个文件里有留痕指纹盐，
  // 盐一旦被别的用户读到，加盐哈希对他而言就退化成了裸哈希。
  // 作者机器上 umask 恰好是 077 看不出问题，别人机器上默认是 022。
  await mkdir(base, { recursive: true, mode: 0o700 });
  await writeFile(settingsPath(base), `${JSON.stringify(s, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * 读设置，顺带保证盐已经落盘。
 *
 * 盐必须稳定：每次运行重新生成的话，同一个值在两条 run 里会得到两个不同指纹，
 * 「这两步是不是开了同一个地址」就再也对不上了，脱敏后的留痕也就失去了复查价值。
 */
export async function ensureSettings(base = defaultCacheDir()): Promise<Settings> {
  const s = await loadSettings(base);
  try {
    await saveSettings(s, base);
  } catch {
    // 写不进去就用内存里这份跑完这一轮。留痕与配置都不该反过来把操作搞崩。
  }
  return s;
}

export function isProfileAllowed(s: Settings, dir: string): boolean {
  return s.chrome.allowedProfiles.includes(dir);
}

/** 幂等地把一个 profile 目录名加进允许名单，返回新的设置（不改入参）。 */
export function withProfileAllowed(s: Settings, dir: string): Settings {
  if (isProfileAllowed(s, dir)) return s;
  return { ...s, chrome: { ...s.chrome, allowedProfiles: [...s.chrome.allowedProfiles, dir].sort() } };
}

export function withProfileForgotten(s: Settings, dir: string): Settings {
  return { ...s, chrome: { ...s.chrome, allowedProfiles: s.chrome.allowedProfiles.filter((d) => d !== dir) } };
}
