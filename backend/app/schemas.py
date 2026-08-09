from typing import Literal

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


class RuleCreate(BaseModel):
    name: str
    description: str = ""
    dataset_id: str
    severity: Literal["critical", "high", "medium", "low"] = "medium"
    logic: Literal["AND", "OR"] = "AND"
    conditions: list[Condition] = Field(min_length=1)
    anomaly_key_fields: list[str] = Field(min_length=1)
    schedule: RuleSchedule
    notification_targets: list[NotificationTarget] = Field(min_length=1)
    enabled: bool = False


class AnomalyStatusUpdate(BaseModel):
    status: Literal["pending", "processing", "resolved"]
    assignee: str | None = None


class BulkAnomalyStatusUpdate(AnomalyStatusUpdate):
    ids: list[str] = Field(min_length=1)
