import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Provider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { appStore } from "../src/lib/store";
import {
  householdSnapshotAtom,
  householdSyncedAtom,
} from "../src/features/mijia/household-state";
import { HomeSelection } from "../src/features/mijia/HomeSelection";
import { LoginFlow } from "../src/features/mijia/LoginFlow";
import { RetryConnectionButton } from "../src/features/mijia/RetryConnectionButton";
import { householdSnapshot, loginId } from "./support/household";

beforeEach(() => {
  appStore.set(householdSnapshotAtom, householdSnapshot());
  appStore.set(householdSyncedAtom, false);
});

function render(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(
    createElement(
      Provider,
      { store: appStore },
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        element,
      ),
    ),
  );
}

describe("control buttons during state stream loss", () => {
  it("does not expose a household switch for an already bound instance", () => {
    const html = render(createElement(HomeSelection));
    const select = html.match(/<select[^>]*id="mijia-home"[^>]*>/)?.[0];
    expect(select).toBeUndefined();
    expect(html).toContain("停止服务");
  });

  it("offers explicit login and credential cleanup before the first snapshot", () => {
    appStore.set(householdSnapshotAtom, undefined);
    const html = render(createElement(LoginFlow));
    expect(html).toContain("开始登录");
    expect(html).toContain("清除已保存授权");
    expect(html).not.toContain("disabled");
  });

  it("keeps cancellation available for the last known login attempt", () => {
    const snapshot = householdSnapshot();
    snapshot.projection.account.account = { status: "idle" };
    snapshot.projection.login.login = {
      id: loginId,
      status: "pending",
      error: null,
      material_version: 1,
    };
    appStore.set(householdSnapshotAtom, snapshot);
    const html = render(createElement(LoginFlow));
    const cancel = html.match(/<button[^>]*>取消登录<\/button>/)?.[0];
    expect(cancel).toBeDefined();
    expect(cancel).not.toContain("disabled");
  });

  it("allows a manual connection retry despite stale installing state", () => {
    const snapshot = householdSnapshot();
    snapshot.projection.media.media.binding = { status: "installing" };
    appStore.set(householdSnapshotAtom, snapshot);
    const html = render(createElement(RetryConnectionButton));
    expect(html).not.toContain("disabled");
  });
});
