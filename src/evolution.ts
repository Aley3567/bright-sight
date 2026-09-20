import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { defaultCacheDir } from "./actions.ts";
import { ulid, type JournalEvent } from "./journal.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_TTL_MS = 30 * DAY_MS;
const HISTORY_TTL_MS = 90 * DAY_MS;

export type MemoryScope = {
  application: string;
  taskKind: string;
};

export type SemanticStep = {
  actionId: string;
  /** 只存判据名；执行时仍由原来的 verify.ts 计算结果。 */
  verify: string[];
};

export type MemoryBody =
  | { kind: "preference"; instruction: string }
  | { kind: "skill"; steps: SemanticStep[] };

export type MemoryStatus = "candidate" | "active" | "suspended" | "rejected" | "superseded";

export type MemoryVersion = {
  id: string;
  version: number;
  scope: MemoryScope;
  body: MemoryBody;
  status: MemoryStatus;
  evidenceIds: string[];
  positiveFeedback: number;
  negativeFeedback: number;
  validation: { status: "pending" | "passed" | "failed"; checks: string[] };
  createdAt: string;
  updatedAt: string;
};

export type CorrectionCase = {
  id: string;
  at: string;
  runId: string;
  scope: MemoryScope;
  /** 用户主动提交 feedback 时才保存；不会进入日常运行上下文。 */
  rawConversation: string[];
  verifyFailures: string[];
  proposed: MemoryBody;
};

export type CorrectionInput = Omit<CorrectionCase, "id" | "at">;

export type EvolutionState = {
  version: 1;
  memories: MemoryVersion[];
};

export type JournalEvidence = {
  scope: MemoryScope;
  steps: SemanticStep[];
  verifyFailures: string[];
};

export type FeedbackIntent = "use_once" | "activate" | "skip" | "revise" | "forget";

export const FEEDBACK_STRIP_ACTIONS: readonly FeedbackIntent[] = [
  "use_once",
  "activate",
  "skip",
  "revise",
  "forget",
];

type EvolutionOptions = {
  dir?: string;
  now?: () => number;
  nextId?: () => string;
};

type Tombstone = {
  at: string;
  scope: MemoryScope;
  deletedVersions: number;
};

export function evolutionDir(base = defaultCacheDir()): string {
  return `${base}/evolution`;
}

export function scopeKey(scope: MemoryScope): string {
  return `${scope.application.trim()}\u0000${scope.taskKind.trim()}`;
}

function memoriesPath(dir: string): string {
  return `${dir}/memories.json`;
}

function correctionsPath(dir: string): string {
  return `${dir}/corrections.jsonl`;
}

function tombstonesPath(dir: string): string {
  return `${dir}/deletions.jsonl`;
}

function iso(now: () => number): string {
  return new Date(now()).toISOString();
}

function assertScope(scope: MemoryScope): void {
  if (!scope.application.trim() || !scope.taskKind.trim()) throw new Error("记忆作用域缺少 application 或 taskKind");
}

function assertBody(body: MemoryBody): void {
  if (body.kind === "preference") {
    if (!body.instruction.trim()) throw new Error("偏好内容不能为空");
    return;
  }
  if (body.steps.length < 2 || body.steps.length > 5) throw new Error("短技能必须包含 2–5 个语义步骤");
  for (const step of body.steps) {
    if (!step.actionId.trim()) throw new Error("技能步骤缺少 actionId");
    if (step.verify.length === 0 || step.verify.some((name) => !name.trim())) {
      throw new Error(`技能步骤 ${step.actionId} 缺少验证条件`);
    }
  }
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // Windows 不实现 POSIX 权限；调用仍保留，换到 macOS 时会真正生效。
  }
}

async function markPrivate(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch {
    // 同上。权限语义不能因为开发机是 Windows 就从代码里消失。
  }
}

async function loadState(dir: string): Promise<EvolutionState> {
  try {
    const parsed = JSON.parse(await readFile(memoriesPath(dir), "utf8")) as Partial<EvolutionState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.memories)) throw new Error("记忆文件格式不受支持");
    return { version: 1, memories: parsed.memories };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, memories: [] };
    throw err;
  }
}

async function saveState(dir: string, state: EvolutionState): Promise<void> {
  await ensurePrivateDir(dir);
  const path = memoriesPath(dir);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await markPrivate(path);
}

async function appendPrivate(dir: string, file: string, data: unknown): Promise<void> {
  await ensurePrivateDir(dir);
  await appendFile(file, `${JSON.stringify(data)}\n`, { encoding: "utf8", mode: 0o600 });
  await markPrivate(file);
}

