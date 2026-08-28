"""Small runtime primitives shared by the local service entrypoints."""

from __future__ import annotations

import errno
import logging
import os
from pathlib import Path
import re
import signal


class ProcessLock:
    """Hold an OS file lock; a stale file never implies a running process."""

    def __init__(self, path: Path):
        self.path = path
        self._file = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        stream = self.path.open('a+b')
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            stream.close()
            if exc.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                return False
            raise
        self._file = stream
        return True

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None


def install_break_handler() -> None:
    """Translate targeted Windows process-group shutdown to normal Ctrl+C."""
    if os.name == 'nt':
        signal.signal(signal.SIGBREAK, lambda *_: signal.raise_signal(signal.SIGINT))


class BrowserAddressFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if (record.name == 'uvicorn.error'
                and str(record.msg).startswith('Uvicorn running on %s://%s:%d')
                and isinstance(record.args, tuple) and len(record.args) == 3
                and record.args[1] == '0.0.0.0'):
            # The same args are also used by Uvicorn's color_message formatter.
            record.args = (record.args[0], '127.0.0.1', record.args[2])
        return True


class FeishuLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if message.startswith('disconnected to '):
            message = '飞书连接断开，等待 SDK 自动重连'
        elif message.startswith('connected to '):
            message = '飞书连接成功，卡片回调已在线'
        elif 'connect failed' in message:
            message = '飞书连接失败，请检查凭据、平台配置和网络；后端继续运行'
        else:
            message = re.sub(r'(?:https?|wss?)://\S+', '[连接地址已隐藏]', message)
            for name in ('FEISHU_APP_SECRET', 'SENTINEL_INTERNAL_TOKEN', 'INTERNAL_EXECUTION_TOKEN'):
                secret = os.environ.get(name, '').strip()
                if secret:
                    message = message.replace(secret, '[已隐藏]')
        record.msg, record.args = message, ()
        # SDK exception messages may contain authentication URLs or payloads.
        record.exc_info = record.exc_text = None
        return True
