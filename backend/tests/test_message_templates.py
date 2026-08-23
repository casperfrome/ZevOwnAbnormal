import pytest


def _templates():
    from app import message_templates

    return message_templates


def test_private_template_renders_dataset_values_links_and_literal_braces_safely():
    """Removing Markdown escaping or brace handling must make this test fail."""
    templates = _templates()
    template = (
        "异常记录：{车牌号}\n"
        "冻库温度：{frozen_temperature} ℃\n"
        "字面量：{{阈值}}\n"
        "[查看明细]({异常记录链接})\n"
        "[处置手册](https://docs.example/runbook)"
    )

    rendered = templates.render_private_markdown(
        template,
        {"车牌号": "皖A[危险](https://evil.example)", "frozen_temperature": -8.5},
        "https://sentinel.example/#records/record-1",
    )

    assert rendered == (
        "异常记录：皖A\\[危险\\]\\(https://evil.example\\)\n"
        "冻库温度：-8.5 ℃\n"
        "字面量：{阈值}\n"
        "[查看明细](https://sentinel.example/#records/record-1)\n"
        "[处置手册](https://docs.example/runbook)"
    )


def test_group_template_aggregates_each_chunk_in_first_seen_order_and_builds_post_nodes():
    """Sorting, retaining duplicates, or aggregating outside the chunk must fail."""
    templates = _templates()
    template = (
        "异常记录组：{车牌号列表}\n"
        "[查看记录组]({异常记录组链接}) · [值班手册](https://docs.example/on-call)"
    )

    lines = templates.render_group_post_lines(
        template,
        [
            {"车牌号": "皖A001"},
            {"车牌号": "皖A002"},
            {"车牌号": "皖A001"},
            {"车牌号": None},
        ],
        "https://sentinel.example/#anomaly-groups/run-1",
    )

    assert lines == [
        [{"tag": "text", "text": "异常记录组：皖A001、皖A002"}],
        [
            {
                "tag": "a",
                "text": "查看记录组",
                "href": "https://sentinel.example/#anomaly-groups/run-1",
            },
            {"tag": "text", "text": " · "},
            {
                "tag": "a",
                "text": "值班手册",
                "href": "https://docs.example/on-call",
            },
        ],
    ]


def test_group_template_keeps_escaped_braces_before_a_link_without_corrupting_node_offsets():
    """Parsing link offsets from a brace-masked string must not slice the original line incorrectly."""
    templates = _templates()

    lines = templates.render_group_post_lines(
        "{{说明}} [查看记录组]({异常记录组链接})",
        [],
        "https://sentinel.example/#anomaly-groups/run-1",
        {"车牌号"},
    )

    assert lines == [[
        {"tag": "text", "text": "{说明} "},
        {
            "tag": "a",
            "text": "查看记录组",
            "href": "https://sentinel.example/#anomaly-groups/run-1",
        },
    ]]


@pytest.mark.parametrize(
    ("template", "context", "message"),
    [
        ("{missing}", "private", "模板参数不存在"),
        ("{车牌号}", "group", "群聊模板仅支持字段列表参数"),
        ("{车牌号列表}", "private", "私聊模板不支持字段列表参数"),
        ("{异常记录组链接}", "private", "私聊模板不支持异常记录组链接"),
        ("{异常记录链接}", "group", "群聊模板不支持异常记录链接"),
        ("[不安全](http://example.com)", "private", "自定义链接必须使用 HTTPS"),
        ("[错误目标]({车牌号})", "private", "超链接目标仅支持系统深链"),
        ("[缺少右括号](https://example.com", "private", "超链接格式不完整"),
    ],
)
def test_template_validation_rejects_unknown_or_context_incompatible_content(
    template, context, message,
):
    """Weakening validation for any unsafe or ambiguous syntax must fail."""
    templates = _templates()

    with pytest.raises(templates.MessageTemplateError, match=message):
        templates.validate_message_template(template, {"车牌号"}, context)


def test_template_validation_accepts_manual_parameters_and_escaped_braces():
    templates = _templates()

    templates.validate_message_template(
        "{{说明}} {车牌号}\n[查看]({异常记录链接})",
        {"车牌号"},
        "private",
    )
