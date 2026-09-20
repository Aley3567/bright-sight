import ApplicationServices
import XCTest
@testable import BrightSightVoice

final class AXActionSurfaceTests: XCTestCase {
  func testTraversalPaginatesOffersAndReportsDepthTruncation() throws {
    let app = AXUIElementCreateApplication(101)
    let window = AXUIElementCreateApplication(102)
    let button = AXUIElementCreateApplication(103)
    let field = AXUIElementCreateApplication(104)
    let group = AXUIElementCreateApplication(105)
    let hiddenButton = AXUIElementCreateApplication(106)
    let store = FakeAXStore(application: app, focusedWindow: window)
    store.add(app, state: axState(role: kAXApplicationRole as String), children: [button, field, group])
    store.add(window, state: axState(role: kAXWindowRole as String, title: "Main"))
    store.add(button, state: axState(
      role: kAXButtonRole as String,
      title: "Continue",
      actions: [kAXPressAction as String]
    ))
    store.add(field, state: axState(
      role: kAXTextFieldRole as String,
      title: "Name",
      value: "before",
      editable: true
    ))
    store.add(group, state: axState(role: kAXGroupRole as String), children: [hiddenButton])
    store.add(hiddenButton, state: axState(
      role: kAXButtonRole as String,
      title: "Hidden",
      actions: [kAXPressAction as String]
    ))

    let result = try AXSurfaceBuilder(
      client: FakeAXClient(store: store),
      budget: AXTraversalBudget(maxDepth: 1, maxNodes: 20, maxMilliseconds: 1_000, pageSize: 10)
    ).observe(
      try axObserveParams([
        "scope": .string("application"),
        "pid": .number(101),
        "offset": .number(1),
        "pageSize": .number(1),
      ]),
      processID: 101
    )

    XCTAssertEqual(result.totalOffers, 2)
    XCTAssertEqual(result.offset, 1)
    XCTAssertEqual(result.offers.map(\.operation), [.typeText])
    XCTAssertNil(result.nextOffset)
    XCTAssertEqual(result.truncation?.reason, .depth)
    XCTAssertEqual(result.truncation?.depth, 1)
  }

  func testTraversalSkipsAStaleChildButKeepsOtherOffers() throws {
    let app = AXUIElementCreateApplication(201)
    let window = AXUIElementCreateApplication(202)
    let stale = AXUIElementCreateApplication(203)
    let button = AXUIElementCreateApplication(204)
    let store = FakeAXStore(application: app, focusedWindow: window)
    store.add(app, state: axState(role: kAXApplicationRole as String), children: [stale, button])
    store.add(window, state: axState(role: kAXWindowRole as String, title: "Main"))
    store.fail(
      stale,
      with: AXCallError(code: AXError.invalidUIElement.rawValue, kind: .stale, operation: "test")
    )
    store.add(button, state: axState(
      role: kAXButtonRole as String,
      title: "Save",
      actions: [kAXPressAction as String]
    ))

    let result = try AXSurfaceBuilder(
      client: FakeAXClient(store: store),
      budget: AXTraversalBudget(maxDepth: 3, maxNodes: 20, maxMilliseconds: 1_000, pageSize: 10)
    ).observe(
      try axObserveParams([
        "scope": .string("application"),
        "pid": .number(201),
      ]),
      processID: 201
    )

    XCTAssertEqual(result.offers.map(\.label), ["Save"])
    XCTAssertNil(result.truncation)
  }

  func testPerformerRejectsChangedFingerprintBeforeWriting() {
    let fixture = performerFixture(currentValue: "changed")

    let result = AXActionPerformer(client: fixture.client).perform(
      try! axPerformParams(frameID: fixture.frame.id, offerID: fixture.offerID, operation: .typeText, value: "after"),
      frame: fixture.frame
    )

    XCTAssertEqual(result.status, .rejectedStale)
    XCTAssertFalse(result.verification.ok)
    XCTAssertEqual(fixture.store.replaceTextCalls, 0)
  }

