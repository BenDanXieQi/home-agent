import { PawPrint, UserRound } from "lucide-react";
import type { Member } from "../../modules/members/queries";

export function MemberAvatar({ name, kind }: Pick<Member, "name" | "kind">) {
  const initial = Array.from(name.trim())[0];
  return (
    <span
      aria-hidden="true"
      className="grid size-16 shrink-0 place-items-center rounded-2xl bg-white text-2xl font-medium text-ink shadow-surface"
    >
      {kind === "pet" ? (
        <PawPrint size={27} strokeWidth={1.4} />
      ) : (
        initial || <UserRound size={27} strokeWidth={1.4} />
      )}
    </span>
  );
}
