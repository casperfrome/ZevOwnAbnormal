"""Own child process trees without killing unrelated Python processes."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path
import time
import threading
from contextlib import contextmanager


class WindowsJob:
    """A kill-on-close Job Object also owns descendants of an exited parent."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes as w

        class BasicLimits(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                        ('flags', w.DWORD), ('min_working_set', ctypes.c_size_t),
                        ('max_working_set', ctypes.c_size_t), ('active_limit', w.DWORD),
                        ('affinity', ctypes.c_size_t), ('priority', w.DWORD),
                        ('scheduling', w.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in
                        ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [('basic', BasicLimits), ('io', IoCounters),
                        ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                        ('peak_process_memory', ctypes.c_size_t), ('peak_job_memory', ctypes.c_size_t)]

        self._kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self._kernel.CreateJobObjectW.argtypes = [w.LPVOID, w.LPCWSTR]
        self._kernel.CreateJobObjectW.restype = w.HANDLE
        self._kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD]
        self._kernel.SetInformationJobObject.restype = w.BOOL
        self._kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self._kernel.AssignProcessToJobObject.restype = w.BOOL
        self._kernel.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, w.LPVOID]
        self._kernel.QueryInformationJobObject.restype = w.BOOL
        self._kernel.CloseHandle.argtypes = [w.HANDLE]
        self._kernel.CloseHandle.restype = w.BOOL
        self._kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        self._kernel.OpenProcess.restype = w.HANDLE
        self._kernel.IsProcessInJob.argtypes = [w.HANDLE, w.HANDLE, ctypes.POINTER(w.BOOL)]
        self._kernel.IsProcessInJob.restype = w.BOOL
        self.handle = self._kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.basic.flags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self._kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def assign(self, process: subprocess.Popen) -> None:
        import ctypes
        if not self._kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if self.handle:
            self._kernel.CloseHandle(self.handle)
            self.handle = None

    def process_ids(self) -> list[int]:
        import ctypes
        if not self.handle:
            return []
        capacity = 16
        while True:
            buffer = ctypes.create_string_buffer(8 + ctypes.sizeof(ctypes.c_size_t) * capacity)
            ok = self._kernel.QueryInformationJobObject(self.handle, 3, buffer, len(buffer), None)
            if ok:
                count = ctypes.c_uint32.from_buffer(buffer, 4).value
                return list((ctypes.c_size_t * count).from_buffer(buffer, 8))
            if ctypes.get_last_error() != 234:  # ERROR_MORE_DATA
                raise ctypes.WinError(ctypes.get_last_error())
            capacity = max(capacity * 2, ctypes.c_uint32.from_buffer(buffer).value)

    @contextmanager
    def pinned_member(self, pid: int):
        """Keep a verified job member's PID from being reused while signaling."""
        import ctypes
        from ctypes import wintypes as w
        handle = self._kernel.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        try:
            member = w.BOOL()
            yield bool(handle and self.handle and self._kernel.IsProcessInJob(
                handle, self.handle, ctypes.byref(member)) and member.value)
        finally:
            if handle:
                self._kernel.CloseHandle(handle)


def signal_console(pid: int) -> int:
    """Short-lived helper: signal only a child's isolated Windows console."""
    import ctypes
    from ctypes import wintypes as w
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    handler_type = ctypes.WINFUNCTYPE(w.BOOL, w.DWORD)
    kernel.AttachConsole.argtypes = [w.DWORD]
    kernel.AttachConsole.restype = w.BOOL
    kernel.SetConsoleCtrlHandler.argtypes = [handler_type, w.BOOL]
    kernel.SetConsoleCtrlHandler.restype = w.BOOL
    kernel.GenerateConsoleCtrlEvent.argtypes = [w.DWORD, w.DWORD]
    kernel.GenerateConsoleCtrlEvent.restype = w.BOOL
    kernel.FreeConsole()
    if not kernel.AttachConsole(pid):
        return 1
    # Attaching resets the handler table; protect this helper from its own
    # broadcast without changing signal handling in the service processes.
    handler = handler_type(lambda _: True)
    try:
        if not kernel.SetConsoleCtrlHandler(handler, True):
            return 1
        return 0 if kernel.GenerateConsoleCtrlEvent(1, 0) else 1
    finally:
        kernel.FreeConsole()


class OwnedProcess:
    def __init__(self, process: subprocess.Popen, job: WindowsJob | None = None):
        self.process = process
        self.job = job
        self.relay = None

    def poll(self):
        return self.process.poll()

    def stop(self) -> None:
        try:
            if self.job is not None:
                pids = self.job.process_ids()
                if pids:
                    for pid in pids:
                        with self.job.pinned_member(pid) as member:
                            if not member:
                                continue
                            result = subprocess.run(
                                [sys.executable, str(Path(__file__).resolve()), '--signal-console', str(pid)],
                                creationflags=subprocess.CREATE_NO_WINDOW, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
                            )
                            if result.returncode == 0:
                                break
                    deadline = time.monotonic() + 10
                    while self.job.process_ids() and time.monotonic() < deadline:
                        time.sleep(.05)
            elif self.poll() is None:
                try:
                    os.killpg(self.process.pid, signal.SIGINT)
                except (OSError, ProcessLookupError):
                    pass
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    if self.job is None:
                        os.killpg(self.process.pid, signal.SIGKILL)
        finally:
            if self.job is not None:
                self.job.close()
            elif os.name != 'nt':
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.process.wait(timeout=5)
            if self.relay is not None:
                self.relay.join(timeout=2)


def relay_output(stream, destination) -> None:
    # Console pseudohandles cannot be shared across Windows consoles. Pipes
    # also keep non-ASCII logs consistent in PowerShell and redirected runs.
    with stream:
        for line in stream:
            try:
                destination.write(line)
                destination.flush()
            except (OSError, ValueError):
                # Keep draining if the caller closes its display stream.
                pass


def spawn(command: list[str], *, cwd, env) -> OwnedProcess:
    job = WindowsJob() if os.name == 'nt' else None
    process = None
    try:
        startup = None
        if os.name == 'nt':
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 0
        process = subprocess.Popen(
            command, cwd=cwd, env=env,
            # Uvicorn reload broadcasts CTRL_C to its console on Windows.
            # Separate hidden consoles keep that signal away from the manager
            # and Feishu; pipes relay logs to the original console.
            creationflags=subprocess.CREATE_NEW_CONSOLE if os.name == 'nt' else 0,
            startupinfo=startup, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', bufsize=1,
            start_new_session=os.name != 'nt',
        )
        if job is not None:
            job.assign(process)
        owned = OwnedProcess(process, job)
        owned.relay = threading.Thread(target=relay_output, args=(process.stdout, sys.stdout), daemon=True)
        owned.relay.start()
        return owned
    except BaseException:
        if process is not None:
            process.kill()
            process.wait()
        if job is not None:
            job.close()
        raise


if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--signal-console':
    sys.exit(signal_console(int(sys.argv[2])))
