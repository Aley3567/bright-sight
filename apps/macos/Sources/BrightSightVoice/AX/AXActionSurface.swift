import AppKit
import ApplicationServices
import Foundation

struct AXSurfaceResult {
  let frame: AXStoredFrame
  let offers: [AXActionOffer]
  let offset: Int
  let totalOffers: Int
  let nextOffset: Int?
  let truncation: AXTruncation?
  let elapsedMilliseconds: Int

  var json: JSONValue {
    var page: [String: JSONValue] = [
      "offset": .number(Double(offset)),
      "count": .number(Double(offers.count)),
      "total": .number(Double(totalOffers)),
    ]
    if let nextOffset { page["nextOffset"] = .number(Double(nextOffset)) }
    var fields: [String: JSONValue] = [
      "frameId": .string(frame.id),
      "pid": .number(Double(frame.processID)),
      "offers": .array(offers.map(\.json)),
      "page": .object(page),
      "elapsedMs": .number(Double(elapsedMilliseconds)),
    ]
    if let truncation { fields["truncated"] = truncation.json }
    return .object(fields)
  }
}

/// 客户端持有 existential 而不是泛型参数：Swift 不给 `any P` 提供 self-conformance，
/// 泛型版本没法接受一个被抹掉具体类型的客户端（`AXRuntime` 需要这么做才能被注入测试替身）。
/// AX 调用本身是毫秒级的辅助功能服务往返，动态派发的那点开销不构成理由。
struct AXSurfaceBuilder {
  private struct PendingNode {
    let element: AXUIElement
    let path: [Int]
    let depth: Int
  }

  let client: any AXSurfaceClient
  let budget: AXTraversalBudget
  var now: () -> DispatchTime = DispatchTime.now

