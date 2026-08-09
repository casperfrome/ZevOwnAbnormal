from cryptography.fernet import Fernet


class CredentialCipher:
    def __init__(self, key: str):
        self._fernet = Fernet(key.encode("utf-8"))

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("utf-8")

    def decrypt(self, ciphertext: str) -> str:
        return self._fernet.decrypt(ciphertext.encode("utf-8")).decode("utf-8")
