import { createContext, useContext, useMemo } from "react";
import { QueryBuilderDnD } from "@react-querybuilder/dnd";
import { createDndKitAdapter } from "@react-querybuilder/dnd/dnd-kit";
import * as DndKit from "@dnd-kit/core";
import {
  automationEventPredicateSchema,
  automationTriggerSchema,
  automationLimits,
  type AutomationCapabilities,
} from "@home-agent/api/automations";
import {
  QueryBuilder,
  Rule,
  isOptionGroupArray,
  type RuleGroupType,
  type RuleProps,
  type FieldSelectorProps,
  type ValueEditorProps,
} from "react-querybuilder";
import {
  defaultPropertyValue,
  defaultWindow,
  operatorLabels,
  normalizeQuery,
  propertyFieldName,
} from "../../modules/automations/editor";
import { PropertyValue } from "./PropertyValue";
import { SearchSelect } from "../../components/SearchSelect";
import "./automations.css";

const dragAdapter = createDndKitAdapter(DndKit);
const EventLabelsContext = createContext<Record<string, string>>({});

const CapabilitiesContext = createContext<AutomationCapabilities>({
  properties: [],
  actions: [],
  event_types: [],
  notification: false,
});

function ConditionField(props: FieldSelectorProps) {
  const options = isOptionGroupArray(props.options)
    ? props.options.flatMap((group) => group.options)
    : props.options;
  return (
    <SearchSelect
      className="rule-fields w-80 max-w-full max-sm:w-full"
      label="设备属性或其他条件"
      placeholder="属性不可用，可保留为停用草稿"
      value={props.value ?? ""}
      disabled={props.disabled ?? false}
      options={options.map((option) => ({
        value: option.name,
        label: option.label,
      }))}
      onValueChange={(value) => props.handleOnChange(value)}
    />
  );
}

function ConditionRule(props: RuleProps) {
  const isEvent = props.rule.field === "event";
  const role =
    isEvent || props.rule.meta?.role !== "state" ? "trigger" : "state";
  const trigger = automationTriggerSchema.safeParse(
    props.rule.meta?.trigger,
  ).data;
  const mode = isEvent
    ? "event"
    : trigger?.mode === "event"
      ? "enter"
      : (trigger?.mode ?? "enter");
  function changeRole(next: string) {
    props.actions.onPropChange(
      "meta",
      { ...props.rule.meta, role: next },
      props.path,
    );
  }
  return (
    <div className="w-full min-w-0 rounded-xl bg-white p-3 shadow-surface">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="条件角色"
          value={role}
          disabled={props.disabled || isEvent}
          onChange={(event) => changeRole(event.target.value)}
        >
          <option value="trigger">触发</option>
          <option value="state">状态</option>
        </select>
        {role === "trigger" ? (
          <>
            <select
              aria-label="触发方式"
              value={mode}
              disabled={props.disabled || isEvent}
              onChange={(event) => {
                const next =
                  event.target.value === "sustained"
                    ? { mode: "sustained", duration_seconds: 60 }
                    : { mode: event.target.value };
                props.actions.onPropChange(
                  "meta",
                  { ...props.rule.meta, trigger: next },
                  props.path,
                );
              }}
            >
              {isEvent ? (
                <option value="event">每次事件发生</option>
              ) : (
                <>
                  <option value="enter">开始满足</option>
                  <option value="exit">不再满足</option>
                  <option value="sustained">持续满足</option>
                </>
              )}
            </select>
            {mode === "sustained" ? (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="number"
                  aria-label="持续秒数"
                  min={1}
                  max={automationLimits.durationSeconds}
                  value={
                    trigger?.mode === "sustained"
                      ? trigger.duration_seconds
                      : 60
                  }
                  disabled={props.disabled ?? false}
                  onChange={(event) => {
                    const duration = event.target.valueAsNumber;
                    if (
                      !Number.isInteger(duration) ||
                      duration < 1 ||
                      duration > automationLimits.durationSeconds
                    )
                      return;
                    props.actions.onPropChange(
                      "meta",
                      {
                        ...props.rule.meta,
                        trigger: {
                          mode: "sustained",
                          duration_seconds: duration,
                        },
                      },
                      props.path,
                    );
                  }}
                />
                秒
              </label>
            ) : null}
          </>
        ) : (
          <span className="text-xs text-muted">
            只检查当前状态，自身变化不执行动作
          </span>
        )}
      </div>
      <Rule {...props} />
    </div>
  );
}

