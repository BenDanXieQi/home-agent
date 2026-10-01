import { Pencil, Sparkles } from "lucide-react";
import type { Member } from "../../modules/members/queries";
import { Button } from "../../components/Button";
import { MemberAvatar } from "./MemberAvatar";
import { MemberActivity } from "./MemberActivity";

export function MemberOverview({
  member,
  scope,
  onEdit,
}: {
  member: Member;
  scope: string;
  onEdit: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="grid items-stretch gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <section
          aria-label={`${member.name}的基本资料`}
          className="min-w-0 rounded-2xl bg-surface p-5"
        >
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-sm font-medium">基本资料</h2>
            <Button
              size="small"
              variant="ghost"
              icon={<Pencil size={13} />}
              onClick={onEdit}
            >
              编辑
            </Button>
          </div>
          <div className="flex items-center gap-4 lg:flex-col lg:items-start">
            <MemberAvatar name={member.name} kind={member.kind} />
            <div className="min-w-0">
              <h3 className="break-words text-xl font-medium">{member.name}</h3>
              <p className="mt-2 text-xs text-muted">
                {member.kind === "person"
                  ? "人物"
                  : `宠物 · ${member.species || "未填写物种"}`}
              </p>
            </div>
          </div>
          <div className="mt-6 border-t border-line pt-4">
            <h4 className="text-xs text-muted">外观与备注</h4>
            <p
              className={`mt-2 whitespace-pre-wrap break-words text-sm leading-7 ${member.description ? "" : "text-muted/60"}`}
            >
              {member.description || "还没有填写"}
            </p>
          </div>
        </section>
        <section
          aria-labelledby="member-portrait-title"
          className="flex min-w-0 flex-col rounded-2xl bg-surface p-5"
        >
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="member-portrait-title"
                className="flex items-center gap-2 text-sm font-medium"
              >
                <Sparkles size={15} />
                AI 成员画像
              </h2>
              <p className="mt-2 text-xs text-muted">
                根据日常观察，整理习惯与行为特征。
              </p>
            </div>
            <Button disabled title="成员画像生成尚未接入">
              生成总结
            </Button>
          </header>
          <div className="mt-5 flex min-h-52 flex-1 items-center rounded-xl bg-white px-6 py-8 shadow-surface">
            <div className="max-w-xl">
              <h3 className="text-sm font-medium">还没有成员画像</h3>
              <p className="mt-2 text-sm leading-7 text-muted">
                成员画像生成尚未接入。接入后可在这里主动生成总结，查看日常习惯、行为特征及其观察依据。
              </p>
              <p className="mt-4 text-xs leading-6 text-muted">
                手动填写的资料保留在基本资料区，AI 总结不会覆盖它们。
              </p>
            </div>
          </div>
        </section>
      </div>
      <MemberActivity key={member.id} member={member} scope={scope} />
    </div>
  );
}
