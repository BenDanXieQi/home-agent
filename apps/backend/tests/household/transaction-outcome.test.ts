import { expect, mock, test } from "bun:test";
import {
  createConfirmedWriter,
  StorageOutcomeUnknownError,
} from "../../src/db/transaction-outcome";

/** Commit acknowledgement and subsequent reads fail independently of durable data. */
function storage() {
  const rows = new Map<string, string>();
  const mutations: { key: string; value: string }[] = [];
  const locks: string[] = [];
  let lostCommit: "committed" | "rolled_back" | undefined;
  let unreadable = false;
  let failConfirmation = true;
  const tx = {
    async read(key: string) {
      if (unreadable) throw new Error("Fixture database connection failed");
      return rows.get(key);
    },
    async write(key: string, value: string) {
      mutations.push({ key, value });
      rows.set(key, value);
      return value;
    },
  };
  const transaction = async <T>(
    key: string,
    run: (value: typeof tx) => Promise<T>,
  ) => {
    locks.push(key);
    const previous = rows.get(key);
    const before = mutations.length;
    const result = await run(tx);
    if (mutations.length !== before && lostCommit) {
      if (lostCommit === "rolled_back") {
        if (previous === undefined) rows.delete(key);
        else rows.set(key, previous);
      }
      lostCommit = undefined;
      unreadable = failConfirmation;
      throw new Error("Fixture lost COMMIT acknowledgement");
    }
    return result;
  };
  const write = createConfirmedWriter(transaction);
  return {
    rows,
    mutations,
    locks,
    loseCommit(outcome: NonNullable<typeof lostCommit>, failRead = true) {
      lostCommit = outcome;
      failConfirmation = failRead;
    },
    reconnect() {
      unreadable = false;
    },
    save(key: string, value: string) {
      return write(
        key,
        async (database, beforeWrite) => {
          if ((await database.read(key)) === value) return value;
          beforeWrite();
          return database.write(key, value);
        },
        async (database) => {
          return (await database.read(key)) === value
            ? { committed: true, value }
            : { committed: false };
        },
      );
    },
  };
}

test("a lost commit acknowledgement returns the confirmed value without replaying the insert", async () => {
  const db = storage();
  db.loseCommit("committed", false);
  expect(await db.save("home-selection/account-a", "home-a")).toBe("home-a");
  expect(db.mutations).toEqual([
    { key: "home-selection/account-a", value: "home-a" },
  ]);
  expect(db.locks).toEqual([
    "home-selection/account-a",
    "home-selection/account-a",
  ]);
});

test("an unreadable commit outcome prevents every later insert until the original aggregate is confirmed", async () => {
  const db = storage();
  db.loseCommit("committed");
  await expect(
    db.save("account-a/home-a", "directory-a"),
  ).rejects.toBeInstanceOf(StorageOutcomeUnknownError);
  expect(db.rows.get("account-a/home-a")).toBe("directory-a");
  for (const key of ["account-a/home-a", "account-b/home-b"])
    await expect(db.save(key, "next-directory")).rejects.toBeInstanceOf(
      StorageOutcomeUnknownError,
    );
  expect(db.mutations).toEqual([
    { key: "account-a/home-a", value: "directory-a" },
  ]);
  expect(new Set(db.locks)).toEqual(new Set(["account-a/home-a"]));

  db.reconnect();
  expect(await db.save("account-a/home-a", "directory-a")).toBe("directory-a");
  expect(db.mutations).toHaveLength(1);
  expect(await db.save("account-b/home-b", "directory-b")).toBe("directory-b");
  expect(db.mutations).toHaveLength(2);
  expect(db.locks.at(-1)).toBe("account-b/home-b");
});

test("a confirmed rollback permits a new candidate only after rereading the original aggregate", async () => {
  const db = storage();
  db.loseCommit("rolled_back");
  await expect(
    db.save("home-selection/account-a", "home-a"),
  ).rejects.toBeInstanceOf(StorageOutcomeUnknownError);
  await expect(
    db.save("home-selection/account-a", "home-b"),
  ).rejects.toBeInstanceOf(StorageOutcomeUnknownError);
  expect(db.mutations).toHaveLength(1);
  expect(db.rows.has("home-selection/account-a")).toBe(false);
  db.reconnect();
  expect(await db.save("home-selection/account-a", "home-b")).toBe("home-b");
  expect(db.rows.get("home-selection/account-a")).toBe("home-b");
  expect(db.mutations.map(({ value }) => value)).toEqual(["home-a", "home-b"]);
});

test("confirmed writes and read-only rejections do not retain a pending recovery", async () => {
  const locks: string[] = [];
  const write = createConfirmedWriter(
    async <T>(key: string, run: (tx: null) => Promise<T>) => {
      locks.push(key);
      return run(null);
    },
  );
  const failure = new Error("Rejected before any write");
  await expect(
    write(
      "first",
      async () => {
        throw failure;
      },
      async () => {
        throw new Error("A rejected candidate must not be reconciled");
      },
    ),
  ).rejects.toBe(failure);
  expect(
    await write(
      "second",
      async (_tx, beforeWrite) => {
        beforeWrite();
        return "saved";
      },
      async () => ({ committed: false }),
    ),
  ).toBe("saved");
  expect(locks).toEqual(["first", "second"]);
});

test("a callback failure after a write rolls back without confirming an unattempted commit", async () => {
  const rows = new Map<string, string>();
  let commits = 0;
  let rollbacks = 0;
  const write = createConfirmedWriter(
    async <T>(_key: string, run: (tx: typeof rows) => Promise<T>) => {
      const before = new Map(rows);
      try {
        const result = await run(rows);
        commits++;
        return result;
      } catch (error) {
        rows.clear();
        for (const [key, value] of before) rows.set(key, value);
        rollbacks++;
        throw error;
      }
    },
  );
  const failure = new Error("Scope changed after the write statement");
  const confirm = mock(async () => {
    throw new Error("Confirmation connection is unavailable");
  });
  await expect(
    write(
      "account",
      async (tx, beforeWrite) => {
        beforeWrite();
        tx.set("account", "old-home");
        throw failure;
      },
      confirm,
    ),
  ).rejects.toBe(failure);
  expect(rows.size).toBe(0);
  expect(commits).toBe(0);
  expect(rollbacks).toBe(1);
  expect(confirm).not.toHaveBeenCalled();

  expect(
    await write(
      "account",
      async (tx, beforeWrite) => {
        beforeWrite();
        tx.set("account", "new-home");
        return "new-home";
      },
      confirm,
    ),
  ).toBe("new-home");
  expect(rows.get("account")).toBe("new-home");
  expect(commits).toBe(1);
  expect(confirm).not.toHaveBeenCalled();
});
