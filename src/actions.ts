import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { capabilityEffectOf, type ScriptEffect } from "./scripts.ts";
import type { ActionParam, Risk, ScriptActionSpec } from "./types.ts";

// sdef 不是 osascript：它只读磁盘上的脚本字典，不投递 Apple Event，
// 也不接受任何用户输入（参数恒为 readdir 扫出的 .app 路径），
// 因此不归 osa.ts 管——osa.ts 的职责边界是「唯一 spawn osascript 的出口」。
const run = promisify(execFile);

/**
 * 动作面不是手写的：它从 macOS 自己的脚本字典（sdef）里长出来。
 *
 * 这带来一个直接后果——本系统没有为任何单个应用写过适配代码。
 * 用户装了什么可脚本化的应用，动作面就自动多出那个应用的全部命令，
 * 包括我们从未见过的第三方应用。
 */

/** 系统标准套件，几乎所有应用通过 xi:include 继承它，sdef 命令本身不展开。 */
const COCOA_STANDARD = "/System/Library/ScriptingDefinitions/CocoaStandard.sdef";

/**
 * 破坏性命令清单。
 *
 * 风险在动作面构建期就固定，不交给模型每次重判：模型失准时，
 * 安全闸不能跟着一起失准。模型的破坏性判断只用于追加拦截，不能解除拦截。
 */
const DESTRUCTIVE = new Set(["delete", "remove", "empty", "erase", "trash"]);
const CAUTION = new Set(["move", "save", "print", "duplicate", "set", "close", "quit"]);

function riskOf(command: string): Risk {
  const c = command.toLowerCase();
  if (DESTRUCTIVE.has(c)) return "destructive";
  if (CAUTION.has(c)) return "caution";
  return "safe";
}

/** 「造出一个东西」的动词。落在 `make` 上的命令最多，它是 sdef 里唯一的通用造物入口。 */
const CREATES = new Set(["make", "create", "new"]);
/** 「把人带到某个地方」的动词：打开某个位置/页面属于导航，不是改动。 */
const NAVIGATES = new Set(["open", "show", "go", "launch", "activate"]);

/**
 * sdef 动词给出的**初判**副作用档。
 *
 * 它只是初判：`make` 这一个动词既推不出「开标签页是 navigate」也推不出「记笔记是 draft」，
 * 真正可执行的动作（在冻结注册表里的）由 `surface.ts` 用模板的 effect 覆盖成权威值。
 * 这里存在的意义是让动作面里那些**不可执行**的条目也有一个诚实的字段，
 * 而不是编一个看起来像真的值。它不参与任何安全判据——能不能执行由注册表说了算。
 */
function scriptEffectOf(command: string): ScriptEffect {
  const c = command.toLowerCase();
  if (DESTRUCTIVE.has(c)) return "destroy";
  if (CREATES.has(c)) return "create";
  if (NAVIGATES.has(c)) return "navigate";
  return "read";
}

/**
 * 极简 sdef 解析。
 *
 * 不引入 XML 依赖：sdef 是结构高度规整的机器生成文件（元素不跨行嵌套同名标签，
 * 无 CDATA），正则足够且让本模块保持零依赖，与仓库其余部分一致。
 * 代价是格式一旦变化会静默少抽命令，因此 extractApp 对空结果会显式报告。
 */
