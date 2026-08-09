from app.query_service import execute_readonly_query


class FakeCursor:
    description = (("store_id", 253), ("gmv", 246))

    def __init__(self):
        self.executed = None

    def execute(self, sql, params):
        self.executed = (sql, params)

    def fetchall(self):
        return [{"store_id": "S001", "gmv": 123.45}]

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class FakeConnection:
    def __init__(self):
        self.cursor_instance = FakeCursor()

    def cursor(self):
        return self.cursor_instance

    def close(self):
        pass


def test_execute_query_wraps_preview_limit_and_returns_real_metadata():
    connection = FakeConnection()

    result = execute_readonly_query(connection, "SELECT store_id, gmv FROM ads", limit=200)

    sql, params = connection.cursor_instance.executed
    assert "sentinel_preview" in sql
    assert params == (200,)
    assert result["rows"] == [{"store_id": "S001", "gmv": 123.45}]
    assert result["fields"] == [
        {"name": "store_id", "type": "VARCHAR"},
        {"name": "gmv", "type": "DECIMAL"},
    ]