function ConditionValue(props: ValueEditorProps) {
  const capabilities = useContext(CapabilitiesContext);
  const eventLabels = useContext(EventLabelsContext);
  if (props.field === "ai")
    return (
      <p className="text-xs text-muted">
        AI 判断尚未启用，请改用设备属性或时间条件。
      </p>
    );
  if (props.field === "time_window") {
    const raw: unknown = props.value;
    const base = defaultWindow();
    const window =
      raw && typeof raw === "object"
        ? {
            ...base,
            start:
              "start" in raw && typeof raw.start === "string"
                ? raw.start
                : base.start,
            end:
              "end" in raw && typeof raw.end === "string" ? raw.end : base.end,
            time_zone:
              "time_zone" in raw && typeof raw.time_zone === "string"
                ? raw.time_zone
                : base.time_zone,
            weekdays:
              "weekdays" in raw && Array.isArray(raw.weekdays)
                ? raw.weekdays.filter((day) => typeof day === "number")
                : base.weekdays,
          }
        : base;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="time"
          aria-label="开始时间"
          value={window.start}
          disabled={props.disabled ?? false}
          onChange={(event) =>
            props.handleOnChange({ ...window, start: event.target.value })
          }
        />
        <span className="text-xs text-muted">至</span>
        <input
          type="time"
          aria-label="结束时间"
          value={window.end}
          disabled={props.disabled ?? false}
          onChange={(event) =>
            props.handleOnChange({ ...window, end: event.target.value })
          }
        />
        <span className="text-xs text-muted" aria-label="时区">
          {window.time_zone === "Asia/Shanghai"
            ? "北京时间（UTC+8）"
            : `时区：${window.time_zone}`}
        </span>
        <fieldset className="flex flex-wrap gap-2" aria-label="每周生效日">
          {["一", "二", "三", "四", "五", "六", "日"].map((day, index) => (
            <label key={day} className="inline-flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={window.weekdays.includes(index + 1)}
                disabled={props.disabled ?? false}
                onChange={(event) =>
                  props.handleOnChange({
                    ...window,
                    weekdays: event.target.checked
                      ? [...window.weekdays, index + 1].toSorted(
                          (a, b) => a - b,
                        )
                      : window.weekdays.filter((value) => value !== index + 1),
                  })
                }
              />
              {day}
            </label>
          ))}
        </fieldset>
      </div>
    );
  }
  if (props.field === "event") {
    const event = automationEventPredicateSchema.safeParse(props.value).data;
    const devices = new Map(
      [...capabilities.properties, ...capabilities.actions].map((item) => [
        item.device_id,
        item.device_name,
      ]),
    );
    return (
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="事件类型"
          value={event?.event_type ?? ""}
          disabled={props.disabled ?? false}
          onChange={(input) =>
            props.handleOnChange({
              ...event,
              kind: "event",
              event_type: input.target.value,
            })
          }
        >
          <option value="">选择事件</option>
          {capabilities.event_types.map((name) => (
            <option key={name} value={name}>
              {eventLabels[name] ?? name}
            </option>
          ))}
        </select>
        <select
          aria-label="事件设备范围"
          value={event?.device_id ?? ""}
          disabled={props.disabled ?? false}
          onChange={(input) =>
            props.handleOnChange({
              kind: "event",
              event_type: event?.event_type ?? "",
              ...(input.target.value ? { device_id: input.target.value } : {}),
            })
          }
        >
          <option value="">不限设备</option>
          {event?.device_id && !devices.has(event.device_id) ? (
            <option value={event.device_id}>原设备已不可用</option>
          ) : null}
          {[...devices].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
    );
  }
  const property = capabilities.properties.find(
    (item) => propertyFieldName(item) === props.field,
  );
  if (!property)
    return (
      <span className="text-xs text-danger">
        属性暂不可用，原条件值已保留，可保存为停用草稿
      </span>
    );
  const multiple = props.operator === "in" || props.operator === "not_in";
  if (multiple && property.options.length) {
    const values: unknown[] = Array.isArray(props.value) ? props.value : [];
    return (
      <fieldset className="flex flex-wrap gap-3" aria-label="匹配的属性值">
        {property.options.map((option) => (
          <label
            key={JSON.stringify(option.value)}
            className="inline-flex items-center gap-1 text-xs"
          >
            <input
              type="checkbox"
              checked={values.includes(option.value)}
              disabled={props.disabled ?? false}
              onChange={(event) =>
                props.handleOnChange(
                  event.target.checked
                    ? [...values, option.value]
                    : values.filter((value) => value !== option.value),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </fieldset>
    );
  }
  if (multiple || props.operator === "between") {
    const values: unknown[] = Array.isArray(props.value)
      ? props.value
      : props.operator === "between"
        ? [props.value, props.value]
        : [props.value];
    return (
      <div className="flex flex-wrap items-center gap-2">
        {values.map((value, index) => (
          <span key={index} className="inline-flex items-center gap-1">
            <PropertyValue
              property={property}
              value={value}
              label={`条件值 ${index + 1}`}
              disabled={props.disabled ?? false}
              onChange={(next) =>
                props.handleOnChange(
                  values.map((current, item) =>
                    item === index ? next : current,
                  ),
                )
              }
            />
            {multiple && values.length > 1 ? (
              <button
                type="button"
                aria-label={`删除值 ${index + 1}`}
                disabled={props.disabled ?? false}
                onClick={() =>
                  props.handleOnChange(
                    values.filter((_, item) => item !== index),
                  )
                }
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
        {multiple ? (
          <button
            type="button"
            disabled={props.disabled || values.length >= 64}
            onClick={() =>
              props.handleOnChange([...values, defaultPropertyValue(property)])
            }
          >
            加一个值
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <PropertyValue
      property={property}
      value={props.value}
      label="条件值"
      disabled={props.disabled ?? false}
      onChange={(value) => props.handleOnChange(value)}
    />
  );
}

export function RuleTreeEditor({
  query,
  onChange,
  capabilities,
  eventLabels,
  disabled,
}: {
  query: RuleGroupType;
  onChange: (query: RuleGroupType) => void;
  capabilities: AutomationCapabilities;
  eventLabels: Record<string, string>;
  disabled: boolean;
}) {
  const fields = useMemo(
    () => [
      ...capabilities.properties
        .filter((property) => property.readable)
        .map((property) => ({
          name: propertyFieldName(property),
          label: `${property.device_name} · ${property.description}`,
          defaultValue: defaultPropertyValue(property),
        })),
      { name: "time_window", label: "时间范围", defaultValue: defaultWindow() },
      ...(capabilities.event_types.length
        ? [
            {
              name: "event",
              label: "家庭事件",
              defaultValue: {
                kind: "event",
                event_type: capabilities.event_types[0],
              },
            },
          ]
        : []),
    ],
    [capabilities],
  );
  return (
    <CapabilitiesContext value={capabilities}>
      <EventLabelsContext value={eventLabels}>
        <div className="automation-editor">
          <QueryBuilderDnD
            dnd={dragAdapter}
            controlElements={{ rule: ConditionRule }}
          >
            <QueryBuilder
              query={query}
              onQueryChange={(next) => onChange(normalizeQuery(next))}
              fields={fields}
              disabled={disabled}
              showNotToggle
              showShiftActions
              listsAsArrays
              maxLevels={automationLimits.depth - 1}
              enableMountQueryChange={false}
              combinators={[
                { name: "and", label: "全部满足（AND）" },
                { name: "or", label: "任一满足（OR）" },
              ]}
              getOperators={(field) => {
                const property = capabilities.properties.find(
                  (item) => propertyFieldName(item) === field,
                );
                return property
                  ? property.operators.map((operator) => ({
                      name: operator,
                      label: operatorLabels[operator],
                    }))
                  : field === "time_window" ||
                      field === "event" ||
                      field === "ai"
                    ? [{ name: "eq", label: "符合" }]
                    : Object.entries(operatorLabels).map(([name, label]) => ({
                        name,
                        label,
                      }));
              }}
              controlElements={{
                fieldSelector: ConditionField,
                valueEditor: ConditionValue,
              }}
              translations={{
                addRule: { label: "+ 条件", title: "添加条件" },
                addGroup: { label: "+ 条件组", title: "添加条件组" },
                removeRule: { label: "删除", title: "删除条件" },
                removeGroup: { label: "删除组", title: "删除条件组" },
                notToggle: { label: "取反（NOT）", title: "将此组结果取反" },
                fields: {
                  title: "设备属性或其他条件",
                  placeholderLabel: "选择条件",
                },
                operators: {
                  title: "比较方式",
                  placeholderLabel: "选择比较方式",
                },
                value: { title: "条件值" },
                shiftActionUp: { label: "↑", title: "上移" },
                shiftActionDown: { label: "↓", title: "下移" },
              }}
            />
          </QueryBuilderDnD>
        </div>
      </EventLabelsContext>
    </CapabilitiesContext>
  );
}