  func testPerformerReplacesTextAndVerifiesTheExactValue() {
    let fixture = performerFixture(currentValue: "before")

    let result = AXActionPerformer(client: fixture.client).perform(
      try! axPerformParams(frameID: fixture.frame.id, offerID: fixture.offerID, operation: .typeText, value: "after"),
      frame: fixture.frame
    )

    XCTAssertEqual(result.status, .executed)
    XCTAssertTrue(result.verification.ok)
    XCTAssertEqual(fixture.store.replaceTextCalls, 1)
    XCTAssertEqual(fixture.store.currentState(of: fixture.element)?.value, "after")
  }

  // ── 三条按下的执行分支 ──────────────────────────────────────────────────────
  //
  // CLICK / SELECT / OPEN 在 `AXActionPerformer` 里共用一段 AXPress 代码，但它们的
  // effect/risk 由 `AXOfferFactory` 按 role 分别算出。只测其中一条，等于让另外两条的
  // 「role 装错了位置」在真跑时才发现。

  func testPressOperationsReachTheClientAndVerifyAnObservableChange() throws {
    for expected in [(role: kAXButtonRole as String, operation: AXOperation.click),
                     (role: kAXMenuItemRole as String, operation: AXOperation.select),
                     (role: "AXLink", operation: AXOperation.open)]
    {
      let fixture = try pressFixture(role: expected.role)
      XCTAssertEqual(fixture.operation, expected.operation, "\(expected.role) 给错了动作类型")
      fixture.store.pressOutcome = .changed(axState(
        role: expected.role,
        title: "Go",
        selected: true,
        actions: [kAXPressAction as String]
      ))

      let result = AXActionPerformer(client: fixture.client).perform(
        try axPerformParams(frameID: fixture.frame.id, offerID: fixture.offerID, operation: expected.operation),
        frame: fixture.frame
      )

      XCTAssertEqual(result.status, .executed, "\(expected.role)：\(result.verification.detail)")
      XCTAssertEqual(fixture.store.performCalls, [kAXPressAction as String], "\(expected.role) 应当只按一次")
    }
  }

  func testPressWithoutAnObservableChangeIsEffectUnknownAndNotRetried() throws {
    let fixture = try pressFixture(role: kAXButtonRole as String)
    fixture.store.pressOutcome = .unchanged

    let result = AXActionPerformer(client: fixture.client).perform(
      try axPerformParams(frameID: fixture.frame.id, offerID: fixture.offerID, operation: .click),
      frame: fixture.frame
    )

    XCTAssertEqual(result.status, .effectUnknown)
    XCTAssertFalse(result.verification.ok)
    XCTAssertNotNil(result.error, "副作用可能已经发生，必须带上禁止自动重试的说明")
    XCTAssertEqual(fixture.store.performCalls.count, 1, "读不到变化不等于没按下去，不能再按一次")
  }

  func testPressThatRemovesItsTargetCountsAsExecuted() throws {
    let fixture = try pressFixture(role: kAXButtonRole as String)
    fixture.store.pressOutcome = .targetVanishes

    let result = AXActionPerformer(client: fixture.client).perform(
      try axPerformParams(frameID: fixture.frame.id, offerID: fixture.offerID, operation: .click),
      frame: fixture.frame
    )

    // 按钮把窗口关掉是可观测变化，不是 stale：元素在动作前已经完成过 freshness 复验。
    XCTAssertEqual(result.status, .executed)
    XCTAssertTrue(result.verification.ok)
  }

  func testPerformerRefusesAnOperationThatDoesNotBelongToTheOffer() throws {
    let fixture = try pressFixture(role: kAXButtonRole as String)

    let result = AXActionPerformer(client: fixture.client).perform(
      try axPerformParams(frameID: fixture.frame.id, offerID: fixture.offerID, operation: .typeText, value: "x"),
      frame: fixture.frame
    )

    XCTAssertEqual(result.status, .rejectedStale)
    XCTAssertTrue(fixture.store.performCalls.isEmpty, "operation 对不上时不能碰客户端")
    XCTAssertEqual(fixture.store.replaceTextCalls, 0)
  }

