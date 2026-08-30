import subprocess
import sys
import logging
import socket
from pathlib import Path

import pytest

from scripts import bootstrap_env


def test_seed_platform_can_be_loaded_from_backend_directory():
    backend = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-I", "-c", f"import runpy; runpy.run_path(r'{backend / 'scripts' / 'seed_platform.py'}', run_name='not_main')"],
        cwd=backend,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_reconcile_schedules_can_be_loaded_from_backend_directory():
    backend = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-I", "-c", f"import runpy; runpy.run_path(r'{backend / 'scripts' / 'reconcile_schedules.py'}', run_name='not_main')"],
        cwd=backend,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_bootstrap_env_writes_all_runtime_settings_without_printing_secrets(tmp_path, monkeypatch, capsys):
    credential_file = tmp_path / "credentials.txt"
    credential_file.write_text("App ID: cli_test_app\nApp Secret: test-secret-value\n", encoding="utf-8")
    env_file = tmp_path / ".env"
    monkeypatch.setattr(bootstrap_env, "CREDENTIAL_FILE", credential_file)
    monkeypatch.setattr(bootstrap_env, "ENV_FILE", env_file)

    bootstrap_env.main()

    values = dict(
        line.split("=", 1)
        for line in env_file.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    )
    assert values["AUTO_LOGIN"] == "false"
    assert values["SENTINEL_PUBLIC_BASE_URL"] == "http://localhost:8000"
    assert values["SENTINEL_API_BASE_URL"] == "http://127.0.0.1:8000"
    assert values["SENTINEL_INTERNAL_TOKEN"]
    assert values["INTERNAL_EXECUTION_TOKEN"] == values["SENTINEL_INTERNAL_TOKEN"]
    assert values["VALIDATION_TIMEOUT_SCAN_INTERVAL_SECONDS"] == "60"
    assert values["VALIDATION_MAINTENANCE_BATCH_SIZE"] == "50"
    assert values["FEISHU_HTTP_TIMEOUT_SECONDS"] == "10"
    assert values["FEISHU_APP_ID"] == "cli_test_app"
    assert values["FEISHU_APP_SECRET"] == "test-secret-value"
    output = capsys.readouterr().out
    assert "test-secret-value" not in output
    assert values["SENTINEL_INTERNAL_TOKEN"] not in output


def test_backend_utc_modules_load_on_python_310():
    backend = Path(__file__).resolve().parents[1]
    migration = backend / "alembic" / "versions" / "20260822_0006_anomaly_push_pipeline.py"
    commands = [
        "from app.models import utcnow; assert utcnow().tzinfo is None",
        f"import runpy; runpy.run_path(r'{migration}', run_name='not_main')",
    ]

    for command in commands:
        result = subprocess.run(
            [sys.executable, "-c", command],
            cwd=backend,
            capture_output=True,
            text=True,
        )

        assert result.returncode == 0, result.stderr


def test_startup_address_filter_changes_only_browser_url_and_preserves_color():
    from scripts.runtime_support import BrowserAddressFilter
    from uvicorn.logging import DefaultFormatter

    record = logging.LogRecord('uvicorn.error', logging.INFO, '', 0,
                               'Uvicorn running on %s://%s:%d (Press CTRL+C to quit)',
                               ('http', '0.0.0.0', 8000), None)
    record.color_message = 'Uvicorn running on \x1b[1m%s://%s:%d\x1b[0m (Press CTRL+C to quit)'
    BrowserAddressFilter().filter(record)
    for color in (True, False):
        rendered = DefaultFormatter('%(message)s', use_colors=color).format(record)
        assert 'http://127.0.0.1:8000' in rendered
        assert '0.0.0.0' not in rendered
    other = logging.makeLogRecord({'msg': 'Cannot bind 0.0.0.0:8000', 'args': ()})
    BrowserAddressFilter().filter(other)
    assert other.getMessage() == 'Cannot bind 0.0.0.0:8000'


def test_runtime_lock_excludes_second_process_and_releases(tmp_path):
    from scripts.runtime_support import ProcessLock

    path = tmp_path / 'service.lock'
    code = ('from pathlib import Path; from scripts.runtime_support import ProcessLock; '
            f'lock=ProcessLock(Path({str(path)!r})); '
            'ok=lock.acquire(); print(ok); lock.close()')
    lock = ProcessLock(path)
    assert lock.acquire()
    try:
        result = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).parents[1],
                                capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == 'False'
    finally:
        lock.close()
    assert lock.acquire()
    lock.close()


