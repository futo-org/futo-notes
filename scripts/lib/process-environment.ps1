param([int]$ProcessId)
# Another process's environment block, read from its PEB (x64): the Windows counterpart of
# /proc/<pid>/environ and `ps -E`, which scripts/qa-target.mjs reads FUTO_NOTES_DATA_DIR
# from. Prints NAME=value lines; exits 4 when the process cannot be opened (not ours).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ProcessEnvironment {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicInformation { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int informationClass, ref BasicInformation information, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static byte[] Read(IntPtr process, IntPtr address, long size) {
        var buffer = new byte[size]; IntPtr read;
        if (!ReadProcessMemory(process, address, buffer, (IntPtr)size, out read)) throw new Exception("ReadProcessMemory failed");
        return buffer;
    }
    public static string Of(int processId) {
        IntPtr process = OpenProcess(0x0400 | 0x0010, false, processId); // QUERY_INFORMATION | VM_READ
        if (process == IntPtr.Zero) return null;
        try {
            var information = new BasicInformation(); int returned;
            if (NtQueryInformationProcess(process, 0, ref information, Marshal.SizeOf(information), out returned) != 0) return null;
            var parameters = (IntPtr)BitConverter.ToInt64(Read(process, information.PebBaseAddress + 0x20, 8), 0);
            var environment = (IntPtr)BitConverter.ToInt64(Read(process, parameters + 0x80, 8), 0);
            var size = BitConverter.ToInt64(Read(process, parameters + 0x3F0, 8), 0);
            return Encoding.Unicode.GetString(Read(process, environment, size));
        } finally { CloseHandle(process); }
    }
}
'@
$block = [ProcessEnvironment]::Of($ProcessId)
if ($null -eq $block) { exit 4 }
$block.Split([char]0) | Where-Object { $_ -match '^[^=].*=' }
