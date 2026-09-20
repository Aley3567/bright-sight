import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { ProfileGate } from "./types.ts";
import { isProfileAllowed, type Settings } from "./settings.ts";

/**
 * Chrome profile 探测。
 *
 * ── 为什么需要这个模块 ──
 * 本系统开标签页的方式是 `tell application "Google Chrome"`，也就是把 Apple Event
 * 投给系统里那个 Chrome。Apple Event 按 bundle id 投递，投给谁由「哪个实例在跑」决定，
 * 调用方无从选择。而**AppleScript 根本没有 profile 这个概念**：Chrome 的脚本字典全文
 * 没有任何 profile 命令，`window` 只有 `mode`（normal / incognito）。
 *
 * 结论是硬的：能做的不是「切到某个 profile」，而是**先知道自己将要落在哪个 profile 上，
 * 落在陌生的那个就停下来问人**。这个模块负责前半句，policy.ts 的 profile 闸负责后半句。
 *
 * ── 零硬编码 ──
 * 这里不出现任何具体的 profile 目录名、显示名或账号。目录名从磁盘扫出来，
 * 显示名只在向用户提问的那一瞬间读一次，既不落盘也不进留痕。
 *
 * ── 一个实测陷阱 ──
 * `Local State` 的写入滞后于用户操作若干秒。所以这里不单靠它：再用各 profile 的
 * `Preferences` mtime 做一次交叉印证，两路不一致时如实报出来，由人来判。
 * 另外 `lsof` 这条路走不通，它被权限挡死，对 Chrome 主进程返回不了有用的东西。
 */

export type ChromeProfile = {
  /** 目录名，如 `Default`。Chrome 自己分配，不含个人信息，可以安全落盘。 */
  dir: string;
  /** 显示名，用户自己起的，常常就是真名或邮箱。**只用于当场向人提问，绝不落盘。** */
  name: string | null;
};

export type ProfileDetection =
  | {
      ok: true;
      /** 判定为当前在用的 profile。 */
      active: ChromeProfile;
      /** `Local State` 给出的答案。 */
      byState: string | null;
      /** `Preferences` mtime 最新的那个。 */
      byMtime: string | null;
      /** 两路是否一致。不一致说明 Local State 还没写完，结论要打折。 */
      agree: boolean;
      all: ChromeProfile[];
    }
  | { ok: false; reason: string; all: ChromeProfile[] };

/**
 * macOS 上 Chrome 的用户数据目录。
 *
 * 路径由 `homedir()` 拼出来，不是写死的 `/Users/<某人>`——后者会让这个项目只在
 * 作者那台机器上成立。这一段固定后缀是 Chrome 在 macOS 上的平台约定，属于平台常量。
 */
export function chromeUserDataDir(home = homedir()): string {
  return `${home}/Library/Application Support/Google/Chrome`;
}

/** profile 目录的判据：`Default`，或 `Profile ` 开头。Chrome 就这两种命名。 */
function looksLikeProfileDir(name: string): boolean {
  return name === "Default" || name.startsWith("Profile ");
}

type LocalState = {
  profile?: {
    last_active_profiles?: unknown;
    info_cache?: Record<string, { name?: unknown }>;
  };
};

async function readLocalState(dataDir: string): Promise<LocalState | null> {
  try {
    return JSON.parse(await readFile(`${dataDir}/Local State`, "utf8")) as LocalState;
  } catch {
    return null;
  }
}