  func observe(_ params: AXObserveParams, processID: pid_t) throws -> AXSurfaceResult {
    let started = now().uptimeNanoseconds
    let application = try client.application(processID: processID)
    let root: AXUIElement
    switch params.scope {
    case .focusedWindow:
      root = try client.focusedWindow(of: application)
    case .application:
      root = application
    }
    let window = try currentWindowFingerprint(application: application, root: root, scope: params.scope)
    var queue = [PendingNode(element: root, path: [], depth: 0)]
    var cursor = 0
    var visited = 0
    var deepest = 0
    var hitDepth = false
    var truncationReason: AXTruncation.Reason?
    var stored: [String: AXStoredOffer] = [:]
    var ordered: [AXActionOffer] = []
    // 消歧要用的两份索引。都是**遍历的副产品**：每个节点的 state 本来就要读一遍，
    // path 本来就要算出来交给 fingerprint，这里只是不把它们扔掉——不产生任何额外 AX 往返。
    var nodeTexts: [(path: [Int], text: String)] = []
    var offerPaths: [String: [Int]] = [:]

    while cursor < queue.count {
      let elapsed = milliseconds(since: started)
      if elapsed >= budget.maxMilliseconds {
        truncationReason = .deadline
        break
      }
      if visited >= budget.maxNodes {
        truncationReason = .nodes
        break
      }
      let node = queue[cursor]
      cursor += 1
      visited += 1
      deepest = max(deepest, node.depth)
      let stateAndChildren: (AXElementState, [AXUIElement])
      do {
        stateAndChildren = try client.state(of: node.element, includeChildren: true)
      } catch let error as AXCallError
        where node.depth > 0 && (error.kind == .stale || error.kind == .unsupported)
      {
        // AX 树在读取期间会继续变化。一个晚到的子节点不能让已经收集到的整个动作面作废；
        // 根节点失败仍向上抛，因为那意味着目标应用或窗口本身已经不可观察。
        continue
      }
      let (state, children) = stateAndChildren
      if let text = AXOfferFactory.text(for: state) {
        nodeTexts.append((path: node.path, text: text))
      }
      let fingerprint = AXElementFingerprint(
        processID: processID,
        window: window,
        path: node.path,
        role: state.role,
        subrole: state.subrole,
        identifier: state.identifier,
        title: state.title,
        value: state.value
      )
      for offer in AXOfferFactory.offers(for: state) {
        let id = UUID().uuidString
        let ref = UUID().uuidString
        let publicOffer = AXActionOffer(
          id: id,
          operation: offer.operation,
          ref: ref,
          role: state.role,
          label: AXOfferFactory.label(for: state),
          state: AXTargetState(enabled: state.enabled, selected: state.selected, editable: state.editable),
          effect: offer.effect,
          risk: offer.risk
        )
        ordered.append(publicOffer)
        offerPaths[id] = node.path
        stored[id] = AXStoredOffer(
          publicOffer: publicOffer,
          element: node.element,
          fingerprint: fingerprint,
          beforeState: state
        )
      }
      guard !children.isEmpty else { continue }
      if node.depth >= budget.maxDepth {
        hitDepth = true
        continue
      }
      for (index, child) in children.enumerated() {
        queue.append(PendingNode(element: child, path: node.path + [index], depth: node.depth + 1))
      }
    }
    if truncationReason == nil, hitDepth { truncationReason = .depth }

    // 回填在**分页之前**：重复与否是整个动作面的性质，不是某一页的性质。
    // 放在分页后算的话，同一条 offer 会因为它落在第几页而拿到不同的描述。
    var contexts = Self.disambiguationContexts(offers: ordered, offerPaths: offerPaths, nodes: nodeTexts)
    // 文字兜不住的那几组再补一次位置序号。真机实测（Ghostty 的焦点窗口）7 个 label 退化成
    // `AXButton` 的按钮——它们连名字都没有，祖先文本对它们无能为力，只剩屏幕位置可用。
    for (id, ordinal) in positionalOrdinals(offers: ordered, contexts: contexts, stored: stored) {
      contexts[id] = Self.combine(contexts[id], with: ordinal)
    }
    if !contexts.isEmpty {
      for index in ordered.indices { ordered[index].context = contexts[ordered[index].id] }
      // `stored` 里那份要跟着一起改：执行期的重复守卫与恢复重认领比对的是 publicOffer，
      // 两份不一致会让一条刚发出去的 offer 在自己的 frame 里对不上自己。
      for (id, context) in contexts {
        guard let entry = stored[id] else { continue }
        var offer = entry.publicOffer
        offer.context = context
        stored[id] = AXStoredOffer(
          publicOffer: offer,
          element: entry.element,
          fingerprint: entry.fingerprint,
          beforeState: entry.beforeState
        )
      }
    }

    let elapsed = milliseconds(since: started)
    let pageSize = min(params.pageSize ?? budget.pageSize, AXWireLimits.maxPageSize)
    let lower = min(params.offset, ordered.count)
    let upper = min(lower + pageSize, ordered.count)
    let page = Array(ordered[lower..<upper])
    let nextOffset = upper < ordered.count ? upper : nil
    let frame = AXStoredFrame(
      id: UUID().uuidString,
      processID: processID,
      scope: params.scope,
      root: root,
      window: window,
      offers: stored,
      createdAt: Date()
    )
    let truncation = truncationReason.map {
      AXTruncation(reason: $0, depth: deepest, nodes: visited, milliseconds: elapsed)
    }
    return AXSurfaceResult(
      frame: frame,
      offers: page,
      offset: lower,
      totalOffers: ordered.count,
      nextOffset: nextOffset,
      truncation: truncation,
      elapsedMilliseconds: elapsed
    )
  }

  /// 给同名目标补一段能把它们区分开的文字。
  ///
  /// **只处理 label 撞了的那些 offer。** 官方 jaggedness 文档把「大量不相关状态」列为 Jev 的
  /// 已知失败模式（"Context grows, accuracy falls"）——给一个本来就唯一的选项附描述，不提高
  /// 区分度，只摊薄注意力。这与 `jev-ultrafast` 给每个元素都挂 6000 字符 innerText 的做法
  /// 相反，那是社区实现自己挑的数，不是官方指导。
  ///
  /// 分组键带上 operation：模型看到的选项文字是 `AX <OP>：<label>`，同名但不同 operation
  /// 的两条在模型眼里本来就不一样，不该被算成一次冲突而白白吃掉一段上下文预算。
  ///
  /// 逐级向上取祖先的**子树文字**，停在第一个能把整组完全区分开的层级。真机实测（Chrome 的
  /// GitHub 页面，141 个可动作元素、8 组同名）四组分别在第 1、1、2、3 层区分开。
  static func disambiguationContexts(
    offers: [AXActionOffer],
    offerPaths: [String: [Int]],
    nodes: [(path: [Int], text: String)]
  ) -> [String: String] {
    var groups: [String: [String]] = [:]
    for offer in offers {
      groups["\(offer.operation.rawValue)\u{1f}\(offer.label)", default: []].append(offer.id)
    }

    var result: [String: String] = [:]
    for ids in groups.values where ids.count > 1 {
      var best: [String: String] = [:]
      var bestDistinct = 0
      for level in 1...AXWireLimits.maxContextLevels {
        var texts: [String: String] = [:]
        for id in ids {
          guard let path = offerPaths[id], path.count >= level else { continue }
          let text = Self.subtreeText(under: Array(path.dropLast(level)), nodes: nodes)
          if !text.isEmpty { texts[id] = text }
        }
        // 往上走**不是**单调变好：同组两个目标可能在第 k 层各有各的父节点、到第 k+1 层
        // 合并到同一个祖先下，于是拿到一模一样的文字。只认目前最好的一层，别被上一层带坏。
        let distinct = Set(texts.values).count
        if texts.count == ids.count && distinct > bestDistinct {
          best = texts
          bestDistinct = distinct
          if distinct == ids.count { break }
        }
      }
      // 找满层数仍分不开就用最好的那层：一段不完全区分的文字，仍然强过一组一模一样的选项。
      for (id, text) in best { result[id] = text }
    }
    return result
  }