def test_port_check_rejects_existing_listener():
    from scripts.start_services import check_port

    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        with pytest.raises(RuntimeError, match='port_in_use'):
            check_port(listener.getsockname()[1])


def test_frontend_build_runs_when_dependencies_exist(tmp_path, monkeypatch):
    from scripts import start_services as runtime
    frontend = tmp_path / 'frontend'
    (frontend / 'node_modules').mkdir(parents=True)
    (frontend / 'package.json').write_text('{}', encoding='utf-8')
    calls = []
    monkeypatch.setattr(runtime.subprocess, 'run', lambda command, **options: calls.append((command, options)) or type('Result', (), {'returncode': 0})())

    assert runtime.build_frontend(tmp_path) == 0
    expected_npm = 'npm.cmd' if runtime.os.name == 'nt' else 'npm'
    assert calls[0][0] == [expected_npm, 'run', 'build']
    assert calls[0][1]['cwd'] == frontend


def test_frontend_build_explains_npm_ci_when_dependencies_are_missing(tmp_path, capsys):
    from scripts import start_services as runtime
    frontend = tmp_path / 'frontend'
    frontend.mkdir()
    (frontend / 'package.json').write_text('{}', encoding='utf-8')

    assert runtime.build_frontend(tmp_path) != 0
    assert 'npm ci' in capsys.readouterr().out


@pytest.fixture
def service_runtime(monkeypatch, tmp_path):
    from scripts import start_services as runtime
    events = []

    class Child:
        def __init__(self, role):
            self.role = role
            self.returncode = None

        def poll(self):
            return self.returncode

        def stop(self):
            events.append('stop:' + self.role)

    children = {}

    def spawn(command, **kwargs):
        role = 'api' if '--serve' in command else 'feishu'
        events.append('start:' + role)
        children[role] = Child(role)
        return children[role]

    monkeypatch.setattr(runtime, 'spawn', spawn)
    monkeypatch.setattr(runtime, 'check_port', lambda *a: events.append('port'))
    monkeypatch.setattr(runtime, 'build_frontend', lambda *a: events.append('build') or 0)
    monkeypatch.setattr(runtime, 'run_migrations', lambda *a: events.append('migrate') or 0)
    monkeypatch.setattr(runtime, 'wait_ready', lambda *a, **kw: events.append('healthy'))
    monkeypatch.setattr(runtime.time, 'sleep', lambda _: setattr(children['api'], 'returncode', 0))
    return runtime, events, children, tmp_path


def test_unified_start_orders_readiness_before_feishu_and_cleans_owned_children(service_runtime):
    runtime, events, _, root = service_runtime
    assert runtime.run_services(root) == 0
    assert events == ['port', 'build', 'migrate', 'start:api', 'healthy', 'start:feishu',
                      'stop:feishu', 'stop:api']


def test_migration_failure_starts_no_services(service_runtime, monkeypatch):
    runtime, events, _, root = service_runtime
    monkeypatch.setattr(runtime, 'run_migrations', lambda *a: 7)
    assert runtime.run_services(root) == 7
    assert events == ['port', 'build']


def test_unhealthy_backend_is_stopped_without_starting_feishu(service_runtime, monkeypatch):
    runtime, events, _, root = service_runtime

    def unhealthy(*args, **kwargs):
        raise RuntimeError('health_timeout')

    monkeypatch.setattr(runtime, 'wait_ready', unhealthy)
    assert runtime.run_services(root) != 0
    assert events == ['port', 'build', 'migrate', 'start:api', 'stop:api']


def test_feishu_exit_warns_once_without_stopping_or_restarting_backend(service_runtime, monkeypatch, capsys):
    runtime, events, children, root = service_runtime
    ticks = []

    def tick(_):
        ticks.append(1)
        children['feishu'].returncode = 1
        if len(ticks) == 3:
            children['api'].returncode = 0

    monkeypatch.setattr(runtime.time, 'sleep', tick)
    assert runtime.run_services(root) == 0
    assert len(ticks) == 3
    assert events.count('start:feishu') == 1
    assert capsys.readouterr().out.count('feishu_exited') == 1


def test_duplicate_manager_starts_nothing(service_runtime):
    from scripts.runtime_support import ProcessLock
    runtime, events, _, root = service_runtime
    lock = ProcessLock(root / 'tmp' / 'sentinel-start.lock')
    assert lock.acquire()
    try:
        assert runtime.run_services(root) != 0
        assert not events
    finally:
        lock.close()


