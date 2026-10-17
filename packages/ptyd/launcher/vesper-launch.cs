// vesper-launch: runs one command line with a normal-privilege token in the caller's console.
//
// Vesper's daemon can run elevated (the built-in Administrator account has no UAC split
// token). Shells and agents started through this launcher get a restricted copy of the
// daemon's token: only SeChangeNotifyPrivilege left, BUILTIN\Administrators deny-only and
// Medium integrity, so files whose ACL grants only SYSTEM and Administrators are out of reach.
//
// Usage: vesper-launch.exe <command line>
//   Everything after the launcher's own program name in the raw command line goes to
//   CreateProcessAsUserW unchanged, so the child sees exactly the quoting the caller wrote.
//
// The child shares the launcher's console (node-pty's ConPTY), working directory and
// environment. The launcher ignores Ctrl+C and Ctrl+Break so that only the child reacts to
// them, waits for the child and exits with its exit code. If the child cannot be started it
// prints the failing API and Win32 error to stderr and exits with LaunchFailedExitCode.
//
// Build (needs only the .NET Framework 4 that ships with Windows):
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+
//     /target:exe /platform:anycpu /out:vesper-launch.exe vesper-launch.cs

using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class VesperLaunch
{
    const int LaunchFailedExitCode = 127;

    const uint TOKEN_ASSIGN_PRIMARY = 0x1, TOKEN_DUPLICATE = 0x2, TOKEN_QUERY = 0x8, TOKEN_ADJUST_DEFAULT = 0x80;
    const uint DISABLE_MAX_PRIVILEGE = 0x1, SE_GROUP_INTEGRITY = 0x20;
    const int TokenOwner = 4, TokenDefaultDacl = 6, TokenIntegrityLevel = 25; // TOKEN_INFORMATION_CLASS
    const int GENERIC_ALL = 0x10000000;
    const string MediumIntegritySid = "S-1-16-8192";
    const uint STARTF_USESTDHANDLES = 0x100, INFINITE = 0xFFFFFFFF;
    const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    const uint CTRL_C_EVENT = 0, CTRL_BREAK_EVENT = 1;

    // Kept in a static field so the garbage collector never frees the delegate that the
    // console calls into.
    static readonly ConsoleCtrlHandler IgnoreInterrupts = delegate(uint ctrlType)
    {
        // Ctrl+C and Ctrl+Break reach every process on the console; the child handles them.
        // Close, logoff and shutdown fall through to the default handler, which exits.
        return ctrlType == CTRL_C_EVENT || ctrlType == CTRL_BREAK_EVENT;
    };

    static int Main()
    {
        string commandLine = ChildCommandLine(Marshal.PtrToStringUni(GetCommandLineW()));
        if (commandLine.Length == 0)
        {
            Console.Error.WriteLine("usage: vesper-launch.exe <command line>");
            return LaunchFailedExitCode;
        }
        try
        {
            // A handler routine rather than SetConsoleCtrlHandler(NULL, TRUE): the NULL form
            // sets a flag that child processes inherit, so the child would ignore Ctrl+C too.
            Check(SetConsoleCtrlHandler(IgnoreInterrupts, true), "SetConsoleCtrlHandler");
            return Run(commandLine);
        }
        catch (Win32Exception e)
        {
            Console.Error.WriteLine("vesper-launch: {0} failed: Win32 error {1}: {2}", e.Message,
                e.NativeErrorCode, new Win32Exception(e.NativeErrorCode).Message);
            return LaunchFailedExitCode;
        }
    }

    static int Run(string commandLine)
    {
        IntPtr processToken, token;
        Check(OpenProcessToken(GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            out processToken), "OpenProcessToken");
        // The restricted token's handle gets the same access as processToken.
        var administrators = new[] { new SID_AND_ATTRIBUTES {
            Sid = Unmanaged(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null)) } };
        Check(CreateRestrictedToken(processToken, DISABLE_MAX_PRIVILEGE, 1, administrators,
            0, IntPtr.Zero, 0, IntPtr.Zero, out token), "CreateRestrictedToken");
        CloseHandle(processToken);
        SetTokenDefaults(token, WindowsIdentity.GetCurrent().User);

        // STARTF_USESTDHANDLES plus inheritance hands the child the launcher's own console
        // handles, and also works when the launcher's stdio is redirected to pipes or files.
        var startup = new STARTUPINFO
        {
            dwFlags = STARTF_USESTDHANDLES,
            hStdInput = GetStdHandle(STD_INPUT_HANDLE),
            hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE),
            hStdError = GetStdHandle(STD_ERROR_HANDLE),
        };
        startup.cb = Marshal.SizeOf(startup);
        PROCESS_INFORMATION child;
        // No creation flags: same console, same process group (so Ctrl+C reaches the child).
        // Null environment: the child inherits the launcher's, minus the directory variable.
        string directory = ChildDirectory();
        Check(CreateProcessAsUserW(token, null, new StringBuilder(commandLine, commandLine.Length + 1),
            IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, directory, ref startup, out child),
            "CreateProcessAsUserW");
        CloseHandle(child.hThread);
        CloseHandle(token);

        WaitForSingleObject(child.hProcess, INFINITE);
        uint exitCode;
        Check(GetExitCodeProcess(child.hProcess, out exitCode), "GetExitCodeProcess");
        return unchecked((int)exitCode);
    }

    // The elevated launcher itself starts in its own protected folder (so no DLL planted in the
    // session's writable directory loads into it) and is told the child's directory in this
    // variable, which the child does not inherit. Without it the child starts where the launcher did.
    const string ChildDirectoryVariable = "VESPER_LAUNCH_CWD";

    static string ChildDirectory()
    {
        string directory = Environment.GetEnvironmentVariable(ChildDirectoryVariable);
        Environment.SetEnvironmentVariable(ChildDirectoryVariable, null);
        return string.IsNullOrEmpty(directory) ? null : directory;
    }

    // Lowers the integrity level and gives the token a default owner and DACL of its own.
    // CreateRestrictedToken keeps the elevated default DACL (Administrators and SYSTEM full
    // control), so objects the child creates, including its own processes, threads and
    // pipes, would be closed to it: Git Bash then fails in NtSetInformationToken
    // (0xC0000022) and cannot create pipes. It already moves the default owner from the
    // deny-only Administrators to the user, but undocumented, so the owner is set explicitly.
    static void SetTokenDefaults(IntPtr token, SecurityIdentifier user)
    {
        SetInformation(token, TokenIntegrityLevel, Unmanaged(new SecurityIdentifier(MediumIntegritySid)),
            SE_GROUP_INTEGRITY, "SetTokenInformation(TokenIntegrityLevel)");
        SetInformation(token, TokenOwner, Unmanaged(user), 0, "SetTokenInformation(TokenOwner)");

        var dacl = new RawAcl(GenericAcl.AclRevision, 2);
        dacl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, GENERIC_ALL, user, false, null));
        dacl.InsertAce(1, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, GENERIC_ALL,
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), false, null));
        var bytes = new byte[dacl.BinaryLength];
        dacl.GetBinaryForm(bytes, 0);
        SetInformation(token, TokenDefaultDacl, Unmanaged(bytes), 0, "SetTokenInformation(TokenDefaultDacl)");
    }

    // TOKEN_MANDATORY_LABEL is a SID_AND_ATTRIBUTES; TOKEN_OWNER and TOKEN_DEFAULT_DACL are a
    // single pointer, which is the first field of SID_AND_ATTRIBUTES, so one layout fits all.
    static void SetInformation(IntPtr token, int infoClass, IntPtr pointer, uint attributes, string api)
    {
        var info = new SID_AND_ATTRIBUTES { Sid = pointer, Attributes = attributes };
        Check(SetTokenInformation(token, infoClass, ref info, Marshal.SizeOf(info)), api);
    }

    // The raw command line minus argv[0] and the blanks after it. argv[0] runs to its closing
    // quote when it starts with one, otherwise to the first space or tab; text glued to a
    // closing quote still belongs to it (node-pty writes "C:\path\vesper-launch.exe" args).
    static string ChildCommandLine(string raw)
    {
        int i = 0;
        if (raw.Length > 0 && raw[0] == '"')
        {
            i = raw.IndexOf('"', 1);
            i = i < 0 ? raw.Length : i + 1;
        }
        while (i < raw.Length && raw[i] != ' ' && raw[i] != '\t') i++;
        while (i < raw.Length && (raw[i] == ' ' || raw[i] == '\t')) i++;
        return raw.Substring(i);
    }

    // Native copies of SIDs and ACLs live as long as the token that refers to them, which is
    // the launcher's lifetime, so they are never freed.
    static IntPtr Unmanaged(SecurityIdentifier sid)
    {
        var bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        return Unmanaged(bytes);
    }

    static IntPtr Unmanaged(byte[] bytes)
    {
        IntPtr memory = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, memory, bytes.Length);
        return memory;
    }

    // Throws with the API name as the message; Main turns it into the stderr report.
    static void Check(bool ok, string api)
    {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), api);
    }

    delegate bool ConsoleCtrlHandler(uint ctrlType);

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll")] static extern IntPtr GetCommandLineW();
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int stdHandle);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler h, bool add);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr existingToken, uint flags, int disableSidCount,
        SID_AND_ATTRIBUTES[] sidsToDisable, int deletePrivilegeCount, IntPtr privilegesToDelete,
        int restrictedSidCount, IntPtr sidsToRestrict, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetTokenInformation(IntPtr token, int infoClass, ref SID_AND_ATTRIBUTES info, int length);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessAsUserW(IntPtr token, string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION info);
}