  /// 文字分不开同名目标时的最后一招：按屏幕位置给它们排个序号。
  ///
  /// 给的是**序数词而不是坐标**。官方 jaggedness 文档把「计数、数字/十六进制/RGB」列为 Jev
  /// 的弱项，把 `(120, 340)` 这种东西丢给它，等于用它最不擅长的形式表达一个它本可以直接读懂
  /// 的顺序。「从上往下第 3 个」是文字，也是人指着屏幕会说的话。
  ///
  /// 位置是**按需读**的：只有文字兜不住的那几个元素才多花一次 AX 往返。放进逐节点的批量读取
  /// 里，就是拿 500 节点的常规路径去补一条罕见路径——真机实测 GitHub 整棵树正好顶满 150ms 预算。
  private func positionalOrdinals(
    offers: [AXActionOffer],
    contexts: [String: String],
    stored: [String: AXStoredOffer]
  ) -> [String: String] {
    var groups: [String: [String]] = [:]
    for offer in offers {
      groups["\(offer.operation.rawValue)\u{1f}\(offer.label)", default: []].append(offer.id)
    }

    var result: [String: String] = [:]
    for ids in groups.values where ids.count > 1 {
      // 文字已经把这一组完全分开了就不加序号：多一句话就多一分注意力被摊薄。
      if Set(ids.map { contexts[$0] ?? "" }).count == ids.count { continue }

      var placed: [(id: String, point: CGPoint)] = []
      for id in ids {
        guard let element = stored[id]?.element, let point = client.position(of: element) else { continue }
        placed.append((id, point))
      }
      // 有一个读不到就整组放弃。只给其中几个编号，模型看到的是「第 1 个、第 2 个、以及两个
      // 没编号的」——比一个都不编更难选。
      guard placed.count == ids.count else { continue }
      let sorted = placed.sorted { $0.point.y == $1.point.y ? $0.point.x < $1.point.x : $0.point.y < $1.point.y }
      // 坐标完全相同的目标**共用同一个序号**，不各给一个。
      //
      // 真机实测逼出来的：Ghostty 焦点窗口里 7 个无名按钮，位置全都读得到，但其中两个压在
      // 同一个 (1412,137) 上。原先写的是「有重叠就整组放弃」——一对重叠把另外五个能区分的
      // 也一起毙了。反过来给重叠的两个各编一个号同样不行：那是在编造一个不存在的区分。
      // 并列才是诚实的：分得开的分开，分不开的照实让它们保持一样。
      var ordinal = 0
      var previous: CGPoint?
      for item in sorted {
        if previous != item.point { ordinal += 1 }
        previous = item.point
        result[item.id] = "从上往下第 \(ordinal) 个"
      }
    }
    return result
  }

  /// 截到线上限额。
  ///
  /// 按 **UTF-16 码元**而不是 Character 数：对侧 `src/ax.ts` 用 JS 的 `.length` 校验这个上限，
  /// 而 JS 的字符串长度就是 UTF-16 码元数。一个 emoji 在 Swift 是 1 个 Character、在 JS 是 2——
  /// 按 Character 截到 200 的串，到了对侧可能量出 400，一次完全正常的观察会被判畸形。
  /// 逐个 Character 往回退而不是直接切 utf16 视图：切码元会把代理对劈成两半，落地一个 U+FFFD。
  static func capToWireLimit(_ text: String) -> String {
    cap(text, to: AXWireLimits.maxContextCharacters)
  }

