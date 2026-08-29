from datetime import datetime, timedelta, timezone

import jwt
from cryptography.fernet import Fernet


def issue_session_token(
    user_id: str, is_superuser: bool, session_version: int, secret: str,
    now: datetime | None = None,
) -> str:
    issued_at = now or datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": user_id,
            "role": "superadmin" if is_superuser else "user",
            "session_version": session_version,
            "iat": issued_at,
            "exp": issued_at + timedelta(hours=24),
        },
        secret,
        algorithm="HS256",
    )


class CredentialCipher:
    def __init__(self, key: str):
        self._fernet = Fernet(key.encode("utf-8"))

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("utf-8")

    def decrypt(self, ciphertext: str) -> str:
        return self._fernet.decrypt(ciphertext.encode("utf-8")).decode("utf-8")
