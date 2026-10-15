/**
 * Windows job objects through koffi, which ships prebuilt binaries, so no compiler is needed.
 *
 * Assigning a shell to a job lets Vesper end it together with every process it starts
 * later, including detached ones that `taskkill /T` misses once their parent has exited.
 * Bindings assume x64, where the calling convention is fixed.
 */
import koffi from 'koffi';

export interface ProcessJob {
  assign(pid: number): void;
  isMember(pid: number): boolean;
  terminate(exitCode: number): void;
  close(): void;
}

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

// Anonymous structs: koffi type names are process-global and may only be registered once.
const IO_COUNTERS = koffi.struct({
  ReadOperationCount: 'uint64',
  WriteOperationCount: 'uint64',
  OtherOperationCount: 'uint64',
  ReadTransferCount: 'uint64',
  WriteTransferCount: 'uint64',
  OtherTransferCount: 'uint64',
});
const BASIC_LIMIT_INFORMATION = koffi.struct({
  PerProcessUserTimeLimit: 'int64',
  PerJobUserTimeLimit: 'int64',
  LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'size_t',
  MaximumWorkingSetSize: 'size_t',
  ActiveProcessLimit: 'uint32',
  Affinity: 'uintptr_t',
  PriorityClass: 'uint32',
  SchedulingClass: 'uint32',
});
const EXTENDED_LIMIT_INFORMATION = koffi.struct({
  BasicLimitInformation: BASIC_LIMIT_INFORMATION,
  IoInfo: IO_COUNTERS,
  ProcessMemoryLimit: 'size_t',
  JobMemoryLimit: 'size_t',
  PeakProcessMemoryUsed: 'size_t',
  PeakJobMemoryUsed: 'size_t',
});

export function extendedLimitInfoSize(): number {
  return koffi.sizeof(EXTENDED_LIMIT_INFORMATION);
}

let api: ReturnType<typeof loadKernel32> | undefined;

function loadKernel32() {
  const lib = koffi.load('kernel32.dll');
  return {
    CreateJobObjectW: lib.func('void *CreateJobObjectW(void *attributes, const char16_t *name)'),
    OpenProcess: lib.func('void *OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    AssignProcessToJobObject: lib.func('int AssignProcessToJobObject(void *job, void *process)'),
    TerminateJobObject: lib.func('int TerminateJobObject(void *job, uint32_t exitCode)'),
    IsProcessInJob: lib.func('int IsProcessInJob(void *process, void *job, _Out_ int *result)'),
    SetInformationJobObject: lib.func('SetInformationJobObject', 'int', [
      'void *',
      'int',
      koffi.pointer(EXTENDED_LIMIT_INFORMATION),
      'uint32_t',
    ]),
    CloseHandle: lib.func('int CloseHandle(void *handle)'),
    GetLastError: lib.func('uint32_t GetLastError()'),
  };
}

function kernel32() {
  api ??= loadKernel32();
  return api;
}

function win32Error(call: string): Error {
  return new Error(`${call} failed (Win32 error ${kernel32().GetLastError()})`);
}

function withProcess<T>(pid: number, access: number, use: (process: unknown) => T): T {
  const { OpenProcess, CloseHandle } = kernel32();
  const process: unknown = OpenProcess(access, 0, pid);
  if (!process) throw win32Error(`OpenProcess(${pid})`);
  try {
    return use(process);
  } finally {
    CloseHandle(process);
  }
}

export function createProcessJob(options: { killOnClose: boolean }): ProcessJob {
  const k = kernel32();
  const handle: unknown = k.CreateJobObjectW(null, null);
  if (!handle) throw win32Error('CreateJobObjectW');
  if (options.killOnClose) {
    const info = { BasicLimitInformation: { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } };
    if (!k.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, info, extendedLimitInfoSize())) {
      const error = win32Error('SetInformationJobObject');
      k.CloseHandle(handle);
      throw error;
    }
  }

  let open = true;
  const live = (): unknown => {
    if (!open) throw new Error('job is closed');
    return handle;
  };

  return {
    assign(pid) {
      withProcess(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE, (process) => {
        if (!k.AssignProcessToJobObject(live(), process)) throw win32Error('AssignProcessToJobObject');
      });
    },
    isMember(pid) {
      return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, (process) => {
        const result = [0];
        if (!k.IsProcessInJob(process, live(), result)) throw win32Error('IsProcessInJob');
        return result[0] !== 0;
      });
    },
    terminate(exitCode) {
      if (!k.TerminateJobObject(live(), exitCode)) throw win32Error('TerminateJobObject');
    },
    close() {
      if (!open) return;
      open = false;
      k.CloseHandle(handle);
    },
  };
}
