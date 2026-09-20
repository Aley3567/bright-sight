import {
  NOTIFY_TRANSPORT_ERROR,
  RPC_CALL_TIMEOUT_MS,
  RPC_MAX_LINE_CHARS,
  RPC_REPLAYED_FIELD,
  RPC_REQUEST_KEY_FIELD,
  encodeMessage,
  makeRpcError,
  parityOf,
  parseMessage,
  type ParsedMessage,
  type RpcError,
  type RpcErrorCode,
  type RpcId,
  type RpcParity,
} from "./protocol.ts";

/**
 * 双向 JSON Lines 对等端。
 *
 * 「对等端」不是措辞讲究：这一层不区分客户端和服务端，两个方向都能发请求。
 * 整个阶段 2 改造存在的理由就是这个——一次性 spawn 撑不住「Node 决策到一半，
 * 反过来要求 Swift 去观察或执行」。做成单向的请求处理器等于白改。
 *
 * 流是**注入**的，不碰 `process.stdin` / `process.stdout`。`src/loop.ts` 是现成的榜样：
 * 它的全部依赖都是函数参数，所以整个控制流能在内存里跑完。这里同理——
 * 测试里 `write` 是个往数组里塞字符串的闭包，`ingest` 手工喂半行，全程零 IO。
 */

/** 写出去。参数已经带了行尾换行，实现只管原样送走。 */
export type RpcWriter = (chunk: string) => void;

export type RpcHandlerContext = {
  /**
   * 反向调用对面并等结果。这是双向的那一半。
   *
   * **不会自动重发。** 超时返回 `request_timeout`，要不要再来一次由调用方决定——
   * 对面可能已经做完了副作用只是回话慢，自动重发等于替用户多按一次按钮。
   */
  call: <T = unknown>(method: string, params?: unknown, opts?: RpcCallOptions) => Promise<T>;
  notify: (method: string, params?: unknown) => void;
  /**
   * 连接断开时 abort。
   *
   * 它只能拦住「还没发生的下一步」：已经投递出去的 Apple Event 不会回滚。
   * 把它当 undo 用是错的。
   */
  signal: AbortSignal;
  requestId: RpcId;
};

export type RpcHandler = (params: unknown, ctx: RpcHandlerContext) => Promise<unknown>;

export type RpcMethodSpec = {
  handler: RpcHandler;
  /**
   * 这个方法有真实副作用，同一个 `requestKey` 最多执行一次。
   *
   * 长驻连接会超时、会重连、会重发，而 `session.handle` 真的会开标签页、写笔记。
   * 不去重的话，`docs/agent-v2-design.md` §10 不变量 1「一个决定最多执行一次」
   * 就在 RPC 这一层破了，而且破得很隐蔽：Swift 那边看起来只是「重试了一下」。
   *
   * 缺 `requestKey` 一律 `invalid_params`，不会「先执行了再说」。
   */
  once?: boolean;
};

export type RpcCallOptions = { timeoutMs?: number; signal?: AbortSignal };

export type RpcPeerOptions = {
  write: RpcWriter;
  methods: Record<string, RpcMethodSpec>;
  /**
   * 我方请求 id 的奇偶。Node 侧一律 `even`，Swift 侧一律 `odd`（见 protocol.ts）。
   *
   * 两侧各自分配 id 时，不切开空间就分不清 `{"id":1,"result":…}` 是谁的回应。
   */
  idParity: RpcParity;
  /** 不认识的通知怎么办。默认静默忽略——协议兼容规则 2。 */
  onNotification?: (method: string, params: unknown) => void;
  /** 传输层事故（行读不出来、id 对不上）。默认除了给对面发一条通知之外什么都不做。 */
  onTransportError?: (error: RpcError) => void;
  maxLineChars?: number;
  /** 幂等结果缓存条数。超出的键降级成墓碑，见 `replay_unavailable`。 */
  replayCacheSize?: number;
  /** 墓碑上限。 */
  replayTombstoneSize?: number;
};