function parseCommands(xml: string, app: string): ScriptActionSpec[] {
  const out: ScriptActionSpec[] = [];
  // 命令块：<command name="..." ...> ... </command>，或自闭合的 <command ... />
  const blocks = xml.matchAll(/<command\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/command>)/g);
  for (const m of blocks) {
    const attrs = m[1];
    const body = m[2] ?? "";
    const name = /name="([^"]*)"/.exec(attrs)?.[1];
    if (!name) continue;
    const desc = /description="([^"]*)"/.exec(attrs)?.[1] ?? "";

    const params: ActionParam[] = [];
    const direct = /<direct-parameter\b([^>]*?)(?:\/>|>([\s\S]*?)<\/direct-parameter>)/.exec(body);
    if (direct) {
      const a = direct[1];
      const inner = direct[2] ?? "";
      // 类型可能写在属性上，也可能展开成多个 <type type="..."/> 子元素
      const t =
        /type="([^"]*)"/.exec(a)?.[1] ??
        [...inner.matchAll(/<type\s+type="([^"]*)"/g)].map((x) => x[1]).join("|") ??
        "any";
      params.push({ name: "direct", type: t || "any", optional: /optional="yes"/.test(a) });
    }
    for (const p of body.matchAll(/<parameter\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/parameter>)/g)) {
      const a = p[1];
      const pn = /name="([^"]*)"/.exec(a)?.[1];
      if (!pn) continue;
      const t = /type="([^"]*)"/.exec(a)?.[1] ??
        [...(p[2] ?? "").matchAll(/<type\s+type="([^"]*)"/g)].map((x) => x[1]).join("|");
      params.push({ name: pn, type: t || "any", optional: /optional="yes"/.test(a) });
    }

    out.push({
      id: `${app}.${name.replace(/\s+/g, "-")}`,
      app,
      summary: desc || `${app} 的 ${name} 命令`,
      kind: "script",
      params,
      risk: riskOf(name),
      effect: capabilityEffectOf(scriptEffectOf(name)),
    });
  }
  return out;
}

/**
 * sdef 里的一个 class，只保留可写属性。
 *
 * 可写属性才是 `make new <class> with properties {...}` 能填的槽位。
 * 注意不能拿 make 命令自己的 `<parameter>`——CocoaStandard 里那是
 * `new / at / with data / with properties`，是 AppleScript 的语法槽位，
 * 把它们喂给模型比不喂更糟。
 */
type ClassDef = { name: string; description: string; writable: ActionParam[] };

function parseClasses(xml: string): ClassDef[] {
  const out: ClassDef[] = [];
  for (const m of xml.matchAll(/<class\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/class>)/g)) {
    const attrs = m[1];
    const body = m[2] ?? "";
    const name = /name="([^"]*)"/.exec(attrs)?.[1];
    if (!name) continue;
    const writable: ActionParam[] = [];
    for (const pm of body.matchAll(/<property\s+([^>]*?)(?:\/>|>[\s\S]*?<\/property>)/g)) {
      const a = pm[1];
      const pn = /name="([^"]*)"/.exec(a)?.[1];
      if (!pn) continue;
      // access 缺省即可读写；只有显式 access="r" 才是只读
      if (/access="r"/.test(a)) continue;
      writable.push({ name: pn, type: /type="([^"]*)"/.exec(a)?.[1] ?? "any", optional: true });
    }
    out.push({
      name,
      description: /description="([^"]*)"/.exec(attrs)?.[1] ?? "",
      writable,
    });
  }
  return out;
}

/** sdef 用实体转义写英文撇号等字符，展示给模型前还原掉。 */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 把通用的 `make` 展开成 `make-<class>`。
 *
 * 动机有两条，它们在这里合流：
 *
 * 能力——Notes 的 sdef 自有命令只有 open note location 和 show，现在动作面里那个
 * `make` 来自 CocoaStandard，描述是通用的「Create a new object.」，根本不告诉模型
 * 在备忘录里能建什么。模型在 make 和 open 之间犹豫不是阈值问题，是选项本身没信息。
 *
 * 安全——展开后的 id（`Notes.make-note`）才是执行模板注册表的键，
 * 「能不能执行」于是变成「这个 class 组合在不在表里」，而不是「命令动词像不像危险」。
 *
 * 只展开 make，不做全量 command × class：Chrome 5 个 class × 20+ 命令是 100+ 条，
 * 全系统会撞穿 Choice 的 255 上限，而且 `Chrome.reload-bookmark-folder` 这种组合根本不存在。
 */
