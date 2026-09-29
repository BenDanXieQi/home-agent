import { twMerge } from "tailwind-merge";
import { useAtomValue } from "jotai";
import type { ComponentProps } from "react";
import { Avatar } from "radix-ui";
import { UserRound } from "lucide-react";
import { mijiaAccountAtom } from "./account";

export function AccountAvatar({
  className = "",
  ...props
}: Omit<
  ComponentProps<typeof Avatar.Root>,
  "children" | "asChild" | "dangerouslySetInnerHTML"
>) {
  const account = useAtomValue(mijiaAccountAtom);
  const profile = account?.status === "authenticated" ? account.profile : null;
  return (
    <Avatar.Root
      {...props}
      className={twMerge(
        `account-avatar grid size-8 shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-white text-muted max-md:size-7 ${className}`,
      )}
    >
      <Avatar.Image
        className="size-full object-cover"
        src={profile?.avatarUrl ?? undefined}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
      />
      <Avatar.Fallback className="grid size-full place-items-center">
        <UserRound size={17} />
      </Avatar.Fallback>
    </Avatar.Root>
  );
}
