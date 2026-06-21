import Foundation
import Capacitor

// Capacitor bridge for the camera's raw-TCP control channel.
//
// JS API (see www/js/transport.js):
//   connect({ host, port })            -> { connectionId }
//   write({ connectionId, data })      -> {}            data: base64
//   read({ connectionId, length })     -> { data }      data: base64, exactly `length` bytes
//   close({ connectionId })            -> {}
//
// Conforms to CAPBridgedPlugin so Capacitor 6 auto-registers it — no .m file and
// no JS package needed; the web layer reaches it with
// `Capacitor.registerPlugin('LytroTcp')`.
@objc(LytroTcpPlugin)
public class LytroTcpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LytroTcpPlugin"
    public let jsName = "LytroTcp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "com.mattyv.lytroog.tcp")
    private var conns: [String: LytroTcpConnection] = [:]

    @objc func connect(_ call: CAPPluginCall) {
        guard #available(iOS 12.0, *) else { call.reject("requires iOS 12+"); return }
        guard let host = call.getString("host") else { call.reject("host required"); return }
        let port = UInt16(truncatingIfNeeded: call.getInt("port") ?? 5678)
        let id = UUID().uuidString
        let c = LytroTcpConnection(host: host, port: port, queue: queue)
        queue.async { self.conns[id] = c }
        c.start { error in
            if let error = error {
                self.queue.async { self.conns.removeValue(forKey: id) }
                call.reject("connect failed: \(error.localizedDescription)")
            } else {
                call.resolve(["connectionId": id])
            }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let c = connection(for: call) else { return }
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("data (base64) required"); return
        }
        c.write(data, resolve: { call.resolve() }, reject: { call.reject($0.localizedDescription) })
    }

    @objc func read(_ call: CAPPluginCall) {
        guard let c = connection(for: call) else { return }
        let n = call.getInt("length") ?? 0
        if n <= 0 { call.resolve(["data": ""]); return }
        c.read(n,
               resolve: { data in call.resolve(["data": data.base64EncodedString()]) },
               reject: { call.reject($0.localizedDescription) })
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let id = call.getString("connectionId") else { call.reject("connectionId required"); return }
        queue.async {
            self.conns[id]?.close()
            self.conns.removeValue(forKey: id)
            call.resolve()
        }
    }

    private func connection(for call: CAPPluginCall) -> LytroTcpConnection? {
        guard let id = call.getString("connectionId") else { call.reject("connectionId required"); return nil }
        guard let c = conns[id] else { call.reject("no such connection"); return nil }
        return c
    }
}
