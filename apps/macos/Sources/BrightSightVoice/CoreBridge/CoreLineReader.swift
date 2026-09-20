import Foundation

/// stdout 的行切分。
///
/// 半行、粘包、一行被从任意位置切成两段，都是管道上的常态而不是异常：内核给的是字节块，
/// 和消息边界没有任何关系。
///
/// **缓冲的是字节，不是字符串。** 这是最容易漏的一个坑：中文一个字三字节，
/// `availableData` 完全可能把一个字从中间切开，此时 `String(decoding:as:UTF8.self)` 会
/// 当场产出替换字符（U+FFFD），后半块再怎么拼也还原不回来——坏的不是显示，是 JSON 解析，
/// 而且只在长指令、大结果上偶发。这里只在攒够完整一行之后才解码，于是多字节切断
/// 天然不成立：切口一定落在两个字节之间，而行尾那个 `\n` 是 ASCII，不可能是某个多字节字符的一部分。
struct CoreLineReader {
  enum Line: Equatable {
    case text(String)
    /// 单行超过上限，已丢弃并重新对齐到下一个换行。
    case oversized(bytes: Int)
    /// 攒齐了一整行，但它不是合法 UTF-8。当成传输事故报出去，不要拿替换字符去喂 JSON 解析。
    case undecodable(bytes: Int)
  }

  private var buffer = Data()
  /// 上一行超长被丢了，正在吞到下一个换行为止。丢掉却不重新对齐的话，
  /// 缓冲区里剩的是半条消息，之后每一行都会错位。
  private var resyncing = false
  let maxLineBytes: Int

  init(maxLineBytes: Int = CoreProtocol.maxLineBytes) {
    self.maxLineBytes = maxLineBytes
  }

  mutating func reset() {
    buffer.removeAll(keepingCapacity: false)
    resyncing = false
  }

  mutating func ingest(_ chunk: Data) -> [Line] {
    buffer.append(chunk)
    var out: [Line] = []

    while let newline = buffer.firstIndex(of: 0x0A) {
      var line = buffer[buffer.startIndex..<newline]
      buffer = Data(buffer[buffer.index(after: newline)...])
      if resyncing {
        resyncing = false
        continue
      }
      // Swift 侧与 Node 侧都写 \n，但别人把这条线接出去时 \r\n 是常见意外，容忍掉比事后查一小时划算
      if line.last == 0x0D { line = line.dropLast() }
      if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) { continue }
      if let text = String(data: Data(line), encoding: .utf8) {
        out.append(.text(text))
      } else {
        out.append(.undecodable(bytes: line.count))
      }
    }

    if buffer.count > maxLineBytes {
      out.append(.oversized(bytes: buffer.count))
      buffer.removeAll(keepingCapacity: false)
      resyncing = true
    }
    return out
  }
}