  private struct PressFixture {
    let client: FakeAXClient
    let store: FakeAXStore
    let frame: AXStoredFrame
    let offerID: String
    let operation: AXOperation
    let element: AXUIElement
  }

  /// 用真实的 `AXSurfaceBuilder` 造 frame，而不是手搓一个 offer：这样 offer id 与 operation
  /// 都来自 `AXOfferFactory`，role 到动作类型的映射装错位置时测试才会红。
  private func pressFixture(role: String) throws -> PressFixture {
    let app = AXUIElementCreateApplication(501)
    let window = AXUIElementCreateApplication(502)
    let target = AXUIElementCreateApplication(503)
    let store = FakeAXStore(application: app, focusedWindow: window)
    store.add(app, state: axState(role: kAXApplicationRole as String), children: [target])
    store.add(window, state: axState(role: kAXWindowRole as String, title: "Main"))
    store.add(target, state: axState(role: role, title: "Go", actions: [kAXPressAction as String]))

    let client = FakeAXClient(store: store)
    let observed = try AXSurfaceBuilder(
      client: client,
      budget: AXTraversalBudget(maxDepth: 3, maxNodes: 20, maxMilliseconds: 1_000, pageSize: 10)
    ).observe(
      try axObserveParams(["scope": .string("application"), "pid": .number(501)]),
      processID: 501
    )
    let offer = try XCTUnwrap(observed.offers.first, "\(role) 应当给出一个动作")
    return PressFixture(
      client: client,
      store: store,
      frame: observed.frame,
      offerID: offer.id,
      operation: offer.operation,
      element: target
    )
  }

  private func performerFixture(currentValue: String) -> (
    client: FakeAXClient,
    store: FakeAXStore,
    frame: AXStoredFrame,
    offerID: String,
    element: AXUIElement
  ) {
    let app = AXUIElementCreateApplication(301)
    let window = AXUIElementCreateApplication(302)
    let field = AXUIElementCreateApplication(303)
    let store = FakeAXStore(application: app, focusedWindow: window)
    let windowState = axState(role: kAXWindowRole as String, title: "Editor")
    let observedState = axState(
      role: kAXTextFieldRole as String,
      title: "Body",
      value: "before",
      editable: true
    )
    store.add(app, state: axState(role: kAXApplicationRole as String), children: [field])
    store.add(window, state: windowState)
    store.add(field, state: axState(
      role: kAXTextFieldRole as String,
      title: "Body",
      value: currentValue,
      editable: true
    ))
    let windowFingerprint = AXWindowFingerprint(
      role: windowState.role,
      subrole: nil,
      identifier: nil,
      title: windowState.title
    )
    let offerID = "offer-1"
    let publicOffer = AXActionOffer(
      id: offerID,
      operation: .typeText,
      ref: "ref-1",
      role: observedState.role,
      label: "Body",
      state: AXTargetState(enabled: true, selected: nil, editable: true),
      effect: .draft,
      risk: .safe
    )
    let fingerprint = AXElementFingerprint(
      processID: 301,
      window: windowFingerprint,
      path: [0],
      role: observedState.role,
      subrole: nil,
      identifier: nil,
      title: observedState.title,
      value: observedState.value
    )
    let frame = AXStoredFrame(
      id: "frame-1",
      processID: 301,
      scope: .application,
      root: app,
      window: windowFingerprint,
      offers: [offerID: AXStoredOffer(
        publicOffer: publicOffer,
        element: field,
        fingerprint: fingerprint,
        beforeState: observedState
      )],
      createdAt: Date()
    )
    return (FakeAXClient(store: store), store, frame, offerID, field)
  }
}

