"""One local entrypoint for migrations, the API and optional Feishu callbacks."""

from __future__ import annotations

import argparse
from copy import deepcopy
import os
from pathlib import Path
import socket
import sys
import time

import httpx
import uvicorn

from scripts.runtime_support import ProcessLock, install_break_handler
from scripts.service_process import spawn


ROOT = Path(__file__).resolve().parents[2]

# Executed in the spawned Uvicorn worker too, so the entire Windows group
# handles targeted CTRL_BREAK as a graceful Ctrl+C instead of abrupt exit.
install_break_handler()


def report(message: str) -> None:
    print(f'[ZevOwnAbnormal] {message}', flush=True)


def check_port(port: int = 8000) -> None:
    with socket.socket() as probe:
        if os.name == 'nt':
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            probe.bind(('0.0.0.0', port))
        except OSError:
            raise RuntimeError('port_in_use') from None


def run_migrations(root: Path, env: dict[str, str]) -> int:
    report('正在执行数据库迁移')
    migration = spawn([sys.executable, '-m', 'alembic', '-c', 'alembic.ini', 'upgrade', 'head'],
                      cwd=root / 'backend', env=env)
    try:
        while migration.poll() is None:
            time.sleep(0.2)
        return migration.poll()
    finally:
        migration.stop()


def wait_ready(api, timeout: float = 60) -> None:
    deadline = time.monotonic() + timeout
    while True:
        if api.poll() is not None:
            raise RuntimeError('backend_exited')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('health_timeout')
        if backend_healthy(timeout=min(2, remaining)):
            return
        time.sleep(min(0.2, max(0, deadline - time.monotonic())))


def backend_healthy(*, timeout: float = 2) -> bool:
    try:
        response = httpx.get('http://127.0.0.1:8000/api/v1/health', timeout=timeout, trust_env=False)
        return response.status_code == 200 and response.json().get('status') == 'ok'
    except (httpx.HTTPError, ValueError, AttributeError):
        return False


def run_services(root: Path = ROOT) -> int:
    lock = ProcessLock(root / 'tmp' / 'sentinel-start.lock')
    owned = []
    try:
        if not lock.acquire():
            report('启动管理器已运行，请使用原终端；未启动重复实例')
            return 1
        check_port()
        env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
        code = run_migrations(root, env)
        if code:
            report(f'数据库迁移失败，停止启动 exit_code={code}')
            return code
        api = spawn([sys.executable, '-u', '-m', 'scripts.start_services', '--serve'],
                    cwd=root / 'backend', env=env)
        owned.append(api)
        wait_ready(api)
        report('后端已就绪： http://127.0.0.1:8000')
        feishu = None
        try:
            feishu = spawn([sys.executable, '-u', str(root / '飞书长连接启动' / '飞书长连接启动.py'), '--optional'],
                           cwd=root, env=env)
            owned.append(feishu)
        except OSError as exc:
            report(f'飞书进程启动失败，后端继续运行 error_type={type(exc).__name__}')
        next_health_check = time.monotonic() + 5
        unhealthy_since = None
        while api.poll() is None:
            if feishu is not None and feishu.poll() is not None:
                code = feishu.poll()
                if code == 20:
                    report('已有独立飞书实例，本次不接管、不停止该实例')
                elif code:
                    report(f'飞书回调离线，后端继续运行 feishu_exited exit_code={code}')
                feishu = None
            now = time.monotonic()
            if now >= next_health_check:
                next_health_check = now + 5
                if backend_healthy():
                    if unhealthy_since is not None:
                        report('后端健康检查恢复正常')
                    unhealthy_since = None
                elif unhealthy_since is None:
                    unhealthy_since = now
                    report('后端暂未响应，等待热重载恢复（最多 60 秒）')
                elif now - unhealthy_since >= 60:
                    raise RuntimeError('backend_unhealthy')
            time.sleep(0.2)
        code = api.poll()
        if code:
            report(f'后端进程退出 exit_code={code}')
        return code
    except KeyboardInterrupt:
        report('正在停止本次启动的服务')
        return 0
    except (OSError, RuntimeError) as exc:
        reason = str(exc) if str(exc) in ('port_in_use', 'health_timeout', 'backend_exited', 'backend_unhealthy') else type(exc).__name__
        report(f'启动失败 reason={reason}；请检查端口、配置及上方后端日志')
        return 1
    finally:
        for child in reversed(owned):
            try:
                child.stop()
            except (OSError, subprocess.TimeoutExpired) as exc:
                report(f'子进程清理失败 error_type={type(exc).__name__}')
        lock.close()


def serve() -> None:
    config = deepcopy(uvicorn.config.LOGGING_CONFIG)
    config['filters'] = {'browser_address': {'()': 'scripts.runtime_support.BrowserAddressFilter'}}
    config['handlers']['default']['filters'] = ['browser_address']
    uvicorn.run('app.main:app', host='0.0.0.0', port=8000, reload=True, log_config=config)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.serve:
        serve()
    else:
        sys.exit(run_services())
