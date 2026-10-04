import { setupChatStorage } from "../src/chat/setup";
import { loadConfig } from "../src/config";
import { createAgentDatabase } from "../src/db";

const config = loadConfig();
const url = config.AGENT_DATABASE_URL ?? config.DATABASE_URL;
if (!url) throw new Error("Set AGENT_DATABASE_URL or DATABASE_URL");
const database = createAgentDatabase(url);
try {
  await database.checkpointer.setup();
  await setupChatStorage(database);
  console.info("Agent checkpoint and conversation storage are ready");
} finally {
  await database.close();
}