// ── 同名目标的区分文字 ────────────────────────────────────────────────────────
//
// 这组测试钉住的是「模型看到的那句选项说明够不够把两个目标分开」。真机实测（Chrome 的
// GitHub 页面）8 组同名目标里，四组分别要向上 1、1、2、3 层才区分得开，所以既要测「第一层
// 就够」，也要测「第一层不够得再往上」，还要测「往上反而变差」——只测顺风路径的话，
// `disambiguationContexts` 里那个「留最好的一层」的守卫删掉也全绿。

final class AXDisambiguationContextTests: XCTestCase {
  /// 造一棵 app → 若干 group → 若干 button 的两层树，按钮全部可按。
  private func observe(
    groups: [(title: String, buttons: [String])],
    maxDepth: Int = 6
  ) throws -> [AXActionOffer] {
    let app = AXUIElementCreateApplication(900)
    let store = FakeAXStore(application: app, focusedWindow: app)
    var groupElements: [AXUIElement] = []
    var nextID: pid_t = 901

    for group in groups {
      let groupElement = AXUIElementCreateApplication(nextID)
      nextID += 1
      var buttonElements: [AXUIElement] = []
      for title in group.buttons {
        let button = AXUIElementCreateApplication(nextID)
        nextID += 1
        store.add(button, state: axState(
          role: kAXButtonRole as String,
          title: title,
          actions: [kAXPressAction as String]
        ))
        buttonElements.append(button)
      }
      store.add(
        groupElement,
        state: axState(role: kAXGroupRole as String, title: group.title),
        children: buttonElements
      )
      groupElements.append(groupElement)
    }
    store.add(app, state: axState(role: kAXApplicationRole as String), children: groupElements)

    return try AXSurfaceBuilder(
      client: FakeAXClient(store: store),
      budget: AXTraversalBudget(maxDepth: maxDepth, maxNodes: 100, maxMilliseconds: 10_000, pageSize: 50)
    ).observe(
      try axObserveParams(["scope": .string("application"), "pid": .number(900)]),
      processID: 900
    ).offers
  }

  private func context(_ offers: [AXActionOffer], label: String, containing needle: String) -> String? {
    offers.first { $0.label == label && ($0.context ?? "").contains(needle) }?.context
  }

  func testOnlyDuplicateLabelsCarryContext() throws {
    let offers = try observe(groups: [
      (title: "收件箱", buttons: ["打开", "存档"]),
      (title: "已发送", buttons: ["打开"]),
    ])

    // 「存档」在整个动作面里唯一，不该被附上任何东西：官方把「大量不相关状态」列为已知失败
    // 模式，给唯一选项加描述不提高区分度，只摊薄注意力。
    XCTAssertNil(offers.first { $0.label == "存档" }?.context)

    let opened = offers.filter { $0.label == "打开" }
    XCTAssertEqual(opened.count, 2)
    let contexts = opened.compactMap(\.context)
    XCTAssertEqual(contexts.count, 2, "两条同名 offer 都要拿到区分文字")
    XCTAssertEqual(Set(contexts).count, 2, "拿到的文字必须互不相同，否则等于没区分")
    XCTAssertNotNil(context(offers, label: "打开", containing: "收件箱"))
    XCTAssertNotNil(context(offers, label: "打开", containing: "已发送"))
  }

  func testSameLabelUnderDifferentOperationsIsNotAConflict() throws {
    let app = AXUIElementCreateApplication(910)
    let field = AXUIElementCreateApplication(911)
    let button = AXUIElementCreateApplication(912)
    let store = FakeAXStore(application: app, focusedWindow: app)
    // 同一个 label 落在 TYPE_TEXT 与 CLICK 两条 offer 上。模型看到的是 `AX TYPE_TEXT：搜索`
    // 与 `AX CLICK：搜索`，本来就不一样，不该白白吃掉一段上下文预算。
    store.add(field, state: axState(role: kAXTextFieldRole as String, title: "搜索", editable: true))
    store.add(button, state: axState(
      role: kAXButtonRole as String,
      title: "搜索",
      actions: [kAXPressAction as String]
    ))
    store.add(app, state: axState(role: kAXApplicationRole as String), children: [field, button])

    let offers = try AXSurfaceBuilder(
      client: FakeAXClient(store: store),
      budget: AXTraversalBudget(maxDepth: 6, maxNodes: 100, maxMilliseconds: 10_000, pageSize: 50)
    ).observe(
      try axObserveParams(["scope": .string("application"), "pid": .number(910)]),
      processID: 910
    ).offers

    XCTAssertEqual(offers.count, 2)
    XCTAssertTrue(offers.allSatisfy { $0.context == nil }, "不同 operation 的同名目标不算冲突")
  }

