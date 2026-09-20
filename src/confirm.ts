import { createInterface } from "node:readline/promises";
import { describeGate, detectActiveProfile, gateFor, type ProfileDetection } from "./chrome.ts";
import { saveSettings, ensureSettings, withProfileAllowed, type Settings } from "./settings.ts";
import type { ProfileGate } from "./types.ts";

/**
 * 当场拍板。
 *
 * 这一层刻意只存在于 CLI 侧。policy.ts 那道 profile 闸是兜底——它保证**任何**调用方
 * （包括将来的语音入口、将来的服务端）都拦得住；这里做的是让常见路径不必撞在兜底上：
 * 执行前先看清楚会落在哪个 profile，陌生就当场问一句。
 *
 * 两条路径都要有，缺一条都不行：只有兜底，用户每次都得改配置再重跑；
 * 只有这里，换一个入口调 loop 就悄悄绕过了整道闸。
 */

/** 问一句是非题。返回 true 表示用户明确同意。 */
export type Asker = (question: string) => Promise<boolean>;

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * 终端问答。
 *
 * 默认答案是「否」：回车、Ctrl-D、读不出来，全部当作不同意。这类提示的默认值
 * 必须是不执行——用户按回车常常只是想看清楚问题，不该因此在别人的登录态里开页面。
 */
export async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^(y|yes)$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

export type ProfilePrecheck = {
  gate: ProfileGate;
  detection: ProfileDetection;
  settings: Settings;
  /** 人读的一句话，CLI 直接打印。 */
  summary: string;
  /** 用户被问到了并且明确说了不。调用方应当就此收手。 */
  declined: boolean;
};

export type PrecheckOptions = {
  /**
   * 怎么问人。`null` 表示不问——非 TTY（CI、管道）下没有人可问，
   * 这时不该假装问过，而应把闸门状态原样交给 policy，让它拦成 confirm 并说清原因。
   */
  ask?: Asker | null;
  /** 设置所在目录，测试用。 */
  base?: string;
  /** Chrome 用户数据目录，测试用。 */
  dataDir?: string;
};

/**
 * 执行前的 profile 预检。
 *
 * 用户答 y 之后会把这个 profile **记进允许名单**，下次不再问。记的是目录名
 * （`Default` / `Profile 3`），不是显示名——显示名常常就是真名或邮箱。
 * 探测失败那条路不记：连是哪个都不知道，记什么都是假的，所以只对这一次放行。
 */
export async function precheckProfile(opts: PrecheckOptions = {}): Promise<ProfilePrecheck> {
  const settings = await ensureSettings(opts.base);
  const detection = await detectActiveProfile(opts.dataDir);
  const gate = gateFor(detection, settings);
  const summary = describeGate(gate, detection);

  if (gate.kind === "allowed") return { gate, detection, settings, summary, declined: false };
  if (!opts.ask) return { gate, detection, settings, summary, declined: false };

  const shown =
    gate.kind === "unknown" && detection.ok && detection.active.name
      ? `${gate.dir}（${detection.active.name}）`
      : gate.kind === "unknown"
        ? gate.dir
        : "";

  const question =
    gate.kind === "unknown"
      ? `${summary}\n要在 ${shown} 下执行吗？答 y 会把它记进允许名单，以后不再问。[y/N] `
      : `${summary}\n仍然继续吗？只对这一次生效，不会记住。[y/N] `;

  if (!(await opts.ask(question))) {
    return { gate, detection, settings, summary, declined: true };
  }

  if (gate.kind === "unknown") {
    const next = withProfileAllowed(settings, gate.dir);
    try {
      await saveSettings(next, opts.base);
    } catch {
      // 写不进去不影响这一轮放行，只是下次还会再问一遍
    }
    return {
      gate: { kind: "allowed", dir: gate.dir, via: "prompt" },
      detection,
      settings: next,
      summary: `已记住 ${gate.dir}，下次不再询问`,
      declined: false,
    };
  }

  return {
    // dir 填不出真值就如实写「未探测到」，不要编一个看起来像目录名的东西——
    // 它会原样进留痕，事后读的人得能分清「人放行的」和「名单里有的」
    gate: { kind: "allowed", dir: "(未探测到)", via: "prompt" },
    detection,
    settings,
    summary: "本次放行（未记住）",
    declined: false,
  };
}
