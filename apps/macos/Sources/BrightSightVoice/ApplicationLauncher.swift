import AppKit
import Foundation

struct ApplicationLaunchTarget: Equatable {
  let name: String
  let url: URL
}

enum ApplicationLaunchError: LocalizedError {
  case failed(String, String)

  var errorDescription: String? {
    switch self {
    case .failed(let name, let detail): return "无法打开\(name)：\(detail)"
    }
  }
}

/// A narrow native capability for opening an already installed application.
/// Resolution is exact after normalization; ambiguous or descriptive text falls
/// through to the core agent rather than opening a guessed application.
final class ApplicationLauncher {
  private lazy var installedApplications = discoverApplications()

  func target(for command: String) -> ApplicationLaunchTarget? {
    guard let requested = Self.requestedApplicationName(from: command) else { return nil }
    let key = Self.normalized(requested)
    let matches = installedApplications.filter { target in
      Self.normalized(target.name) == key || Self.aliases[key] == target.url.lastPathComponent
    }
    let unique = Dictionary(grouping: matches, by: \.url.path).compactMap(\.value.first)
    return unique.count == 1 ? unique[0] : nil
  }

  func launch(_ target: ApplicationLaunchTarget) async throws -> String {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.addsToRecentItems = false

    return try await withCheckedThrowingContinuation { continuation in
      NSWorkspace.shared.openApplication(at: target.url, configuration: configuration) { app, error in
        if let error {
          continuation.resume(throwing: ApplicationLaunchError.failed(target.name, error.localizedDescription))
          return
        }
        guard let app, !app.isTerminated else {
          continuation.resume(throwing: ApplicationLaunchError.failed(target.name, "系统没有返回运行中的应用"))
          return
        }
        continuation.resume(returning: target.name)
      }
    }
  }

  static func requestedApplicationName(from command: String) -> String? {
    let value = command.trimmingCharacters(in: .whitespacesAndNewlines)
    let prefixes = ["帮我打开一下", "打开一下我的", "打开我的", "启动一下", "打开一下", "帮我打开", "启动", "打开"]
    guard let prefix = prefixes.first(where: { value.hasPrefix($0) }) else { return nil }
    var name = String(value.dropFirst(prefix.count))
      .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    for suffix in ["这个应用", "这个软件", "应用", "软件"] where name.hasSuffix(suffix) {
      name = String(name.dropLast(suffix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
      break
    }
    return name.isEmpty ? nil : name
  }

  private func discoverApplications() -> [ApplicationLaunchTarget] {
    let homeApplications = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
    let roots = [
      URL(fileURLWithPath: "/Applications", isDirectory: true),
      URL(fileURLWithPath: "/System/Applications", isDirectory: true),
      URL(fileURLWithPath: "/System/Applications/Utilities", isDirectory: true),
      homeApplications,
    ]

    var targets: [ApplicationLaunchTarget] = []
    for root in roots {
      guard let urls = try? FileManager.default.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
      ) else { continue }

      for url in urls where url.pathExtension.lowercased() == "app" {
        let fileName = url.deletingPathExtension().lastPathComponent
        let bundle = Bundle(url: url)
        let displayName = bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
          ?? bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String
          ?? fileName
        targets.append(ApplicationLaunchTarget(name: displayName, url: url))
        if displayName != fileName {
          targets.append(ApplicationLaunchTarget(name: fileName, url: url))
        }
      }
    }
    return targets
  }

  private static func normalized(_ value: String) -> String {
    value
      .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
      .replacingOccurrences(of: " ", with: "")
      .lowercased()
  }

  private static let aliases: [String: String] = [
    "微信": "WeChat.app",
    "safari": "Safari.app",
    "系统设置": "System Settings.app",
    "设置": "System Settings.app",
    "备忘录": "Notes.app",
    "chrome": "Google Chrome.app",
    "谷歌浏览器": "Google Chrome.app",
  ]
}
