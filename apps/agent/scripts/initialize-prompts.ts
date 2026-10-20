import { readdir } from "node:fs/promises";
import { LangfuseClient } from "@langfuse/client";
import { langfuseConnection } from "@home-agent/observability/langfuse";
import { promptConfigurationSchema } from "../src/prompts";

const configuration = promptConfigurationSchema.parse(process.env);
const connection = langfuseConnection(configuration);
if (!connection.publicKey && !connection.secretKey) {
  console.info("未配置 Langfuse 项目密钥，跳过初始提示词检查。");
  process.exit(0);
}
if (!connection.publicKey || !connection.secretKey)
  throw new Error(
    "初始化提示词需要 LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY。",
  );

const client = new LangfuseClient(connection);
const directory = new URL("../prompts/", import.meta.url);
const label = configuration.AGENT_PROMPT_LABEL;

try {
  for (const file of (await readdir(directory)).toSorted()) {
    if (!file.endsWith(".json")) continue;
    const initial: Parameters<typeof client.api.prompts.create>[0] =
      await Bun.file(new URL(file, directory)).json();
    const { data } = await client.api.prompts.list({ name: initial.name });
    const existing = data.find(({ name }) => name === initial.name);

    if (existing) {
      if (!existing.labels.includes(label))
        throw new Error(
          `提示词 ${initial.name} 已存在，但缺少 ${label} 标签，请在 Langfuse 中指定版本。`,
        );
      console.info(`提示词 ${initial.name} 已存在（${label}），保留现有版本。`);
      continue;
    }

    const created = await client.api.prompts.create({
      ...initial,
      labels: [label],
    });
    console.info(
      `已初始化提示词 ${created.name} v${created.version}（${label}）。`,
    );
  }
} finally {
  await client.shutdown();
}
