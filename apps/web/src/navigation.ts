import {
  Database,
  LayoutGrid,
  Users,
  ScrollText,
  Settings2,
  Video,
} from "lucide-react";

export const navigation = [
  {
    to: "/devices",
    label: "房间",
    icon: LayoutGrid,
    cornerRadius: 14,
    mobilePrimary: true,
  },
  {
    to: "/members",
    label: "成员",
    icon: Users,
    cornerRadius: 14,
    mobilePrimary: true,
  },
  {
    to: "/cameras",
    label: "视频",
    icon: Video,
    cornerRadius: 22,
    mobilePrimary: true,
  },
  {
    to: "/device-logs",
    label: "日志",
    icon: ScrollText,
    cornerRadius: 10,
    mobilePrimary: false,
  },
  {
    to: "/data",
    label: "数据",
    icon: Database,
    cornerRadius: 14,
    mobilePrimary: false,
  },
  {
    to: "/settings",
    label: "设置",
    icon: Settings2,
    cornerRadius: 18,
    mobilePrimary: false,
  },
] as const;
