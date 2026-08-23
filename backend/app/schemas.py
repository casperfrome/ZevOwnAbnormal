from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator, model_validator


DatasourceType = Literal["mysql", "starrocks"]


class DatasourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    type: DatasourceType
    host: str = Field(min_length=1)
    port: int = Field(gt=0, le=65535)
    database: str = Field(min_length=1)
    username: str = Field(min_length=1)
    password: str = ""
    ssl: bool = False
    description: str = ""


class DatasourceUpdate(BaseModel):
    name: str | None = None
    host: str | None = None
    port: int | None = Field(default=None, gt=0, le=65535)
    database: str | None = None
    username: str | None = None
    password: str | None = None
    ssl: bool | None = None
    description: str | None = None


class DatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    datasource_id: str
    sql: str = Field(min_length=1)
    description: str = ""


class DatasetUpdate(BaseModel):
    name: str | None = None
    datasource_id: str | None = None
    sql: str | None = None
    description: str | None = None


class Condition(BaseModel):
    field: str
    operator: Literal[
        "gt", "gte", "lt", "lte", "eq", "neq", "between", "is_null", "is_not_null",
        "gt_threshold_ratio", "lt_threshold_ratio",
    ]
    value: float | int | str | None = None
    upper_value: float | int | str | None = None
    baseline: Literal["7d_avg", "30d_avg", "prev_period"] | None = None

    @model_validator(mode="before")
    @classmethod
    def normalize_numeric_operands(cls, data):
        if not isinstance(data, dict):
            return data
        numeric_operators = {
            "gt", "gte", "lt", "lte", "between",
            "gt_threshold_ratio", "lt_threshold_ratio",
        }
        if data.get("operator") not in numeric_operators:
            return data
        normalized = dict(data)
        for name in ("value", "upper_value"):
            value = normalized.get(name)
            if isinstance(value, str) and value.strip():
                normalized[name] = float(value)
        return normalized

    @model_validator(mode="after")
    def validate_operands(self):
        if self.operator == "between" and (self.value is None or self.upper_value is None):
            raise ValueError("between 需要上下界")
        if self.operator.endswith("threshold_ratio") and (self.value is None or self.baseline is None):
            raise ValueError("基线操作符需要倍数和基线类型")
        return self


class NotificationTarget(BaseModel):
    receive_id_type: Literal["open_id", "union_id", "user_id", "email", "chat_id"]
    source: Literal["literal", "field"]
    value: str | None = None
    field: str | None = None

    @model_validator(mode="after")
    def validate_source(self):
        if self.source == "literal" and not self.value:
            raise ValueError("固定目标需要 value")
        if self.source == "field" and not self.field:
            raise ValueError("字段目标需要 field")
        return self


