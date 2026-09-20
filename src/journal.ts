import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { defaultCacheDir } from "./actions.ts";

/**
 * 事件留痕：append-only 的本地 JSONL。
 *
 * 存储是自带的，不接任何外部系统——bright-sight/ 始终可以整个目录搬出去独立成仓。
 * 下面这三十行 ULID 是重写的而不是复用的：复用能省三十行，代价是整个目录多出
 * 唯一一处对外依赖，这笔账不划算。
 */

/** Crockford base32：去掉了 I L O U，避免和 1 0 混淆，也避免拼出脏话。 */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number, len: number): string {
  let out = "";
  let v = ms;
  for (let i = 0; i < len; i++) {
    out = B32[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += B32[bytes[i] % 32];
  return out;
}

export type UlidOptions = { now?: () => number; entropy?: (n: number) => Uint8Array };

/**
 * 时间前缀 + 随机后缀，字典序即时间序。
 * now / entropy 都可注入，测试靠注入拿确定性，不 mock 全局。
 */
export function ulid(opts: UlidOptions = {}): string {
  const ms = (opts.now ?? Date.now)();
  const rnd = (opts.entropy ?? ((n: number) => new Uint8Array(randomBytes(n))))(16);
  return encodeTime(ms, 10) + encodeRandom(rnd, 16);
}

export type JournalEvent = {
  id: string;
  at: string;
  runId: string;
  step: number;
  /** 四步闭环里的哪一步，或 run 级别的开始/结束。 */
  phase: "run.start" | "observe" | "judge" | "act" | "verify" | "run.end";
  /**
   * 这条事件的 data 是否经过脱敏。
   *
   * 逐条记而不是整份文件记一次：留痕是 append-only 的，同一个文件理论上可以跨越
   * 一次配置变更。回放时如果分不清哪几行是原文，「这份记录能不能拿给别人看」
   * 就没有答案了。
   */
  redacted: boolean;
  data: unknown;
};

export type Journal = {
  runId: string;
  path: string;
  append: (phase: JournalEvent["phase"], step: number, data: unknown) => Promise<void>;
};

/** 脱敏函数：拿到 phase 与原始 data，返回真正落盘的那一份。 */
export type JournalRedactor = (phase: JournalEvent["phase"], data: unknown) => unknown;

export type JournalOptions = UlidOptions & {
  dir?: string;
  runId?: string;
  /**
   * 落盘前怎么脱敏。
   *
   * journal.ts 刻意不认识 redact.ts，也不读环境变量：它只负责把给它的东西原样追加。
   * 「默认该不该脱敏」是策略，策略归调用方（CLI）决定，这样这个模块在测试里
   * 能被完整地穷举，不必先摆平一堆环境。
   */
  redact?: JournalRedactor;
};

export function journalDir(base = defaultCacheDir()): string {
  return `${base}/journal`;
}

/**
 * 开一条 run 的留痕。
 *
 * 写失败不抛：留痕是为了事后复查，它不能反过来把正在进行的操作搞崩。
 * 但失败会被计数并在 run 结束时报出来，免得静默丢事件。
 */
export async function openJournal(opts: JournalOptions = {}): Promise<Journal & { failures: () => number }> {
  const dir = opts.dir ?? journalDir();
  const runId = opts.runId ?? ulid(opts);
  const path = `${dir}/${runId}.jsonl`;
  const now = opts.now ?? Date.now;
  const redact = opts.redact;
  let failures = 0;

  try {
    // 权限显式给出，不听凭 umask：留痕即便脱敏了也是一份「这台机器上发生过什么」的记录，
    // 同机的其他用户没有理由读得到它
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    failures++;
  }

  return {
    runId,
    path,
    failures: () => failures,
    append: async (phase, step, data) => {
      const ev: JournalEvent = {
        id: ulid(opts),
        at: new Date(now()).toISOString(),
        runId,
        step,
        phase,
        redacted: redact !== undefined,
        data: redact ? redact(phase, data) : data,
      };
      try {
        await appendFile(path, `${JSON.stringify(ev)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch {
        failures++;
      }
    },
  };
}

/** 读回一条 run 的全部事件。坏行单独报出来，不因为一行坏掉丢掉整个文件。 */
export async function readJournal(path: string): Promise<{ events: JournalEvent[]; broken: number }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { events: [], broken: 0 };
  }
  const events: JournalEvent[] = [];
  let broken = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
    } catch {
      broken++;
    }
  }
  return { events, broken };
}
