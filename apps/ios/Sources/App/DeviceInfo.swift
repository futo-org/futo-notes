import Foundation

enum DeviceInfo {
    static func hardwareModel() -> String {
        var system = utsname()
        uname(&system)
        let machine = system.machine
        return withUnsafePointer(to: machine) { pointer in
            pointer.withMemoryRebound(
                to: CChar.self, capacity: MemoryLayout.size(ofValue: machine)
            ) {
                String(cString: $0)
            }
        }
    }
}