export type RpcPeer = {
  /** 喂进一段文本。可以是半行、可以是好几行，可以从任意字节位置切开。 */
  ingest: (chunk: string) => void;
  call: <T = unknown>(method: string, params?: unknown, opts?: RpcCallOptions) => Promise<T>;
  notify: (method: string, params?: unknown) => void;
  /** 等当前在飞的入站处理全部落定。测试用；生产路径不需要等它。 */
  drain: () => Promise<void>;
  close: (reason?: string) => void;
  pendingCalls: () => number;
};

/**
 * 处理器主动抛出的、有明确语义的失败。
 *
 * `sideEffectFree` 默认 **false**，这是缺省 fail-closed 的实例：处理器抛了个异常，
 * 我们不知道它抛之前有没有已经开出一个标签页，于是把这个 requestKey 记成墓碑，
 * 重发时回 `replay_unavailable` 而不是再跑一遍。确实什么都没发生的路径
 * （参数校验、缺凭证）才显式声明 `sideEffectFree: true`，把键放回去。
 */
export class RpcFailure extends Error {
  code: RpcErrorCode;
  retriable?: boolean;
  sideEffectFree: boolean;

  constructor(code: RpcErrorCode, message: string, opts: { retriable?: boolean; sideEffectFree?: boolean } = {}) {
    super(message);
    this.name = "RpcFailure";
    this.code = code;
    this.retriable = opts.retriable;
    this.sideEffectFree = opts.sideEffectFree ?? false;
  }
}

function errorOf(err: unknown): RpcError {
  if (err instanceof RpcFailure) {
    return makeRpcError(err.code, err.message, err.retriable === undefined ? {} : { retriable: err.retriable });
  }
  // 原始异常消息原样带出去：它是给用户看的，可能含原话——所以 protocol.ts 里
  // 写明了「不要把 error.message 写进持久日志」。这一层不落盘，也不该在这里二次加工成
  // 一句没有信息量的「出错了」
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return makeRpcError("internal_error", detail);
}

/**
 * 行切分。
 *
 * 半行、粘包、一行被从任意位置切成两段，都是 stdio 上的常态，不是异常。
 * 多字节字符被切开不用这里操心：调用方对流设了 utf8 编码，Node 的 StringDecoder
 * 会把半个字符留到下一块。
 *
 * 超长行不能只是丢掉——丢掉之后缓冲区里剩的是半条消息，接下来每一行都会错位。
 * 所以要一直吞到下一个换行为止，重新对齐。
 */
function makeLineReader(maxChars: number, onLine: (line: string) => void, onOverflow: (chars: number) => void) {
  let buf = "";
  let skipping = false;
  return (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (skipping) {
        skipping = false;
        continue;
      }
      // Swift 侧用 \n，但别人接上来时 \r\n 是常见意外，容忍掉比事后查一小时划算
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (clean.trim() === "") continue;
      onLine(clean);
    }
    if (buf.length > maxChars) {
      onOverflow(buf.length);
      buf = "";
      skipping = true;
    }
  };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; cleanup: () => void };

/** 命中去重时给 result 补一位标记。非对象结果原样返回——没地方挂这一位，也不该硬造。 */
function markReplayed(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), [RPC_REPLAYED_FIELD]: true };
}

