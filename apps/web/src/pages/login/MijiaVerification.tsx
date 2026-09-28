import { useForm } from "react-hook-form";
import { Button } from "../../components/Button";
export function MijiaVerification({
  verificationUrl,
  disabled,
  pending,
  onVerify,
}: {
  verificationUrl: string;
  disabled: boolean;
  pending: boolean;
  onVerify: (ticket: string) => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm({
    defaultValues: { ticket: "" },
    mode: "onChange",
  });
  return (
    <form
      className="py-3 text-xs leading-6 [&_.button]:mt-3"
      noValidate
      onSubmit={handleSubmit(({ ticket }) => {
        if (disabled) return;
        onVerify(ticket);
      })}
    >
      <p>在小米验证页面获取短信或邮件验证码，填入下方继续本次登录。</p>
      <a
        className="underline underline-offset-4"
        href={verificationUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        打开小米安全验证
      </a>
      <label className="mt-4" htmlFor="mijia-security-code">
        安全验证码（短信或邮件）
      </label>
      <input
        id="mijia-security-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={10}
        disabled={disabled}
        aria-invalid={!!errors.ticket}
        aria-describedby={errors.ticket ? "mijia-code-error" : undefined}
        {...register("ticket", {
          required: "请输入验证码。",
          pattern: {
            value: /^[0-9]{4,10}$/,
            message: "请输入 4–10 位数字验证码。",
          },
        })}
      />
      {errors.ticket ? (
        <p id="mijia-code-error" className="mt-1 text-xs text-danger">
          {errors.ticket.message}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={disabled || !isValid}
        status={pending ? "pending" : "idle"}
      >
        {pending ? "正在验证…" : "提交验证码"}
      </Button>
    </form>
  );
}
