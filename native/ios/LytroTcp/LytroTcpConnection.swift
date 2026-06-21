import Foundation
import Network

// A single TCP connection to the camera, pinned to the Wi-Fi interface.
//
// The camera's access point has no internet, so iOS will happily route a normal
// socket out over cellular and never reach 10.100.1.1. Forcing
// `requiredInterfaceType = .wifi` is what makes the connection actually land on
// the camera — this is the single most important line in the whole ingest path.
//
// Everything runs on one serial queue, so the buffer and the pending-read list
// need no extra locking.
@available(iOS 12.0, *)
final class LytroTcpConnection {
    private let conn: NWConnection
    private let queue: DispatchQueue
    private var buffer = Data()
    private var pending: [(need: Int, resolve: (Data) -> Void, reject: (Error) -> Void)] = []
    private var failure: Error?

    init(host: String, port: UInt16, queue: DispatchQueue) {
        self.queue = queue
        let params = NWParameters.tcp
        params.requiredInterfaceType = .wifi      // <-- pin to the camera's Wi-Fi
        params.prohibitExpensivePaths = false
        if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }
        conn = NWConnection(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: port) ?? 5678,
            using: params
        )
    }

    func start(completion: @escaping (Error?) -> Void) {
        var reported = false
        conn.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                if !reported { reported = true; completion(nil) }
                self.receiveLoop()
            case .failed(let err):
                if !reported { reported = true; completion(err) }
                self.failAll(err)
            case .cancelled:
                self.failAll(self.failure ?? Self.err(-1, "cancelled"))
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    // continuously pull bytes into the buffer and satisfy waiting reads
    private func receiveLoop() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let data = data, !data.isEmpty {
                self.buffer.append(data)
                self.servePending()
            }
            if let error = error { self.failAll(error); return }
            if isComplete {
                self.failAll(Self.err(-2, "connection closed by camera"))
                return
            }
            self.receiveLoop()
        }
    }

    // resolve any reads whose byte count is now available (runs on `queue`)
    private func servePending() {
        while let req = pending.first, buffer.count >= req.need {
            let chunk = buffer.prefix(req.need)
            buffer.removeFirst(req.need)
            pending.removeFirst()
            req.resolve(Data(chunk))
        }
    }

    private func failAll(_ error: Error) {
        failure = error
        let waiting = pending
        pending.removeAll()
        for r in waiting { r.reject(error) }
    }

    func read(_ n: Int, resolve: @escaping (Data) -> Void, reject: @escaping (Error) -> Void) {
        queue.async {
            if let f = self.failure { reject(f); return }
            self.pending.append((need: n, resolve: resolve, reject: reject))
            self.servePending()
        }
    }

    func write(_ data: Data, resolve: @escaping () -> Void, reject: @escaping (Error) -> Void) {
        conn.send(content: data, completion: .contentProcessed { error in
            if let error = error { reject(error) } else { resolve() }
        })
    }

    func close() {
        failure = Self.err(-3, "closed")
        conn.cancel()
    }

    private static func err(_ code: Int, _ msg: String) -> NSError {
        NSError(domain: "LytroTcp", code: code, userInfo: [NSLocalizedDescriptionKey: msg])
    }
}
