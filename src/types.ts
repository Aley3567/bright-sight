/**
 * 盲视（BrightSight）：不读屏幕像素的桌面智能体。
 *
 * 命名取自神经科学现象——视觉皮层受损者坚称看不见，却能准确指出物体位置。
 * 本系统同样不看屏幕：感知来自 macOS 无障碍树与应用脚本字典，
 * 二者都是操作系统主动暴露给程序的结构化语义，比像素便宜且无歧义。
 *
 * 一轮交互是 observe → judge → act → verify 的闭环，四步各自落一条事件。
 * 事件以 append-only 的 JSONL 落在本地（journal.ts），因此任何一步的
 * 判断依据和概率分布事后都能原样调出来复查。
 *
 * 存储是自带的、不依赖任何外部系统——bright-sight/ 始终可以整个目录搬出去独立成仓。
 */

/** 一个可被执行的语义动作，由应用脚本字典（sdef）或无障碍树推导而来。 */
export type ActionSpec = {
  /** 稳定标识，形如 `Notes.make-note`，用作决策层选项的键。 */
  id: string;
  /** 归属应用名，与 `tell application "<app>"` 中的名称一致。 */
  app: string;
  /** 给模型看的一句话说明；决策层只凭这句话和参数表判断该不该选它。 */
  summary: string;
  kind: "script" | "ax" | "shell";
  params: ActionParam[];
  /**
   * 危险等级：destructive 的动作即便概率很高也必须经人确认。
   * 该判断在动作面构建期就固定下来，不依赖模型每次重新判断，
   * 模型失准时安全闸不会跟着一起失准。
   */
  risk: "safe" | "caution" | "destructive";
};

export type ActionParam = {
  name: string;
  /** AppleScript 原始类型名，如 text / boolean / integer / specifier。 */
  type: string;
  optional: boolean;
};

/** 一次感知快照：当下这台机器的结构化状态，作为决策层的 state 输入。 */
export type Snapshot = {
  at: string;
  /** 前台应用名。 */
  front: string;
  /** 前台窗口标题，取不到时为 null（例如无窗口的后台代理）。 */
  window: string | null;
  /** 正在运行的应用，按最近使用排序。 */
  running: string[];
  /** 当前窗口里可交互的元素，已剔除纯装饰节点。 */
  elements: UIElement[];
  /** 用户当前选中的文本，多步任务常需要它作为上下文。 */
  selection: string | null;
};

export type UIElement = {
  /** 无障碍角色，如 button / text field / menu item。 */
  role: string;
  /** 可读标签：优先取 title，缺失时退到 description 或 value。 */
  label: string;
  /** 在窗口元素序列中的位置，执行层按它定位，不用像素坐标。 */
  index: number;
};

/** 决策层的一次判断结果。概率全部保留，事后可复查，不只存最终选项。 */
export type Judgement = {
  /** 选中的动作 id，或 `none` 表示当前输入还不足以决定任何动作。 */
  action: string;
  /** 各候选动作的概率分布，键为动作 id。 */
  probabilities: Record<string, number>;
  /** 分布集中度；低于阈值时不执行，转为向用户澄清。 */
  confidence: number;
  /** 模型认为该指令已表达完整的概率；语音边说边判时靠它决定要不要再等。 */
  complete: number;
  /** 模型认为该动作具有破坏性的概率，与动作面固定的 risk 取并集。 */
  destructive: number;
  /** 产生该判断的后端，jev 或某个 llm 模型名，用于对照实验。 */
  backend: string;
  /** 端到端耗时（毫秒），是"不看屏幕"这一路线的核心证据。 */
  latency_ms: number;
};

/**
 * 任务层动作：不对应任何应用命令，是循环自己的控制动作。
 *
 * 它们和真实动作放在同一个选项集里让模型挑，因为"该收手了"和"该执行下一步了"
 * 本来就是同一个判断。分成两次问，模型就得在不知道能不能收手的前提下选动作。
 */
