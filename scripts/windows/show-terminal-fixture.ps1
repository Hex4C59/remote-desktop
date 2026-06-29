param([Parameter(Mandatory=$true)][string]$OutputDirectory)
# Start with powershell.exe -NoExit. This configures a real interactive
# PowerShell terminal in an isolated directory; all commands arrive via Android.
$ErrorActionPreference = 'Stop'
try {
    Add-Type @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class TerminalFixture {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct SmallRect { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct BufferInfo { public Coord Size, Cursor; public ushort Attributes; public SmallRect Window; public Coord MaxSize; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct FontInfo {
        public uint Size, Font; public Coord FontSize; public uint Family, Weight;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string FaceName;
    }
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h,out uint mode);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h,uint mode);
    [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr h,out BufferInfo info);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool ReadConsoleOutputCharacter(IntPtr h,[Out] char[] value,uint count,Coord origin,out uint read);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool SetCurrentConsoleFontEx(IntPtr h,bool maximum,ref FontInfo info);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref Point point);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder value,int capacity);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    public static void SetReadableFont() {
        FontInfo font=new FontInfo(); font.Size=(uint)Marshal.SizeOf(typeof(FontInfo));
        font.FontSize.Y=32; font.Family=54; font.Weight=400; font.FaceName="Consolas";
        if (!SetCurrentConsoleFontEx(GetStdHandle(-11),false,ref font)) throw new Exception("Cannot set a readable terminal font.");
    }
    public static void Observe(string directory) {
        Thread observer=new Thread(delegate() {
            try {
                IntPtr output=GetStdHandle(-11); string previous=null;
                string path=Path.Combine(directory,"console-text.txt"), pending=path+".pending";
                while (true) {
                    BufferInfo info;
                    if (!GetConsoleScreenBufferInfo(output,out info)) throw new Exception("Cannot observe console output.");
                    uint length=(uint)(info.Size.X*(info.Cursor.Y+1));
                    char[] text=new char[(int)length]; uint read;
                    if (!ReadConsoleOutputCharacter(output,text,length,new Coord(),out read) || read!=length) throw new Exception("Cannot read complete console output.");
                    // The console API returns counted characters, not a NUL-terminated string.
                    string current=new string(text,0,(int)read);
                    if (current!=previous) {
                        File.WriteAllText(pending,current);
                        if (File.Exists(path)) File.Replace(pending,path,null); else File.Move(pending,path);
                        previous=current;
                    }
                    Thread.Sleep(100);
                }
            } catch (Exception error) { File.WriteAllText(Path.Combine(directory,"observer-error.txt"),error.ToString()); }
        });
        observer.IsBackground=true; observer.Start();
    }
}
'@
    [void][TerminalFixture]::SetProcessDPIAware()
    $window=[TerminalFixture]::GetConsoleWindow()
    if ($window -eq [IntPtr]::Zero) { throw 'A dedicated classic console is required.' }
    $inputHandle=[TerminalFixture]::GetStdHandle(-10)
    [uint32]$mode=0
    if (![TerminalFixture]::GetConsoleMode($inputHandle,[ref]$mode) -or ![TerminalFixture]::SetConsoleMode($inputHandle,($mode -bor 0x80) -band (-bnot 0x40))) { throw 'Cannot disable console QuickEdit selection.' }
    $Host.UI.RawUI.WindowTitle='REMOTE DESKTOP - TERMINAL INPUT ACCEPTANCE'
    $Host.UI.RawUI.BackgroundColor='DarkBlue'; $Host.UI.RawUI.ForegroundColor='White'
    [TerminalFixture]::SetReadableFont()
    Clear-Host
    $width=[TerminalFixture]::GetSystemMetrics(0); $height=[TerminalFixture]::GetSystemMetrics(1)
    [void][TerminalFixture]::ShowWindow($window,9)
    if (![TerminalFixture]::SetWindowPos($window,[IntPtr](-1),[int]($width/8),[int]($height/6),[int]($width*3/4),[int]($height*2/3),0x40)) { throw 'Cannot position terminal fixture.' }
    Start-Sleep -Milliseconds 250
    $class=New-Object Text.StringBuilder 128
    [void][TerminalFixture]::GetClassName($window,$class,128)
    if (![TerminalFixture]::IsWindowVisible($window) -or [TerminalFixture]::IsIconic($window) -or $class.ToString() -ne 'ConsoleWindowClass') { throw 'A visible restored classic console is required.' }
    $client=New-Object TerminalFixture+Rect; $origin=New-Object TerminalFixture+Point
    [void][TerminalFixture]::GetClientRect($window,[ref]$client)
    [void][TerminalFixture]::ClientToScreen($window,[ref]$origin)
    $work=Join-Path $OutputDirectory 'work'
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    Set-Location $work
    [IO.File]::WriteAllText((Join-Path $work 'result-lines.txt'),'')
    [IO.File]::WriteAllText((Join-Path $work 'task04_completion_unique.txt'),'TAB_COMPLETED')
    # A real cancellable foreground native process. Ctrl+C must stop it before
    # its eventual completion marker and leave PowerShell accepting commands.
    @'
Write-Output 'FOREGROUND_RUNNING'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'foreground-started.txt'),'running')
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'foreground-pid.txt'),[string]$PID)
Start-Sleep -Seconds 300
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'foreground-finished.txt'),'unexpected completion')
'@ | Set-Content -Path (Join-Path $work 'foreground.ps1') -Encoding ASCII
    Import-Module PSReadLine -Global -ErrorAction Stop
    Set-PSReadLineOption -EditMode Windows -HistorySaveStyle SaveNothing -BellStyle None
    Set-PSReadLineOption -Colors @{
        Command=[ConsoleColor]::White; Default=[ConsoleColor]::White; String=[ConsoleColor]::Yellow
        Parameter=[ConsoleColor]::Cyan; Number=[ConsoleColor]::Cyan; Variable=[ConsoleColor]::Cyan
        Operator=[ConsoleColor]::White; Member=[ConsoleColor]::White; Type=[ConsoleColor]::Magenta
        Keyword=[ConsoleColor]::White; ContinuationPrompt=[ConsoleColor]::White
    }
    Set-PSReadLineKeyHandler -Key Tab -Function Complete
    Set-PSReadLineKeyHandler -Key UpArrow -Function PreviousHistory
    Set-PSReadLineKeyHandler -Key DownArrow -Function NextHistory
    function global:prompt { 'TASK04 PS> ' }
    Start-Transcript -Path (Join-Path $OutputDirectory 'terminal-transcript.txt') -Force | Out-Null
    Write-Host 'REMOTE DESKTOP TERMINAL INPUT ACCEPTANCE'
    Write-Host 'Touch this terminal from Android, then send commands.'
    Write-Host 'Results are confined to this disposable working directory.'
    [TerminalFixture]::Observe($OutputDirectory)
    [ordered]@{pid=$PID;window=$window.ToInt64();screen_width=$width;screen_height=$height;left=$origin.X;top=$origin.Y;width=$client.Right;height=$client.Bottom;work_directory=$work;psreadline=(Get-Module PSReadLine).Version.ToString();font='Consolas';font_height=32} | ConvertTo-Json | Set-Content (Join-Path $OutputDirectory 'fixture.json')
} catch {
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'fixture-error.txt'),$_.Exception.ToString())
    exit 1
}
