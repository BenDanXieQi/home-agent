import { useId, useState } from "react";
import { Check, PawPrint, UserRound } from "lucide-react";
import { memberProfileSchema } from "@home-agent/api/household-members";
import type { Member } from "../../modules/members/queries";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";

const kinds = [
  {
    value: "person",
    label: "人物",
    description: "家中的一位成员",
    icon: UserRound,
  },
  {
    value: "pet",
    label: "宠物",
    description: "家中的动物伙伴",
    icon: PawPrint,
  },
] as const;

export function MemberForm({
  member,
  pending,
  onSave,
  onCancel,
  onDelete,
}: {
  member: Member | null;
  pending: boolean;
  onSave: (
    id: string,
    profile: ReturnType<typeof memberProfileSchema.parse>,
  ) => void;
  onCancel: () => void;
  onDelete: (() => void) | undefined;
}) {
  const inputId = useId();
  const [id] = useState(() => member?.id ?? crypto.randomUUID());
  const [kind, setKind] = useState(member?.kind ?? "person");
  const [name, setName] = useState(member?.name ?? "");
  const [species, setSpecies] = useState(member?.species ?? "");
  const [description, setDescription] = useState(member?.description ?? "");
  const [error, setError] = useState("");
  return (
    <form
      className="mx-auto w-full max-w-3xl"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const profile = memberProfileSchema.safeParse({
          kind,
          name,
          description,
          ...(kind === "pet" ? { species } : {}),
        });
        if (!profile.success) {
          setError("请填写名称；宠物还需要填写物种，并检查内容长度。");
          return;
        }
        setError("");
        onSave(id, profile.data);
      }}
    >
      <div className="mb-7">
        <h2 className="text-2xl font-medium tracking-tight">
          {member ? `编辑${member.name}的资料` : "认识一位新成员"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          {member
            ? "维护名称、外观特征和日常备注。"
            : "为家人或宠物建立一份资料。"}
        </p>
      </div>
      <fieldset
        disabled={pending}
        className="min-w-0 rounded-2xl bg-surface p-2"
      >
        <legend className="sr-only">{member ? "编辑成员" : "添加成员"}</legend>
        <div className="divide-y divide-line/70 rounded-xl bg-white px-5 shadow-surface md:px-7">
          <fieldset
            disabled={pending || !!member}
            className="grid min-w-0 gap-4 py-6 md:grid-cols-[128px_minmax(0,1fr)] md:gap-6"
          >
            <legend className="sr-only">成员类型</legend>
            <div>
              <h3 className="text-sm font-medium">成员类型</h3>
              <p className="mt-1.5 text-xs leading-5 text-muted">
                {member ? "登记后不可更改" : "选择人物或宠物"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {kinds.map(({ value, label, description: hint, icon: Icon }) => (
                <label
                  key={value}
                  className={`relative m-0 min-w-0 rounded-xl border p-4 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ink ${kind === value ? "border-ink bg-surface" : "border-line hover:bg-surface/60"} ${member || pending ? "cursor-default" : "cursor-pointer"}`}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name={`${inputId}-kind`}
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                  />
                  <span className="flex items-center justify-between gap-2">
                    <Icon size={21} strokeWidth={1.5} className="text-ink" />
                    {kind === value ? (
                      <Check size={14} className="text-ink" />
                    ) : null}
                  </span>
                  <span className="mt-3 block text-sm font-medium text-ink">
                    {label}
                  </span>
                  <span className="mt-1 block text-[11px] leading-5 text-muted">
                    {hint}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 py-6 md:grid-cols-[128px_minmax(0,1fr)] md:gap-6">
            <div>
              <h3 className="text-sm font-medium">基本信息</h3>
              <p className="mt-1.5 text-xs leading-5 text-muted">
                平时使用的称呼
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label
                className={`m-0 grid gap-2 text-xs ${kind === "person" ? "sm:col-span-2" : ""}`}
              >
                {kind === "person" ? "姓名 / 称呼" : "宠物名字"}
                <input
                  required
                  maxLength={100}
                  placeholder={
                    kind === "person"
                      ? "怎么称呼这位成员？"
                      : "宠物叫什么名字？"
                  }
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {kind === "pet" ? (
                <label className="m-0 grid gap-2 text-xs">
                  物种
                  <input
                    required
                    maxLength={50}
                    placeholder="例如：猫、狗"
                    value={species}
                    onChange={(event) => setSpecies(event.target.value)}
                  />
                </label>
              ) : null}
            </div>
          </div>
          <div className="grid gap-4 py-6 md:grid-cols-[128px_minmax(0,1fr)] md:gap-6">
            <div>
              <label
                htmlFor={`${inputId}-description`}
                className="m-0 text-sm font-medium text-ink"
              >
                外观与备注
              </label>
              <p className="mt-1.5 text-xs leading-5 text-muted">
                选填，之后也可补充
              </p>
            </div>
            <div>
              <textarea
                id={`${inputId}-description`}
                rows={4}
                maxLength={2000}
                placeholder={
                  kind === "pet"
                    ? "毛色、体型、明显特征，或其他想记下的事…"
                    : "外观特征，或其他想记下的事…"
                }
                className="block min-h-28 w-full resize-y rounded-lg border border-transparent bg-surface px-3 py-3 text-sm leading-6 text-ink placeholder:text-muted/60 focus-visible:outline-offset-0 disabled:opacity-50"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <p className="mt-2 text-right text-[11px] tabular-nums text-muted/60">
                {description.length} / 2000
              </p>
            </div>
          </div>
        </div>
      </fieldset>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="mt-6 flex items-center justify-end gap-2">
        {onDelete ? (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            className="mr-auto text-danger"
            onClick={onDelete}
          >
            删除成员
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button
          type="submit"
          variant="primary"
          status={pending ? "pending" : "idle"}
        >
          {member ? "保存修改" : "添加成员"}
        </Button>
      </div>
    </form>
  );
}