def test_wait_ready_times_out_and_checks_backend_exit(monkeypatch):
    from scripts import start_services as runtime
    import httpx
    from types import SimpleNamespace

    monkeypatch.setattr(runtime.httpx, 'get', lambda *a, **kw: httpx.Response(503))
    with pytest.raises(RuntimeError, match='health_timeout'):
        runtime.wait_ready(SimpleNamespace(poll=lambda: None), timeout=0)
    with pytest.raises(RuntimeError, match='backend_exited'):
        runtime.wait_ready(SimpleNamespace(poll=lambda: 2), timeout=1)


def test_serve_keeps_public_binding_and_reload(monkeypatch):
    from scripts import start_services as runtime
    calls = []
    monkeypatch.setattr(runtime.uvicorn, 'run', lambda *a, **kw: calls.append((a, kw)))
    runtime.serve()
    args, options = calls[0]
    assert args == ('app.main:app',)
    assert options['host'] == '0.0.0.0'
    assert options['port'] == 8000
    assert options['reload'] is True
    assert 'filters' in options['log_config']


def test_ctrl_c_cleans_all_owned_children(service_runtime, monkeypatch):
    runtime, events, _, root = service_runtime

    def interrupt(_):
        raise KeyboardInterrupt

    monkeypatch.setattr(runtime.time, 'sleep', interrupt)
    assert runtime.run_services(root) == 0
    assert events[-2:] == ['stop:feishu', 'stop:api']


def test_feishu_spawn_failure_does_not_stop_backend(service_runtime, monkeypatch, capsys):
    runtime, events, children, root = service_runtime
    original_spawn = runtime.spawn

    def spawn(command, **kwargs):
        if '--serve' not in command:
            raise OSError('secret must not appear')
        return original_spawn(command, **kwargs)

    monkeypatch.setattr(runtime, 'spawn', spawn)
    assert runtime.run_services(root) == 0
    assert children['api'].returncode == 0
    output = capsys.readouterr().out
    assert '后端继续运行' in output
    assert 'secret must not appear' not in output