async function readCorrections(dir: string): Promise<CorrectionCase[]> {
  try {
    const raw = await readFile(correctionsPath(dir), "utf8");
    const out: CorrectionCase[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as CorrectionCase);
      } catch {
        // 忘记操作以隐私为先：坏行无法证明不含待删内容，因此不把它重新写回。
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * 从既有 journal 的结构字段提取证据。外部字符串是否脱敏不影响 actionId 与 verify 判据名。
 */
export function evidenceFromJournal(events: readonly JournalEvent[]): JournalEvidence {
  const actions = new Map<number, string>();
  const acted = new Set<number>();
  const checks = new Map<number, string[]>();
  const failures: string[] = [];

  for (const event of events) {
    const data = asRecord(event.data);
    if (!data) continue;
    if (event.phase === "judge") {
      const judgement = asRecord(data.judgement);
      if (typeof judgement?.action === "string" && !["ASK", "WAIT", "DONE", "BLOCKED", "UNSUPPORTED"].includes(judgement.action)) {
        actions.set(event.step, judgement.action);
      }
    } else if (event.phase === "act") {
      acted.add(event.step);
    } else if (event.phase === "verify" && Array.isArray(data.checks)) {
      const names: string[] = [];
      for (const raw of data.checks) {
        const check = asRecord(raw);
        if (typeof check?.name !== "string") continue;
        names.push(check.name);
        if (check.ok !== true) failures.push(check.name);
      }
      checks.set(event.step, names);
    }
  }

  const selected = [...actions.entries()].filter(([step]) => acted.has(step));
  const fallback = selected.length > 0 ? selected : [...actions.entries()].slice(-1);
  if (fallback.length === 0) throw new Error("这条 run 没有可用于纠正的语义动作");
  const ids = fallback.map(([, actionId]) => actionId);
  const applications = [...new Set(ids.map((id) => id.slice(0, Math.max(0, id.lastIndexOf(".")))))]
    .filter(Boolean)
    .sort();
  return {
    scope: {
      application: applications.join("+") || "unknown",
      taskKind: ids.join(">"),
    },
    steps: fallback.map(([step, actionId]) => ({ actionId, verify: checks.get(step) ?? [] })),
    verifyFailures: [...new Set(failures)],
  };
}

export type EvolutionStore = ReturnType<typeof openEvolutionStore>;

export function openEvolutionStore(opts: EvolutionOptions = {}) {
  const dir = opts.dir ?? evolutionDir();
  const now = opts.now ?? Date.now;
  const nextId = opts.nextId ?? (() => ulid({ now }));

  return {
    dir,

    async list(): Promise<MemoryVersion[]> {
      return (await loadState(dir)).memories;
    },

    async suggest(scope: MemoryScope): Promise<MemoryVersion[]> {
      const key = scopeKey(scope);
      return (await loadState(dir)).memories
        .filter((memory) => scopeKey(memory.scope) === key && (memory.status === "candidate" || memory.status === "active"))
        .sort((a, b) => b.version - a.version);
    },

    async recordCorrection(input: CorrectionInput): Promise<{ correction: CorrectionCase; memory: MemoryVersion }> {
      assertScope(input.scope);
      assertBody(input.proposed);
      if (input.rawConversation.length === 0 || input.rawConversation.some((line) => !line.trim())) {
        throw new Error("明确反馈不能为空");
      }

      const at = iso(now);
      const correction: CorrectionCase = { ...input, id: nextId(), at };
      // 原文先记证据，再更新派生记忆；后一步失败也不会让用户刚提交的纠正凭空消失。
      await appendPrivate(dir, correctionsPath(dir), correction);

      const state = await loadState(dir);
      const key = scopeKey(input.scope);
      const candidate = state.memories.find((memory) => scopeKey(memory.scope) === key && memory.status === "candidate");
      let memory: MemoryVersion;
      if (candidate) {
        candidate.body = input.proposed;
        candidate.evidenceIds.push(correction.id);
        candidate.validation = { status: "pending", checks: [] };
        candidate.updatedAt = at;
        memory = candidate;
      } else {
        const version = Math.max(0, ...state.memories.filter((m) => scopeKey(m.scope) === key).map((m) => m.version)) + 1;
        memory = {
          id: nextId(),
          version,
          scope: input.scope,
          body: input.proposed,
          status: "candidate",
          evidenceIds: [correction.id],
          positiveFeedback: 0,
          negativeFeedback: 0,
          validation: { status: "pending", checks: [] },
          createdAt: at,
          updatedAt: at,
        };
        state.memories.push(memory);
      }
      await saveState(dir, state);
      return { correction, memory };
    },

    async activate(id: string): Promise<MemoryVersion> {
      const state = await loadState(dir);
      const target = state.memories.find((memory) => memory.id === id);
      if (!target) throw new Error(`找不到记忆: ${id}`);
      if (target.validation.status !== "passed") throw new Error("候选尚未通过 fixture / dry-run 验证，不能启用");
      const key = scopeKey(target.scope);
      const at = iso(now);
      for (const memory of state.memories) {
        if (memory.id !== id && scopeKey(memory.scope) === key && memory.status === "active") {
          memory.status = "superseded";
          memory.updatedAt = at;
        }
      }
      target.status = "active";
      target.updatedAt = at;
      await saveState(dir, state);
      return target;
    },

    async markValidated(id: string, passed: boolean, checks: string[]): Promise<MemoryVersion> {
      const state = await loadState(dir);
      const target = state.memories.find((memory) => memory.id === id);
      if (!target) throw new Error(`找不到记忆: ${id}`);
      if (checks.length === 0 || checks.some((check) => !check.trim())) throw new Error("验证结果必须包含至少一个代码判据");
      target.validation = { status: passed ? "passed" : "failed", checks: [...new Set(checks)] };
      target.updatedAt = iso(now);
      if (!passed) target.status = "suspended";
      await saveState(dir, state);
      return target;
    },

    async setStatus(id: string, status: "suspended" | "rejected"): Promise<MemoryVersion> {
      const state = await loadState(dir);
      const target = state.memories.find((memory) => memory.id === id);
      if (!target) throw new Error(`找不到记忆: ${id}`);
      target.status = status;
      target.updatedAt = iso(now);
      if (status === "suspended") target.negativeFeedback++;
      await saveState(dir, state);
      return target;
    },

    async markHelpful(id: string): Promise<MemoryVersion> {
      const state = await loadState(dir);
      const target = state.memories.find((memory) => memory.id === id);
      if (!target) throw new Error(`找不到记忆: ${id}`);
      target.positiveFeedback++;
      target.updatedAt = iso(now);
      await saveState(dir, state);
      return target;
    },

    async forget(id: string): Promise<number> {
      const state = await loadState(dir);
      const target = state.memories.find((memory) => memory.id === id);
      if (!target) return 0;
      const key = scopeKey(target.scope);
      const removed = state.memories.filter((memory) => scopeKey(memory.scope) === key);
      const evidence = new Set(removed.flatMap((memory) => memory.evidenceIds));
      state.memories = state.memories.filter((memory) => scopeKey(memory.scope) !== key);
      await saveState(dir, state);

      const remaining = (await readCorrections(dir)).filter((correction) => !evidence.has(correction.id));
      const correctionFile = correctionsPath(dir);
      await writeFile(correctionFile, remaining.map((item) => JSON.stringify(item)).join("\n") + (remaining.length ? "\n" : ""), {
        encoding: "utf8",
        mode: 0o600,
      });
      await markPrivate(correctionFile);
      const tombstone: Tombstone = { at: iso(now), scope: target.scope, deletedVersions: removed.length };
      await appendPrivate(dir, tombstonesPath(dir), tombstone);
      return removed.length;
    },

    async prune(): Promise<number> {
      const state = await loadState(dir);
      const before = state.memories.length;
      const t = now();
      const removedEvidence = new Set<string>();
      state.memories = state.memories.filter((memory) => {
        if (memory.status === "active") return true;
        const age = t - Date.parse(memory.updatedAt);
        const keep = memory.status === "candidate" ? age < CANDIDATE_TTL_MS : age < HISTORY_TTL_MS;
        if (!keep) for (const id of memory.evidenceIds) removedEvidence.add(id);
        return keep;
      });
      if (state.memories.length !== before) {
        await saveState(dir, state);
        const remaining = (await readCorrections(dir)).filter((correction) => !removedEvidence.has(correction.id));
        const path = correctionsPath(dir);
        await writeFile(path, remaining.map((item) => JSON.stringify(item)).join("\n") + (remaining.length ? "\n" : ""), {
          encoding: "utf8",
          mode: 0o600,
        });
        await markPrivate(path);
      }
      return before - state.memories.length;
    },
  };
}

export type ActionEffect = "read" | "navigate" | "draft" | "submit" | "change" | "destroy";

export type ScheduledAuthorization = {
  memoryVersionId: string;
  application: string;
  target: string;
  inputFingerprint: string;
  effect: "submit" | "change";
  verify: string[];
};

export type ScheduledRequest = {
  memoryVersionId: string;
  application: string;
  target: string;
  inputFingerprint: string;
  effect: ActionEffect;
  verify: string[];
};

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index]);
}

/** 定时授权只能精确匹配；任何缺字段或版本漂移都 fail-closed。 */
export function authorizeScheduled(request: ScheduledRequest, grant?: ScheduledAuthorization): { allowed: boolean; reason: string } {
  if (request.effect === "destroy") return { allowed: false, reason: "destroy 永远不能定时预授权" };
  if (["read", "navigate", "draft"].includes(request.effect)) return { allowed: true, reason: "低风险动作无需预授权" };
  if (!grant) return { allowed: false, reason: `${request.effect} 缺少精确预授权` };
  const exact = grant.memoryVersionId === request.memoryVersionId
    && grant.application === request.application
    && grant.target === request.target
    && grant.inputFingerprint === request.inputFingerprint
    && grant.effect === request.effect
    && sameStrings(grant.verify, request.verify);
  return exact
    ? { allowed: true, reason: "技能版本、目标、输入与验证条件完全匹配" }
    : { allowed: false, reason: "预授权与当前技能版本、目标、输入或验证条件不一致" };
}

