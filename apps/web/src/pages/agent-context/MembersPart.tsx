import { memo } from "react";
import { identified, named } from "./presentation";
import type { Parts } from "./presentation";
import { RecordBrowser } from "./RecordBrowser";

export const MembersPart = memo(function MembersPart({
  data,
}: {
  data: Extract<Parts["members"], { status: "ready" }>["data"];
}) {
  return (
    <RecordBrowser
      rows={data.members}
      label="成员资料"
      filterColumns={["kind"]}
      columns={[
        { id: "name", header: "成员", accessorFn: (m) => m.name },
        {
          id: "kind",
          header: "类别",
          accessorFn: (m) => (m.kind === "person" ? "人物" : m.species),
          filterFn: "equalsString",
        },
        {
          id: "description",
          header: "描述",
          accessorFn: (m) => m.description || "暂无描述",
        },
      ]}
      identify={identified}
      title={named}
      describe={(m) =>
        `${m.kind === "person" ? "人物" : m.species} · ${m.description}`
      }
      render={(m) => <p className="text-sm">{m.description || "暂无描述"}</p>}
    />
  );
});
