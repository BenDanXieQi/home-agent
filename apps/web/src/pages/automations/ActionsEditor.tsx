import { Plus, Trash2 } from "lucide-react";
import {
  type AutomationAction,
  type AutomationCapabilities,
  automationLimits,
} from "@home-agent/api/automations";
import {
  defaultPropertyValue,
  propertyFieldName,
} from "../../modules/automations/editor";
import { Button } from "../../components/Button";
import { SearchSelect } from "../../components/SearchSelect";
import { PropertyValue } from "./PropertyValue";

function actionChoices(capabilities: AutomationCapabilities) {
  return [
    ...capabilities.properties
      .filter((property) => property.writeable)
      .map((property) => ({
        key: propertyFieldName(property),
        label: `${property.device_name} · 设置${property.description}`,
        action: {
          id: crypto.randomUUID(),
          kind: "set_property" as const,
          device_id: property.device_id,
          property_key: property.property_key,
          value: defaultPropertyValue(property),
        },
      })),
    ...capabilities.actions.map((action) => ({
      key: JSON.stringify([action.device_id, action.action_key]),
      label: `${action.device_name} · ${action.description}`,
      action: {
        id: crypto.randomUUID(),
        kind: "invoke_action" as const,
        device_id: action.device_id,
        action_key: action.action_key,
        inputs: action.inputs.map(defaultPropertyValue),
      },
    })),
    ...(capabilities.notification
      ? [
          {
            key: "notification",
            label: "网页消息",
            action: {
              id: crypto.randomUUID(),
              kind: "notification" as const,
              message: "",
            },
          },
        ]
      : []),
  ];
}

function actionKey(action: AutomationAction) {
  return action.kind === "notification"
    ? "notification"
    : JSON.stringify([
        action.device_id,
        action.kind === "set_property"
          ? action.property_key
          : action.action_key,
      ]);
}

export function ActionsEditor({
  actions,
  onChange,
  capabilities,
  disabled,
}: {
  actions: AutomationAction[];
  onChange: (actions: AutomationAction[]) => void;
  capabilities: AutomationCapabilities;
  disabled: boolean;
}) {
  const choices = actionChoices(capabilities);
  function update(index: number, action: AutomationAction) {
    onChange(
      actions.map((current, position) =>
        position === index ? action : current,
      ),
    );
  }
  return (
    <div className="space-y-3">
      {actions.map((action, index) => {
        const property =
          action.kind === "set_property"
            ? capabilities.properties.find(
                (item) =>
                  item.device_id === action.device_id &&
                  item.property_key === action.property_key,
              )
            : undefined;
        const command =
          action.kind === "invoke_action"
            ? capabilities.actions.find(
                (item) =>
                  item.device_id === action.device_id &&
                  item.action_key === action.action_key,
              )
            : undefined;
        return (
          <div
            key={action.id}
            className="flex min-w-0 flex-wrap items-start gap-3 rounded-xl bg-surface p-4"
          >
            <SearchSelect
              className="w-80 max-w-full"
              label={`动作 ${index + 1}`}
              placeholder="此动作能力已不可用"
              value={actionKey(action)}
              disabled={disabled}
              options={choices.map((choice) => ({
                value: choice.key,
                label: choice.label,
              }))}
              onValueChange={(value) => {
                const next = choices.find((choice) => choice.key === value);
                if (next) update(index, { ...next.action, id: action.id });
              }}
            />
            {action.kind === "set_property" && property ? (
              <PropertyValue
                label="写入值"
                property={property}
                value={action.value}
                disabled={disabled}
                onChange={(value) => update(index, { ...action, value })}
              />
            ) : null}
            {action.kind === "notification" ? (
              <label className="min-w-48 flex-1 text-xs text-muted">
                <textarea
                  aria-label="网页消息内容"
                  className="automation-input min-h-20 w-full resize-y"
                  value={action.message}
                  disabled={disabled}
                  maxLength={4000}
                  placeholder="规则触发时显示的消息"
                  onChange={(event) =>
                    update(index, { ...action, message: event.target.value })
                  }
                />
                消息保存在这条自动化的执行记录中。
              </label>
            ) : null}
            {action.kind === "invoke_action" && command
              ? command.inputs.map((input, parameter) => (
                  <label
                    key={`${input.name}-${parameter}`}
                    className="flex flex-col gap-1 text-xs text-muted"
                  >
                    {input.name}
                    <PropertyValue
                      label={input.name}
                      property={input}
                      value={action.inputs[parameter]}
                      disabled={disabled}
                      onChange={(value) =>
                        update(index, {
                          ...action,
                          inputs: action.inputs.map((current, position) =>
                            position === parameter ? value : current,
                          ),
                        })
                      }
                    />
                  </label>
                ))
              : null}
            <Button
              type="button"
              variant="ghost"
              size="small"
              aria-label={`删除动作 ${index + 1}`}
              icon={<Trash2 size={14} />}
              disabled={disabled}
              onClick={() =>
                onChange(actions.filter((_, position) => position !== index))
              }
            />
          </div>
        );
      })}
      <Button
        type="button"
        size="small"
        icon={<Plus size={14} />}
        disabled={
          disabled ||
          !choices.length ||
          actions.length >= automationLimits.actions
        }
        onClick={() => {
          const first = choices[0];
          if (first) onChange([...actions, first.action]);
        }}
      >
        添加动作
      </Button>
      {!choices.length ? (
        <p className="text-sm text-muted">当前家庭暂无可用动作能力。</p>
      ) : null}
    </div>
  );
}
