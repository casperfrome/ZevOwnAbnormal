from app.security import CredentialCipher
from app.sql_guard import SqlValidationError, validate_readonly_sql


def test_credential_cipher_round_trip_hides_plaintext():
    cipher = CredentialCipher("y4R9V3fBMN_WBq6j7u5oA-rOQ1z3B1l1J1dQxQ8_s8Y=")
    encrypted = cipher.encrypt("db-secret")

    assert encrypted != "db-secret"
    assert cipher.decrypt(encrypted) == "db-secret"


def test_sql_guard_accepts_select_and_cte():
    validate_readonly_sql("SELECT store_id, gmv FROM ads_store_daily_operation")
    validate_readonly_sql("WITH daily AS (SELECT 1 AS n) SELECT n FROM daily")


def test_sql_guard_rejects_mutation_and_multiple_statements():
    for sql in (
        "DELETE FROM orders",
        "SELECT 1; DROP TABLE orders",
        "INSERT INTO audit_log VALUES (1)",
        "SELECT 1 INTO audit_copy",
    ):
        try:
            validate_readonly_sql(sql)
        except SqlValidationError:
            pass
        else:
            raise AssertionError(f"unsafe SQL was accepted: {sql}")