function expandMake(specs: ScriptActionSpec[], classes: ClassDef[], app: string): ScriptActionSpec[] {
  const generic = specs.find((s) => s.id === `${app}.make`);
  if (!generic) return specs;

  const expanded: ScriptActionSpec[] = [];
  for (const c of classes) {
    if (c.writable.length === 0) continue; // 没有可填的属性，建出来也是个空壳
    const desc = unescapeXml(c.description) || `${app} 的 ${c.name}`;
    expanded.push({
      id: `${app}.make-${c.name.replace(/\s+/g, "-")}`,
      app,
      summary: `在 ${app} 里新建一个 ${c.name}：${desc}`,
      kind: "script",
      params: c.writable,
      risk: generic.risk,
      effect: generic.effect,
    });
  }
  if (expanded.length === 0) return specs;
  // 展开成功就撤掉那条无信息的通用 make，避免它和展开项互相稀释概率
  return [...specs.filter((s) => s.id !== generic.id), ...expanded];
}

/**
 * 把一份 sdef 原文解析成动作面。
 *
 * 与 extractApp 分开是为了可测：测试拿提交进仓库的 sdef 快照跑这里，
 * 断言就不会随本机应用版本漂移；extractApp 只负责把原文取出来。
 */
export function parseSdef(own: string, app: string, standard?: string): ScriptActionSpec[] {
  if (!own.trim()) return [];
  const specs = parseCommands(own, app);
  // 继承标准套件：sdef 只留下 xi:include 指令，需要我们自己展开
  if (standard && own.includes("xi:include") && own.includes("CocoaStandard.sdef")) {
    specs.push(...parseCommands(standard, app));
  }
  // 同名命令去重：应用自有定义覆盖标准套件的同名项
  const seen = new Map<string, ScriptActionSpec>();
  for (const s of specs) if (!seen.has(s.id)) seen.set(s.id, s);
  // class 只从应用自有 sdef 抽：标准套件里的 application / window 是通用外壳，
  // 展开出来的 make-application 之类对任何意图都没有区分度
  return expandMake([...seen.values()], parseClasses(own), app);
}

/** 读取一个应用的完整动作面：标准套件 + 应用自有套件。 */
export async function extractApp(appPath: string): Promise<ScriptActionSpec[]> {
  const app = appPath.split("/").pop()!.replace(/\.app$/, "");
  let own = "";
  try {
    const { stdout } = await run("sdef", [appPath], { maxBuffer: 8 << 20 });
    own = stdout;
  } catch {
    return []; // 不可脚本化的应用没有 sdef，这是正常情况而非错误
  }
  let standard: string | undefined;
  try {
    standard = await readFile(COCOA_STANDARD, "utf8");
  } catch {
    // 标准套件读不到时，应用仍保留自有命令，不因此整体失败
  }
  return parseSdef(own, app, standard);
}

export type Surface = { actions: ScriptActionSpec[]; apps: string[]; scriptable: string[] };

const DEFAULT_DIRS = ["/Applications", "/System/Applications"];

/** 列出待扫描的 .app 路径。指纹与构建必须看到同一份清单，所以单独抽出来。 */
async function scanAppPaths(dirs: readonly string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const d of dirs) {
    try {
      for (const e of await readdir(d)) if (e.endsWith(".app")) paths.push(`${d}/${e}`);
    } catch {
      // 目录不存在（例如精简系统缺少 /Applications）时跳过，不中断扫描
    }
  }
  return paths.sort();
}

/** 扫描系统里全部可脚本化应用，构建完整动作面。 */
export async function buildSurface(dirs: readonly string[] = DEFAULT_DIRS): Promise<Surface> {
  return buildFrom(await scanAppPaths(dirs));
}

async function buildFrom(paths: readonly string[]): Promise<Surface> {
  const results = await Promise.all(paths.map((p) => extractApp(p).catch(() => [])));
  const actions = results.flat();
  const scriptable = [...new Set(actions.map((a) => a.app))].sort();
  const apps = paths.map((p) => p.split("/").pop()!.replace(/\.app$/, "")).sort();
  return { actions, apps, scriptable };
}