  func testContextKeepsTheBestLevelWhenGoingUpMergesTheGroup() throws {
    // 三条同名 offer：甲组一条、乙组两条。
    //   第 1 层——甲组的那条拿到「甲」、乙组的两条拿到同一段「乙」，3 条里 2 个不同值；
    //   第 2 层——三条都归到 application 底下，合并成 1 个值，**比第 1 层更差**。
    // 往上找不是单调变好的，所以必须留住第 1 层而不是最后试的那一层。
    let offers = try observe(groups: [
      (title: "甲", buttons: ["确定"]),
      (title: "乙", buttons: ["确定", "确定"]),
    ])

    let confirms = offers.filter { $0.label == "确定" }
    XCTAssertEqual(confirms.count, 3)
    let contexts = confirms.map { $0.context ?? "" }
    XCTAssertEqual(Set(contexts).count, 2, "留住的必须是区分度最高的那一层（2 个不同值），不是合并后的 1 个")
    XCTAssertNotNil(context(offers, label: "确定", containing: "甲"))
    XCTAssertNotNil(context(offers, label: "确定", containing: "乙"))
  }

  func testGroupWithNoUsableAncestorTextGetsNoContext() throws {
    // 祖先没有任何可读文字时，聚合结果是空串。宁可什么都不附，也不要给模型一对空括号。
    let offers = try observe(groups: [
      (title: "", buttons: ["确定"]),
      (title: "", buttons: ["确定"]),
    ])

    let confirms = offers.filter { $0.label == "确定" }
    XCTAssertEqual(confirms.count, 2)
    // 按钮自己的 title 会进聚合文本，所以两条都是「确定」——分不开，但也不是空。
    // 这里要钉的是「分不开的时候不崩、不给空串」。
    XCTAssertTrue(confirms.allSatisfy { ($0.context ?? "确定").isEmpty == false })
  }

  // ── 文字兜不住时的位置序号 ──────────────────────────────────────────────────
  //
  // 真机实测（Ghostty 焦点窗口）7 个 label 退化成 `AXButton` 的按钮：它们连名字都没有，
  // 祖先文本对它们无能为力。这一组测的就是那种元素。

  /// 造一组**同名且共享同一个父节点**的按钮，所以文字必然分不开，只剩位置可用。
  private func observeSiblings(
    label: String,
    placing points: [CGPoint?]
  ) throws -> [AXActionOffer] {
    let app = AXUIElementCreateApplication(930)
    let group = AXUIElementCreateApplication(931)
    let store = FakeAXStore(application: app, focusedWindow: app)
    var buttons: [AXUIElement] = []
    var nextID: pid_t = 932

    for point in points {
      let button = AXUIElementCreateApplication(nextID)
      nextID += 1
      store.add(button, state: axState(
        role: kAXButtonRole as String,
        title: label,
        actions: [kAXPressAction as String]
      ))
      if let point { store.place(button, at: point) }
      buttons.append(button)
    }
    store.add(group, state: axState(role: kAXGroupRole as String), children: buttons)
    store.add(app, state: axState(role: kAXApplicationRole as String), children: [group])

    return try AXSurfaceBuilder(
      client: FakeAXClient(store: store),
      budget: AXTraversalBudget(maxDepth: 6, maxNodes: 100, maxMilliseconds: 10_000, pageSize: 50)
    ).observe(
      try axObserveParams(["scope": .string("application"), "pid": .number(930)]),
      processID: 930
    ).offers
  }

