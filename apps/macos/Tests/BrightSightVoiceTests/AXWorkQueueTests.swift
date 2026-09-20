import XCTest
@testable import BrightSightVoice

final class AXWorkQueueTests: XCTestCase {
  private typealias Item = AXWorkItem<String, String>

  private func item(
    _ id: String,
    processID: pid_t,
    qos: AXWorkQoS = .utility
  ) -> Item {
    Item(id: id, processID: processID, qos: qos, payload: "payload-\(id)")
  }

  func testQueueRejectsOverflowAndAcceptsAgainAfterDequeue() {
    var queue = AXWorkQueue<String, String>(pendingLimit: 2, concurrencyLimit: 1)
    XCTAssertEqual(queue.enqueue(item("a", processID: 1)), .accepted)
    XCTAssertEqual(queue.enqueue(item("b", processID: 2)), .accepted)
    XCTAssertEqual(queue.enqueue(item("c", processID: 3)), .full)
    XCTAssertEqual(queue.pendingCount, 2)

    XCTAssertEqual(queue.startReady().map(\.id), ["a"])
    XCTAssertEqual(queue.enqueue(item("c", processID: 3)), .accepted)
    XCTAssertEqual(queue.pendingCount, 2)
  }

  func testHigherQoSWinsAndEachLaneStaysFIFO() {
    var queue = AXWorkQueue<String, String>(pendingLimit: 8, concurrencyLimit: 1)
    _ = queue.enqueue(item("utility-1", processID: 1, qos: .utility))
    _ = queue.enqueue(item("background", processID: 2, qos: .background))
    _ = queue.enqueue(item("interactive-1", processID: 3, qos: .userInitiated))
    _ = queue.enqueue(item("interactive-2", processID: 4, qos: .userInitiated))

    XCTAssertEqual(queue.startReady().map(\.id), ["interactive-1"])
    XCTAssertTrue(queue.finish("interactive-1"))
    XCTAssertEqual(queue.startReady().map(\.id), ["interactive-2"])
    XCTAssertTrue(queue.finish("interactive-2"))
    XCTAssertEqual(queue.startReady().map(\.id), ["utility-1"])
    XCTAssertTrue(queue.finish("utility-1"))
    XCTAssertEqual(queue.startReady().map(\.id), ["background"])
  }

  func testBusyProcessDoesNotBlockEligibleWorkFromAnotherProcess() {
    var queue = AXWorkQueue<String, String>(pendingLimit: 8, concurrencyLimit: 2)
    _ = queue.enqueue(item("hung", processID: 10, qos: .userInitiated))
    _ = queue.enqueue(item("same-process", processID: 10, qos: .userInitiated))
    _ = queue.enqueue(item("other-process", processID: 20, qos: .background))

    // 阳性对照：高优先级的同进程工作确实在前面；调度器必须越过它，才能找到另一进程。
    XCTAssertEqual(queue.startReady().map(\.id), ["hung", "other-process"])
    XCTAssertEqual(queue.activeCount, 2)
    XCTAssertEqual(queue.pendingCount, 1)

    XCTAssertTrue(queue.finish("other-process"))
    XCTAssertTrue(queue.startReady().isEmpty, "进程 10 仍在飞，不能把它的第二项也放出去")
    XCTAssertTrue(queue.finish("hung"))
    XCTAssertEqual(queue.startReady().map(\.id), ["same-process"])
  }

  func testConcurrencyLimitLeavesExcessWorkPending() {
    var queue = AXWorkQueue<String, String>(pendingLimit: 8, concurrencyLimit: 2)
    _ = queue.enqueue(item("a", processID: 1))
    _ = queue.enqueue(item("b", processID: 2))
    _ = queue.enqueue(item("c", processID: 3))

    XCTAssertEqual(queue.startReady().map(\.id), ["a", "b"])
    XCTAssertEqual(queue.activeCount, 2)
    XCTAssertEqual(queue.pendingCount, 1)
    XCTAssertTrue(queue.startReady().isEmpty)
  }

  func testDuplicateAndUnknownCompletionCannotCorruptSlots() {
    var queue = AXWorkQueue<String, String>(pendingLimit: 4, concurrencyLimit: 1)
    XCTAssertEqual(queue.enqueue(item("a", processID: 1)), .accepted)
    XCTAssertEqual(queue.enqueue(item("a", processID: 2)), .duplicate)
    XCTAssertEqual(queue.startReady().map(\.id), ["a"])
    XCTAssertEqual(queue.enqueue(item("a", processID: 2)), .duplicate)

    XCTAssertFalse(queue.finish("missing"))
    XCTAssertEqual(queue.activeCount, 1)
    XCTAssertTrue(queue.finish("a"))
    XCTAssertTrue(queue.isIdle)
  }

  func testCancelOnlyRemovesPendingWork() {
    var queue = AXWorkQueue<String, String>(pendingLimit: 4, concurrencyLimit: 1)
    _ = queue.enqueue(item("active", processID: 1))
    _ = queue.enqueue(item("pending", processID: 2))
    XCTAssertEqual(queue.startReady().map(\.id), ["active"])

    XCTAssertFalse(queue.cancelPending("active"))
    XCTAssertTrue(queue.cancelPending("pending"))
    XCTAssertEqual(queue.pendingCount, 0)
    XCTAssertFalse(queue.isIdle)
  }
}
