import { createHmac } from "node:crypto";

/**
 * 留痕脱敏。
 *
 * journal 是这个项目最大的隐私泄露面：不脱敏的话，每个跑起来它的人都会在自己磁盘上
 * 攒下一份「我说过什么、开过哪些网页、窗口标题叫什么、往备忘录里写了什么」的逐条记录。
 * `.gitignore` 只能挡住它进版本库，挡不住它被生成。
 *
 * 所以默认落盘的是**指纹而不是内容**：每个外部字符串只留长度与 HMAC 前 8 位。
 * 这保住了留痕真正的用途——「第 2 步开的地址和第 1 步产出的是不是同一个」「两次运行
 * 是不是同一条原话」——同时让记录本身读不出任何内容。
 *
 * 逃生阀是 `BRIGHTSIGHT_JOURNAL=full`：调试闭环本身时需要看见原文。它必须是显式的、
 * 每次都要主动打开的，默认值站在隐私那一边。
 *
 * ── 边界：什么算「外部字符串」 ──
 * 用户原话、窗口标题、URL、网页标题、笔记正文、AppleScript 回读值，都算，全部指纹化。
 * 应用名（`Notes` / `Google Chrome`）、动作 id、判据名、概率、耗时、布尔结果不算：
 * 它们来自本系统自己的常量表与 sdef，不含用户内容，而且全部抹掉的话留痕就只剩一串
 * 无法分辨的哈希，连「哪一步没过」都答不出来。
 */

export type RedactMode = "hash" | "full";

/** 指纹：长度 + HMAC 前 8 位。长度保留是因为它常常就是定位问题所需的全部信息。 */
export type Fingerprint = { len: number; h: string };

export const JOURNAL_ENV = "BRIGHTSIGHT_JOURNAL";

/**
 * 只有逐字的 `full` 才关闭脱敏。
 *
 * 拼写错误（`Full`、`ful`、`1`）一律落回 hash——脱敏开关拼错时应该更安全而不是更危险。
 */
export function resolveRedactMode(value = process.env[JOURNAL_ENV]): RedactMode {
  return value === "full" ? "full" : "hash";
}

/**
 * HMAC 而不是裸 sha256。
 *
 * 裸哈希对已知候选集是可爆破的：常见网站就那么几千个，窗口标题的模板也有限，
 * 攒一张彩虹表就能把「脱敏」还原回去。盐走 HMAC 的密钥位，每台机器一份，
 * journal 单独流出时无从反推。
 */
export function fingerprint(value: string, salt: string): Fingerprint {
  return { len: [...value].length, h: createHmac("sha256", salt).update(value, "utf8").digest("hex").slice(0, 8) };
}

export type Redactor = {
  mode: RedactMode;
  /** 单个外部字符串。null / undefined 原样透传，它们本身不携带信息。 */
  value: <T extends string | null | undefined>(v: T) => T | Fingerprint;
  /** 一条留痕事件的 data 字段。 */
  event: (phase: string, data: unknown) => unknown;
};

