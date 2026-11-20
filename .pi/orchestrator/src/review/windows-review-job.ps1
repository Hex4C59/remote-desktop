# Win32 Job Object: launcher exit ends its whole review process tree.
# Thread: review subprocess launcher only.
param([Parameter(Mandatory = $true)][string]$Manifest)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Text;
using System.Runtime.InteropServices;

public static class ReviewJob
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong Reads, Writes, Other, ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public int ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int stream);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr handle, IntPtr targetProcess,
        out IntPtr copy, int access, bool inherit, int options);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, int flags, IntPtr environment, string cwd, ref StartupInfo startup,
        out ProcessInfo info);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out int code);

    private static IntPtr InheritStandardHandle(int stream)
    {
        const int DuplicateSameAccess = 2;
        IntPtr self = GetCurrentProcess();
        IntPtr handle = GetStdHandle(stream);
        IntPtr copy;
        if (!DuplicateHandle(self, handle, self, out copy, 0, true, DuplicateSameAccess))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return copy;
    }

    public static int Run(string commandLine, string cwd)
    {
        const int UseStandardHandles = 0x100;
        const int NoWindow = 0x08000000;
        var startup = new StartupInfo();
        startup.Size = Marshal.SizeOf(startup);
        startup.Flags = UseStandardHandles;
        ProcessInfo info;
        try
        {
            startup.Input = InheritStandardHandle(-10);
            startup.Output = InheritStandardHandle(-11);
            startup.Error = InheritStandardHandle(-12);
            if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                NoWindow, IntPtr.Zero, cwd, ref startup, out info))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            if (startup.Input != IntPtr.Zero) CloseHandle(startup.Input);
            if (startup.Output != IntPtr.Zero) CloseHandle(startup.Output);
            if (startup.Error != IntPtr.Zero) CloseHandle(startup.Error);
        }
        CloseHandle(info.Thread);
        try
        {
            int code;
            if (WaitForSingleObject(info.Process, uint.MaxValue) != 0 || !GetExitCodeProcess(info.Process, out code))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return code;
        }
        finally
        {
            CloseHandle(info.Process);
        }
    }

    public static void Enter()
    {
        const uint KillOnJobClose = 0x2000;
        const int ExtendedLimitInformation = 9;
        var limits = new ExtendedLimits();
        limits.Basic.Flags = KillOnJobClose;
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(limits)) ||
            !AssignProcessToJobObject(job, GetCurrentProcess()))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }
        // The unnamed handle is non-inheritable. Keep it open until the launcher process exits.
    }
}
'@

try {
    $invocation = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    [ReviewJob]::Enter()
    exit ([ReviewJob]::Run($invocation.commandLine, $invocation.cwd))
} catch {
    [Console]::Error.WriteLine('Review process launcher failed: ' + $_.Exception.Message)
    exit 1
}
