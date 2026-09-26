import { useAtomValue } from "jotai";
import { Avatar } from "radix-ui";
import { UserRound } from "lucide-react";
import { mijiaAccountAtom } from "./state";

export function AccountAvatar() {
  const account = useAtomValue(mijiaAccountAtom);
  const profile = account?.status === "authenticated" ? account.profile : null;
  return (
    <Avatar.Root className="account-avatar">
      <Avatar.Image
        className="size-full object-cover"
        src={profile?.avatarUrl ?? undefined}
        alt=""
        referrerPolicy="no-referrer"
      />
      <Avatar.Fallback className="grid size-full place-items-center">
        <UserRound size={17} />
      </Avatar.Fallback>
    </Avatar.Root>
  );
}