export type TaskAction = "ASK" | "WAIT" | "DONE" | "BLOCKED" | "UNSUPPORTED";

export const TASK_ACTIONS: Record<TaskAction, string> = {
  ASK: "信息不够，需要向用户追问",
  WAIT: "上一步还没生效，再等一下重新观察",
  DONE: "用户要求的事情已经全部做完了",
  BLOCKED: "做不下去了，需要人介入",
  UNSUPPORTED: "这件事当前系统不支持",
};

export function isTaskAction(id: string): id is TaskAction {
  return Object.prototype.hasOwnProperty.call(TASK_ACTIONS, id);
}

/**
 * 一步执行产出的、可被后续步骤引用的值。
 *
 * 必须带 provenance：产物与 verify 的判据来自同一次回读的同一个字段，
 * 不是两套逻辑碰巧一致。事后看 journal 能一路回溯到那一行 AppleScript 返回值。
 */
export type Artifact = {
  /** 形如 `chrome.active_url`，跨步骤引用时用它。 */
  key: string;
  value: string;
  from: { step: number; actionId: string; field: string };
};

/**
 * 执行结果。
 *
 * argv 无论成败都记录：安全审计要回答的问题是"到底发出去了什么"，
 * 失败的那次发出去了什么同样要能查。
 */
export type ExecResult =
  | { ok: true; readback: Record<string, string>; argv: string[]; ms: number }
  | { ok: false; errors: string[]; argv: string[]; ms: number };

/**
 * Chrome profile 闸门状态。
 *
 * 类型放在这里而不是 chrome.ts，是为了让 policy.ts 能引用它而不必 import 一个带文件 IO
 * 的模块——policy.ts 是安全边界，它的「零 IO、纯函数」必须一眼可验。
 * 探测怎么做在 chrome.ts，拿探测结果怎么判在 policy.ts，两件事不互相依赖。
 */
export type ProfileGate =
  /**
   * 放行。`via` 记的是凭什么放行：`settings` 是名单里本来就有，
   * `prompt` 是人刚刚当场拍的板。两者都算数，但留痕里要分得清——
   * 「是谁允许的」和「允许了没有」是两个问题。
   */
  | { kind: "allowed"; dir: string; via: "settings" | "prompt" }
  /** 探测到了，但不在名单里（或两路探测对不上，结论本身不可靠）。 */
  | { kind: "unknown"; dir: string }
  /** 根本没探测到。不知道会落在哪，和落在陌生 profile 一样不该静默执行。 */
  | { kind: "undetectable"; detail: string }
  /**
   * 这一轮压根不会发出 Apple Event（dry-run），闸门不适用。
   *
   * 单列一个态而不是复用 `allowed`，是为了让意图无法被误读：`allowed` 的含义是
   * 「人确认过可以在这个 profile 下操作」，而 dry-run 是「不会有任何操作」。
   * 两者混在一起，留痕里就再也分不清某一次放行到底凭的是什么。
   * 它只由 CLI 在 dry-run 路径上构造。
   */
  | { kind: "dry-run" };

/** 单条验证判据。全部由代码判定，模型不参与自证。 */
export type VerifyCheck = { name: string; ok: boolean; detail: string };

export type VerifyResult = { ok: boolean; checks: VerifyCheck[] };

/** 一步的完整留痕：observe / judge / act / verify 四段齐全。 */
export type StepRecord = {
  step: number;
  observe: Snapshot;
  judgement: Judgement;
  /** 解析出的动作与参数；模型选了任务层动作时 actionId 就是那个 TaskAction。 */
  actionId: string;
  exec: ExecResult | null;
  verify: VerifyResult | null;
  /** 决策为什么被允许或拦下，由 policy.ts 给出，人读的。 */
  reasons: string[];
};

export type RunStatus = "running" | "done" | "blocked" | "needs_input";

export type RunState = {
  runId: string;
  utterance: string;
  status: RunStatus;
  steps: StepRecord[];
  artifacts: Artifact[];
};