/** 兜底用：把任意结构里的字符串**值**全部指纹化，键名原样保留（键名来自代码，不是用户内容）。 */
function deep(v: unknown, salt: string, depth = 0): unknown {
  if (depth > 8) return "<深度超限>";
  if (typeof v === "string") return fingerprint(v, salt);
  if (Array.isArray(v)) return v.map((x) => deep(x, salt, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = deep(val, salt, depth + 1);
    return out;
  }
  return v;
}

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

/**
 * `act` 事件里 `ax` 字段的白名单脱敏。
 *
 * 白名单只有两处：`status`（枚举）与 `verify.ok`（布尔）——它们不含用户内容，且是
 * 「这一步到底走成了没有、为什么没成」的关键。`verify.detail` 与其余一切字段都按内容处理：
 * detail 可能带元素标签，而没列进白名单的字段默认过度脱敏。这样以后往 `ax` 里加字段，
 * 忘记来这里补规则时的后果是「信息变少」，不是「原文落盘」。
 */
function redactAxFact(v: unknown, salt: string): unknown {
  const r = asRec(v);
  if (!r) return deep(v, salt);
  const out: Rec = {};
  for (const [k, val] of Object.entries(r)) {
    if (k === "status") {
      out[k] = val;
      continue;
    }
    if (k === "verify") {
      const vr = asRec(val);
      if (!vr) {
        out[k] = deep(val, salt);
        continue;
      }
      const vo: Rec = {};
      for (const [vk, vv] of Object.entries(vr)) vo[vk] = vk === "ok" ? vv : deep(vv, salt);
      out[k] = vo;
      continue;
    }
    out[k] = deep(val, salt);
  }
  return out;
}

/**
 * 按 phase 分派，而不是无差别递归。
 *
 * 无差别递归会把 `confidence: 0.92`、`ok: true`、`name: "url_origin_match"` 一起抹掉，
 * 留痕就退化成一堆看不出所以然的指纹。逐个 phase 写清楚「哪些字段是内容、哪些是结构」，
 * 代价是新增 phase 时要来这里加一条——所以 default 分支是全量指纹化：
 * 忘了加，结果是过度脱敏而不是静默泄露。
 */
function redactEvent(phase: string, data: unknown, salt: string): unknown {
  const d = asRec(data);
  if (!d) return deep(data, salt);

  switch (phase) {
    case "run.start":
      // utterance 是用户原话，整条都是内容
      return { ...d, utterance: typeof d.utterance === "string" ? fingerprint(d.utterance, salt) : d.utterance };

    case "observe":
      // front 是应用名（本系统常量 / 系统进程名），保留；window 是窗口标题，是内容
      return { ...d, window: typeof d.window === "string" ? fingerprint(d.window, salt) : d.window };

    case "judge": {
      // judgement 全是数值与后端名，保留；span 是从用户原话切出来的片段，是内容。
      // bodySource / violations 是本系统自己生成的 key 与判据文本，保留——
      // 它们正是「模型为什么被拦下」的唯一线索。
      const span = typeof d.span === "string" ? fingerprint(d.span, salt) : d.span;
      // targetId 是 Swift 现铸的 offerId：外部来源、每次观察都变，不是本系统的常量，
      // 按「白名单之外一律指纹化」处理。抹掉它不影响留痕的用途——
      // 「模型挑了哪类能力、挑中成没成立」看 action 与 violations 就够。
      const targetId = typeof d.targetId === "string" ? fingerprint(d.targetId, salt) : d.targetId;
      return { ...d, span, targetId };
    }

    case "act": {
      // argv 是真正发出去的值，回读是应用返回的值，两边都是内容。
      // ok / ms / errors 是结构与本系统自己的错误文本，保留。
      const out: Rec = { ...d };
      if (Array.isArray(d.argv)) out.argv = d.argv.map((a) => (typeof a === "string" ? fingerprint(a, salt) : a));
      const rb = asRec(d.readback);
      if (rb) {
        const r: Rec = {};
        // 键名来自模板的 fields，是代码常量；只有值需要指纹化
        for (const [k, v] of Object.entries(rb)) r[k] = typeof v === "string" ? fingerprint(v, salt) : v;
        out.readback = r;
      }
      // AX 动作的凭证：status 是枚举、verify.ok 是布尔（结构，是事后归因的关键），
      // verify.detail 是给人看的一句话、可能带元素标签（内容）。白名单之外一律指纹化——
      // 以后往 ax 里加字段，默认后果是过度脱敏而不是静默泄露。
      if (d.ax !== undefined) out.ax = redactAxFact(d.ax, salt);
      return out;
    }

    case "verify": {
      // name 与 ok 是判据本身，保留——「哪条判据没过」必须能读出来。
      // detail 由代码拼装，但拼进去的是 URL、容器名、标题，所以整条当内容处理。
      if (!Array.isArray(d.checks)) return d;
      const checks = d.checks.map((c) => {
        const r = asRec(c);
        if (!r) return deep(c, salt);
        return { ...r, detail: typeof r.detail === "string" ? fingerprint(r.detail, salt) : r.detail };
      });
      return { ...d, checks };
    }

    case "run.end":
      // 状态、步数、耗时，全是结构
      return d;

    case "suspend":
    case "resume": {
      // 挂起/恢复这一对全是结构：confirmId 是本轮现铸的随机串（不是用户内容，
      // 而且抹掉它就再也对不上「哪一次挂起后来被谁恢复了」），actionId 是动作 id，
      // gate 与 stale 是枚举值与判据名，approved 是布尔。
      //
      // 刻意**不**在这里放行 reasons / detail：待确认的理由里会带 Chrome profile 目录名
      // 与窗口标题。白名单之外一律指纹化，是为了让「以后往这条事件里加字段」的默认后果
      // 是过度脱敏，而不是静默泄露。
      const keep = new Set(["confirmId", "actionId", "gate", "approved", "stale", "step"]);
      const out: Rec = {};
      for (const [k, v] of Object.entries(d)) out[k] = keep.has(k) ? v : deep(v, salt);
      return out;
    }

    default:
      return deep(data, salt);
  }
}

export function makeRedactor(mode: RedactMode, salt: string): Redactor {
  if (mode === "full") {
    return { mode, value: (v) => v, event: (_phase, data) => data };
  }
  return {
    mode,
    value: (v) => (typeof v === "string" ? fingerprint(v, salt) : v),
    event: (phase, data) => redactEvent(phase, data, salt),
  };
}
