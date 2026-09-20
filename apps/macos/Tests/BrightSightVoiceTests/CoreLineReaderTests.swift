import XCTest
@testable import BrightSightVoice

/// 行切分的全部失败模式都在这里：管道给的是字节块，和消息边界没有任何关系。
final class CoreLineReaderTests: XCTestCase {
  private func texts(_ lines: [CoreLineReader.Line]) -> [String] {
    lines.compactMap { line -> String? in
      guard case .text(let text) = line else { return nil }
      return text
    }
  }

  private func data(_ text: String) -> Data {
    Data(text.utf8)
  }

  func testSplitsPackedLinesAndHoldsPartialOne() {
    var reader = CoreLineReader()
    let first = reader.ingest(data("{\"id\":1}\n{\"id\":3}\n{\"id\":5"))
    XCTAssertEqual(texts(first), ["{\"id\":1}", "{\"id\":3}"])
    XCTAssertEqual(texts(first).count, 2, "粘包：一次 read 里来了两条半")

    let second = reader.ingest(data("}\n"))
    XCTAssertEqual(texts(second), ["{\"id\":5}"], "半行必须等到下一块才成行")
  }

  func testSkipsBlankLinesAndTrimsCarriageReturn() {
    var reader = CoreLineReader()
    let lines = reader.ingest(data("\n   \n{\"ok\":true}\r\n\n"))
    XCTAssertEqual(texts(lines), ["{\"ok\":true}"])
  }

  func testMultibyteCharacterSplitAcrossChunks() {
    // 用户原话会原样出现在 params 里，中文一个字三字节，切口落在字中间是常态
    let line = "{\"utterance\":\"打开备忘录记一下今天的会议要点\"}\n"
    let bytes = Data(line.utf8)
    // 找一个确实把某个字切开的位置：前半段单独解码必须失败
    guard let cut = (1..<bytes.count).first(where: { String(data: bytes.prefix($0), encoding: .utf8) == nil }) else {
      return XCTFail("这条样本里没有多字节字符，测试本身失效了")
    }
    let head = bytes.prefix(cut)
    let tail = bytes.suffix(from: cut)

    // 阳性对照：按字节切 String 会当场产出替换字符，而且后半段再怎么拼也还原不回来。
    // 没有这一条，下面那句「拼回来了」证明不了缓冲字节这件事有意义
    let naive = String(decoding: head, as: UTF8.self) + String(decoding: tail, as: UTF8.self)
    XCTAssertTrue(naive.contains("\u{FFFD}"), "阳性对照：这个切口确实切坏了一个字")
    XCTAssertNotEqual(naive + "\n", line)

    var reader = CoreLineReader()
    XCTAssertTrue(texts(reader.ingest(head)).isEmpty, "半个字符不该成行")
    XCTAssertEqual(texts(reader.ingest(tail)), [String(line.dropLast())])
  }

  func testMultibyteSplitOneBytePerChunk() {
    // 极端一点：一个字节一块。真实管道不会这么切，但它是「只在完整行边界解码」的充分证据
    let line = "{\"utterance\":\"搜一下 TypeScript，链接存进备忘录\"}"
    var reader = CoreLineReader()
    var got: [String] = []
    for byte in Data((line + "\n").utf8) {
      got += texts(reader.ingest(Data([byte])))
    }
    XCTAssertEqual(got, [line])
  }

  func testOversizedLineIsDroppedAndStreamResyncs() {
    var reader = CoreLineReader(maxLineBytes: 32)
    let overflow = reader.ingest(Data(repeating: 0x41, count: 40))
    guard case .oversized(let bytes)? = overflow.first else {
      return XCTFail("超过上限的一行必须报出来，而不是一直攒在内存里")
    }
    XCTAssertEqual(bytes, 40)
    XCTAssertEqual(reader.maxLineBytes, 32, "上限确实是我们设的那个，超长行不是碰巧触发的")

    // 丢掉之后还要重新对齐：剩下的半条消息必须一起吞掉，否则之后每一行都错位
    let after = reader.ingest(data("尾巴还没结束\n{\"ok\":1}\n"))
    XCTAssertEqual(texts(after), ["{\"ok\":1}"], "超长行的残余被吞掉，下一整行照常读出来")
  }

  func testUndecodableLineIsReportedNotSilentlyMangled() {
    var reader = CoreLineReader()
    var chunk = Data([0xFF, 0xFE, 0xFD])
    chunk.append(0x0A)
    chunk.append(contentsOf: Data("{\"ok\":1}\n".utf8))
    let lines = reader.ingest(chunk)

    guard case .undecodable(let bytes)? = lines.first else {
      return XCTFail("不是合法 UTF-8 的一行不能拿替换字符去喂 JSON 解析")
    }
    XCTAssertEqual(bytes, 3)
    // 阳性对照：同一块里后面那条正常行照样读得出来，说明上面不是「整块都没读」
    XCTAssertEqual(texts(lines), ["{\"ok\":1}"])
  }

  func testResetDropsHalfLine() {
    var reader = CoreLineReader()
    _ = reader.ingest(data("{\"half\":"))
    reader.reset()
    XCTAssertEqual(texts(reader.ingest(data("true}\n"))), ["true}"], "reset 之后半行不该被拼进下一行")
  }
}
