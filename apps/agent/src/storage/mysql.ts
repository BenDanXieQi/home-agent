import { SQL, type ReservedSQL } from "bun";
import {
  MemoryStorage,
  type Id,
  type Storage,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const sessionName = "main-agents";

// Pi owns validation, document replay, and reads; MySQL owns durable commits and IDs.
export class MysqlStorage extends MemoryStorage {
  private failure: Error | undefined;
  private closing = false;

  private constructor(
    private readonly client: SQL,
    private readonly connection: ReservedSQL,
  ) {
    super();
  }

  static async open(url: string) {
    let storage: MysqlStorage | undefined;
    let connection: ReservedSQL | undefined;
    const client = new SQL(url, {
      max: 1,
      idleTimeout: 0,
      maxLifetime: 0,
      connectionTimeout: 10,
      onclose() {
        if (storage)
          storage.failure = new Error(
            "The MySQL storage connection was closed",
          );
      },
    });

    try {
      connection = await client.reserve();
      const [lock] = await connection<{ acquired: number }[]>`
        SELECT GET_LOCK(${`home-agent:${sessionName}`}, 0) AS acquired
      `;
      if (lock?.acquired !== 1)
        throw new Error("The main Agent storage already has an owner");

      await connection`
        CREATE TABLE IF NOT EXISTS agent_sessions (
          name VARCHAR(64) PRIMARY KEY,
          next_id BIGINT NOT NULL DEFAULT 2
        ) ENGINE=InnoDB
      `;
      await connection`
        CREATE TABLE IF NOT EXISTS agent_commits (
          session_name VARCHAR(64) NOT NULL,
          seq BIGINT NOT NULL,
          writes JSON NOT NULL,
          PRIMARY KEY (session_name, seq),
          FOREIGN KEY (session_name) REFERENCES agent_sessions(name)
        ) ENGINE=InnoDB
      `;
      await connection`
        INSERT IGNORE INTO agent_sessions (name) VALUES (${sessionName})
      `;

      storage = new MysqlStorage(client, connection);
      let after = 0;
      while (true) {
        const rows = await connection<
          Pick<ReturnType<MemoryStorage["prepareCommit"]>, "seq" | "writes">[]
        >`
          SELECT seq, writes FROM agent_commits
          WHERE session_name = ${sessionName} AND seq > ${after}
          ORDER BY seq LIMIT 256
        `;
        if (!rows.length) break;
        for (const row of rows) {
          storage.prepareCommit(row.writes, row.seq).apply();
          after = row.seq;
        }
      }
      return storage;
    } catch (error) {
      await connection?.release();
      await client.close();
      throw error;
    }
  }

  override async commit(...[writes, context]: Parameters<Storage["commit"]>) {
    if (this.failure) throw this.failure;
    context.abortSignal?.throwIfAborted();

    const prepared = this.prepareCommit(writes);
    try {
      await this.connection`
        INSERT INTO agent_commits (session_name, seq, writes)
        VALUES (${sessionName}, ${prepared.seq}, ${JSON.stringify(prepared.writes)})
      `;
    } catch (error) {
      this.failure = new Error("MySQL persistence failed", { cause: error });
      throw this.failure;
    }
    return prepared.apply();
  }

  override async mintId<I extends Id<string>>() {
    if (this.failure) throw this.failure;

    const candidate = await super.mintId<I>();
    const result = await this.connection`
      UPDATE agent_sessions
      SET next_id = LAST_INSERT_ID(GREATEST(next_id, ${candidate})) + 1
      WHERE name = ${sessionName}
    `;
    const id = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(id) || id < 2)
      throw new Error("MySQL returned an invalid Pi record ID");

    // MySQL allocated and validated this numeric ID; Pi's brand is compile-time only.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return id as I;
  }

  override async close() {
    if (this.closing) return;
    this.closing = true;

    try {
      await super.close(BACKGROUND_CONTEXT);
    } finally {
      await this.connection.release();
      await this.client.close();
    }
  }
}
