import { useState } from "react";
import type {
  AutomationCapabilities,
  automationAiPredicateSchema,
} from "@home-agent/api/automations";
import { propertyFieldName } from "../../modules/automations/editor";

export function AiConditionEditor({
  value,
  onChange,
  capabilities,
  disabled,
}: {
  value: ReturnType<typeof automationAiPredicateSchema.parse>;
  onChange: (
    value: ReturnType<typeof automationAiPredicateSchema.parse>,
  ) => void;
  capabilities: AutomationCapabilities;
  disabled: boolean;
}) {
  const [search, setSearch] = useState("");
  const available = capabilities.properties.filter(
    (property) => property.readable,
  );
  const selected = new Set(value.property_refs.map(propertyFieldName));
  const missing = value.property_refs.filter(
    (ref) =>
      !available.some(
        (property) => propertyFieldName(property) === propertyFieldName(ref),
      ),
  );
  const update = (patch: Partial<typeof value>) =>
    onChange({ ...value, ...patch });
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 w-full space-y-3 rounded-lg bg-surface p-3"
    >
      <label className="block space-y-1 text-sm">
        <span>AI 判断目标</span>
        <textarea
          className="automation-input min-h-20 w-full"
          maxLength={4000}
          value={value.goal}
          placeholder="描述需要根据所选设备状态判断的目标"
          onChange={(event) => update({ goal: event.target.value })}
        />
      </label>
      <p className="text-xs text-muted">
        按周期更新判断，不会每次设备上报都调用
        AI。结果过期或证据变化时按未知处理；随这条规则一起启停。
      </p>
      <input
        className="automation-input w-full"
        aria-label="搜索 AI 参考属性"
        placeholder="搜索设备或属性"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <fieldset
        aria-label="AI 允许读取的设备属性"
        className="grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2"
      >
        <legend className="mb-2 text-xs">
          参考设备属性 · {selected.size} / 50
        </legend>
        {available
          .filter((property) =>
            `${property.device_name} ${property.description}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((property) => (
            <label
              key={propertyFieldName(property)}
              className="flex gap-2 text-xs"
            >
              <input
                type="checkbox"
                checked={selected.has(propertyFieldName(property))}
                disabled={
                  disabled ||
                  (!selected.has(propertyFieldName(property)) &&
                    selected.size >= 50)
                }
                onChange={(event) =>
                  update({
                    property_refs: event.target.checked
                      ? [
                          ...value.property_refs,
                          {
                            device_id: property.device_id,
                            property_key: property.property_key,
                          },
                        ]
                      : value.property_refs.filter(
                          (ref) =>
                            propertyFieldName(ref) !==
                            propertyFieldName(property),
                        ),
                  })
                }
              />
              {property.device_name} · {property.description}
            </label>
          ))}
      </fieldset>
      {missing.length ? (
        <p className="text-xs text-warning">
          {missing.length} 个原属性不可用。
          <button
            type="button"
            onClick={() =>
              update({
                property_refs: value.property_refs.filter(
                  (ref) => !missing.includes(ref),
                ),
              })
            }
          >
            移除不可用属性
          </button>
        </p>
      ) : null}
      <label className="block text-xs">
        检查间隔（分钟）
        <input
          className="automation-input ml-2"
          type="number"
          min={5}
          max={1440}
          value={
            Number.isFinite(value.interval_seconds)
              ? value.interval_seconds / 60
              : ""
          }
          onChange={(event) =>
            update({ interval_seconds: event.target.valueAsNumber * 60 })
          }
        />
      </label>
      <details className="space-y-3 text-xs">
        <summary>高级设置</summary>
        <label className="block">
          判断有效期（分钟）
          <input
            className="automation-input ml-2"
            type="number"
            min={1}
            max={1440}
            value={
              Number.isFinite(value.result_ttl_seconds)
                ? value.result_ttl_seconds / 60
                : ""
            }
            onChange={(event) =>
              update({ result_ttl_seconds: event.target.valueAsNumber * 60 })
            }
          />
        </label>
        <label className="block">
          24 小时调用上限
          <input
            className="automation-input ml-2"
            type="number"
            min={1}
            max={48}
            value={
              Number.isFinite(value.max_calls_per_day)
                ? value.max_calls_per_day
                : ""
            }
            onChange={(event) =>
              update({ max_calls_per_day: event.target.valueAsNumber })
            }
          />
        </label>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={value.evaluate_unchanged}
            onChange={(event) =>
              update({ evaluate_unchanged: event.target.checked })
            }
          />
          证据不变也重新判断
        </label>
        <p className="text-muted">
          关闭时，相同证据只判断一次；结果过期后保持未知，等待新证据。
        </p>
      </details>
    </fieldset>
  );
}