class ValidationTarget(BaseModel):
    source: Literal["literal", "field"]
    value: str | None = None
    field: str | None = None

    @field_validator("value", "field", mode="before")
    @classmethod
    def normalize_target_text(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def validate_source(self):
        if self.source == "literal" and not self.value:
            raise ValueError("固定验证目标需要 value")
        if self.source == "field" and not self.field:
            raise ValueError("字段验证目标需要 field")
        return self


class GroupBroadcastConfig(BaseModel):
    enabled: bool = False
    webhook_url: str | None = None
    mention_targets: list[ValidationTarget] = Field(default_factory=list)

    @field_validator("webhook_url", mode="before")
    @classmethod
    def normalize_webhook(cls, value):
        if not isinstance(value, str):
            return value
        normalized = value.strip()
        if not normalized:
            return None
        parsed = urlparse(normalized)
        hook_prefix = "/open-apis/bot/v2/hook/"
        hook_token = (
            parsed.path[len(hook_prefix):]
            if parsed.path.startswith(hook_prefix)
            else ""
        )
        if (
            parsed.scheme != "https"
            or parsed.hostname != "open.feishu.cn"
            or parsed.port not in (None, 443)
            or parsed.username is not None
            or parsed.password is not None
            or not hook_token
            or "/" in hook_token
        ):
            raise ValueError("群机器人 webhook 必须是飞书官方 HTTPS 地址")
        return normalized

    @model_validator(mode="after")
    def validate_enabled_targets(self):
        if self.enabled and not self.mention_targets:
            raise ValueError("启用群聊播报时至少需要一个艾特来源")
        return self


class SqlValidationParameter(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    field: str = Field(min_length=1, max_length=255)

    @field_validator("name", "field", mode="before")
    @classmethod
    def normalize_parameter_text(cls, value):
        return value.strip() if isinstance(value, str) else value


class SqlTrueCondition(BaseModel):
    field: str = Field(min_length=1, max_length=255)
    operator: Literal["gt", "gte", "lt", "lte", "eq", "neq", "between", "is_null", "is_not_null"]
    value: float | int | str | None = None
    upper_value: float | int | str | None = None

    @field_validator("field", mode="before")
    @classmethod
    def normalize_result_field(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def validate_operands(self):
        if self.operator == "between" and (self.value is None or self.upper_value is None):
            raise ValueError("between 需要上下界")
        if self.operator not in {"is_null", "is_not_null"} and self.value is None:
            raise ValueError("该 True 条件需要期望值")
        return self


class SqlValidationConfig(BaseModel):
    query_template: str = Field(min_length=1, max_length=20000)
    parameters: list[SqlValidationParameter] = Field(default_factory=list)
    true_condition: SqlTrueCondition

    @field_validator("query_template", mode="before")
    @classmethod
    def normalize_query_template(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def validate_unique_parameters(self):
        names = [parameter.name for parameter in self.parameters]
        if len(names) != len(set(names)):
            raise ValueError("SQL 参数名不能重复")
        return self


class RuleValidationConfig(BaseModel):
    validation_enabled: bool = False
    validation_targets: list[ValidationTarget] = Field(default_factory=list)
    validation_timeout_minutes: int = Field(default=1440, ge=1, le=43200)
    validation_method: Literal["pseudo", "sql"] = "pseudo"
    sql_validation_config: SqlValidationConfig | None = None

    @model_validator(mode="after")
    def validate_enabled_targets(self):
        if self.validation_enabled and not self.validation_targets:
            raise ValueError("启用实时验证时至少需要一个验证目标")
        if self.validation_method == "pseudo" and self.sql_validation_config is not None:
            raise ValueError("伪校验不能同时配置 SQL 校验")
        if self.validation_method == "sql" and self.sql_validation_config is None:
            raise ValueError("SQL 校验需要完整的 SQL 配置")
        return self


class FeishuCardActionCallback(BaseModel):
    anomaly_id: str = Field(min_length=1)
    operator_user_id: str = Field(min_length=1)
    message_id: str = Field(min_length=1)
    action: str = Field(min_length=1)
    validation_text: str = ""

    @field_validator("anomaly_id", "operator_user_id", "message_id", "action", "validation_text", mode="before")
    @classmethod
    def normalize_callback_text(cls, value):
        return value.strip() if isinstance(value, str) else value


class FeishuMessageTestRequest(BaseModel):
    receive_id_type: Literal["open_id", "union_id", "user_id", "email", "chat_id"]
    receive_id: str = Field(min_length=1, max_length=255)

    @field_validator("receive_id", mode="before")
    @classmethod
    def normalize_receive_id(cls, value):
        return value.strip() if isinstance(value, str) else value


class RuleSchedule(BaseModel):
    frequency: Literal["min", "hour", "day"]
    interval: int = Field(default=1, ge=1)
    time: str | None = None
    start_date: str
    end_date: str | None = None

    @model_validator(mode="after")
    def validate_frequency(self):
        if self.frequency == "min" and self.interval > 59:
            raise ValueError("分钟间隔必须在 1-59")
        if self.frequency == "hour" and self.interval > 23:
            raise ValueError("小时间隔必须在 1-23")
        if self.frequency == "day" and self.interval != 1:
            raise ValueError("按天调度固定每日一次")
        if self.frequency == "day" and not self.time:
            raise ValueError("按天调度必须填写执行时间")
        return self


class RuleCreate(RuleValidationConfig):
    name: str
    description: str = ""
    dataset_id: str
    severity: Literal["critical", "high", "medium", "low"] = "medium"
    logic: Literal["AND", "OR"] = "AND"
    conditions: list[Condition] = Field(min_length=1)
    anomaly_key_fields: list[str] = Field(min_length=1)
    schedule: RuleSchedule
    notification_targets: list[NotificationTarget] = Field(min_length=1)
    group_broadcast: GroupBroadcastConfig = Field(default_factory=GroupBroadcastConfig)
    enabled: bool = False


class AnomalyStatusUpdate(BaseModel):
    status: Literal["pending", "processing", "resolved"]
    assignee: str | None = None


class BulkAnomalyStatusUpdate(AnomalyStatusUpdate):
    ids: list[str] = Field(min_length=1)