  func testPositionalOrdinalsSeparateSiblingsThatTextCannot() throws {
    // 三个同名同父的按钮：祖先子树文字对三者完全一样，文字这条路走到头。
    let offers = try observeSiblings(label: "确定", placing: [
      CGPoint(x: 10, y: 300),
      CGPoint(x: 10, y: 100),
      CGPoint(x: 10, y: 200),
    ])

    let contexts = offers.compactMap(\.context)
    XCTAssertEqual(contexts.count, 3)
    XCTAssertEqual(Set(contexts).count, 3, "位置序号必须把三个分开")
    // 序号按屏幕从上往下算，不是按遍历顺序：y=100 的那个是第 1 个，尽管它排在遍历的第二位。
    XCTAssertTrue(offers[1].context?.hasSuffix("从上往下第 1 个") == true)
    XCTAssertTrue(offers[2].context?.hasSuffix("从上往下第 2 个") == true)
    XCTAssertTrue(offers[0].context?.hasSuffix("从上往下第 3 个") == true)
  }

  func testPositionalOrdinalsAreSkippedWhenAnyMemberHasNoPosition() throws {
    // 只给其中两个编号，模型看到的是「第 1 个、第 2 个、以及一个没编号的」——比一个都不编更难选。
    let offers = try observeSiblings(label: "确定", placing: [
      CGPoint(x: 10, y: 100),
      nil,
      CGPoint(x: 10, y: 200),
    ])

    XCTAssertFalse(
      offers.contains { ($0.context ?? "").contains("从上往下第") },
      "有一个读不到位置就整组放弃编号"
    )
  }

  func testFullyOverlappingTargetsShareOneOrdinalInsteadOfInventingADistinction() throws {
    // 压在同一个坐标上的两个目标，各编一个号就是在编造一个不存在的区分。并列才是诚实的。
    let offers = try observeSiblings(label: "确定", placing: [
      CGPoint(x: 10, y: 100),
      CGPoint(x: 10, y: 100),
    ])

    let ordinals = offers.map { $0.context ?? "" }
    XCTAssertEqual(Set(ordinals).count, 1, "重叠的两个必须拿到一模一样的描述")
    XCTAssertTrue(ordinals.allSatisfy { $0.hasSuffix("从上往下第 1 个") })
  }

  func testOneOverlappingPairDoesNotCostTheWholeGroupItsOrdinals() throws {
    // 真机实测逼出来的：Ghostty 的 7 个无名按钮里有两个压在同一点上。
    // 原先写的是「有重叠就整组放弃」，于是另外五个本来分得开的也一起没了。
    let offers = try observeSiblings(label: "确定", placing: [
      CGPoint(x: 10, y: 100),
      CGPoint(x: 10, y: 200),
      CGPoint(x: 10, y: 200),
      CGPoint(x: 10, y: 300),
    ])

    let ordinals = offers.map { $0.context ?? "" }
    XCTAssertEqual(Set(ordinals).count, 3, "四个目标里有一对重叠，该分出三档而不是零档")
    XCTAssertTrue(ordinals[0].hasSuffix("第 1 个"))
    XCTAssertTrue(ordinals[1].hasSuffix("第 2 个"))
    XCTAssertTrue(ordinals[2].hasSuffix("第 2 个"), "重叠的那一对并列")
    XCTAssertTrue(ordinals[3].hasSuffix("第 3 个"), "并列之后不跳号，下一个是第 3 个")
  }

  func testPositionalOrdinalsAreNotAddedWhenTextAlreadySeparatesTheGroup() throws {
    // 文字够用就不该再加一句序号：多一句话就多一分注意力被摊薄，这是官方点名的失败模式。
    let offers = try observe(groups: [
      (title: "收件箱", buttons: ["打开"]),
      (title: "已发送", buttons: ["打开"]),
    ])

    XCTAssertFalse(offers.contains { ($0.context ?? "").contains("从上往下第") })
  }