  private static func cap(_ text: String, to limit: Int) -> String {
    var out = text
    while out.utf16.count > limit { out = String(out.dropLast()) }
    return out
  }

  /// 把位置序号接到容器文字后面，**先给序号留出位置再截文字**。
  ///
  /// 真机实测逼出来的：原先写的是「拼完再统一截断」，而序号在末尾，于是长文字的那几条
  /// 刚拼上的序号当场被截掉——Ghostty 那 7 个无名按钮里，前三个的序号就是这么没的，
  /// 表面上看是「几何兜底没生效」，实际上是生效了又被自己抹掉。
  ///
  /// 序号是这一组**唯一**的区分信息（文字已经证明兜不住了），它不能是被牺牲的那一个。
  static func combine(_ text: String?, with ordinal: String) -> String {
    let separator = " · "
    guard let text, !text.isEmpty else { return capToWireLimit(ordinal) }
    let reserved = (separator + ordinal).utf16.count
    // 序号自己就顶满预算时，留序号扔文字：文字是锦上添花，序号是这一组仅有的区分依据。
    guard reserved < AXWireLimits.maxContextCharacters else { return capToWireLimit(ordinal) }
    return cap(text, to: AXWireLimits.maxContextCharacters - reserved) + separator + ordinal
  }

  /// 某个祖先底下整棵子树的可读文字，按遍历顺序拼接。
  ///
  /// `nodes` 是 BFS 序，所以祖先自己的文字排在前面、后代跟在后面——这正是人念出来的顺序。
  /// 只收 title/description/value，不收 role：`AXGroup` 这类角色名在聚合文本里是纯噪声。
  static func subtreeText(under prefix: [Int], nodes: [(path: [Int], text: String)]) -> String {
    var parts: [String] = []
    var used = 0
    for node in nodes {
      guard node.path.count >= prefix.count, Array(node.path.prefix(prefix.count)) == prefix else { continue }
      parts.append(node.text)
      used += node.text.count + 1
      // 够长了就停，别为了一个会被截断的尾巴把整棵子树走完。
      if used >= AXWireLimits.maxContextCharacters { break }
    }
    // 截断放在拼接之后：分隔符也占预算，逐段累加算出来的长度与最终串不是一个数。
    return capToWireLimit(parts.joined(separator: " "))
  }

  private func currentWindowFingerprint(
    application: AXUIElement,
    root: AXUIElement,
    scope: AXObservationScope
  ) throws -> AXWindowFingerprint? {
    let window: AXUIElement
    if scope == .focusedWindow {
      window = root
    } else {
      guard let focused = try? client.focusedWindow(of: application) else { return nil }
      window = focused
    }
    let (state, _) = try client.state(of: window, includeChildren: false)
    return AXWindowFingerprint(
      role: state.role,
      subrole: state.subrole,
      identifier: state.identifier,
      title: state.title
    )
  }

  private func milliseconds(since started: UInt64) -> Int {
    Int((now().uptimeNanoseconds - started) / 1_000_000)
  }
}

struct AXOfferDescriptor: Equatable {
  let operation: AXOperation
  let effect: AXCapabilityEffect
  let risk: AXCapabilityRisk
}

enum AXOfferFactory {
  static func offers(for state: AXElementState) -> [AXOfferDescriptor] {
    guard state.enabled else { return [] }
    var result: [AXOfferDescriptor] = []
    let press = state.actions.contains(kAXPressAction as String)
    if state.editable && Self.editableRoles.contains(state.role) {
      result.append(.init(operation: .typeText, effect: .draft, risk: .safe))
    }
    if press {
      if state.role == (kAXMenuItemRole as String) {
        result.append(.init(operation: .select, effect: .change, risk: .caution))
      } else if state.role == "AXLink" {
        result.append(.init(operation: .open, effect: .navigate, risk: .safe))
      } else {
        // 未知 role 只要系统明确声明 AXPress 就仍可点击；风险保持 caution，不能因不认识而降级成 safe。
        result.append(.init(operation: .click, effect: .change, risk: .caution))
      }
    }
    return result
  }

  static func label(for state: AXElementState) -> String {
    state.title ?? state.description ?? state.value ?? state.role
  }

  /// 聚合上下文时取的文字。与 `label(for:)` 的区别只在兜底：**不退到 role**。
  /// role 是给一条 offer 兜底用的（总得有个名字），但在聚合文本里 `AXGroup AXGroup AXStaticText`
  /// 这种串只会挤占字符预算，一点区分度都不带。没有可读文字就不参与聚合。
  static func text(for state: AXElementState) -> String? {
    state.title ?? state.description ?? state.value
  }

