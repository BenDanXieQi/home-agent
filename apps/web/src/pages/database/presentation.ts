export const tablePresentation = {
  household_subjects: {
    title: "家庭成员",
  },
  context_records: {
    title: "上下文",
  },
  context_entities: {
    title: "对象关联",
  },
};

export const fieldLabels: Record<string, string> = {
  id: "唯一标识",
  kind: "类型",
  name: "名称",
  details: "补充资料",
  createdAt: "保存时间",
  topic: "主题",
  summary: "描述",
  data: "结构化内容",
  certainty: "支持程度",
  occurredAt: "发生时间",
  expiresAt: "到期时间",
  evidence: "依据",
  scopeEpoch: "运行标识",
  contextId: "上下文 ID",
  entityType: "对象类型",
  entityId: "对象 ID",
  role: "关联角色",
};

const valueLabels: Record<string, string> = {
  person: "人物",
  pet: "宠物",
  room: "房间",
  device: "设备",
  observation: "观察",
  assessment: "判断",
  supported: "有支持",
  tentative: "暂定",
  unknown: "未知",
  conflicting: "冲突",
  subject: "主体",
  participant: "参与者",
  location: "地点",
  source: "来源",
};

export function displayCell(key: string, value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    if (["kind", "certainty", "entityType", "role"].includes(key))
      return valueLabels[value] ?? value;
    if (["createdAt", "occurredAt", "expiresAt"].includes(key))
      return new Date(value).toLocaleString("zh-CN", { hour12: false });
    return value;
  }
  return JSON.stringify(value);
}

export function rowKey(row: Record<string, unknown>) {
  return typeof row.id === "string"
    ? row.id
    : JSON.stringify([row.contextId, row.entityType, row.entityId, row.role]);
}
