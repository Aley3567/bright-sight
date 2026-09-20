import SwiftUI

struct VoiceCapsuleView: View {
  /// 面板宽度。各 phase 统一，不随内容变——无边框浮窗的宽度一变，整块会横向抖。
  /// 500 是「波形独占一行」换来的：波形不再和转录文字抢同一行的横向空间。
  private static let cardWidth: CGFloat = 500
  /// 步骤清单超过这个数就限高滚动。浮窗高度变化会让它跳，三行是不跳得难看的上限。
  private static let inlineStepLimit = 3

  @ObservedObject var model: AssistantController
  /// borderless panel 默认不可拖，这两个回调把 header 背景区的 DragGesture 交回
  /// VoicePanelController 去调 `panel.setFrameOrigin`——SwiftUI 视图本身拿不到 NSPanel。
  var onDragChanged: (CGSize) -> Void = { _ in }
  var onDragEnded: () -> Void = {}
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    VStack(spacing: 12) {
      header
      content
    }
    .padding(14)
    .frame(width: Self.cardWidth)
    .background {
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(Self.shellFill(colorScheme))
    }
    .overlay {
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .strokeBorder(Self.shellStroke(colorScheme), lineWidth: 0.5)
    }
    // 阴影分两层，因为一层做不到两件事：半径够大才浮得起来，可那样边缘就糊掉了，
    // 而边缘发糊正是换掉 material 要解决的问题。近影贴着边把卡片从背景里切出来，远影负责浮起感。
    //
    // 两层的「半径 + y 偏移」都卡在 12pt 以内，那是下面 `.padding(12)` 留给阴影的全部余量：
    // 窗口背景是透明的，但超出窗口 frame 的像素会被直接裁掉，裁出来是一条硬直边，比没有阴影更难看。
    // 原来那条 radius 24 + y 10 扩散约 34pt，早就落在裁切线外了——上一版边界发糊，这是另一半原因。
    .shadow(color: Self.shadowNear(colorScheme), radius: 1, y: 1)
    .shadow(color: Self.shadowFar(colorScheme), radius: 8, y: 3)
    .padding(12)
    .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.86), value: model.state.phase)
  }

  // MARK: - 外壳

  /// 外壳用不透明填色，不用 material。
  ///
  /// 原来是 `.ultraThinMaterial` 上再压一层 76% 白：毛玻璃被遮掉九成，付了材质的离屏合成开销
  /// 却拿不到材质的观感。
  ///
  /// 深色下不是把浅色版压黑，而是给一个比系统窗口背景略亮的自有灰。面板浮在所有窗口最上层，
  /// 跟背后的深色窗口同亮度就分不出层次——深色模式下「卡片」这个概念全靠它比背景亮一点点撑着。
  private static func shellFill(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(red: 0.141, green: 0.141, blue: 0.161) : .white
  }

  /// 描边必须和填色反向：浅色卡片用黑边、深色卡片用白边。
  /// 上一版是白底配白边（white 22%），同向等于没画，这是那一版边界消失的直接原因。
  private static func shellStroke(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color.white.opacity(0.09) : Color.black.opacity(0.07)
  }

  /// 深色下阴影要浓得多。浅色背景上 6% 黑就够读出一条边，
  /// 同样的浓度铺在深色背景上完全看不见——阴影靠的是和背景的差，不是自己的绝对深浅。
  private static func shadowNear(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color.black.opacity(0.44) : Color.black.opacity(0.06)
  }

  private static func shadowFar(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color.black.opacity(0.52) : Color.black.opacity(0.13)
  }

  /// 头部不再顶着产品名。
  ///
  /// 常驻浮窗每次弹出都自报一次家门没有信息量——菜单栏图标已经说明它是谁。
  /// 腾出来的主位给状态词：用户真正要在一瞬间读到的是「它现在在干什么」。
  private var header: some View {
    HStack(spacing: 9) {
      if model.state.phase != .idle && model.state.phase != .confirming {
        Button(action: model.back) {
          Image(systemName: "chevron.left")
            .font(.system(size: 11, weight: .bold))
            .frame(width: 24, height: 24)
            .background(Color.primary.opacity(0.07), in: Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("返回")
        .accessibilityLabel("返回上一步")
      }

      ZStack {
        Circle().fill(statusColor.opacity(0.16)).frame(width: 28, height: 28)
        Image(systemName: statusSymbol)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(statusColor)
      }

      Text(statusTitle)
        .font(.system(size: 15, weight: .semibold))
        .lineLimit(1)

      Spacer(minLength: 8)

      if model.isSpeaking {
        SpeakingWaveformView(compact: true)
          .frame(width: 46, height: 24)
          .transition(.scale.combined(with: .opacity))
          .accessibilityLabel("Bright Sight 正在说话")
      }

      // 未固定时用 pin（SF Symbols 里它本来就是斜的），固定后换 pin.fill 并转正。
      // 原来的 pin.slash 画的是「被斜杠划掉的钉子」，那是「置顶不可用」的意思，不是「未置顶」。
      Button(action: model.togglePin) {
        Image(systemName: model.isPinned ? "pin.fill" : "pin")
          .font(.system(size: 12, weight: .semibold))
          .rotationEffect(.degrees(model.isPinned ? 0 : -42))
          .frame(width: 24, height: 24)
      }
      .buttonStyle(.plain)
      .foregroundStyle(model.isPinned ? Color.accentColor : .secondary)
      .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.7), value: model.isPinned)
      .help(model.isPinned ? "取消置顶" : "置顶，切到其他应用时不自动隐藏")
      .accessibilityLabel(model.isPinned ? "取消置顶" : "置顶")

      Button(action: model.toggleVoiceFeedback) {
        Image(systemName: model.voiceFeedbackEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
          .font(.system(size: 12))
          .frame(width: 24, height: 24)
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
      .help(model.voiceFeedbackEnabled ? "关闭语音反馈" : "开启语音反馈")
      .accessibilityLabel(model.voiceFeedbackEnabled ? "关闭语音反馈" : "开启语音反馈")

      Button(action: model.close) {
        Image(systemName: "xmark")
          .font(.system(size: 10, weight: .bold))
          .frame(width: 24, height: 24)
          .background(Color.primary.opacity(0.07), in: Circle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
      .help("关闭")
      .accessibilityLabel("关闭 Bright Sight")
    }
    // 背景层而不是整个 HStack 上挂手势：按钮各自有自己的点击区域，手势加在同层会截胡它们的点击。
    // minimumDistance 给够，单纯点击（不移动）时手势不识别，落回给下面的按钮。
    .background(
      Color.clear
        .contentShape(Rectangle())
        .gesture(
          DragGesture(minimumDistance: 2)
            .onChanged { value in onDragChanged(value.translation) }
            .onEnded { _ in onDragEnded() }
        )
    )
  }

  @ViewBuilder
  private var content: some View {
    switch model.state.phase {
    case .idle:
      HStack(spacing: 10) {
        primaryButton(
          title: "按住右 ⌘ 说话",
          symbol: "mic.fill",
          action: model.toggleVoiceCapture
        )
        secondaryButton(title: "输入文字", symbol: "keyboard", action: model.showTyping)
      }

    case .authorizing, .finalizing, .working:
      VStack(spacing: 10) {
        HStack(spacing: 12) {
          if model.isSpeaking {
            SpeakingWaveformView(compact: false)
              .frame(width: 58, height: 38)
              .accessibilityLabel("Bright Sight 正在说话")
          } else {
            ProgressView().controlSize(.small)
          }
          VStack(alignment: .leading, spacing: 3) {
            if !model.state.transcript.isEmpty {
              Text(model.state.transcript)
                .font(.system(size: 14, weight: .medium))
                .lineLimit(2)
            }
            Text(model.state.detail)
              .font(.system(size: 12))
              .foregroundStyle(.secondary)
          }
          Spacer()
        }

        HStack(spacing: 8) {
          if !model.state.transcript.isEmpty {
            compactButton(title: "返回修改", symbol: "pencil", action: model.back)
          }
          Spacer(minLength: 0)
          compactButton(title: "停止", symbol: "stop.fill", tint: .red, action: model.cancelCurrent)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 78)

    case .listening:
      VStack(alignment: .leading, spacing: 10) {
        Text(model.state.transcript.isEmpty ? "请说…" : model.state.transcript)
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(model.state.transcript.isEmpty ? .secondary : .primary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)

        FlowWaveView(levels: model.state.levels)
          .frame(maxWidth: .infinity)
          .frame(height: 40)
          .accessibilityHidden(true)

        HStack(spacing: 8) {
          Text(model.state.detail)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .lineLimit(1)
          Spacer(minLength: 8)
          compactButton(title: "取消", symbol: "xmark", action: model.cancelCurrent)
          filledButton(title: "完成", symbol: "checkmark", action: model.endVoice)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 104)

    case .typing:
      HStack(spacing: 10) {
        TextField("输入你要做的事", text: $model.draftText)
          .textFieldStyle(.plain)
          .font(.system(size: 14))
          .padding(.horizontal, 12)
          .frame(height: 40)
          .background(Color.primary.opacity(0.065), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .onSubmit(model.submitDraft)
          .accessibilityLabel("输入指令")

        Button(action: model.submitDraft) {
          Image(systemName: "arrow.up")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 40, height: 40)
            .background(model.draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.gray : Color.accentColor, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(model.draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityLabel("提交指令")
      }

    case .confirming:
      // 两个 field label（「要做什么」「为什么需要确认」）删掉了：那是把 struct 的字段名
      // 摆到界面上给人读。确认框里动作本身就是标题，原因是它下面的一句说明，都不需要标签。
      VStack(alignment: .leading, spacing: 10) {
        Text(model.state.confirmationAction)
          .font(.system(size: 16, weight: .semibold))
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)

        Text(model.state.confirmation?.reason ?? model.state.detail)
          .font(.system(size: 12.5))
          .foregroundStyle(.secondary)
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)

        HStack(spacing: 8) {
          if model.state.isAnsweringConfirmation {
            ProgressView().controlSize(.small)
            Text("正在处理决定…")
              .font(.system(size: 11))
              .foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
          compactButton(title: "取消", symbol: "xmark", action: model.rejectConfirmation)
          filledButton(title: "确认执行", symbol: "checkmark", action: model.approveConfirmation)
        }
        .disabled(model.state.isAnsweringConfirmation)
        .opacity(model.state.isAnsweringConfirmation ? 0.65 : 1)
      }
      .frame(maxWidth: .infinity, minHeight: 104)

    case .result:
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 12) {
          if model.isSpeaking {
            SpeakingWaveformView(compact: false)
              .frame(width: 58, height: 38)
              .accessibilityLabel("Bright Sight 正在说话")
          } else {
            Image(systemName: "checkmark.circle.fill")
              .font(.system(size: 22))
              .foregroundStyle(Color.green)
          }
          VStack(alignment: .leading, spacing: 3) {
            if !model.state.transcript.isEmpty {
              Text(model.state.transcript)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)
            }
            Text(model.state.detail)
              .font(.system(size: 12))
              .foregroundStyle(.secondary)
              .lineLimit(2)
          }
          Spacer()
        }

        stepList(model.state.steps)

        if model.isSpeaking {
          HStack {
            Spacer()
            compactButton(title: "停止播报", symbol: "speaker.slash.fill", action: model.stopSpeaking)
          }
        }
      }
      .frame(maxWidth: .infinity, minHeight: 66)

    case .failure:
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 12) {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.system(size: 22))
            .foregroundStyle(Color.orange)
          VStack(alignment: .leading, spacing: 3) {
            if !model.state.transcript.isEmpty {
              Text(model.state.transcript)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)
            }
            Text(model.state.detail)
              .font(.system(size: 12))
              .foregroundStyle(.secondary)
              .lineLimit(2)
          }
          Spacer()
        }

        // 失败态更需要这张清单：没做成不等于什么都没发生，
        // 「已经动过什么」是用户决定要不要重来时唯一的依据。
        stepList(model.state.steps)

        HStack(spacing: 8) {
          compactButton(
            title: model.state.transcript.isEmpty ? "返回" : "修改",
            symbol: "chevron.left",
            action: model.back
          )
          compactButton(title: "重新说", symbol: "mic.fill", action: model.retryVoice)
          if model.canRetryLastCommand {
            compactButton(title: "重试", symbol: "arrow.clockwise", tint: .accentColor, action: model.retryLastCommand)
          }
        }
      }
      .frame(maxWidth: .infinity, minHeight: 82)
    }
  }

  // MARK: - 步骤清单

  @ViewBuilder
  private func stepList(_ steps: [CommandStep]) -> some View {
    if !steps.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        Divider().opacity(0.5)
        if steps.count > Self.inlineStepLimit {
          ScrollView { stepRows(steps) }
            .frame(maxHeight: CGFloat(Self.inlineStepLimit) * 22)
        } else {
          stepRows(steps)
        }
      }
    }
  }

  private func stepRows(_ steps: [CommandStep]) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
        HStack(spacing: 7) {
          Image(systemName: stepSymbol(step.state))
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(stepTint(step.state))
            .frame(width: 13)
          Text(step.app)
            .font(.system(size: 11.5, weight: .medium))
            .lineLimit(1)
          Text(step.command)
            .font(.system(size: 11))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
          Spacer(minLength: 6)
          Text(stepNote(step.state))
            .font(.system(size: 10.5))
            .foregroundStyle(stepTint(step.state))
        }
        .frame(height: 22)
        .accessibilityElement(children: .combine)
      }
    }
  }

  private func stepSymbol(_ state: CommandStep.State) -> String {
    switch state {
    case .verified: "checkmark.circle.fill"
    case .unverified: "circle.dashed"
    case .failed: "xmark.circle.fill"
    }
  }

  private func stepTint(_ state: CommandStep.State) -> Color {
    switch state {
    case .verified: .green
    // 橙色而不是绿色：动作发出去了，但没有回读能证明它成立。这不是成功。
    case .unverified: .orange
    case .failed: .red
    }
  }

  private func stepNote(_ state: CommandStep.State) -> String {
    switch state {
    case .verified: "已验证"
    case .unverified: "未验证"
    case .failed: "验证未通过"
    }
  }

  // MARK: - 按钮

  private func primaryButton(title: String, symbol: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Label(title, systemImage: symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .frame(height: 42)
        .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
    .buttonStyle(.plain)
  }

  private func secondaryButton(title: String, symbol: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Label(title, systemImage: symbol)
        .font(.system(size: 13, weight: .medium))
        .frame(maxWidth: .infinity)
        .frame(height: 42)
        .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }
    .buttonStyle(.plain)
  }

  private func compactButton(
    title: String,
    symbol: String,
    tint: Color = .secondary,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Label(title, systemImage: symbol)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(tint)
        .padding(.horizontal, 11)
        .frame(height: 30)
        .background(tint.opacity(0.10), in: Capsule())
    }
    .buttonStyle(.plain)
  }

  /// 主操作用填实的。
  ///
  /// 和 `compactButton` 并列而不是加个参数：这两者的区别不是配色，是「这一格里哪个是主操作」。
  /// 确认框里两个按钮同权重，等于把「执行」和「取消」摆成同一件事。
  private func filledButton(title: String, symbol: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Label(title, systemImage: symbol)
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 13)
        .frame(height: 30)
        .background(Color.accentColor, in: Capsule())
    }
    .buttonStyle(.plain)
  }

  private var statusTitle: String {
    if model.isSpeaking { return "正在说话" }
    switch model.state.phase {
    case .idle: return "语音或文字"
    case .authorizing: return "准备中"
    case .listening: return "正在听"
    case .finalizing: return "正在转录"
    case .typing: return "文字输入"
    case .working: return "正在行动"
    case .confirming: return "需要你确认"
    case .result: return "已完成"
    case .failure: return "需要处理"
    }
  }

  private var statusSymbol: String {
    if model.isSpeaking { return "waveform" }
    switch model.state.phase {
    case .listening: return "waveform"
    case .typing: return "keyboard"
    case .working, .authorizing, .finalizing: return "sparkles"
    case .confirming: return "exclamationmark.shield"
    case .result: return "checkmark"
    case .failure: return "exclamationmark"
    case .idle: return "circle.hexagongrid.fill"
    }
  }

  private var statusColor: Color {
    switch model.state.phase {
    case .listening: .red
    case .result: .green
    case .failure: .orange
    case .confirming: .orange
    default: .accentColor
    }
  }
}

