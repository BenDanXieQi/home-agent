import { AppError, validationIssues } from "@home-agent/api/errors";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  serviceConfigurationSchema,
  serviceConfigurationWithDefaults as configurationWithDefaults,
  type ValidationIssue,
  type ServiceConfiguration,
} from "@home-agent/api/contracts";
import writeFileAtomic from "write-file-atomic";
import { Document, parseDocument } from "yaml";
import { z } from "zod";

export const MAX_CONFIG_BYTES = 64 * 1024;

export { serviceConfigurationSchema };

export function resolveConnectionConfigPath(
  repositoryRoot: string,
  args: readonly string[] = process.argv.slice(2),
  startupCwd = process.cwd(),
): string {
  let configuredPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument !== "--config" && !argument.startsWith("--config=")) continue;
    const value = argument === "--config" ? args[++index] : argument.slice(9);
    if (configuredPath !== undefined || !value || value.startsWith("--")) {
      throw new AppError("connection_config_argument_invalid");
    }
    configuredPath = value;
  }

  return configuredPath === undefined
    ? resolve(repositoryRoot, "config/config.yaml")
    : resolve(startupCwd, configuredPath);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function invalidFile(
  issues: ValidationIssue[] = [{ path: "config", code: "invalid_yaml" }],
  cause?: unknown,
): AppError {
  return new AppError("connection_config_invalid", {
    issues,
    cause,
    operation: "connections.parse",
  });
}

function validateConfiguration(
  input: unknown,
  fromFile: boolean,
): ServiceConfiguration {
  const result = serviceConfigurationSchema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError(
    fromFile ? "connection_config_invalid" : "connection_config_input_invalid",
    {
      issues: validationIssues(result.error, "config").map((issue) =>
        issue.code === "invalid_format" &&
        ["services.agent.url", "services.go2rtc.url"].includes(issue.path)
          ? { ...issue, code: "invalid_service_url" as const }
          : issue,
      ),
      operation: "connections.validate",
    },
  );
}

async function readDocument(path: string) {
  let source: string;
  try {
    // Nonblocking open rejects FIFOs without hanging a request. Check the opened
    // file, then read at most the limit plus one byte even if it grows meanwhile.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const information = await file.stat();
      if (!information.isFile())
        throw invalidFile([{ path: "config", code: "not_regular_file" }]);
      if (information.size > MAX_CONFIG_BYTES) {
        throw invalidFile([
          {
            path: "config",
            code: "file_too_large",
            params: { maxBytes: MAX_CONFIG_BYTES },
          },
        ]);
      }
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_CONFIG_BYTES)
        throw invalidFile([
          {
            path: "config",
            code: "file_too_large",
            params: { maxBytes: MAX_CONFIG_BYTES },
          },
        ]);
      source = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("connection_config_unavailable", {
      cause: error,
      operation: "connections.read",
    });
  }

  try {
    const document = parseDocument(source, {
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      merge: false,
      resolveKnownTags: false,
      prettyErrors: false,
    });
    const problems = [...document.errors, ...document.warnings];
    if (problems.length > 0)
      throw invalidFile(undefined, new Error("Invalid YAML document"));
    const input: unknown = document.toJS({ maxAliasCount: 0 });
    const configuration = validateConfiguration(input, true);
    return { document, configuration };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidFile(undefined, error);
  }
}

export function createConnectionStore(configPath: string) {
  const path = resolve(configPath);
  const schemaPath = resolve(dirname(path), "config.schema.json");

  async function initialize(): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw new AppError("connection_config_unavailable", {
          cause: error,
          operation: "connections.initialize",
        });
      }
      try {
        await mkdir(dirname(path), { recursive: true });
        const initial = configurationWithDefaults.parse({
          services: { agent: {}, go2rtc: {} },
        });
        const document = new Document(initial);
        document.commentBefore =
          " yaml-language-server: $schema=./config.schema.json";
        // Exclusive creation never replaces an existing YAML, including a file
        // created by another startup between the existence check and this write.
        await writeFile(path, document.toString(), { flag: "wx", mode: 0o600 });
      } catch (creationError) {
        if (!hasCode(creationError, "EEXIST")) {
          throw new AppError("connection_config_unavailable", {
            cause: creationError,
            operation: "connections.create",
          });
        }
      }
    }

    try {
      // Avoid overwriting the YAML if a custom path or symlink points at the
      // schema filename. Editor hints are optional and never gate valid YAML.
      const [yamlTarget, schemaTarget] = await Promise.all([
        realpath(path),
        realpath(schemaPath).catch((error: unknown) => {
          if (hasCode(error, "ENOENT")) return schemaPath;
          throw error;
        }),
      ]);
      if (yamlTarget === schemaTarget)
        throw new Error("Schema path refers to the YAML file");
      const schema = z.toJSONSchema(configurationWithDefaults);
      await writeFileAtomic(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
    } catch (error) {
      console.warn(
        "Could not write config.schema.json; YAML configuration remains available",
        error,
      );
    }
  }

  async function read(): Promise<ServiceConfiguration> {
    return (await readDocument(path)).configuration;
  }

  async function isWritable(): Promise<boolean> {
    try {
      // write-file-atomic follows symlinks, so check the actual replacement
      // directory as well as the file's permissions, including explicit modes.
      const target = await realpath(path);
      const directory = dirname(target);
      const [fileInformation, directoryInformation] = await Promise.all([
        stat(target),
        stat(directory),
      ]);
      if (
        !fileInformation.isFile() ||
        (fileInformation.mode & 0o222) === 0 ||
        (directoryInformation.mode & 0o222) === 0
      ) {
        return false;
      }
      await Promise.all([
        access(target, constants.W_OK),
        access(directory, constants.W_OK | constants.X_OK),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async function save(input: unknown): Promise<ServiceConfiguration> {
    const configuration = validateConfiguration(input, false);
    const { document } = await readDocument(path);
    if (!(await isWritable())) {
      throw new AppError("connection_config_read_only");
    }
    // Mutating existing scalar nodes through Document preserves nearby comments
    // and formatting. Manual editing and Web saves must be performed separately;
    // this local single-user store deliberately has no conflict detection.
    document.setIn(
      ["services", "agent", "url"],
      configuration.services.agent.url,
    );
    document.setIn(
      ["services", "go2rtc", "url"],
      configuration.services.go2rtc.url,
    );
    const contents = document.toString();
    if (Buffer.byteLength(contents, "utf8") > MAX_CONFIG_BYTES) {
      throw new AppError("connection_config_too_large", {
        params: { maxBytes: MAX_CONFIG_BYTES },
      });
    }
    try {
      // The library preserves existing mode/ownership, fsyncs, then renames an
      // adjacent temporary file. Its built-in per-file serialization is enough.
      await writeFileAtomic(path, contents);
    } catch (error) {
      const readOnly = ["EACCES", "EPERM", "EROFS"].some((code) =>
        hasCode(error, code),
      );
      throw new AppError(
        readOnly
          ? "connection_config_read_only"
          : "connection_config_save_failed",
        { cause: error, operation: "connections.save" },
      );
    }
    return configuration;
  }

  return { path, initialize, read, isWritable, save };
}

export type ConnectionStore = ReturnType<typeof createConnectionStore>;
