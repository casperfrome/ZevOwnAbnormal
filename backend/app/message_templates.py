from __future__ import annotations

import re
from typing import Iterable, Literal
from urllib.parse import urlparse


TemplateContext = Literal["private", "group"]

_OPEN_BRACE = "\ue000\ue000"
_CLOSE_BRACE = "\ue001\ue001"
_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")
_LINK = re.compile(r"\[([^\]\r\n]+)\]\((\{[^{}]+\}|[^)\r\n]+)\)")
_MARKDOWN_SPECIAL = re.compile(r"([\\`*_{}\[\]()<>#+!|])")


class MessageTemplateError(ValueError):
    pass


def _mask_literal_braces(value: str) -> str:
    return value.replace("{{", _OPEN_BRACE).replace("}}", _CLOSE_BRACE)


def _restore_literal_braces(value: str) -> str:
    return value.replace(_OPEN_BRACE, "{").replace(_CLOSE_BRACE, "}")


def _valid_https_url(value: str) -> bool:
    parsed = urlparse(value)
    return (
        parsed.scheme == "https"
        and bool(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
        and not any(character.isspace() for character in value)
    )


def _validate_placeholder(name: str, field_names: set[str], context: TemplateContext) -> None:
    if name == "异常记录链接":
        if context != "private":
            raise MessageTemplateError("群聊模板不支持异常记录链接")
        return
    if name == "异常记录组链接":
        if context != "group":
            raise MessageTemplateError("私聊模板不支持异常记录组链接")
        return
    if name.endswith("列表"):
        if context != "group":
            raise MessageTemplateError("私聊模板不支持字段列表参数")
        field_name = name[:-2]
        if field_name not in field_names:
            raise MessageTemplateError(f"模板参数不存在：{name}")
        return
    if context == "group" and name in field_names:
        raise MessageTemplateError("群聊模板仅支持字段列表参数")
    if name not in field_names:
        raise MessageTemplateError(f"模板参数不存在：{name}")


def validate_message_template(
    template: str,
    field_names: Iterable[str],
    context: TemplateContext,
) -> None:
    if context not in {"private", "group"}:
        raise MessageTemplateError("模板上下文无效")
    if not isinstance(template, str) or not template.strip():
        raise MessageTemplateError("推送内容不能为空")

    masked = _mask_literal_braces(template)
    links = list(_LINK.finditer(masked))
    link_starts = {match.start() for match in links}
    for marker in re.finditer(r"\[[^\]\r\n]+\]\(", masked):
        if marker.start() not in link_starts:
            raise MessageTemplateError("超链接格式不完整")
    for link in links:
        target = link.group(2)
        if target.startswith("{"):
            target_name = target[1:-1]
            _validate_placeholder(target_name, set(field_names), context)
            expected_target = "异常记录链接" if context == "private" else "异常记录组链接"
            if target_name != expected_target:
                raise MessageTemplateError("超链接目标仅支持系统深链参数")
        elif not _valid_https_url(target):
            raise MessageTemplateError("自定义链接必须使用 HTTPS")

    fields = set(field_names)
    for match in _PLACEHOLDER.finditer(masked):
        _validate_placeholder(match.group(1), fields, context)
    remainder = _PLACEHOLDER.sub("", masked)
    if "{" in remainder or "}" in remainder:
        raise MessageTemplateError("模板参数花括号不完整")


def _escape_markdown_value(value: object) -> str:
    normalized = "" if value is None else str(value)
    return _MARKDOWN_SPECIAL.sub(r"\\\1", normalized)


def _replace_private_placeholders(text: str, row: dict, record_url: str) -> str:
    masked = _mask_literal_braces(text)

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name == "异常记录链接":
            return record_url
        return _escape_markdown_value(row.get(name))

    return _restore_literal_braces(_PLACEHOLDER.sub(replace, masked))


def render_private_markdown(template: str, row: dict, record_url: str) -> str:
    validate_message_template(template, row.keys(), "private")
    return _replace_private_placeholders(template, row, record_url)


def _group_values(records: list[dict], field_name: str) -> str:
    values: list[str] = []
    seen: set[str] = set()
    for record in records:
        raw_value = record.get(field_name)
        value = "" if raw_value is None else str(raw_value).strip()
        if value and value not in seen:
            values.append(value)
            seen.add(value)
    return "、".join(values)


def _replace_group_placeholders(text: str, records: list[dict], group_url: str) -> str:
    masked = _mask_literal_braces(text)

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name == "异常记录组链接":
            return group_url
        return _group_values(records, name[:-2])

    return _restore_literal_braces(_PLACEHOLDER.sub(replace, masked))


def _group_line_nodes(line: str, records: list[dict], group_url: str) -> list[dict[str, str]]:
    nodes: list[dict[str, str]] = []
    cursor = 0
    for link in _LINK.finditer(_mask_literal_braces(line)):
        prefix = line[cursor:link.start()]
        if prefix:
            nodes.append({"tag": "text", "text": _replace_group_placeholders(prefix, records, group_url)})
        target = link.group(2)
        href = group_url if target == "{异常记录组链接}" else target
        nodes.append({
            "tag": "a",
            "text": _restore_literal_braces(link.group(1)),
            "href": href,
        })
        cursor = link.end()
    suffix = line[cursor:]
    if suffix or not nodes:
        nodes.append({"tag": "text", "text": _replace_group_placeholders(suffix, records, group_url)})
    return nodes


def render_group_post_lines(
    template: str,
    records: list[dict],
    group_url: str,
    field_names: Iterable[str] | None = None,
) -> list[list[dict[str, str]]]:
    available_fields = (
        set(field_names)
        if field_names is not None
        else {str(key) for record in records for key in record}
    )
    validate_message_template(template, available_fields, "group")
    return [_group_line_nodes(line, records, group_url) for line in template.splitlines()]