/// 流动波形。
///
/// 和它替换掉的那个音量计的区别不在样式：那边 7 根 bar 全读同一个 `audioLevel`，
/// 只乘了个固定的钟形系数，所以永远整体涨落——说话一停，整排同时塌到底，看起来像卡死了。
/// 这里读的是历史窗口：新采样从右端进、整条左移，停顿会留下一段平坦的痕迹继续走出画面，
/// 那才是「还在听」的视觉证据。
///
/// 用 Canvas 而不是堆 Capsule：48 个采样点要连成平滑曲线，逐点堆视图既做不出曲线，
/// 每次采样还要重建 48 个 SwiftUI 节点。
///
/// 不需要 TimelineView：重绘由 `levels` 的变化驱动，也就是由真实的音频回调驱动，
/// 本来就是「跟着声音动」而不是「自己在动」。
private struct FlowWaveView: View {
  let levels: [Float]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Canvas { context, size in
      guard levels.count >= 2, size.width > 0, size.height > 0 else { return }
      let mid = size.height / 2
      let step = size.width / CGFloat(levels.count - 1)
      let peak = max(1, mid - 1)

      var top: [CGPoint] = []
      var bottom: [CGPoint] = []
      top.reserveCapacity(levels.count)
      bottom.reserveCapacity(levels.count)
      for (index, value) in levels.enumerated() {
        let magnitude = reduceMotion ? 0.12 : CGFloat(value)
        let amplitude = max(1, magnitude * peak)
        let x = CGFloat(index) * step
        top.append(CGPoint(x: x, y: mid - amplitude))
        bottom.append(CGPoint(x: x, y: mid + amplitude))
      }

      var shape = Path()
      shape.move(to: top[0])
      Self.addSmoothCurve(&shape, through: top)
      shape.addLine(to: bottom[bottom.count - 1])
      Self.addSmoothCurve(&shape, through: Array(bottom.reversed()))
      shape.closeSubpath()

      context.fill(
        shape,
        with: .linearGradient(
          Gradient(colors: [
            Color.accentColor.opacity(0.14),
            Color.accentColor.opacity(0.50),
            Color.red.opacity(0.75),
          ]),
          startPoint: .zero,
          endPoint: CGPoint(x: size.width, y: 0)
        )
      )
    }
  }

  /// 中点平滑：相邻两点之间走一段三次贝塞尔，两个控制点都取横向中点。
  /// 比折线柔和，又不像 Catmull-Rom 那样会在陡变处冲出包络——音量突变时冲出去会穿帮。
  private static func addSmoothCurve(_ path: inout Path, through points: [CGPoint]) {
    guard points.count >= 2 else { return }
    for index in 0..<(points.count - 1) {
      let current = points[index]
      let next = points[index + 1]
      let midX = (current.x + next.x) / 2
      path.addCurve(
        to: next,
        control1: CGPoint(x: midX, y: current.y),
        control2: CGPoint(x: midX, y: next.y)
      )
    }
  }
}

private struct SpeakingWaveformView: View {
  let compact: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    TimelineView(.animation(minimumInterval: 0.08, paused: reduceMotion)) { context in
      HStack(alignment: .center, spacing: compact ? 2.5 : 3.5) {
        ForEach(0..<7, id: \.self) { index in
          Capsule()
            .fill(index == 3 ? Color.accentColor : Color.accentColor.opacity(0.72))
            .frame(width: compact ? 3 : 4, height: barHeight(index, at: context.date))
        }
      }
    }
  }

  private func barHeight(_ index: Int, at date: Date) -> CGFloat {
    let minimum: CGFloat = compact ? 5 : 7
    let range: CGFloat = compact ? 13 : 25
    guard !reduceMotion else {
      return minimum + range * CGFloat(0.28 + Double(index % 3) * 0.11)
    }

    let time = date.timeIntervalSinceReferenceDate * 7.5
    let primary = (sin(time + Double(index) * 0.88) + 1) / 2
    let secondary = (sin(time * 0.63 + Double(index) * 1.71) + 1) / 2
    return minimum + range * CGFloat(0.18 + primary * 0.56 + secondary * 0.18)
  }
}
