"""Regression checks for the Feishu long-connection launcher."""

import ast
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "飞书长连接启动" / "飞书长连接启动.py"


def test_launcher_uses_websocket_client_and_starts_it():
    tree = ast.parse(SCRIPT_PATH.read_text(encoding="utf-8"))
    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)]

    assert any(
        isinstance(call.func, ast.Attribute)
        and call.func.attr == "Client"
        and isinstance(call.func.value, ast.Attribute)
        and call.func.value.attr == "ws"
        for call in calls
    ), "launcher must create lark.ws.Client"
    assert any(
        isinstance(call.func, ast.Attribute) and call.func.attr == "start"
        for call in calls
    ), "launcher must call the WebSocket client's start()"


def test_launcher_reads_feishu_credentials_from_environment():
    tree = ast.parse(SCRIPT_PATH.read_text(encoding="utf-8"))
    main = next(
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "main"
    )
    assignments = {
        node.targets[0].id: node.value
        for node in main.body
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
    }

    for variable, environment_name in {
        "app_id": "FEISHU_APP_ID",
        "app_secret": "FEISHU_APP_SECRET",
    }.items():
        value = assignments[variable]
        assert isinstance(value, ast.Call)
        assert isinstance(value.func, ast.Name)
        assert value.func.id == "get_required_env"
        assert isinstance(value.args[0], ast.Constant)
        assert value.args[0].value == environment_name
