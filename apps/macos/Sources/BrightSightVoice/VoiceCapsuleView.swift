import SwiftUI

struct VoiceCapsuleView: View {
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
    .frame(width: 420)
    .background {
      ZStack {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(colorScheme == .light ? Color.white.opacity(0.76) : Color.black.opacity(0.36))
      }
    }
    .overlay {
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .strokeBorder(Color.white.opacity(0.22), lineWidth: 0.8)
    }
    .shadow(color: .black.opacity(0.18), radius: 24, y: 10)
    .padding(12)
    .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.86), value: model.state.phase)
  }

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

      VStack(alignment: .leading, spacing: 1) {
        Text("Bright Sight")
          .font(.system(size: 13, weight: .semibold))
        Text(statusTitle)
          .font(.system(size: 11))
          .foregroundStyle(.secondary)
      }

      Spacer(minLength: 8)

      if model.isSpeaking {
        SpeakingWaveformView(compact: true)
          .frame(width: 46, height: 24)
          .transition(.scale.combined(with: .opacity))
          .accessibilityLabel("Bright Sight 正在说话")
      }

      compactButton(
        title: "置顶",
        symbol: model.isPinned ? "pin.fill" : "pin.slash",
        tint: model.isPinned ? .accentColor : .secondary,
        action: model.togglePin
      )
      .help(model.isPinned ? "取消置顶" : "置顶，切到其他应用时不自动隐藏")
      .accessibilityLabel(model.isPinned ? "取消置顶" : "置顶")

      Button(action: model.toggleVoiceFeedback) {
        Image(systemName: model.voiceFeedbackEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
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
      VStack(spacing: 10) {
        HStack(spacing: 14) {
          WaveformView(level: model.state.audioLevel)
            .frame(width: 72, height: 38)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 4) {
            Text(model.state.transcript.isEmpty ? "请说…" : model.state.transcript)
              .font(.system(size: 15, weight: .medium))
              .foregroundStyle(model.state.transcript.isEmpty ? .secondary : .primary)
              .lineLimit(3)
            Text(model.state.detail)
              .font(.system(size: 11))
              .foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
        }

        HStack(spacing: 8) {
          compactButton(title: "取消", symbol: "xmark", action: model.cancelCurrent)
          Spacer(minLength: 0)
          compactButton(title: "完成", symbol: "stop.fill", tint: .accentColor, action: model.endVoice)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 94)

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
      VStack(alignment: .leading, spacing: 11) {
        VStack(alignment: .leading, spacing: 3) {
          Text("要做什么")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.secondary)
          Text(model.state.confirmationAction)
            .font(.system(size: 13, weight: .medium))
            .lineLimit(2)
        }

        VStack(alignment: .leading, spacing: 3) {
          Text("为什么需要确认")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.secondary)
          Text(model.state.confirmation?.reason ?? model.state.detail)
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .lineLimit(3)
        }

        HStack(spacing: 8) {
          if model.state.isAnsweringConfirmation {
            ProgressView().controlSize(.small)
            Text("正在处理决定…")
              .font(.system(size: 11))
              .foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
          compactButton(title: "取消", symbol: "xmark", action: model.rejectConfirmation)
          compactButton(title: "确认执行", symbol: "checkmark", tint: .accentColor, action: model.approveConfirmation)
        }
        .disabled(model.state.isAnsweringConfirmation)
        .opacity(model.state.isAnsweringConfirmation ? 0.65 : 1)
      }
      .frame(maxWidth: .infinity, minHeight: 112)

    case .result:
      VStack(spacing: 10) {
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
        if model.isSpeaking {
          HStack {
            Spacer()
            compactButton(title: "停止播报", symbol: "speaker.slash.fill", action: model.stopSpeaking)
          }
        }
      }
      .frame(maxWidth: .infinity, minHeight: 66)

    case .failure:
      VStack(spacing: 10) {
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

  private var statusTitle: String {
    if model.isSpeaking { return "正在说话" }
    switch model.state.phase {
    case .idle: return "语音或文字"
    case .authorizing: return "准备中"
    case .listening: return "正在听"
    case .finalizing: return "正在转录"
    case .typing: return "文字输入"
    case .working: return "正在行动"
    case .confirming: return "等待确认"
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
    case .confirming: return "questionmark.circle"
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

private struct WaveformView: View {
  let level: Float
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    HStack(alignment: .center, spacing: 4) {
      ForEach(0..<7, id: \.self) { index in
        Capsule()
          .fill(index == 3 ? Color.red : Color.accentColor)
          .frame(width: 5, height: barHeight(index))
      }
    }
    .animation(reduceMotion ? nil : .spring(response: 0.16, dampingFraction: 0.72), value: level)
  }

  private func barHeight(_ index: Int) -> CGFloat {
    let distance = abs(index - 3)
    let shape = max(0.35, 1 - Float(distance) * 0.16)
    return 8 + CGFloat(level * shape) * 30
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
