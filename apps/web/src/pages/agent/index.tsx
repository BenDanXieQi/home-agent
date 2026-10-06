import { useEffect, useRef, useState } from "react";
import { chatResponseSchema } from "@home-agent/api/contracts";
import { requestJson } from "../../api/client";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { MarkdownAnswer } from "./MarkdownAnswer";

export default function AgentPage() {
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  async function submit() {
    if (pending.current || !message.trim()) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setAnswer("");
    setError("");
    try {
      const result = await requestJson(
        (client, options) =>
          client.api.chat.$post({ json: { message } }, options),
        chatResponseSchema,
        { signal: controller.signal, timeoutMs: 140000 },
      );
      if (!controller.signal.aborted) setAnswer(result.answer);
    } catch {
      if (!controller.signal.aborted)
        setError("请求失败，请检查模型配置和服务状态后重试。");
    } finally {
      if (pending.current === controller) pending.current = null;
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-6">
      <div>
        <h2 className="text-lg font-semibold">家庭助手</h2>
        <p className="mt-2 text-sm text-muted">
          每次提问独立回答，暂不保存对话，也未接入家庭资料和设备。
        </p>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit().catch(() => {
            setError("发送失败，请重试。");
          });
        }}
      >
        <label htmlFor="agent-message" className="text-sm">
          你的问题
        </label>
        <textarea
          id="agent-message"
          className="min-h-28 rounded-xl border border-line bg-paper p-3 text-sm"
          rows={4}
          maxLength={16000}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={busy}
        />
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !message.trim()}
          >
            发送
          </Button>
          {busy ? (
            <Button
              type="button"
              onClick={() => {
                pending.current?.abort();
              }}
            >
              停止
            </Button>
          ) : null}
        </div>
      </form>
      {busy ? <output className="text-sm text-muted">正在回答…</output> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {answer ? (
        <div aria-live="polite">
          <MarkdownAnswer>{answer}</MarkdownAnswer>
        </div>
      ) : null}
    </section>
  );
}