def test_owned_process_shutdown_is_graceful_and_leaves_unrelated_process(tmp_path):
    import os
    import time
    from scripts.service_process import spawn
    marker = tmp_path / 'ready'
    stopped = tmp_path / 'stopped'
    code = (
        'from pathlib import Path; import time; '
        'from scripts.runtime_support import install_break_handler; install_break_handler(); '
        f'Path({str(marker)!r}).touch()\n'
        'try:\n    while True: time.sleep(.1)\n'
        f'except KeyboardInterrupt:\n    Path({str(stopped)!r}).touch()\n'
    )
    cwd = Path(__file__).parents[1]
    unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    owned = spawn([sys.executable, '-c', code], cwd=cwd, env=os.environ.copy())
    try:
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.05)
        assert marker.exists()
        owned.stop()
        assert stopped.exists(), 'shutdown must deliver a graceful interrupt'
        assert owned.poll() == 0
        assert unrelated.poll() is None
    finally:
        if owned.poll() is None:
            owned.stop()
        unrelated.terminate()
        unrelated.wait(timeout=5)


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows Job Object descendant ownership')
def test_job_cleans_descendant_after_parent_has_already_exited(tmp_path):
    import os
    import time
    from scripts.runtime_support import ProcessLock
    from scripts.service_process import spawn
    marker = tmp_path / 'child-ready'
    stopped = tmp_path / 'child-stopped'
    lock_path = tmp_path / 'descendant.lock'
    child_code = (
        'from pathlib import Path; import time; from scripts.runtime_support import ProcessLock, install_break_handler; '
        'install_break_handler(); '
        f'lock=ProcessLock(Path({str(lock_path)!r})); assert lock.acquire(); '
        f'Path({str(marker)!r}).touch()\n'
        'try:\n    while True: time.sleep(.1)\n'
        f'except KeyboardInterrupt:\n    Path({str(stopped)!r}).touch()\n'
    )
    parent_code = (
        'import subprocess, sys, time; from pathlib import Path; '
        f'subprocess.Popen([sys.executable, "-c", {child_code!r}]); '
        f'marker=Path({str(marker)!r})\n'
        'while not marker.exists(): time.sleep(.05)\n'
    )
    owned = spawn([sys.executable, '-c', parent_code], cwd=Path(__file__).parents[1], env=os.environ.copy())
    probe = ProcessLock(lock_path)
    try:
        deadline = time.monotonic() + 10
        while owned.poll() is None and time.monotonic() < deadline:
            time.sleep(.05)
        assert owned.poll() == 0
        assert not probe.acquire(), 'descendant should still hold its lock'
        owned.stop()
        assert stopped.exists(), 'orphaned descendants must receive a graceful interrupt too'
        deadline = time.monotonic() + 5
        while not probe.acquire() and time.monotonic() < deadline:
            time.sleep(.05)
        assert probe._file is not None, 'job close must release descendant resources'
    finally:
        owned.stop()
        probe.close()


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows console control-event isolation')
def test_child_reload_ctrl_c_does_not_interrupt_service_manager():
    # Run the broadcast experiment in its own hidden console so a regression
    # cannot interrupt pytest or the developer's interactive console.
    child = ('import os, signal, time; '
             'signal.signal(signal.SIGINT, lambda *_: None); '
             'os.kill(0, signal.CTRL_C_EVENT); time.sleep(.2)')
    harness = (
        'import os, sys, signal, time; from scripts.service_process import spawn; '
        'received=[]; signal.signal(signal.SIGINT, lambda *_: received.append(True)); '
        f'child=spawn([sys.executable,"-c",{child!r}],cwd=os.getcwd(),env=os.environ.copy())\n'
        'try:\n    child.process.wait(timeout=5); time.sleep(.2); print("interrupted="+str(bool(received)), flush=True)\n'
        'finally:\n    child.stop()\n'
    )
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0
    result = subprocess.run([sys.executable, '-c', harness], cwd=Path(__file__).parents[1],
                            creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=startup,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert 'interrupted=False' in result.stdout


def test_unresponsive_worker_stops_owned_services_after_reload_grace(service_runtime, monkeypatch):
    runtime, events, _, root = service_runtime
    clock = [0]
    monkeypatch.setattr(runtime.time, 'monotonic', lambda: clock[0])

    def tick(_):
        clock[0] += 5
        assert clock[0] <= 70, 'a live reloader must not hide a dead API worker'

    monkeypatch.setattr(runtime.time, 'sleep', tick)
    monkeypatch.setattr(runtime, 'backend_healthy', lambda **kw: False, raising=False)
    assert runtime.run_services(root) != 0
    assert clock[0] == 65
    assert events[-2:] == ['stop:feishu', 'stop:api']


@pytest.mark.skipif(sys.platform != 'win32', reason='Console handles differ from redirected pipes')
def test_hidden_child_logs_reach_real_parent_console():
    harness = '''
import ctypes, msvcrt, os, sys
from ctypes import wintypes as w
from scripts.service_process import spawn
class Coord(ctypes.Structure):
    _fields_ = [('x', ctypes.c_short), ('y', ctypes.c_short)]
original = sys.stdout
with open('CONOUT$', 'w', encoding='utf-8') as console:
    sys.stdout = console
    try:
        child = spawn([sys.executable, '-c', "print('CHILD_LOG_VISIBLE', flush=True)"], cwd=os.getcwd(), env=os.environ.copy())
        child.process.wait(timeout=5)
        child.stop()
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        read = kernel.ReadConsoleOutputCharacterW
        read.argtypes = [w.HANDLE, w.LPWSTR, w.DWORD, Coord, ctypes.POINTER(w.DWORD)]
        buffer, count = ctypes.create_unicode_buffer(4096), w.DWORD()
        assert read(msvcrt.get_osfhandle(console.fileno()), buffer, 4096, Coord(0,0), ctypes.byref(count))
        visible = 'CHILD_LOG_VISIBLE' in buffer.value
    finally:
        sys.stdout = original
print('visible=' + str(visible))
'''
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0
    result = subprocess.run([sys.executable, '-c', harness], cwd=Path(__file__).parents[1],
                            creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=startup,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert 'visible=True' in result.stdout


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows owned-only shutdown escalation')
def test_shutdown_escalates_after_grace_and_rejects_unrelated_pid(tmp_path):
    import os
    import time
    from scripts.service_process import spawn
    marker = tmp_path / 'ready'
    code = ('import signal, time; from pathlib import Path; '
            'signal.signal(signal.SIGBREAK, lambda *_: None); '
            f'Path({str(marker)!r}).touch(); time.sleep(30)')
    unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    owned = spawn([sys.executable, '-c', code], cwd=Path(__file__).parents[1], env=os.environ.copy())
    try:
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.05)
        assert marker.exists()
        with owned.job.pinned_member(unrelated.pid) as member:
            assert not member
        with owned.job.pinned_member(owned.process.pid) as member:
            assert member
        started = time.monotonic()
        owned.stop()
        assert time.monotonic() - started >= 10
        assert owned.poll() is not None
        assert unrelated.poll() is None
    finally:
        owned.stop()
        unrelated.terminate()
        unrelated.wait(timeout=5)
