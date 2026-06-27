param([Parameter(Mandatory=$true)][string]$OutputDirectory)
# A dedicated, harmless real console. ReadConsoleInput observes Windows mouse
# events independently of the sender; no shell commands are read or executed.
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class PointerFixture {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Explicit, Size=20)] struct Input {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(4)] public Coord Position;
        [FieldOffset(8)] public uint Buttons;
        [FieldOffset(16)] public uint Flags;
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint mode);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint mode);
    [DllImport("kernel32.dll")] static extern bool GetNumberOfConsoleInputEvents(IntPtr h, out uint count);
    [DllImport("kernel32.dll")] static extern bool ReadConsoleInput(IntPtr h, [Out] Input[] events, uint length, out uint read);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref Point point);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder value,int capacity);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    public static void Run(string directory) {
        SetProcessDPIAware();
        IntPtr window=GetConsoleWindow(), input=GetStdHandle(-10);
        if (window==IntPtr.Zero) throw new Exception("A dedicated conhost console is required.");
        uint previous;
        if (!GetConsoleMode(input, out previous) || !SetConsoleMode(input, (previous|0x90u)&~0x40u))
            throw new Exception("Cannot enable console mouse input.");
        Console.Title="REMOTE DESKTOP - TOUCH ACCEPTANCE TERMINAL";
        Console.BackgroundColor=ConsoleColor.DarkBlue; Console.ForegroundColor=ConsoleColor.White; Console.Clear();
        int width=GetSystemMetrics(0), height=GetSystemMetrics(1);
        ShowWindow(window,9);
        if (!SetWindowPos(window, new IntPtr(-1), width/8, height/6, width*3/4, height*2/3, 0x40))
            throw new Exception("Cannot position the dedicated console.");
        Thread.Sleep(250);
        StringBuilder windowClass=new StringBuilder(128); GetClassName(window,windowClass,128);
        if (!IsWindowVisible(window) || IsIconic(window) || windowClass.ToString()!="ConsoleWindowClass")
            throw new Exception("Fixture must be a visible restored classic ConsoleWindowClass window, got "+windowClass.ToString());
        Rect client; GetClientRect(window, out client);
        Point origin=new Point(); ClientToScreen(window, ref origin);
        string geometry=String.Format("{{\"pid\":{0},\"window\":{1},\"screen_width\":{2},\"screen_height\":{3},\"left\":{4},\"top\":{5},\"width\":{6},\"height\":{7}}}",
            System.Diagnostics.Process.GetCurrentProcess().Id, window.ToInt64(), width, height,
            origin.X, origin.Y, client.Right, client.Bottom);
        File.WriteAllText(Path.Combine(directory,"fixture.json"), geometry);
        string events=Path.Combine(directory,"console-events.csv");
        File.WriteAllText(events,"event,x,y,foreground,left_down\n");
        Console.WriteLine("PS> 6 * 7"); Console.WriteLine("42");
        Console.WriteLine("TOUCH THIS TERMINAL FROM ANDROID");
        Console.WriteLine("Each real Windows mouse DOWN / UP will appear below.");
        Console.WriteLine("This fixture executes no input as shell commands.");
        bool wasDown=false, wasFocused=false;
        try {
            while (!File.Exists(Path.Combine(directory,"stop-fixture"))) {
                bool focused=GetForegroundWindow()==window;
                if (focused!=wasFocused) {
                    Console.WriteLine("TERMINAL FOCUS: "+(focused?"ACTIVE":"INACTIVE")); wasFocused=focused;
                }
                uint available;
                if (!GetNumberOfConsoleInputEvents(input,out available)) throw new Exception("Console input failed.");
                if (available>0) {
                    Input[] records=new Input[Math.Min(available,128u)]; uint read;
                    if (!ReadConsoleInput(input,records,(uint)records.Length,out read)) throw new Exception("Console read failed.");
                    for (uint index=0;index<read;index++) {
                        Input record=records[index];
                        if (record.Type!=2 || record.Flags!=0) continue;
                        bool down=(record.Buttons&1)!=0;
                        if (down==wasDown) continue;
                        wasDown=down;
                        Point cursor; GetCursorPos(out cursor);
                        string action=down?"down":"up";
                        string line=String.Format("{0},{1},{2},{3},{4}",action,cursor.X,cursor.Y,GetForegroundWindow().ToInt64(),(GetAsyncKeyState(1)&0x8000)!=0);
                        File.AppendAllText(events,line+"\n");
                        Console.WriteLine("WINDOWS "+action.ToUpper()+" at "+cursor.X+","+cursor.Y+" | terminal focus="+focused);
                    }
                }
                Thread.Sleep(10);
            }
        } finally { SetConsoleMode(input,previous); }
    }
}
'@
try { [PointerFixture]::Run($OutputDirectory) }
catch {
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'fixture-error.txt'),$_.Exception.ToString())
    throw
}
