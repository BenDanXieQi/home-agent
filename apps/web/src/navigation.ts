import {
  Database,
  LayoutGrid,
  ScrollText,
  Settings2,
  Video,
} from "lucide-react";

export const navigation = [
  { to: "/devices", label: "设备", icon: LayoutGrid, cornerRadius: 14 },
  { to: "/cameras", label: "视频", icon: Video, cornerRadius: 22 },
  { to: "/device-logs", label: "日志", icon: ScrollText, cornerRadius: 10 },
  { to: "/data", label: "数据", icon: Database, cornerRadius: 14 },
  { to: "/settings", label: "设置", icon: Settings2, cornerRadius: 18 },
] as const;
