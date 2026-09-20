/**
 * 配置数据，不是应用适配代码。
 *
 * 这里唯一"知道某个网站"的东西是搜索 URL 模板。它之所以不算违背"零适配代码"，
 * 是因为模型全程没有见过也没有生成过任何 URL：模型只从用户原话里挑一个查询词片段，
 * 拼 URL 的是下面这段固定模板加 encodeURIComponent。
 * 与之相对，"为 Chrome 写一个 search 动作"才是适配代码——那是在动作面里凭空造能力。
 */

/** 执行白名单。动作面再大，能真正发出 Apple Event 的只有这两个。 */
export const ALLOWED_APPS = ["Notes", "Google Chrome"] as const;
export type AllowedApp = (typeof ALLOWED_APPS)[number];

export function isAllowedApp(app: string): app is AllowedApp {
  return (ALLOWED_APPS as readonly string[]).includes(app);
}

export type SearchEngine = {
  /** `%s` 处填 encodeURIComponent 后的查询词。 */
  template: string;
  /**
   * 结果页允许落在的 origin（发出 URL 自身的 origin 之外）。
   *
   * 实测：Bing 会把 www.bing.com 重定向到 cn.bing.com，百度更是直接跳到
   * wappass.baidu.com 的反爬验证码页。所以 verify 的 origin 检查不能写死成
   * "回读 origin == 发出 origin"，它是引擎相关配置。Google / DuckDuckGo 实测原地不动，
   * 所以这两个引擎的清单是空的，检查退化为严格相等。
   */
  resultOrigins: string[];
};

export const SEARCH_ENGINES: Record<string, SearchEngine> = {
  google: { template: "https://www.google.com/search?q=%s", resultOrigins: [] },
  duckduckgo: { template: "https://duckduckgo.com/?q=%s", resultOrigins: [] },
  bing: { template: "https://www.bing.com/search?q=%s", resultOrigins: ["https://cn.bing.com"] },
};

/** 默认引擎：本机实测可达且不改写 origin。可用 BRIGHTSIGHT_ENGINE 覆盖。 */
export const DEFAULT_ENGINE = "google";

export function resolveEngine(name = process.env.BRIGHTSIGHT_ENGINE ?? DEFAULT_ENGINE): SearchEngine {
  const e = SEARCH_ENGINES[name];
  if (!e) throw new Error(`未知搜索引擎 ${JSON.stringify(name)}，可选：${Object.keys(SEARCH_ENGINES).join("/")}`);
  return e;
}

/**
 * 把查询词拼成搜索 URL。
 *
 * 过一次 new URL() 不是为了好看：查询词来自用户原话，encodeURIComponent 之后
 * 理论上已不可能改变 URL 结构，这道解析是纵深防御——模板本身写错了也要在这里炸掉，
 * 而不是把一个畸形 URL 送进浏览器。
 */
export function searchUrl(query: string, engine = resolveEngine()): string {
  const raw = engine.template.replace("%s", encodeURIComponent(query));
  const u = new URL(raw);
  if (u.protocol !== "https:") throw new Error(`搜索 URL 必须是 https：${raw}`);
  return u.toString();
}

/** 写进笔记或再次打开前，任何 URL 都要过这道 scheme 白名单。 */
export const SAFE_SCHEMES = ["https:", "http:"];

export function isSafeUrl(value: string): boolean {
  try {
    return SAFE_SCHEMES.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** 代码兜底，全都不经模型。 */
export const LIMITS = {
  /** 每步都是真实副作用，步数上限要按"最坏情况用户能接受几次误操作"定，不是按 token。 */
  maxSteps: 6,
  /** 候选片段数量上限，超过就说明切片器没收敛，宁可让用户选也不要灌给模型。 */
  maxSpans: 12,
  /** 单个候选片段的字符上限。 */
  maxSpanChars: 120,
} as const;
