import { describe, expect, mock, test } from "bun:test";
import { MijiaError } from "../../../src/mijia/errors";
import { preparePropertyRead } from "../../../src/mijia/properties/read-request";
import { preparedSpec } from "../../support/protocol-fixtures";

const signal = () => new AbortController().signal;

describe("readable capability gate", () => {
  test("checks each device once, preserves order and copies the accepted request", () => {
    const input = [
      { did: "a", siid: 2, piid: 1 },
      { did: "b", siid: 2, piid: 2 },
      { did: "a", siid: 2, piid: 2 },
    ];
    const getDeviceSpec = mock((did: string) => preparedSpec(did));
    const assertCurrent = mock(() => {});
    const result = preparePropertyRead(
      input,
      { getDeviceSpec, assertCurrent },
      signal(),
    );
    expect(result).toEqual(input);
    expect(getDeviceSpec.mock.calls.map(([did]) => did)).toEqual(["a", "b"]);
    input[0]!.piid = 3;
    expect(result[0]?.piid).toBe(1);
    // No notify capability or directory online fact is required for a readable property.
    expect(result[0]).toEqual({ did: "a", siid: 2, piid: 1 });
  });

  test.each([
    { siid: 0, piid: 1 },
    { siid: 2, piid: 3 },
    { siid: 2, piid: 99 },
  ])("rejects invalid or non-readable address %j synchronously", (address) => {
    expect(() =>
      preparePropertyRead(
        [
          { did: "a", siid: 2, piid: 1 },
          { did: "a", ...address },
        ],
        { getDeviceSpec: () => preparedSpec(), assertCurrent: () => {} },
        signal(),
      ),
    ).toThrow(new MijiaError("property_not_readable"));
  });

  test("cancellation and synchronous scope revocation cannot escape the final gate", () => {
    const controller = new AbortController();
    const cancelled = new Error("cancelled by caller");
    expect(() =>
      preparePropertyRead(
        [{ did: "a", siid: 2, piid: 1 }],
        {
          getDeviceSpec: () => {
            controller.abort(cancelled);
            return preparedSpec();
          },
          assertCurrent: () => {},
        },
        controller.signal,
      ),
    ).toThrow(cancelled);

    let current = true;
    const revoked = new MijiaError("stale_session");
    expect(() =>
      preparePropertyRead(
        [{ did: "a", siid: 2, piid: 1 }],
        {
          getDeviceSpec: () => {
            current = false;
            return preparedSpec();
          },
          assertCurrent: () => {
            if (!current) throw revoked;
          },
        },
        signal(),
      ),
    ).toThrow(revoked);
  });
});