/**
 * 动作面磁盘缓存。
 *
 * buildSurface() 要对全盘每个 .app 各起一次 sdef 子进程，本机实测 9.6 秒 / 112 个应用。
 * 一次 run 里 observe→judge→act→verify 会走多轮，每轮重建动作面是灾难，
 * 所以按「应用清单 + 各自 mtime」做指纹：应用没装没删没更新，就直接复用上次的解析结果。
 *
 * 缓存存的是解析后的 ScriptActionSpec 而非 sdef 原文，所以解析规则一改缓存就必须失效——
 * 这件事没有自动机制，靠 CACHE_VERSION 手动递增。改了 parseCommands / riskOf 就要 +1。
 */
const CACHE_VERSION = 3;

/** 缓存目录可注入：测试指向临时目录，不污染也不依赖真实 ~/.bright-sight。 */
export function defaultCacheDir(): string {
  return `${homedir()}/.bright-sight`;
}

/**
 * 指纹覆盖三样东西：解析器版本、应用清单、每个 .app 的 mtime。
 * 标准套件也算进去——它是几乎所有应用命令的共同来源，系统升级后它变了必须失效。
 */
async function fingerprint(paths: readonly string[]): Promise<string> {
  const h = createHash("sha256");
  h.update(`v${CACHE_VERSION}\n`);
  for (const p of [...paths, COCOA_STANDARD]) {
    let mtime = "missing";
    try {
      mtime = String((await stat(p)).mtimeMs);
    } catch {
      // stat 不到照样写进指纹：路径本身在串里，"存在过但现在没了" 与 "从来没有过"
      // 因为清单不同而天然指纹不同，不会被混成同一个 key
    }
    h.update(`${p}\t${mtime}\n`);
  }
  return h.digest("hex");
}

type CacheFile = Surface & { fingerprint: string };

function isUsableCache(v: unknown, fp: string): v is CacheFile {
  const c = v as Partial<CacheFile> | null;
  return (
    !!c &&
    c.fingerprint === fp &&
    Array.isArray(c.actions) &&
    Array.isArray(c.apps) &&
    Array.isArray(c.scriptable)
  );
}

/**
 * 取动作面，命中缓存就不重建。
 *
 * 缓存永远不是正确性的前提：读不到、解析坏、指纹不符一律静默重建，
 * 写不进去也只是下轮再慢一次，都不向上抛。
 */
export async function loadSurface(
  opts: { dirs?: readonly string[]; cacheDir?: string } = {},
): Promise<Surface & { fromCache: boolean }> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const file = `${cacheDir}/surface.json`;
  const paths = await scanAppPaths(opts.dirs ?? DEFAULT_DIRS);
  const fp = await fingerprint(paths);

  try {
    const cached: unknown = JSON.parse(await readFile(file, "utf8"));
    if (isUsableCache(cached, fp)) {
      return { actions: cached.actions, apps: cached.apps, scriptable: cached.scriptable, fromCache: true };
    }
  } catch {
    // 缓存缺失或损坏，重建
  }

  const surface = await buildFrom(paths);
  try {
    // 0o700 / 0o600 显式写出来，不听凭 umask：surface.json 是一份「这台机器装了
    // 哪些可脚本化应用」的清单，属于指纹类信息。journal.ts 与 settings.ts 都已显式给权限，
    // 这里漏掉就成了三个落盘点里唯一听凭 umask 的那个。
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    // 先写临时文件再 rename：两个 run 并发时，读者要么看到旧的完整文件，
    // 要么看到新的完整文件，不会读到写到一半的 JSON
    const tmp = `${file}.tmp-${process.pid}`;
    const payload: CacheFile = { fingerprint: fp, ...surface };
    await writeFile(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  } catch {
    // 写缓存失败（只读 home、磁盘满）不影响本次结果
  }
  return { ...surface, fromCache: false };
}
