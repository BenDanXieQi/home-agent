import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { spatialPlanningResultSchema } from "@home-agent/api/agent-workflows";
import { spatialDraftSchema } from "@home-agent/api/spatial";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { requestErrorMessage } from "../../messages/zh-CN";
import { RequestError } from "../../api/errors";
import {
  readPlanningImage,
  runSpatialPlanning,
  closeSpatialPlanning,
} from "../../modules/spatial/planning";
import type { SpatialSnapshot } from "../../modules/spatial/api";
import { MarkdownAnswer } from "../agent/MarkdownAnswer";

export function SpatialPlanning({
  scope,
  snapshot,
  available,
}: {
  scope: string;
  snapshot: SpatialSnapshot;
  available: boolean;
}) {
  const [text, setText] = useState("");
  const [image, setImage] = useState<Awaited<
    ReturnType<typeof readPlanningImage>
  > | null>(null);
  const [session, setSession] = useState<ReturnType<
    typeof spatialPlanningResultSchema.parse
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const sessionId = useRef<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
      const currentId = sessionId.current;
      sessionId.current = null;
      if (currentId)
        closeSpatialPlanning(scope, currentId).catch((cause: unknown) => {
          console.error("Spatial planning session close failed", cause);
        });
    };
  }, [scope]);
  useEffect(() => {
    if (!available) pending.current?.abort();
  }, [available]);

  async function operate(action: "message" | "read" | "close") {
    if (pending.current || !available) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      let current = session;
      if (!current) {
        if (action !== "message") return;
        const draft = spatialDraftSchema.parse({
          spaces: snapshot.spaces.map(({ id, name, description }) => ({
            id,
            name,
            description,
          })),
          passages: snapshot.passages.map(
            ({ id, name, description, space_a_id, space_b_id }) => ({
              id,
              name,
              description,
              space_a_id,
              space_b_id,
            }),
          ),
        });
        current = await runSpatialPlanning(
          scope,
          { action: "start", draft },
          new AbortController().signal,
        );
        if (!mounted.current || controller.signal.aborted) {
          await closeSpatialPlanning(scope, current.session_id).catch(
            (cause: unknown) => {
              console.error("Spatial planning session close failed", cause);
            },
          );
          return;
        }
        sessionId.current = current.session_id;
        setSession(current);
      }
      const result = await runSpatialPlanning(
        scope,
        action === "message"
          ? {
              action,
              session_id: current.session_id,
              text,
              images: image ? [image.image] : [],
            }
          : { action, session_id: current.session_id },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      sessionId.current = action === "close" ? null : result.session_id;
      setSession(action === "close" ? null : result);
      if (action === "message" || action === "close") {
        setText("");
        setImage(null);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (
          cause instanceof RequestError &&
          cause.details.code === "not_found"
        ) {
          sessionId.current = null;
          setSession(null);
          setError("会话已失效，请重新开始分析。你的本轮输入已保留。");
        } else setError(requestErrorMessage(cause));
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  async function upload(file: File) {
    if (busy || pending.current || !available) return;
    setBusy(true);
    setError("");
    try {
      setImage(await readPlanningImage(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "图片读取失败。");
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || !available;
  const analyzed = !!session;
  const names = new Map(
    session?.draft.spaces.map((space) => [space.id, space.name]),
  );
  return (
    <section
      className={`mx-auto grid w-full max-w-3xl gap-5 py-6 ${analyzed ? "" : "min-h-[60svh] content-center"}`}
      aria-label="AI 空间规划"
    >
      {!available ? <Notice>家庭连接就绪后可使用 AI 空间规划。</Notice> : null}
      <form
        className={`grid gap-5 ${analyzed ? "" : "mx-auto w-full max-w-sm"}`}
        onSubmit={(event) => {
          event.preventDefault();
          operate("message").catch((cause: unknown) => {
            setError(requestErrorMessage(cause));
          });
        }}
      >
        <label
          className={`relative flex cursor-pointer flex-col items-center justify-center gap-5 overflow-hidden rounded-2xl border border-line bg-white p-6 focus-within:ring-2 focus-within:ring-ink ${analyzed ? "min-h-40" : "min-h-64"} ${disabled ? "cursor-default opacity-60" : "hover:bg-surface/50"}`}
        >
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled}
            aria-label="点击上传你的户型图"
            className="absolute inset-0 z-10 size-full cursor-pointer opacity-0 disabled:cursor-default"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file)
                upload(file).catch((cause: unknown) => {
                  setError(requestErrorMessage(cause));
                });
            }}
          />
          {image ? (
            <img
              src={image.preview}
              alt="已上传的户型图"
              className="max-h-72 w-full object-contain"
            />
          ) : (
            <span
              className="grid size-24 place-items-center rounded-2xl bg-surface text-ink"
              aria-hidden="true"
            >
              <Plus size={48} strokeWidth={1.25} />
            </span>
          )}
          <span className="text-sm font-medium text-ink">
            {image ? "点击更换户型图" : "点击上传你的户型图"}
          </span>
        </label>
        {analyzed ? (
          <label className="grid gap-2 text-xs">
            <span>补充说明</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={disabled}
              rows={3}
              placeholder="回答问题，或告诉 AI 要调整哪里"
              className="w-full resize-y rounded-xl bg-surface p-3 text-sm leading-6"
            />
          </label>
        ) : null}
        <div
          className={`flex flex-wrap gap-2 ${analyzed ? "" : "justify-center"}`}
        >
          <Button
            type="submit"
            variant="primary"
            style={analyzed ? {} : { width: 160 }}
            disabled={
              disabled ||
              (analyzed ? !text.trim() && !image : !image) ||
              session?.status === "running"
            }
          >
            {analyzed ? "继续分析" : "开始 AI 分析"}
          </Button>
          {session ? (
            <>
              <Button
                type="button"
                disabled={disabled}
                onClick={() => {
                  operate("read").catch((cause: unknown) => {
                    setError(requestErrorMessage(cause));
                  });
                }}
              >
                读取当前草稿
              </Button>
              <Button
                type="button"
                disabled={disabled}
                onClick={() => {
                  operate("close").catch((cause: unknown) => {
                    setError(requestErrorMessage(cause));
                  });
                }}
              >
                结束会话
              </Button>
            </>
          ) : null}
        </div>
      </form>
      {busy ? (
        <output className="text-xs text-muted" aria-live="polite">
          正在处理，请稍候…
        </output>
      ) : null}
      {error ? (
        <Notice tone="error">
          {error}
          {session ? " 可先读取当前草稿，核对本轮结果。" : ""}
        </Notice>
      ) : null}
      {session ? (
        <div className="grid gap-4" aria-live="polite">
          <MarkdownAnswer>{session.reply}</MarkdownAnswer>
          {session.questions.length ? (
            <div>
              <h3 className="text-xs font-medium">需要你确认</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {session.questions.map((question, index) => (
                  <li key={index}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="grid gap-3 rounded-xl bg-white p-4">
            <h3 className="text-sm font-medium">
              空间草稿 · 修订 {session.revision}
              {session.status === "running" ? " · 正在分析" : ""}
            </h3>
            {!session.draft.spaces.length ? (
              <p className="text-xs text-muted">
                尚未形成空间，可继续补充图片或说明。
              </p>
            ) : null}
            {session.draft.spaces.map((space) => (
              <div key={space.id} className="text-sm">
                <span className="font-medium">{space.name}</span>
                {space.description ? (
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-muted">
                    {space.description}
                  </p>
                ) : null}
              </div>
            ))}
            <h4 className="mt-2 text-xs font-medium">
              通道 · {session.draft.passages.length} 条
            </h4>
            {session.draft.passages.map((passage) => (
              <div key={passage.id} className="text-sm">
                {passage.name} · {names.get(passage.space_a_id)} ↔{" "}
                {names.get(passage.space_b_id)}
                {passage.description ? (
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-muted">
                    {passage.description}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