  private static let editableRoles: Set<String> = [
    kAXTextFieldRole as String,
    kAXTextAreaRole as String,
    kAXComboBoxRole as String,
  ]
}

struct AXActionPerformer {
  let client: any AXSurfaceClient

  func perform(_ params: AXPerformParams, frame: AXStoredFrame) -> AXPerformResult {
    guard let offer = frame.offers[params.offerID], offer.publicOffer.operation == params.operation else {
      return stale("offer 不属于这个 frame，或 operation 与 offer 不一致")
    }
    do {
      let application = try client.application(processID: frame.processID)
      let currentWindow = try windowFingerprint(application: application, frame: frame)
      guard currentWindow == frame.window else { return stale("前台窗口已经变化") }
      let element = try resolve(path: offer.fingerprint.path, from: frame.root)
      guard client.identical(element, offer.element) else { return stale("AX 元素身份已经变化") }
      let (current, _) = try client.state(of: element, includeChildren: false)
      let currentFingerprint = AXElementFingerprint(
        processID: frame.processID,
        window: currentWindow,
        path: offer.fingerprint.path,
        role: current.role,
        subrole: current.subrole,
        identifier: current.identifier,
        title: current.title,
        value: current.value
      )
      guard offer.fingerprint.matches(currentFingerprint) else { return stale("AX 元素属性已经变化") }

      switch params.operation {
      case .typeText:
        try client.replaceText(params.value ?? "", in: element)
      case .click, .select, .open:
        try client.perform(kAXPressAction as String, on: element)
      }
      return verify(params: params, element: element, before: current)
    } catch let error as AXCallError where error.kind == .stale {
      return stale(error.description)
    } catch {
      return AXPerformResult(
        status: .failed,
        verification: AXVerification(ok: false, detail: "AX 动作没有完成"),
        error: String(describing: error)
      )
    }
  }

  private func verify(params: AXPerformParams, element: AXUIElement, before: AXElementState) -> AXPerformResult {
    do {
      let (after, _) = try client.state(of: element, includeChildren: false)
      if params.operation == .typeText {
        let ok = after.value == params.value
        return AXPerformResult(
          status: ok ? .executed : .effectUnknown,
          verification: AXVerification(ok: ok, detail: ok ? "文本值已定向回读" : "写入后读到的值不一致"),
          error: ok ? nil : "副作用可能已经发生，禁止自动重试"
        )
      }
      let changed = after.visibleSignature != before.visibleSignature
      return AXPerformResult(
        status: changed ? .executed : .effectUnknown,
        verification: AXVerification(ok: changed, detail: changed ? "目标状态发生可观测变化" : "动作返回成功，但目标状态没有可观测变化"),
        error: changed ? nil : "副作用可能已经发生，禁止自动重试"
      )
    } catch let error as AXCallError where error.kind == .stale {
      // 按钮导致窗口/元素消失是可观测变化；元素在动作前已经完成 freshness 复验。
      return AXPerformResult(
        status: .executed,
        verification: AXVerification(ok: true, detail: "动作后原目标消失"),
        error: nil
      )
    } catch {
      return AXPerformResult(
        status: .effectUnknown,
        verification: AXVerification(ok: false, detail: "动作后回读失败"),
        error: "副作用可能已经发生，禁止自动重试"
      )
    }
  }

  private func resolve(path: [Int], from root: AXUIElement) throws -> AXUIElement {
    var current = root
    for index in path {
      let (_, children) = try client.state(of: current, includeChildren: true)
      guard children.indices.contains(index) else {
        throw AXCallError(code: AXError.noValue.rawValue, kind: .stale, operation: "按 AX 路径重定位")
      }
      current = children[index]
    }
    return current
  }

  private func windowFingerprint(application: AXUIElement, frame: AXStoredFrame) throws -> AXWindowFingerprint? {
    let window: AXUIElement
    do {
      window = try client.focusedWindow(of: application)
    } catch let error as AXCallError where error.kind == .stale {
      return nil
    }
    let (state, _) = try client.state(of: window, includeChildren: false)
    return AXWindowFingerprint(role: state.role, subrole: state.subrole, identifier: state.identifier, title: state.title)
  }

  private func stale(_ detail: String) -> AXPerformResult {
    AXPerformResult(
      status: .rejectedStale,
      verification: AXVerification(ok: false, detail: detail),
      error: nil
    )
  }
}