  func testLongContainerTextNeverSwallowsThePositionalOrdinal() {
    // 真机实测逼出来的。原先写的是「拼完再统一截断」，而序号在末尾，于是文字一长，
    // 刚拼上的序号当场被截掉——看起来像「几何兜底没生效」，实际是生效了又被自己抹掉。
    //
    // 只断言长度没超是**不够的**：上一版测试就只验了这个，全绿，而真机上序号已经没了。
    // 序号是这一组唯一的区分信息，必须显式钉住它活着。
    let long = String(repeating: "很长的容器文字", count: 100)
    let combined = AXSurfaceBuilder.combine(long, with: "从上往下第 1 个")

    XCTAssertLessThanOrEqual(combined.utf16.count, AXWireLimits.maxContextCharacters)
    XCTAssertTrue(combined.hasSuffix("从上往下第 1 个"), "序号不能是被牺牲掉的那一个")
    XCTAssertTrue(combined.hasPrefix("很长的容器文字"), "文字该从后面截，不是整段丢掉")
  }

  func testOrdinalSurvivesEvenWithoutAnyContainerText() {
    XCTAssertEqual(AXSurfaceBuilder.combine(nil, with: "从上往下第 2 个"), "从上往下第 2 个")
    XCTAssertEqual(AXSurfaceBuilder.combine("", with: "从上往下第 2 个"), "从上往下第 2 个")
  }

  func testSubtreeTextIsTruncatedByUTF16UnitsNotCharacters() {
    // 对侧 `src/ax.ts` 用 JS 的 `.length`（UTF-16 码元数）校验这个上限。一个 emoji 在 Swift 是
    // 1 个 Character、在 JS 是 2——按 Character 截断会让一条合法观察在对侧被判畸形。
    let emoji = String(repeating: "😀", count: 300)
    let text = AXSurfaceBuilder.subtreeText(under: [], nodes: [(path: [], text: emoji)])

    XCTAssertLessThanOrEqual(text.utf16.count, AXWireLimits.maxContextCharacters)
    XCTAssertFalse(text.contains("\u{FFFD}"), "不能把代理对劈成两半")
    XCTAssertTrue(text.hasPrefix("😀"))
  }

  func testStoredOfferCarriesTheSameContextAsTheWireOffer() throws {
    let app = AXUIElementCreateApplication(920)
    let left = AXUIElementCreateApplication(921)
    let right = AXUIElementCreateApplication(922)
    let leftButton = AXUIElementCreateApplication(923)
    let rightButton = AXUIElementCreateApplication(924)
    let store = FakeAXStore(application: app, focusedWindow: app)
    store.add(leftButton, state: axState(role: kAXButtonRole as String, title: "删除", actions: [kAXPressAction as String]))
    store.add(rightButton, state: axState(role: kAXButtonRole as String, title: "删除", actions: [kAXPressAction as String]))
    store.add(left, state: axState(role: kAXGroupRole as String, title: "草稿"), children: [leftButton])
    store.add(right, state: axState(role: kAXGroupRole as String, title: "垃圾箱"), children: [rightButton])
    store.add(app, state: axState(role: kAXApplicationRole as String), children: [left, right])

    let result = try AXSurfaceBuilder(
      client: FakeAXClient(store: store),
      budget: AXTraversalBudget(maxDepth: 6, maxNodes: 100, maxMilliseconds: 10_000, pageSize: 50)
    ).observe(
      try axObserveParams(["scope": .string("application"), "pid": .number(920)]),
      processID: 920
    )

    // 执行期的重复守卫与恢复重认领比对的是 frame 里存的那份 publicOffer。它要是没跟着回填，
    // 一条刚发出去的 offer 会在自己的 frame 里对不上自己。
    for offer in result.offers {
      XCTAssertEqual(result.frame.offers[offer.id]?.publicOffer.context, offer.context)
      XCTAssertNotNil(offer.context)
    }
  }
}
