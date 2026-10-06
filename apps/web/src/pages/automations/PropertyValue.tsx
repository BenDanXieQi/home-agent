import type { deviceValueSchema } from "@home-agent/api/devices";
import type { AutomationCapabilities } from "@home-agent/api/automations";

export function PropertyValue({
  property,
  value,
  onChange,
  label,
  disabled = false,
}: {
  property: Pick<
    AutomationCapabilities["properties"][number],
    "kind" | "format" | "options" | "range" | "unit"
  >;
  value: unknown;
  onChange: (value: ReturnType<typeof deviceValueSchema.parse>) => void;
  label: string;
  disabled?: boolean;
}) {
  const options =
    property.kind === "boolean" && property.options.length === 0
      ? [
          { value: false, label: "否 / 关闭" },
          { value: true, label: "是 / 开启" },
        ]
      : property.options;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {options.length ? (
        <select
          aria-label={label}
          className="automation-input"
          disabled={disabled}
          value={JSON.stringify(value) ?? ""}
          onChange={(event) => {
            const option = options.find(
              (item) => JSON.stringify(item.value) === event.target.value,
            );
            if (option) onChange(option.value);
          }}
        >
          {!options.some((option) => option.value === value) ? (
            <option value="">请选择</option>
          ) : null}
          {options.map((option) => (
            <option
              key={JSON.stringify(option.value)}
              value={JSON.stringify(option.value)}
            >
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={label}
          className="automation-input"
          type={property.kind === "number" ? "number" : "text"}
          disabled={disabled}
          value={
            typeof value === "number"
              ? Number.isFinite(value)
                ? value
                : ""
              : typeof value === "string"
                ? value
                : ""
          }
          min={property.range?.[0]}
          max={property.range?.[1]}
          step={
            property.range?.[2] ?? (property.format.includes("int") ? 1 : "any")
          }
          onChange={(event) =>
            onChange(
              property.kind === "number"
                ? event.target.valueAsNumber
                : event.target.value,
            )
          }
        />
      )}
      {property.unit ? (
        <span className="text-xs text-muted">{property.unit}</span>
      ) : null}
    </span>
  );
}
