import { useId } from "react";
import { useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, X } from "lucide-react";
import { Popover } from "radix-ui";
import { connectionNoticeAtom } from "../../modules/connections/state";

/** Connection details belong to the navigation mascot's popover. */
export function ConnectionNotice() {
  const notice = useAtomValue(connectionNoticeAtom);
  const titleId = useId();
  const descriptionId = useId();
  return (
    <Popover.Portal>
      <Popover.Content
        className="text-white z-60 w-72 max-w-[calc(100vw_-_24px)] p-4.5 rounded-[20px] [transform-origin:var(--radix-popover-content-transform-origin)] animate-[connection-notice-enter_180ms_ease-out] overflow-hidden border border-[#252525] bg-ink shadow-[0_8px_32px_#00000018,_0_2px_6px_#00000008] motion-reduce:animate-none"
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="flex items-center gap-2.75 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:leading-[1.6]">
          <div>
            <span className="block text-[#a3a3a3] text-[11px] tracking-[0.08em] leading-[1.5]">
              连接状态
            </span>
            <h2 id={titleId}>{notice.title}</h2>
          </div>
          <Popover.Close
            className="ml-auto self-start text-[#a3a3a3] p-1.25 rounded-[7px] cursor-pointer hover:bg-[#303030]"
            aria-label="关闭连接详情"
          >
            <X size={16} />
          </Popover.Close>
        </div>
        <p
          id={descriptionId}
          className="block my-3.5 mx-0 text-[12px] leading-[1.7] text-[#b5b5b5]"
        >
          {notice.message}
        </p>
        <Popover.Close asChild>
          <Link
            draggable={false}
            to="/settings"
            className="select-none inline-flex items-center justify-between w-full py-2.25 px-2.75 rounded-[10px] text-ink bg-white text-[12px] font-medium hover:bg-[#e7e7e7]"
          >
            检查连接 <ArrowUpRight size={14} className="shrink-0" />
          </Link>
        </Popover.Close>
      </Popover.Content>
    </Popover.Portal>
  );
}