export function createPeer(opts: RpcPeerOptions): RpcPeer {
  const maxChars = opts.maxLineChars ?? RPC_MAX_LINE_CHARS;
  const replayCacheSize = opts.replayCacheSize ?? 64;
  const tombstoneSize = opts.replayTombstoneSize ?? 4096;

  const pending = new Map<RpcId, Pending>();
  const inflightInbound = new Set<RpcId>();
  const running = new Set<Promise<unknown>>();
  const lifetime = new AbortController();

  // 幂等三态：在飞 / 有结果 / 只剩墓碑。Map 保插入序，淘汰就是拿第一个键
  const onceFlying = new Map<string, Promise<unknown>>();
  const onceDone = new Map<string, unknown>();
  const onceForgotten = new Set<string>();

  let nextId: RpcId = opts.idParity === "even" ? 2 : 1;
  let closed = false;

  function send(m: Parameters<typeof encodeMessage>[0]): void {
    opts.write(encodeMessage(m));
  }

  function notify(method: string, params?: unknown): void {
    send({ method, params });
  }

  function reportTransport(code: RpcErrorCode, detail: string, id: RpcId | null): void {
    const error = makeRpcError(code, detail);
    opts.onTransportError?.(error);
    // 认得出 id 就回一条对得上号的失败，对面那次调用立刻有结论；
    // 认不出就只能发通知——「有条消息我读不懂」本身也是对面需要知道的事
    if (id === null) notify(NOTIFY_TRANSPORT_ERROR, { error });
    else send({ id, error });
  }

  function settle(m: ParsedMessage & { kind: "success" | "failure" }): void {
    // 奇偶不对说明这条 response 对应的请求根本不是我们发的
    if (parityOf(m.id) !== opts.idParity) {
      reportTransport("unknown_response", `收到 id ${m.id} 的回应，但该 id 不属于本端的请求空间`, null);
      return;
    }
    const p = pending.get(m.id);
    if (!p) {
      reportTransport("unknown_response", `收到 id ${m.id} 的回应，但没有在等这个 id`, null);
      return;
    }
    pending.delete(m.id);
    p.cleanup();
    if (m.kind === "success") p.resolve(m.result);
    else p.reject(new RpcFailure(m.error.code, m.error.message, { retriable: m.error.retriable }));
  }

  function evictOnce(): void {
    while (onceDone.size > replayCacheSize) {
      const oldest = onceDone.keys().next();
      if (oldest.done) break;
      onceDone.delete(oldest.value);
      onceForgotten.add(oldest.value);
    }
    while (onceForgotten.size > tombstoneSize) {
      const oldest = onceForgotten.keys().next();
      if (oldest.done) break;
      onceForgotten.delete(oldest.value);
    }
  }

  async function runOnce(key: string, spec: RpcMethodSpec, params: unknown, ctx: RpcHandlerContext): Promise<unknown> {
    const flying = onceFlying.get(key);
    // 还在跑就挂到同一个 promise 上，绝不并起第二次执行。两个请求 id 各自拿到同一份结果
    if (flying) return markReplayed(await flying);
    if (onceDone.has(key)) return markReplayed(onceDone.get(key));
    if (onceForgotten.has(key)) {
      throw new RpcFailure(
        "replay_unavailable",
        `requestKey 已经执行过，但结果不在缓存里了；不要重发，也不要换一个 key 再发同一条指令`,
      );
    }

    const p = spec.handler(params, ctx);
    onceFlying.set(key, p);
    try {
      const result = await p;
      onceDone.set(key, result);
      evictOnce();
      return result;
    } catch (err) {
      // 明确声明「什么都没发生」的，键就随 finally 一起消失，等于没来过，可以原样重发；
      // 其余一律记墓碑——不知道副作用发生没有时，重发是比报错危险得多的选项
      if (!(err instanceof RpcFailure && err.sideEffectFree)) {
        onceForgotten.add(key);
        evictOnce();
      }
      throw err;
    } finally {
      onceFlying.delete(key);
    }
  }

  function dispatch(id: RpcId, method: string, params: unknown): void {
    const spec = opts.methods[method];
    if (!spec) {
      send({ id, error: makeRpcError("method_not_found", `不认识的 method ${JSON.stringify(method)}`) });
      return;
    }

    let key: string | null = null;
    if (spec.once) {
      const raw = typeof params === "object" && params !== null ? (params as Record<string, unknown>)[RPC_REQUEST_KEY_FIELD] : undefined;
      if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
        send({
          id,
          error: makeRpcError(
            "invalid_params",
            `params.${RPC_REQUEST_KEY_FIELD} 必填，须是 1–128 字符的字符串：它是「一个决定最多执行一次」的去重键`,
          ),
        });
        return;
      }
      key = raw;
    }

    const ctx: RpcHandlerContext = { call, notify, signal: lifetime.signal, requestId: id };
    inflightInbound.add(id);
    const task = (key === null ? spec.handler(params, ctx) : runOnce(key, spec, params, ctx))
      .then(
        (result) => send({ id, result }),
        (err) => send({ id, error: errorOf(err) }),
      )
      .catch((err: unknown) => {
        // 走到这里只可能是 result 序列化不了（循环引用之类）。已经发不出正常回应了，
        // 但对面必须拿到一个结论，否则那次调用会永远挂着
        send({ id, error: makeRpcError("internal_error", `结果无法序列化：${err instanceof Error ? err.message : String(err)}`) });
      })
      .finally(() => {
        inflightInbound.delete(id);
        running.delete(task);
      });
    running.add(task);
  }

  function onMessage(m: ParsedMessage): void {
    switch (m.kind) {
      case "invalid":
        reportTransport(m.code, m.detail, m.id);
        return;
      case "notification":
        opts.onNotification?.(m.method, m.params);
        return;
      case "success":
      case "failure":
        settle(m);
        return;
      case "request": {
        // 对面用我方的奇偶发请求，就会和我们自己发出去的 id 撞车，之后的回应全都分不清归属
        if (parityOf(m.id) === opts.idParity) {
          send({ id: m.id, error: makeRpcError("id_conflict", `id ${m.id} 属于本端的请求空间，请改用${opts.idParity === "even" ? "奇" : "偶"}数 id`) });
          return;
        }
        if (inflightInbound.has(m.id)) {
          send({ id: m.id, error: makeRpcError("id_conflict", `id ${m.id} 还在处理中`) });
          return;
        }
        dispatch(m.id, m.method, m.params);
        return;
      }
    }
  }

  const read = makeLineReader(
    maxChars,
    (line) => onMessage(parseMessage(line)),
    (chars) => reportTransport("oversized_line", `单行超过 ${maxChars} 字符（已收到 ${chars}），已丢弃并重新对齐到下一行`, null),
  );

  function call<T = unknown>(method: string, params?: unknown, callOpts: RpcCallOptions = {}): Promise<T> {
    if (closed) return Promise.reject(new RpcFailure("peer_gone", "连接已关闭"));
    const id = nextId;
    nextId += 2;
    const timeoutMs = callOpts.timeoutMs ?? RPC_CALL_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const onAbort = () => {
        pending.delete(id);
        cleanup();
        reject(new RpcFailure("peer_gone", "调用被取消"));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        callOpts.signal?.removeEventListener("abort", onAbort);
      };
      if (timeoutMs > 0) {
        // unref：一个在等对面的定时器不该把进程钉在活着的状态，stdin 关了就该收摊
        timer = setTimeout(() => {
          pending.delete(id);
          cleanup();
          reject(new RpcFailure("request_timeout", `${method} 超过 ${timeoutMs}ms 没有回应`));
        }, timeoutMs);
        timer.unref?.();
      }
      callOpts.signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, cleanup });
      send({ id, method, params });
    });
  }

  return {
    ingest: (chunk) => read(chunk),
    call,
    notify,
    drain: async () => {
      // 处理器自己还会再派活（反向调用的回应会落回来），所以要反复等到真的空了
      while (running.size > 0) await Promise.allSettled([...running]);
    },
    close: (reason = "连接已关闭") => {
      closed = true;
      lifetime.abort();
      for (const [, p] of pending) {
        p.cleanup();
        p.reject(new RpcFailure("peer_gone", reason));
      }
      pending.clear();
    },
    pendingCalls: () => pending.size,
  };
}