/** 扫出磁盘上实际存在的 profile 目录，显示名能从 Local State 取到就带上。 */
async function listProfiles(dataDir: string, state: LocalState | null): Promise<ChromeProfile[]> {
  let names: string[];
  try {
    const entries = await readdir(dataDir, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && looksLikeProfileDir(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const cache = state?.profile?.info_cache ?? {};
  return names.sort().map((dir) => {
    const n = cache[dir]?.name;
    return { dir, name: typeof n === "string" ? n : null };
  });
}

/** mtime 最新的 `Preferences` 所属的 profile。活跃 profile 会被 Chrome 持续写入。 */
async function newestByMtime(dataDir: string, dirs: readonly string[]): Promise<string | null> {
  let best: { dir: string; ms: number } | null = null;
  for (const dir of dirs) {
    try {
      const s = await stat(`${dataDir}/${dir}/Preferences`);
      if (!best || s.mtimeMs > best.ms) best = { dir, ms: s.mtimeMs };
    } catch {
      // 这个 profile 没有 Preferences（刚建、或被清过），跳过而不是让整次探测失败
    }
  }
  return best?.dir ?? null;
}

/**
 * 探测当前正在使用的 profile。
 *
 * 两路交叉印证，`Local State` 优先——它是 Chrome 自己维护的运行时状态，语义最直接；
 * mtime 只在前者缺席时顶上，并在两者不一致时留下记号。
 */
export async function detectActiveProfile(dataDir = chromeUserDataDir()): Promise<ProfileDetection> {
  const state = await readLocalState(dataDir);
  const all = await listProfiles(dataDir, state);
  if (all.length === 0) {
    return { ok: false, reason: `在 ${dataDir} 下没有找到任何 Chrome profile 目录`, all };
  }

  const raw = state?.profile?.last_active_profiles;
  const listed = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  const known = new Set(all.map((p) => p.dir));
  const byState = listed.find((d) => known.has(d)) ?? null;
  const byMtime = await newestByMtime(dataDir, all.map((p) => p.dir));

  const dir = byState ?? byMtime;
  if (!dir) {
    return { ok: false, reason: "Local State 与 Preferences mtime 都没能指出正在使用的 profile", all };
  }
  const active = all.find((p) => p.dir === dir) ?? { dir, name: null };
  return { ok: true, active, byState, byMtime, agree: byState !== null && byState === byMtime, all };
}

/**
 * 把探测结果与允许名单合成一个闸门状态。
 *
 * 探测失败**不放行**：不知道自己会落在哪个 profile，和确知落在陌生 profile 一样，
 * 都是「不该静默执行」。默认值站在保守那一边。
 */
export function gateFor(detection: ProfileDetection, settings: Settings): ProfileGate {
  if (!detection.ok) return { kind: "undetectable", detail: detection.reason };
  const { dir } = detection.active;
  if (!isProfileAllowed(settings, dir)) return { kind: "unknown", dir };
  if (!detection.agree) {
    // 两路探测对不上——可能刚切过 profile，而 Local State 的写入滞后数秒。
    // 这时「当前是 dir」这个结论本身不可靠，所以不能只看 dir 在不在名单里。
    //
    // 但也不必一律再问一遍：真实答案必定是这两个候选之一，两个都在名单里的话，
    // 无论哪个是对的，结果都是被允许的。这条判断让「同时开着两个都已确认的 profile」
    // 这种日常场景不必每次都被打断，同时一个未确认的候选就足以把它拉回 unknown。
    const candidates = [detection.byState, detection.byMtime].filter((d): d is string => d !== null);
    if (candidates.length === 0 || !candidates.every((d) => isProfileAllowed(settings, d))) {
      return { kind: "unknown", dir };
    }
  }
  return { kind: "allowed", dir, via: "settings" };
}

/** 给人看的一句话。显示名只在这里出现，用完即弃。 */
export function describeGate(gate: ProfileGate, detection: ProfileDetection): string {
  if (gate.kind === "dry-run") return "dry-run 不发送 Apple Event，profile 闸不适用";
  if (gate.kind === "undetectable") return `探测不到当前 Chrome profile：${gate.detail}`;
  const shown = detection.ok && detection.active.name ? `${gate.dir}（${detection.active.name}）` : gate.dir;
  if (gate.kind === "allowed") return `当前 Chrome profile ${shown} 在允许名单内`;
  const drift =
    detection.ok && !detection.agree
      ? `；两路探测不一致（Local State: ${detection.byState ?? "无"}，mtime: ${detection.byMtime ?? "无"}）`
      : "";
  return `当前 Chrome profile ${shown} 不在允许名单内${drift}`;
}
