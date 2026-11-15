// clavium-mcp (macOS) — stdio <-> Streamable HTTP bridge for MCP clients that only
// support stdio servers (Claude Desktop, Codex, ...). It forwards each JSON-RPC line
// from stdin to the MCP endpoint of the running Clavium app on 127.0.0.1 and writes
// the responses to stdout. It holds no secrets itself: the token comes from the
// CLAVIUM_MCP_TOKEN environment variable set in the AI client's configuration.
//
// The macOS counterpart of ClaviumMcpBridge.cs. Foundation only, so it compiles with the
// swiftc of the Xcode command line tools (no packages, no dependencies).
import Foundation

let env = ProcessInfo.processInfo.environment
let token = env["CLAVIUM_MCP_TOKEN"] ?? ""

let dataDir: URL = {
    if let dir = env["CLAVIUM_DATA_DIR"], !dir.isEmpty { return URL(fileURLWithPath: dir) }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Clavium")
}()

func log(_ message: String) {
    FileHandle.standardError.write("[clavium-mcp] \(message)\n".data(using: .utf8)!)
}

func firstMatch(_ pattern: String, in text: String, group: Int = 1) -> String? {
    guard let re = try? NSRegularExpression(pattern: pattern),
          let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let range = Range(m.range(at: group), in: text) else { return nil }
    return String(text[range])
}

func readPort() -> Int {
    let file = dataDir.appendingPathComponent("settings.json")
    if let text = try? String(contentsOf: file, encoding: .utf8),
       let port = firstMatch("\"mcpPort\"\\s*:\\s*(\\d{2,5})", in: text).flatMap({ Int($0) }) {
        return port
    }
    return 47821
}

let endpoint: URL = {
    if let custom = env["CLAVIUM_MCP_URL"], !custom.isEmpty, let url = URL(string: custom) { return url }
    return URL(string: "http://127.0.0.1:\(readPort())/mcp")!
}()

let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.connectionProxyDictionary = [:] // never route localhost traffic through a proxy
    config.timeoutIntervalForRequest = 7 * 24 * 3600 // tool calls may wait for the user's approval
    config.timeoutIntervalForResource = 7 * 24 * 3600
    config.httpMaximumConnectionsPerHost = 32
    config.httpCookieStorage = nil
    config.urlCache = nil
    return URLSession(configuration: config)
}()

let outLock = NSLock()

func write(_ json: String) {
    let line = json.trimmingCharacters(in: .whitespacesAndNewlines) + "\n"
    outLock.lock()
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
    outLock.unlock()
}

let launchLock = NSLock()
var launched = false

/// Start Clavium when an AI client needs it and the app is not running.
func tryLaunchApp() {
    launchLock.lock()
    let first = !launched
    launched = true
    launchLock.unlock()
    guard first, let exe = Bundle.main.executableURL else { return }
    let pathFile = exe.resolvingSymlinksInPath().deletingLastPathComponent().appendingPathComponent("clavium-app-path.txt")
    guard let text = try? String(contentsOf: pathFile, encoding: .utf8) else { return }
    let app = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard app.hasSuffix(".app"), FileManager.default.fileExists(atPath: app) else { return }
    log("Clavium is not running - starting it")
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = ["-g", "-a", app]
    do { try open.run() } catch { log("could not start Clavium: \(error.localizedDescription)") }
}

struct Reply {
    let status: Int
    let contentType: String
    let text: String
}

func postOnce(_ body: Data) -> Result<Reply, Error> {
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    var result: Result<Reply, Error> = .failure(URLError(.unknown))
    let done = DispatchSemaphore(value: 0)
    session.dataTask(with: request) { data, response, error in
        if let http = response as? HTTPURLResponse {
            result = .success(Reply(
                status: http.statusCode,
                contentType: http.value(forHTTPHeaderField: "Content-Type") ?? "",
                text: String(data: data ?? Data(), encoding: .utf8) ?? ""
            ))
        } else {
            result = .failure(error ?? URLError(.badServerResponse))
        }
        done.signal()
    }.resume()
    done.wait()
    return result
}

/// Posts the message. While nothing listens on the port, Clavium is started and the request retried.
func post(_ body: Data) throws -> Reply {
    let deadline = Date().addingTimeInterval(25)
    while true {
        switch postOnce(body) {
        case .success(let reply):
            return reply
        case .failure(let error):
            let refused = (error as? URLError)?.code == .cannotConnectToHost
            if !refused || Date() > deadline { throw error }
            tryLaunchApp()
            Thread.sleep(forTimeInterval: 0.75)
        }
    }
}

func jsonString(_ text: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [text])) ?? Data("[\"\"]".utf8)
    let array = String(data: data, encoding: .utf8) ?? "[\"\"]"
    return String(array.dropFirst().dropLast())
}

func handle(_ line: String) {
    let id = firstMatch("\"id\"\\s*:\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|-?\\d+)", in: line)
    do {
        let reply = try post(Data(line.utf8))
        var text = reply.text
        if reply.status == 202 || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return }
        if reply.contentType.lowercased().contains("text/event-stream") {
            for raw in text.split(separator: "\n", omittingEmptySubsequences: true) {
                let l = raw.hasSuffix("\r") ? raw.dropLast() : raw
                if l.hasPrefix("data:") { write(String(l.dropFirst(5))) }
            }
            return
        }
        // Error replies without an id (e.g. 401) get the request's id so the client can match them.
        if reply.status >= 400, let id = id, text.contains("\"id\":null") {
            text = text.replacingOccurrences(of: "\"id\":null", with: "\"id\":\(id)")
        }
        write(text)
    } catch {
        log(error.localizedDescription)
        guard let id = id else { return }
        let message = "Clavium is not reachable (\(error.localizedDescription)). Start Clavium, unlock it and enable the MCP server."
        write("{\"jsonrpc\":\"2.0\",\"id\":\(id),\"error\":{\"code\":-32000,\"message\":\(jsonString(message))}}")
    }
}

// A client that went away must not kill the bridge with SIGPIPE in the middle of a write.
signal(SIGPIPE, SIG_IGN)

let arguments = CommandLine.arguments
if arguments.count > 1, arguments[1] == "--version" || arguments[1] == "-v" {
    FileHandle.standardError.write("clavium-mcp bridge -> \(endpoint.absoluteString)\n".data(using: .utf8)!)
    exit(0)
}
if token.isEmpty {
    log("CLAVIUM_MCP_TOKEN is not set. Copy the configuration from Clavium > AI Access.")
}

let workers = DispatchQueue(label: "clavium.mcp.requests", attributes: .concurrent)
let pending = DispatchGroup()
while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    pending.enter()
    workers.async {
        handle(line)
        pending.leave()
    }
}
pending.wait()
exit(0)
