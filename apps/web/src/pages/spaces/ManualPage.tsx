import { Link } from "@tanstack/react-router";
import SpacesPage from "./index";

export default function ManualPage() {
  return (
    <>
      <Link
        to="/spaces"
        className="mb-5 inline-block text-xs text-muted hover:text-ink"
      >
        ← 返回 AI 分析
      </Link>
      <SpacesPage manual />
    </>
  );
}
