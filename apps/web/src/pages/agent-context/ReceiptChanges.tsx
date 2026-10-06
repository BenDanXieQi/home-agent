import { presentReceiptChange } from "./receipt-presentation";
import { useState } from "react";
import type { z } from "zod";
import type { agentReceiptSchema } from "@home-agent/api/agent-receipts";
import { Button } from "../../components/Button";

export function ReceiptChanges({
  changes,
}: {
  changes: z.infer<typeof agentReceiptSchema>["changes"];
}) {
  const [limit, setLimit] = useState(20);
  if (!changes.length) return <p className="text-xs text-muted">无数据变化</p>;
  return (
    <div className="space-y-3">
      <div className="max-h-80 overflow-auto rounded-xl bg-surface px-4">
        {changes
          .slice(0, limit)
          .map(presentReceiptChange)
          .map((change, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-line/60 py-3 text-xs last:border-b-0 max-sm:grid-cols-1"
            >
              <span className="break-words font-medium">{change.subject}</span>
              <span className="break-words text-muted">{change.detail}</span>
            </div>
          ))}
      </div>
      {limit < changes.length ? (
        <Button size="small" onClick={() => setLimit(limit + 20)}>
          显示更多（剩余 {changes.length - limit} 项）
        </Button>
      ) : null}
    </div>
  );
}
